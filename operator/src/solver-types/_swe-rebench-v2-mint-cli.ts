/**
 * `jinn solver-nets mint-tasks` orchestration.
 */

import { createHash } from 'node:crypto';
import type { PoolTask } from './_swe-rebench-v2-pool.js';
import {
  EVAL_SEMANTICS_VERSION,
  validatePoolInstances,
  type ValidatedPoolStore,
  type V2MintedEnvironmentAdmissionBinding,
} from './_swe-rebench-v2-validated-pool.js';
import {
  MintedPoolStore,
  computeMintedPoolRowV2Hash,
  mintedIpfsDatasetCid,
  type MintedPoolEntry,
  type DifferentialAdmissionReceiptReferenceV2,
  type MintedEnvironmentBindingV1,
  type MintedProvenance,
} from './_swe-rebench-v2-minted-pool.js';
import {
  assertPublicRepoForPublish,
  assertRepoAllowedForMint,
  loadMintRepoDenylist,
  type PublicRepoChecker,
} from './_swe-rebench-v2-guards.js';
import type { EvalRunner, HfFetcher, HfRow } from '../harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { uploadToIpfs } from '../adapters/mech/ipfs.js';
import {
  createMintedEnvironmentVerifier,
  type MintedEnvironmentVerifier,
} from './_swe-rebench-v2-minted-environment-verifier.js';
import type { TaskEnvironmentSpecV1 } from '../task-creator/environment/contracts.js';
import type { JinnDifferentialAttesterPolicyV1 } from '../task-creator/environment/jinn-differential-policy.js';
import { isAcceptedIpfsCid } from '../task-creator/proofs/ipfs-cid.js';
import { canonicalJson } from '../util/canonical-json.js';
import {
  DifferentialAdmissionPolicyV2,
  hashDifferentialAdmissionReceiptV2,
  targetRecipeCommandForTestPath,
  verifyDifferentialAdmissionReceiptV2,
  type DifferentialAdmissionReceiptV2,
} from './_swe-rebench-v2-differential-admission.js';
import { JINN_MONO_DIFFERENTIAL_PROOF_SOURCE } from '../task-creator/proofs/public-repo-fixtures.js';

/** Receipt data held locally until it is published and bound into a v2 row. */
export interface DifferentialAdmissionReceiptCandidateV2 {
  receipt: DifferentialAdmissionReceiptV2;
  receiptHash: `sha256:${string}`;
  /** A pre-published CID is retained only when the publication result matches it exactly. */
  receiptCid?: string;
}

export interface MintTasksInput {
  candidates: Array<{
    poolTask: PoolTask;
    goldPatch: string;
    provenance: MintedProvenance;
    /** Presence selects the public explicit-environment v2 artifact contract. */
    environment?: MintedEnvironmentBindingV1;
    /** Public fix identity required when hardened differential evidence is present. */
    fixCommit?: string;
    /** Empirically derived public row from the harvest path (never gold patch). */
    row?: HfRow;
    /** Required for every newly hardened explicit-environment v2 admission. */
    differentialAdmission?: DifferentialAdmissionReceiptCandidateV2;
    publish?: boolean;
  }>;
  stateDir: string;
  ipfsRegistryUrl: string;
  ipfsGatewayUrl: string;
  validatedStore: ValidatedPoolStore;
  mintedStore: MintedPoolStore;
  fetcher: HfFetcher;
  runner: EvalRunner;
  upstreamRepoDir: string;
  publicRepoChecker: PublicRepoChecker;
  /** Verifies a v2 binding against its public signed environment spec before admission. */
  environmentVerifier?: MintedEnvironmentVerifier;
  /** Required for the exact Jinn differential source; generic repositories do not use it. */
  jinnDifferentialAttesterPolicy?: JinnDifferentialAttesterPolicyV1;
  /** Durable harvest checkpoints, invoked only after the underlying write succeeds. */
  progress?: MintTasksProgress;
  /** Test seam for the already-public differential receipt publication step. */
  uploadReceipt?: (registryUrl: string, receipt: DifferentialAdmissionReceiptV2) => Promise<string>;
  /**
   * Optional durable authorization boundary for public artifact upload. The
   * caller may hold its canonical consent lock while `publish` rechecks repo
   * visibility, uploads, and commits the minted-pool publication.
   */
  withPublicationAuthorization?: (
    args: { instanceIds: string[]; rowHashVersion: 1 | 2 },
    publish: () => Promise<string>,
  ) => Promise<string>;
}

export interface MintTasksProgress {
  onAdmissionStored?: (args: {
    instanceId: string;
    rowHashVersion: 1 | 2;
    differentialAdmission?: DifferentialAdmissionReceiptReferenceV2;
  }) => Promise<void> | void;
  onIpfsPublished?: (args: {
    instanceIds: string[];
    rowHashVersion: 1 | 2;
    artifactCid: string;
  }) => Promise<void> | void;
}

export interface MintTasksResult {
  admitted: string[];
  rejected: Array<{ instance_id: string; reason: string }>;
  artifactCid?: string;
  artifactCids?: Partial<Record<1 | 2, string>>;
}

async function assertPublicReposImmediatelyBeforeOutbound(
  candidates: MintTasksInput['candidates'],
  checker: PublicRepoChecker,
): Promise<void> {
  const repositories = new Set(candidates.map((candidate) => candidate.poolTask.repo ?? 'unknown/unknown'));
  await Promise.all([...repositories].map((repository) => assertPublicRepoForPublish(repository, checker)));
}

function toV2AdmissionEnvironment(binding: MintedEnvironmentBindingV1): V2MintedEnvironmentAdmissionBinding {
  // The minted-pool schema applies these same checks at record/export time.
  // Keep this boundary explicit because Zod's inferred `string` type cannot
  // preserve the template-literal digest brand used by the vetted-pool seam.
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(binding.environmentHash) ||
    !/^sha256:[0-9a-f]{64}$/u.test(binding.image.digest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(binding.parser.digest) ||
    !binding.image.reference.endsWith(`@${binding.image.digest}`)
  ) {
    throw new Error('explicit environment binding has invalid digest-qualified image or parser identity');
  }
  return binding as V2MintedEnvironmentAdmissionBinding;
}

function quoteCommandPart(value: string): string {
  return /^[a-zA-Z0-9_./:=@+-]+$/u.test(value) ? value : `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalCommandHash(command: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(command)).digest('hex')}`;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** The first real Jinn source is never eligible for the legacy v2 path. */
function isRealJinnDifferentialSource(candidate: MintTasksInput['candidates'][number]): boolean {
  const task = candidate.poolTask;
  const source = JINN_MONO_DIFFERENTIAL_PROOF_SOURCE;
  return task.instance_id === source.instanceId &&
    task.repo === source.repo &&
    task.base_commit === source.baseCommit;
}

function assertRequiredJinnDifferentialAdmission(candidate: MintTasksInput['candidates'][number]): void {
  if (!isRealJinnDifferentialSource(candidate)) return;
  const source = JINN_MONO_DIFFERENTIAL_PROOF_SOURCE;
  if (!candidate.environment) {
    throw new Error('policy: real Jinn differential source requires its explicit signed evaluator environment; legacy routing is forbidden');
  }
  if (!candidate.differentialAdmission || candidate.fixCommit !== source.fixCommit) {
    throw new Error('policy: real Jinn differential source requires hardened differential receipt admission evidence and its reviewed fixCommit');
  }
  if (!candidate.differentialAdmission.receiptCid || !isAcceptedIpfsCid(candidate.differentialAdmission.receiptCid)) {
    throw new Error('policy: real Jinn differential source requires a pre-published differential receipt CID');
  }
}

/**
 * A direct explicit-environment candidate creates a new v2 row. Unlike
 * immutable pre-hardening artifacts loaded elsewhere, it must carry the
 * repeated differential receipt before it can enter local state or IPFS.
 */
function assertRequiredExplicitEnvironmentDifferentialAdmission(
  candidate: MintTasksInput['candidates'][number],
): void {
  if (!candidate.environment) return;
  if (!candidate.differentialAdmission) {
    throw new Error('policy: newly minted explicit-environment v2 candidate requires hardened differential admission receipt evidence');
  }
  if (!candidate.fixCommit) {
    throw new Error('policy: newly minted explicit-environment v2 candidate requires the receipt-bound fixCommit');
  }
}

/**
 * The receipt is public evidence, not a substitute for the signed environment
 * contract. Verify both: receipt content and every context binding derived
 * from the just-fetched `TaskEnvironmentSpecV1`.
 */
function verifyDifferentialAdmissionForMint(args: {
  candidate: MintTasksInput['candidates'][number];
  spec: TaskEnvironmentSpecV1;
}): DifferentialAdmissionReceiptV2 | null {
  const evidence = args.candidate.differentialAdmission;
  // v2 predates hardened causal admission. Keep those immutable/direct CLI
  // rows readable; the public-repository harvest adapter below requires this
  // evidence for every newly hardened row it emits.
  if (!evidence) return null;
  const receipt = verifyDifferentialAdmissionReceiptV2(evidence.receipt);
  if (hashDifferentialAdmissionReceiptV2(receipt) !== evidence.receiptHash) {
    throw new Error('policy: differential admission receipt hash does not match its content');
  }
  const task = args.candidate.poolTask;
  if (
    receipt.task.instanceId !== task.instance_id ||
    receipt.task.repo !== task.repo ||
    receipt.task.baseCommit !== task.base_commit ||
    receipt.task.fixCommit !== args.candidate.fixCommit ||
    receipt.goldPatchHash !== sha256(args.candidate.goldPatch) ||
    receipt.testPatchHash !== sha256(task.test_patch ?? '') ||
    receipt.evalSemanticsVersion !== EVAL_SEMANTICS_VERSION
  ) {
    throw new Error('policy: differential admission receipt task/patch/semantics binding drift');
  }
  if (
    receipt.environment.environmentHash !== args.spec.attestation.environmentHash ||
    receipt.environment.image.reference !== args.spec.execution.image.reference ||
    receipt.environment.image.digest !== args.spec.execution.image.digest ||
    receipt.environment.platform !== args.spec.execution.platform ||
    receipt.environment.parser.id !== args.spec.execution.parser.id ||
    receipt.environment.parser.version !== args.spec.execution.parser.version ||
    receipt.environment.parser.digest !== args.spec.execution.parser.digest ||
    receipt.environment.parser.bundleId !== args.spec.execution.parser.bundleId
  ) {
    throw new Error('policy: differential admission receipt environment binding drift');
  }
  for (const path of receipt.testPaths) {
    const command = targetRecipeCommandForTestPath(args.spec, path.testPath);
    if (canonicalCommandHash(command) !== path.commandHash) {
      throw new Error(`policy: differential admission command binding drift for ${path.testPath}`);
    }
  }
  const FAIL_TO_PASS = receipt.testPaths.flatMap((path) => path.FAIL_TO_PASS);
  const PASS_TO_PASS = receipt.testPaths.flatMap((path) => path.PASS_TO_PASS);
  if (args.candidate.row && (
    !sameStringArray(args.candidate.row.FAIL_TO_PASS, FAIL_TO_PASS) ||
    !sameStringArray(args.candidate.row.PASS_TO_PASS, PASS_TO_PASS)
  )) {
    throw new Error('policy: empirical v2 row does not match differential admission receipt');
  }
  return receipt;
}

/** A fresh CLI v2 candidate has no pre-published minted row to route through.
 * Derive its evaluator row entirely from the verified public environment and
 * candidate's public test patch; never fetch the local IPFS placeholder. */
function evaluatorRowForVerifiedV2Candidate(args: {
  poolTask: PoolTask;
  environment: MintedEnvironmentBindingV1;
  spec: TaskEnvironmentSpecV1;
  empiricalRow?: HfRow;
  /** Hardened rows use receipt-derived assertions, never optional pool fields. */
  differentialReceipt?: DifferentialAdmissionReceiptV2;
}): HfRow {
  if (!args.poolTask.repo || !args.poolTask.test_patch) {
    throw new Error('policy: explicit environment candidate requires repo and public test_patch');
  }
  const publicTests = args.poolTask as PoolTask & { FAIL_TO_PASS?: unknown; PASS_TO_PASS?: unknown };
  const receiptAssertions = args.differentialReceipt
    ? {
        FAIL_TO_PASS: args.differentialReceipt.testPaths.flatMap((path) => path.FAIL_TO_PASS),
        PASS_TO_PASS: args.differentialReceipt.testPaths.flatMap((path) => path.PASS_TO_PASS),
      }
    : undefined;
  const derived: HfRow = {
    instance_id: args.poolTask.instance_id,
    repo: args.poolTask.repo,
    image_name: args.environment.image.reference,
    FAIL_TO_PASS: receiptAssertions?.FAIL_TO_PASS ?? (Array.isArray(publicTests.FAIL_TO_PASS) ? publicTests.FAIL_TO_PASS.filter((value): value is string => typeof value === 'string') : []),
    PASS_TO_PASS: receiptAssertions?.PASS_TO_PASS ?? (Array.isArray(publicTests.PASS_TO_PASS) ? publicTests.PASS_TO_PASS.filter((value): value is string => typeof value === 'string') : []),
    test_patch: args.poolTask.test_patch,
    // Dependencies are already baked into the signed environment image.
    install_config: {
      install: [],
      test_cmd: args.spec.execution.testCommands.map((command) => [command.bin, ...command.args].map(quoteCommandPart).join(' ')),
      log_parser: args.environment.parser.id,
    },
  };
  if (!args.empiricalRow) return derived;
  if (
    args.empiricalRow.instance_id !== derived.instance_id ||
    args.empiricalRow.repo !== derived.repo ||
    args.empiricalRow.image_name !== derived.image_name ||
    args.empiricalRow.install_config.log_parser !== derived.install_config.log_parser ||
    args.empiricalRow.test_patch !== derived.test_patch
  ) {
    throw new Error('policy: empirical v2 row does not match verified public environment/candidate');
  }
  return args.empiricalRow;
}

export async function runMintTasksPipeline(input: MintTasksInput): Promise<MintTasksResult> {
  const denylist = loadMintRepoDenylist();
  const admitted: string[] = [];
  const rejected: Array<{ instance_id: string; reason: string }> = [];
  const toValidate: PoolTask[] = [];
  const verifiedV2Rows = new Map<string, import('../harnesses/impls/swe-rebench-v2-evaluator/index.js').HfRow>();
  const verifiedDifferentialReceipts = new Map<string, DifferentialAdmissionReceiptV2>();
  const verifiedDifferentialEvidence = new Map<string, DifferentialAdmissionReceiptCandidateV2>();
  const environmentVerifier = input.environmentVerifier ?? createMintedEnvironmentVerifier({
    ipfsGatewayUrl: input.ipfsGatewayUrl,
    jinnDifferentialAttesterPolicy: input.jinnDifferentialAttesterPolicy,
  });

  for (const c of input.candidates) {
    const repo = c.poolTask.repo ?? 'unknown/unknown';
    try {
      assertRequiredJinnDifferentialAdmission(c);
      assertRequiredExplicitEnvironmentDifferentialAdmission(c);
      assertRepoAllowedForMint(repo, denylist);
      // Explicit-environment v2 admission may publish its public receipt while
      // constructing the local row, so it needs a visibility gate here too.
      // Ordinary v1/session candidates perform no outbound I/O during local
      // validation: let them mint regardless of visibility and check only at
      // the final artifact boundary below.
      if (c.publish !== false && c.environment !== undefined) {
        await assertPublicRepoForPublish(repo, input.publicRepoChecker);
      }
      if (isRealJinnDifferentialSource(c)) {
        // The source guard above makes this mandatory before any legacy
        // validation or v1 routing can occur.
        const environment = c.environment;
        if (!environment) throw new Error('policy: real Jinn differential source is missing its required environment');
        const spec = await environmentVerifier.verify({ binding: environment, poolTask: c.poolTask });
        const receipt = verifyDifferentialAdmissionForMint({ candidate: c, spec });
        if (!receipt) throw new Error('policy: real Jinn differential source requires a parsed hardened differential receipt');
        verifiedDifferentialReceipts.set(c.poolTask.instance_id, receipt);
        const evidence = c.differentialAdmission;
        if (!evidence) throw new Error('policy: verified differential receipt is missing its candidate evidence');
        verifiedDifferentialEvidence.set(c.poolTask.instance_id, evidence);
        verifiedV2Rows.set(c.poolTask.instance_id, evaluatorRowForVerifiedV2Candidate({
          poolTask: c.poolTask,
          environment,
          spec,
          empiricalRow: c.row,
          differentialReceipt: receipt,
        }));
      } else if (c.environment) {
        const spec = await environmentVerifier.verify({ binding: c.environment, poolTask: c.poolTask });
        const receipt = verifyDifferentialAdmissionForMint({ candidate: c, spec });
        if (receipt) {
          verifiedDifferentialReceipts.set(c.poolTask.instance_id, receipt);
          const evidence = c.differentialAdmission;
          if (!evidence) throw new Error('policy: verified differential receipt is missing its candidate evidence');
          verifiedDifferentialEvidence.set(c.poolTask.instance_id, evidence);
        }
        verifiedV2Rows.set(c.poolTask.instance_id, evaluatorRowForVerifiedV2Candidate({
          poolTask: c.poolTask,
          environment: c.environment,
          spec,
          empiricalRow: c.row,
          differentialReceipt: receipt ?? undefined,
        }));
      }
      toValidate.push({ ...c.poolTask, patch: c.goldPatch });
    } catch (err) {
      rejected.push({
        instance_id: c.poolTask.instance_id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const admissionFetcher: HfFetcher = {
    fetchTaskRow: async (args) => verifiedV2Rows.get(args.instance_id) ?? input.fetcher.fetchTaskRow(args),
  };

  if (toValidate.length > 0) {
    await validatePoolInstances(toValidate, {
      fetcher: admissionFetcher,
      runner: input.runner,
      store: input.validatedStore,
      semanticsVersion: EVAL_SEMANTICS_VERSION,
      upstreamRepoDir: input.upstreamRepoDir,
    }, {
      poolSource: 'minted',
      force: true,
      allowNonPythonInstanceIds: new Set(input.candidates
        .filter((candidate) => candidate.environment !== undefined)
        .map((candidate) => candidate.poolTask.instance_id)),
    });
  }

  for (const c of input.candidates) {
    if (rejected.some((r) => r.instance_id === c.poolTask.instance_id)) continue;
    const entry = await input.validatedStore.getEntry(c.poolTask.instance_id, EVAL_SEMANTICS_VERSION);
    if (!entry?.scorable) {
      rejected.push({ instance_id: c.poolTask.instance_id, reason: entry?.reason ?? 'admission-failed' });
      continue;
    }
    const row = await admissionFetcher.fetchTaskRow({
      hf_dataset: c.poolTask.hf_dataset,
      hf_split: c.poolTask.hf_split,
      instance_id: c.poolTask.instance_id,
    });
    const baseRow = {
        instance_id: c.poolTask.instance_id,
        repo: c.poolTask.repo ?? row.repo,
        image_name: row.image_name,
        FAIL_TO_PASS: row.FAIL_TO_PASS,
        PASS_TO_PASS: row.PASS_TO_PASS,
        test_patch: row.test_patch,
        install_config: row.install_config,
        problem_statement: c.poolTask.problem_statement,
        base_commit: c.poolTask.base_commit,
    };
    let differentialAdmission: DifferentialAdmissionReceiptReferenceV2 | undefined;
    if (c.environment) {
      const receipt = verifiedDifferentialReceipts.get(c.poolTask.instance_id);
      const evidence = verifiedDifferentialEvidence.get(c.poolTask.instance_id);
      if (!receipt || !evidence) {
        throw new Error('policy: newly minted explicit-environment v2 candidate lost its verified differential receipt evidence');
      }
      let receiptCid: string;
      if (c.publish === false) {
        if (
          !evidence.receiptCid ||
          evidence.receiptCid !== evidence.receiptCid.trim() ||
          !isAcceptedIpfsCid(evidence.receiptCid)
        ) {
          throw new Error('policy: --no-post explicit-environment v2 candidate requires a pre-published differential receipt CID');
        }
        // Local records must not cause any external receipt publication. They
        // point only at a CID that the caller has already independently bound.
        receiptCid = evidence.receiptCid;
      } else {
        // Re-check at the actual outbound boundary. The earlier admission
        // check prevents wasted work; this one prevents repository visibility
        // changing between validation and publication.
        await assertPublicReposImmediatelyBeforeOutbound([c], input.publicRepoChecker);
        receiptCid = await (input.uploadReceipt ?? uploadToIpfs)(input.ipfsRegistryUrl, receipt);
        if (evidence.receiptCid !== undefined && receiptCid !== evidence.receiptCid) {
          throw new Error('policy: published differential receipt CID does not match the configured receipt CID');
        }
      }
      differentialAdmission = {
        admissionPolicyVersion: DifferentialAdmissionPolicyV2.admissionPolicyVersion,
        receiptCid,
        receiptHash: hashDifferentialAdmissionReceiptV2(receipt),
      };
    }
    const mintedRow = c.environment
      ? (() => {
          if (!c.poolTask.base_commit || !c.poolTask.language) {
            throw new Error(`explicit environment candidate ${c.poolTask.instance_id} requires base_commit and language`);
          }
          const rowV2 = {
            ...baseRow,
            base_commit: c.poolTask.base_commit,
            ...(differentialAdmission ? { fix_commit: c.fixCommit } : {}),
            language: c.poolTask.language,
            rowHashVersion: 2 as const,
            environment: c.environment,
            ...(differentialAdmission ? { differentialAdmission } : {}),
            publicRowHash: '' as `sha256:${string}`,
          };
          return { ...rowV2, publicRowHash: computeMintedPoolRowV2Hash(rowV2) };
        })()
      : baseRow;
    const admission = c.environment
      ? {
          ...entry,
          rowHashVersion: 2 as const,
          publicRowHash: (mintedRow as typeof mintedRow & { publicRowHash: `sha256:${string}` }).publicRowHash,
          v2Environment: toV2AdmissionEnvironment(c.environment),
          ...(differentialAdmission ? { v2FixCommit: c.fixCommit } : {}),
          ...(differentialAdmission ? { differentialAdmission } : {}),
        }
      : entry;
    if (c.environment) {
      await input.validatedStore.record(c.poolTask.instance_id, admission, EVAL_SEMANTICS_VERSION);
    }
    const mintedEntry: MintedPoolEntry & { goldPatch: string } = {
      row: mintedRow,
      provenance: c.provenance,
      admission,
      hf_dataset: c.poolTask.hf_dataset,
      hf_split: c.poolTask.hf_split,
      mintedAt: new Date().toISOString(),
      // Explicit per-entry marker (D2 tier-2): flipped to true only by
      // setPublishedArtifact below, and only for publish-path candidates.
      published: false,
      goldPatch: c.goldPatch,
    };
    await input.mintedStore.record(c.poolTask.instance_id, mintedEntry, EVAL_SEMANTICS_VERSION);
    await input.progress?.onAdmissionStored?.({
      instanceId: c.poolTask.instance_id,
      rowHashVersion: c.environment ? 2 : 1,
      ...(differentialAdmission ? { differentialAdmission } : {}),
    });
    admitted.push(c.poolTask.instance_id);
  }

  const artifactCids: Partial<Record<1 | 2, string>> = {};
  const publishCandidates = input.candidates.filter((c) => c.publish !== false && admitted.includes(c.poolTask.instance_id));
  const v1PublishCandidates = publishCandidates.filter((candidate) => candidate.environment === undefined);
  const v2PublishCandidates = publishCandidates.filter((candidate) => candidate.environment !== undefined);
  // includeIds: the candidates being published right now are still marked
  // published:false at export time (the marker flips only after a successful
  // upload via setPublishedArtifact); everything else marked false stays out
  // of the published artifact (D2 tier-2 gate).
  if (v1PublishCandidates.length > 0) {
    const v1PublishIds = v1PublishCandidates.map((c) => c.poolTask.instance_id);
    const entries = await Promise.all(v1PublishIds.map((id) => input.mintedStore.getEntry(id, EVAL_SEMANTICS_VERSION)));
    const generatedAt = entries.map((entry) => entry?.mintedAt).filter((value): value is string => Boolean(value)).sort()[0];
    const artifact = await input.mintedStore.exportArtifact(EVAL_SEMANTICS_VERSION, {
      includeIds: v1PublishIds,
      ...(generatedAt ? { generatedAt } : {}),
    });
    const publish = async () => {
      await assertPublicReposImmediatelyBeforeOutbound(v1PublishCandidates, input.publicRepoChecker);
      const artifactCid = await uploadToIpfs(input.ipfsRegistryUrl, artifact);
      await input.mintedStore.setPublishedArtifact(
        EVAL_SEMANTICS_VERSION,
        artifactCid,
        v1PublishIds,
        { rowHashVersion: 1 },
      );
      await input.progress?.onIpfsPublished?.({
        instanceIds: v1PublishCandidates.map((candidate) => candidate.poolTask.instance_id),
        rowHashVersion: 1,
        artifactCid,
      });
      return artifactCid;
    };
    const artifactCid = input.withPublicationAuthorization
      ? await input.withPublicationAuthorization({ instanceIds: v1PublishIds, rowHashVersion: 1 }, publish)
      : await publish();
    artifactCids[1] = mintedIpfsDatasetCid(artifactCid);
  }
  if (v2PublishCandidates.length > 0) {
    const v2PublishIds = v2PublishCandidates.map((c) => c.poolTask.instance_id);
    const entries = await Promise.all(v2PublishIds.map((id) => input.mintedStore.getEntry(id, EVAL_SEMANTICS_VERSION)));
    const generatedAt = entries.map((entry) => entry?.mintedAt).filter((value): value is string => Boolean(value)).sort()[0];
    const artifact = await input.mintedStore.exportArtifactV2(EVAL_SEMANTICS_VERSION, {
      includeIds: v2PublishIds,
      ...(generatedAt ? { generatedAt } : {}),
    });
    const publish = async () => {
      await assertPublicReposImmediatelyBeforeOutbound(v2PublishCandidates, input.publicRepoChecker);
      const artifactCid = await uploadToIpfs(input.ipfsRegistryUrl, artifact);
      await input.mintedStore.setPublishedArtifact(
        EVAL_SEMANTICS_VERSION,
        artifactCid,
        v2PublishIds,
        { rowHashVersion: 2 },
      );
      await input.progress?.onIpfsPublished?.({
        instanceIds: v2PublishCandidates.map((candidate) => candidate.poolTask.instance_id),
        rowHashVersion: 2,
        artifactCid,
      });
      return artifactCid;
    };
    const artifactCid = input.withPublicationAuthorization
      ? await input.withPublicationAuthorization({ instanceIds: v2PublishIds, rowHashVersion: 2 }, publish)
      : await publish();
    artifactCids[2] = mintedIpfsDatasetCid(artifactCid);
  }

  return {
    admitted,
    rejected,
    artifactCid: artifactCids[2] ?? artifactCids[1],
    ...(Object.keys(artifactCids).length > 0 ? { artifactCids } : {}),
  };
}
