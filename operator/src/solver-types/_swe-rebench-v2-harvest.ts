/**
 * Commit-echo harvest orchestration — source-instance mapping, empirical tests,
 * mint pipeline feed. Spec §5.2.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../util/canonical-json.js';
import type { PoolTask } from './_swe-rebench-v2-pool.js';
import type { CommitEchoCandidate } from './_swe-rebench-v2-commit-echo.js';
import {
  parseMintedEnvironmentBindingV1,
  type MintedEnvironmentBindingV1,
  type MintedProvenance,
} from './_swe-rebench-v2-minted-pool.js';
import type { MineableTraceRecord } from './_swe-rebench-v2-mineable-store-port.js';
import { lineageHash } from './_swe-rebench-v2-hunk-echo.js';
import type { EvalRunner, HfFetcher, HfRow } from '../harnesses/impls/swe-rebench-v2-evaluator/index.js';
import {
  deriveF2pP2pFromReports,
  runEmpiricalTestDerivation,
  runTargetedEmpiricalTestDerivation,
  type EmpiricalTestDerivationResult,
} from './_swe-rebench-v2-empirical-tests.js';
import {
  runMintTasksPipeline,
  type DifferentialAdmissionReceiptCandidateV2,
  type MintTasksInput,
} from './_swe-rebench-v2-mint-cli.js';
import {
  EVAL_SEMANTICS_VERSION,
  ValidatedPoolStore,
} from './_swe-rebench-v2-validated-pool.js';
import {
  MintedPoolStore,
  type SweRebenchV2MintedPoolArtifact,
} from './_swe-rebench-v2-minted-pool.js';
import { RoutingTaskRowFetcher } from '../harnesses/impls/swe-rebench-v2-evaluator/routing-task-row-fetcher.js';
import type { PublicRepoChecker } from './_swe-rebench-v2-guards.js';
import type { MintedEnvironmentVerifier } from './_swe-rebench-v2-minted-environment-verifier.js';
import {
  EnvironmentBuildRecipeV1Schema,
  type EnvironmentBuildRecipeV1,
  type CommandSpec,
  type TaskEnvironmentSpecV1,
} from '../task-creator/environment/contracts.js';
import {
  createDifferentialAdmissionReceiptV2,
  hashDifferentialAdmissionReceiptV2,
  targetRecipeCommandForTestPath,
  verifyDifferentialAdmissionReceiptV2,
} from './_swe-rebench-v2-differential-admission.js';
import {
  AWAITING_RECIPE_BINDING_MISMATCH,
  AWAITING_RECIPE_REQUIRED,
  AWAITING_TARGETED_TEST_COMMAND_REQUIRED,
  AWAITING_TEST_PATCH_REQUIRED,
  type BoundEmpiricalEvidenceBindingV1,
  type BoundEmpiricalEvidenceV1,
  type DifferentialAdmissionEvidenceV2,
} from './_swe-rebench-v2-harvest-state.js';

export const MINTED_DATASET_PLACEHOLDER = 'ipfs://local-minted-pending' as const;

export function commitEchoLineageHash(repo: string, fixCommit: string): string {
  const digest = createHash('sha256').update(`${repo}:${fixCommit}`).digest('hex');
  return `sha256:${digest}`;
}

export function findSourceInstanceForRepo(
  pool: PoolTask[],
  scorableIds: Set<string>,
  repo: string,
): PoolTask | null {
  const normalized = repo.toLowerCase();
  for (const task of pool) {
    if ((task.repo ?? '').toLowerCase() !== normalized) continue;
    if (!scorableIds.has(task.instance_id)) continue;
    return task;
  }
  return null;
}

export interface BuiltMintCandidate {
  poolTask: PoolTask;
  goldPatch: string;
  provenance: MintedProvenance;
  row: HfRow;
  /** Selects the v2 minted-pool artifact contract when present. */
  environment?: MintedEnvironmentBindingV1;
  /** Public fix identity paired with hardened differential evidence. */
  fixCommit?: string;
  /** Repeated path-scoped causal evidence required by a hardened v2 admission. */
  differentialAdmission?: DifferentialAdmissionReceiptCandidateV2;
}

/** An operator-approved recipe and its already-published evaluator binding. */
export interface ExplicitRecipeBootstrap {
  recipe: EnvironmentBuildRecipeV1;
  environment: MintedEnvironmentBindingV1;
}

/** Runtime parse for an operator-provided config entry. */
export function parseExplicitRecipeBootstrap(raw: unknown): ExplicitRecipeBootstrap {
  if (!raw || typeof raw !== 'object') throw new Error('explicitRecipe must be an object');
  const value = raw as { recipe?: unknown; environment?: unknown };
  return {
    recipe: EnvironmentBuildRecipeV1Schema.parse(value.recipe),
    environment: parseMintedEnvironmentBindingV1(value.environment),
  };
}

export interface EmpiricalEvidenceStore {
  getEmpiricalEvidence(binding: BoundEmpiricalEvidenceBindingV1): Promise<BoundEmpiricalEvidenceV1 | null>;
  recordEmpiricalEvidence(evidence: BoundEmpiricalEvidenceV1): Promise<void>;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function quoteShell(value: string): string {
  return /^[a-zA-Z0-9_./:=@+-]+$/u.test(value) ? value : `'${value.replace(/'/g, "'\"'\"'")}'`;
}

/** Serialise a trusted structured recipe command only at the evaluator edge. */
export function commandSpecToEvaluatorCommand(command: CommandSpec): string {
  const env = Object.entries(command.environment ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${quoteShell(value)}`);
  const invocation = [command.bin, ...command.args].map(quoteShell).join(' ');
  return [
    ...(command.cwd ? [`cd ${quoteShell(command.cwd)} &&`] : []),
    ...env,
    invocation,
  ].join(' ');
}

export function explicitRecipeBootstrapError(candidate: CommitEchoCandidate, bootstrap: ExplicitRecipeBootstrap): string | null {
  if (bootstrap.recipe.source.repo.toLowerCase() !== candidate.repo.toLowerCase()) {
    return `${AWAITING_RECIPE_BINDING_MISMATCH}: recipe source repo does not match candidate`;
  }
  if (bootstrap.recipe.source.baseCommit !== candidate.base_commit) {
    return `${AWAITING_RECIPE_BINDING_MISMATCH}: recipe source base commit does not match candidate`;
  }
  const { parser } = bootstrap.environment;
  if (
    parser.id !== bootstrap.recipe.parser.id ||
    parser.version !== bootstrap.recipe.parser.version ||
    parser.digest !== bootstrap.recipe.parser.digest ||
    parser.bundleId !== bootstrap.recipe.parser.bundleId
  ) {
    return 'policy: published environment parser does not match trusted recipe';
  }
  return null;
}

function evidenceBinding(candidate: CommitEchoCandidate, environment: MintedEnvironmentBindingV1): BoundEmpiricalEvidenceBindingV1 {
  return {
    schemaVersion: 'swe-rebench-v2-empirical-evidence.v1',
    task: {
      instanceId: candidate.instance_id,
      repo: candidate.repo,
      baseCommit: candidate.base_commit,
      fixCommit: candidate.fix_commit,
    },
    image: environment.image,
    environmentHash: environment.environmentHash,
    parser: environment.parser as BoundEmpiricalEvidenceBindingV1['parser'],
    testPatchHash: sha256(candidate.test_patch),
    evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
  };
}

function deriveCachedEvidence(evidence: BoundEmpiricalEvidenceV1): EmpiricalTestDerivationResult {
  const allTests = [...new Set([
    ...evidence.before.passed,
    ...evidence.before.failed,
    ...evidence.after.passed,
    ...evidence.after.failed,
  ])];
  return {
    ...deriveF2pP2pFromReports(evidence.before, evidence.after, allTests),
    before: evidence.before,
    after: evidence.after,
  };
}

async function deriveEmpiricalWithOptionalEvidence(args: {
  candidate: CommitEchoCandidate;
  image: string;
  install?: string | string[];
  testCmd: string | string[];
  logParser: string;
  runner: EvalRunner;
  environment?: MintedEnvironmentBindingV1;
  store?: EmpiricalEvidenceStore;
}): Promise<EmpiricalTestDerivationResult> {
  const binding = args.environment ? evidenceBinding(args.candidate, args.environment) : undefined;
  if (binding && args.store) {
    const cached = await args.store.getEmpiricalEvidence(binding);
    if (cached) return deriveCachedEvidence(cached);
  }
  const empirical = await runEmpiricalTestDerivation({
    instance_id: args.candidate.instance_id,
    repo: args.candidate.repo,
    image: args.image,
    test_patch: args.candidate.test_patch,
    install: args.install ? (Array.isArray(args.install) ? args.install : [args.install]) : undefined,
    test_cmd: args.testCmd,
    log_parser: args.logParser,
    gold_patch: args.candidate.gold_patch,
    broken_patch: '',
  }, args.runner);
  if (binding && args.store && empirical.before && empirical.after) {
    await args.store.recordEmpiricalEvidence({
      schemaVersion: 'swe-rebench-v2-empirical-evidence.v1',
      binding,
      before: empirical.before,
      after: empirical.after,
      recordedAt: new Date().toISOString(),
    });
  }
  return empirical;
}

/**
 * Harvest targets commands from the approved recipe, then mint admission
 * independently fetches and verifies the signed environment spec before it
 * accepts the resulting receipt. This narrow adapter exposes only the fields
 * the receipt constructor needs; it is not a substitute for that later
 * signature/context verification.
 */
function environmentForDifferentialTargeting(bootstrap: ExplicitRecipeBootstrap): TaskEnvironmentSpecV1 {
  return {
    source: bootstrap.recipe.source,
    execution: {
      platform: bootstrap.environment.platform,
      workspace: bootstrap.recipe.workspace,
      image: bootstrap.environment.image,
      testCommands: bootstrap.recipe.testCommands,
      parser: bootstrap.environment.parser,
      timeoutSeconds: bootstrap.recipe.timeoutSeconds,
      environment: bootstrap.recipe.environment,
    },
    attestation: bootstrap.environment.attestation,
  } as TaskEnvironmentSpecV1;
}

async function deriveDifferentialAdmission(args: {
  candidate: CommitEchoCandidate;
  bootstrap: ExplicitRecipeBootstrap;
  runner: EvalRunner;
  cachedEvidence?: DifferentialAdmissionEvidenceV2;
}): Promise<
  | { empirical: EmpiricalTestDerivationResult; differentialAdmission: DifferentialAdmissionReceiptCandidateV2 }
  | { reason: string }
> {
  const environment = environmentForDifferentialTargeting(args.bootstrap);
  const cached = reuseDifferentialAdmissionReceipt({
    candidate: args.candidate,
    environment,
    cachedEvidence: args.cachedEvidence,
  });
  if (cached) return cached;
  let targetedCommands: Array<{ testPath: string; command: CommandSpec }>;
  try {
    targetedCommands = args.candidate.test_paths.map((testPath) => ({
      testPath,
      command: targetRecipeCommandForTestPath(environment, testPath),
    }));
  } catch (err) {
    return {
      reason: `${AWAITING_TARGETED_TEST_COMMAND_REQUIRED}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const observations = await Promise.all(targetedCommands.map(async ({ testPath, command }) =>
    runTargetedEmpiricalTestDerivation({
      instance_id: args.candidate.instance_id,
      repo: args.candidate.repo,
      image: args.bootstrap.environment.image.reference,
      test_patch: args.candidate.test_patch,
      install: args.bootstrap.recipe.installCommands.map(commandSpecToEvaluatorCommand),
      test_cmd: commandSpecToEvaluatorCommand(command),
      log_parser: args.bootstrap.environment.parser.id,
      gold_patch: args.candidate.gold_patch,
      broken_patch: '',
      normalizedTestPath: testPath,
    }, args.runner),
  ));

  try {
    const receipt = createDifferentialAdmissionReceiptV2({
      task: {
        instanceId: args.candidate.instance_id,
        repo: args.candidate.repo,
        baseCommit: args.candidate.base_commit,
        fixCommit: args.candidate.fix_commit,
      },
      goldPatchHash: sha256(args.candidate.gold_patch),
      testPatchHash: sha256(args.candidate.test_patch),
      environment,
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      testPaths: observations,
    });
    const FAIL_TO_PASS = receipt.testPaths.flatMap((path) => path.FAIL_TO_PASS);
    const PASS_TO_PASS = receipt.testPaths.flatMap((path) => path.PASS_TO_PASS);
    return {
      empirical: { FAIL_TO_PASS, PASS_TO_PASS, dead: FAIL_TO_PASS.length === 0 },
      differentialAdmission: {
        receipt,
        receiptHash: hashDifferentialAdmissionReceiptV2(receipt),
      },
    };
  } catch (err) {
    return {
      reason: `flaky/non-reproducible: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** A cached V2 receipt is reusable only after every public binding re-derives. */
function reuseDifferentialAdmissionReceipt(args: {
  candidate: CommitEchoCandidate;
  environment: TaskEnvironmentSpecV1;
  cachedEvidence?: DifferentialAdmissionEvidenceV2;
}): { empirical: EmpiricalTestDerivationResult; differentialAdmission: DifferentialAdmissionReceiptCandidateV2 } | null {
  const cached = args.cachedEvidence;
  if (!cached?.receipt || cached.admissionPolicyVersion !== 'swe-rebench-v2-differential-admission.v2') return null;
  try {
    const receipt = verifyDifferentialAdmissionReceiptV2(cached.receipt);
    if (hashDifferentialAdmissionReceiptV2(receipt) !== cached.receiptHash) return null;
    if (
      receipt.task.instanceId !== args.candidate.instance_id ||
      receipt.task.repo !== args.candidate.repo ||
      receipt.task.baseCommit !== args.candidate.base_commit ||
      receipt.task.fixCommit !== args.candidate.fix_commit ||
      receipt.goldPatchHash !== sha256(args.candidate.gold_patch) ||
      receipt.testPatchHash !== sha256(args.candidate.test_patch) ||
      receipt.evalSemanticsVersion !== EVAL_SEMANTICS_VERSION ||
      receipt.environment.environmentHash !== args.environment.attestation.environmentHash ||
      receipt.environment.image.reference !== args.environment.execution.image.reference ||
      receipt.environment.image.digest !== args.environment.execution.image.digest ||
      receipt.environment.platform !== args.environment.execution.platform ||
      receipt.environment.parser.id !== args.environment.execution.parser.id ||
      receipt.environment.parser.version !== args.environment.execution.parser.version ||
      receipt.environment.parser.digest !== args.environment.execution.parser.digest ||
      receipt.environment.parser.bundleId !== args.environment.execution.parser.bundleId ||
      receipt.testPaths.length !== args.candidate.test_paths.length
    ) return null;
    for (const [index, path] of receipt.testPaths.entries()) {
      if (path.testPath !== args.candidate.test_paths[index]) return null;
      if (hashCanonicalCommand(targetRecipeCommandForTestPath(args.environment, path.testPath)) !== path.commandHash) return null;
    }
    const FAIL_TO_PASS = receipt.testPaths.flatMap((path) => path.FAIL_TO_PASS);
    const PASS_TO_PASS = receipt.testPaths.flatMap((path) => path.PASS_TO_PASS);
    return {
      empirical: { FAIL_TO_PASS, PASS_TO_PASS, dead: FAIL_TO_PASS.length === 0 },
      differentialAdmission: { receipt, receiptHash: cached.receiptHash },
    };
  } catch {
    return null;
  }
}

function hashCanonicalCommand(command: CommandSpec): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(command)).digest('hex')}`;
}

export async function buildCommitEchoMintCandidate(args: {
  candidate: CommitEchoCandidate;
  /** Legacy Rebench source backing; omitted for explicit trusted recipes. */
  source?: PoolTask;
  explicitRecipe?: ExplicitRecipeBootstrap;
  fetcher: HfFetcher;
  runner: EvalRunner;
  minterSafe?: string;
  empiricalEvidenceStore?: EmpiricalEvidenceStore;
  /** A persisted hardened receipt may resume; legacy V1 observations cannot. */
  differentialAdmissionEvidence?: DifferentialAdmissionEvidenceV2;
}): Promise<{ built: BuiltMintCandidate | null; reason?: string; empirical?: EmpiricalTestDerivationResult }> {
  if (!args.candidate.test_patch || args.candidate.test_paths.length === 0) {
    return { built: null, reason: `${AWAITING_TEST_PATCH_REQUIRED}: commit carries no regression test patch` };
  }

  if (args.explicitRecipe) {
    const invalid = explicitRecipeBootstrapError(args.candidate, args.explicitRecipe);
    if (invalid) return { built: null, reason: invalid };
    const install = args.explicitRecipe.recipe.installCommands.map(commandSpecToEvaluatorCommand);
    const testCmd = args.explicitRecipe.recipe.testCommands.map(commandSpecToEvaluatorCommand);
    const differential = await deriveDifferentialAdmission({
      candidate: args.candidate,
      runner: args.runner,
      bootstrap: args.explicitRecipe,
      cachedEvidence: args.differentialAdmissionEvidence,
    });
    if ('reason' in differential) return { built: null, reason: differential.reason };
    const { empirical, differentialAdmission } = differential;
    if (empirical.dead) {
      return { built: null, reason: 'empirical-dead: no FAIL_TO_PASS tests', empirical };
    }
    const row: HfRow = {
      instance_id: args.candidate.instance_id,
      repo: args.candidate.repo,
      image_name: args.explicitRecipe.environment.image.reference,
      FAIL_TO_PASS: empirical.FAIL_TO_PASS,
      PASS_TO_PASS: empirical.PASS_TO_PASS,
      test_patch: args.candidate.test_patch,
      install_config: { install, test_cmd: testCmd, log_parser: args.explicitRecipe.environment.parser.id },
    };
    const poolTask: PoolTask = {
      instance_id: args.candidate.instance_id,
      hf_dataset: MINTED_DATASET_PLACEHOLDER,
      hf_split: 'minted',
      repo: args.candidate.repo,
      base_commit: args.candidate.base_commit,
      patch: args.candidate.gold_patch,
      test_patch: args.candidate.test_patch,
      language: args.candidate.language,
      problem_statement: args.candidate.problem_statement,
    };
    return {
      built: {
        poolTask,
        goldPatch: args.candidate.gold_patch,
        provenance: {
          synthetic: true,
          mintFamily: 'commit-echo',
          sourceLineageHash: commitEchoLineageHash(args.candidate.repo, args.candidate.fix_commit),
          ...(args.minterSafe ? { minterSafe: args.minterSafe } : {}),
        },
        row,
        environment: args.explicitRecipe.environment,
        fixCommit: args.candidate.fix_commit,
        differentialAdmission,
      },
      empirical,
    };
  }

  if (!args.source) {
    return { built: null, reason: `${AWAITING_RECIPE_REQUIRED}: no trusted recipe or admitted source instance for repo ${args.candidate.repo}` };
  }
  const sourceRow = await args.fetcher.fetchTaskRow({
    hf_dataset: args.source.hf_dataset,
    hf_split: args.source.hf_split,
    instance_id: args.source.instance_id,
  });

  const empirical = await deriveEmpiricalWithOptionalEvidence({
    candidate: args.candidate,
    image: sourceRow.image_name,
    install: sourceRow.install_config.install,
    testCmd: sourceRow.install_config.test_cmd,
    logParser: sourceRow.install_config.log_parser,
    runner: args.runner,
  });
  if (empirical.dead) {
    return { built: null, reason: 'empirical-dead: no FAIL_TO_PASS tests', empirical };
  }

  const row: HfRow = {
    instance_id: args.candidate.instance_id,
    repo: args.candidate.repo,
    image_name: sourceRow.image_name,
    FAIL_TO_PASS: empirical.FAIL_TO_PASS,
    PASS_TO_PASS: empirical.PASS_TO_PASS,
    test_patch: args.candidate.test_patch,
    install_config: sourceRow.install_config,
  };

  const poolTask: PoolTask = {
    instance_id: args.candidate.instance_id,
    hf_dataset: MINTED_DATASET_PLACEHOLDER,
    hf_split: 'minted',
    repo: args.candidate.repo,
    base_commit: args.candidate.base_commit,
    patch: args.candidate.gold_patch,
    test_patch: args.candidate.test_patch,
    language: args.candidate.language === 'unknown' ? (args.source.language ?? 'python') : args.candidate.language,
    problem_statement: args.candidate.problem_statement,
  };

  const provenance: MintedProvenance = {
    synthetic: true,
    mintFamily: 'commit-echo',
    sourceLineageHash: commitEchoLineageHash(args.candidate.repo, args.candidate.fix_commit),
    sourceInstanceId: args.source.instance_id,
    ...(args.minterSafe ? { minterSafe: args.minterSafe } : {}),
  };

  return {
    built: {
      poolTask,
      goldPatch: args.candidate.gold_patch,
      provenance,
      row,
    },
    empirical,
  };
}

/**
 * Session-echo instance id — blinded (spec §7): derived only from the repo
 * slug and the FULL {@link lineageHash} of the session's opaque local
 * `sourceId`, never the `sourceId` itself. `<repo-slug>__session-<hash12>`.
 */
export function sessionEchoInstanceId(repo: string, sourceId: string): string {
  const slug = repo.replace(/\//g, '__');
  return `${slug}__session-${lineageHash(sourceId, 'full').slice(0, 12)}`;
}

/**
 * Session-echo mint candidate — sibling of {@link buildCommitEchoMintCandidate}.
 * v0 session-echo mints the record's whole `acceptedDiff` as gold at the
 * record's true `repo @ baseCommit` (one candidate per record; hunk-subset
 * echo is deferred — `base ⊕ S ⊖ H` isn't representable as a swe-rebench row).
 * `source` borrows eval infra (image, install config, test framework) from an
 * already-admitted instance in the same repo — it plays no role in naming or
 * provenance, so nothing about the session's origin leaks through it.
 */
export async function buildSessionEchoMintCandidate(args: {
  record: MineableTraceRecord;
  source: PoolTask;
  fetcher: HfFetcher;
  runner: EvalRunner;
  minterSafe?: string;
  /** Recording operator's Safe — stamped as `sourceSolverSafe` so
   *  `syntheticClaimBlocked` refuses that operator's own claim (§7). */
  operatorSafe?: string;
}): Promise<{ built: BuiltMintCandidate | null; reason?: string; empirical?: EmpiricalTestDerivationResult }> {
  const sourceRow = await args.fetcher.fetchTaskRow({
    hf_dataset: args.source.hf_dataset,
    hf_split: args.source.hf_split,
    instance_id: args.source.instance_id,
  });

  const instanceId = sessionEchoInstanceId(args.record.repo, args.record.sourceId);
  const sourceLineageHash = lineageHash(args.record.sourceId, 'full');

  const empirical = await runEmpiricalTestDerivation(
    {
      instance_id: instanceId,
      repo: args.record.repo,
      image: sourceRow.image_name,
      test_patch: sourceRow.test_patch,
      install: sourceRow.install_config?.install
        ? (Array.isArray(sourceRow.install_config.install)
          ? sourceRow.install_config.install
          : [sourceRow.install_config.install])
        : undefined,
      test_cmd: sourceRow.install_config?.test_cmd ?? 'pytest',
      log_parser: sourceRow.install_config?.log_parser ?? 'parse_log_pytest',
      gold_patch: args.record.acceptedDiff,
      broken_patch: '',
    },
    args.runner,
  );
  if (empirical.dead) {
    return { built: null, reason: 'empirical-dead: no FAIL_TO_PASS tests', empirical };
  }

  const row: HfRow = {
    instance_id: instanceId,
    repo: args.record.repo,
    image_name: sourceRow.image_name,
    FAIL_TO_PASS: empirical.FAIL_TO_PASS,
    PASS_TO_PASS: empirical.PASS_TO_PASS,
    test_patch: sourceRow.test_patch,
    install_config: sourceRow.install_config,
  };

  const poolTask: PoolTask = {
    instance_id: instanceId,
    hf_dataset: MINTED_DATASET_PLACEHOLDER,
    hf_split: 'minted',
    repo: args.record.repo,
    base_commit: args.record.baseCommit,
    patch: args.record.acceptedDiff,
    test_patch: row.test_patch,
    language: args.source.language ?? 'python',
    problem_statement: `Session-echo mint from a captured task-creator session (${instanceId}).`,
  };

  const provenance: MintedProvenance = {
    synthetic: true,
    mintFamily: 'session-echo',
    sourceLineageHash,
    ...(args.minterSafe ? { minterSafe: args.minterSafe } : {}),
    ...(args.operatorSafe ? { sourceSolverSafe: args.operatorSafe } : {}),
  };

  return {
    built: {
      poolTask,
      goldPatch: args.record.acceptedDiff,
      provenance,
      row,
    },
    empirical,
  };
}

export function inMemoryMintedArtifactFetcher(
  rows: Map<string, HfRow>,
): (cid: string) => Promise<SweRebenchV2MintedPoolArtifact> {
  return async () => ({
    schemaVersion: 'swe-rebench-v2-minted-pool.v1',
    evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
    generatedAt: new Date().toISOString(),
    rows: [...rows.values()].map((r) => ({
      instance_id: r.instance_id,
      repo: r.repo,
      image_name: r.image_name,
      FAIL_TO_PASS: r.FAIL_TO_PASS,
      PASS_TO_PASS: r.PASS_TO_PASS,
      test_patch: r.test_patch,
      install_config: r.install_config,
    })),
  });
}

export interface HarvestMintDeps {
  stateDir: string;
  ipfsRegistryUrl: string;
  ipfsGatewayUrl: string;
  validatedStore: ValidatedPoolStore;
  mintedStore: MintedPoolStore;
  hfFetcher: HfFetcher;
  runner: EvalRunner;
  upstreamRepoDir: string;
  publicRepoChecker: PublicRepoChecker;
  /** Optional test/operator seam for v2 signed environment-spec admission. */
  environmentVerifier?: MintedEnvironmentVerifier;
  minterSafe?: string;
  publish?: boolean;
  progress?: MintTasksInput['progress'];
  withPublicationAuthorization?: MintTasksInput['withPublicationAuthorization'];
}

export async function admitBuiltMintCandidates(
  built: BuiltMintCandidate[],
  deps: HarvestMintDeps,
): Promise<Awaited<ReturnType<typeof runMintTasksPipeline>>> {
  for (const candidate of built) {
    if (candidate.environment && !candidate.differentialAdmission) {
      throw new Error(`policy: hardened explicit-recipe candidate ${candidate.poolTask.instance_id} lacks differential admission evidence`);
    }
  }
  const rowMap = new Map(built.map((b) => [b.poolTask.instance_id, b.row]));
  const routingFetcher = new RoutingTaskRowFetcher({
    hf: deps.hfFetcher,
    fetchMintedArtifact: inMemoryMintedArtifactFetcher(rowMap),
  });

  const input: MintTasksInput = {
    candidates: built.map((b) => ({
      poolTask: b.poolTask,
      goldPatch: b.goldPatch,
      provenance: b.provenance,
      row: b.row,
      ...(b.environment ? { environment: b.environment } : {}),
      ...(b.fixCommit ? { fixCommit: b.fixCommit } : {}),
      ...(b.differentialAdmission ? { differentialAdmission: b.differentialAdmission } : {}),
      publish: deps.publish,
    })),
    stateDir: deps.stateDir,
    ipfsRegistryUrl: deps.ipfsRegistryUrl,
    ipfsGatewayUrl: deps.ipfsGatewayUrl,
    validatedStore: deps.validatedStore,
    mintedStore: deps.mintedStore,
    fetcher: routingFetcher,
    runner: deps.runner,
    upstreamRepoDir: deps.upstreamRepoDir,
    publicRepoChecker: deps.publicRepoChecker,
    environmentVerifier: deps.environmentVerifier,
    progress: deps.progress,
    withPublicationAuthorization: deps.withPublicationAuthorization,
  };
  return runMintTasksPipeline(input);
}

export function escrowInputsFromPatch(
  goldPatch: string,
  failToPass: string[],
): { loc: number; files: number; tests: number } {
  const fileSet = new Set<string>();
  let loc = 0;
  for (const line of goldPatch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\//.exec(line);
      if (m?.[1]) fileSet.add(m[1]);
    }
    if (line.startsWith('+') && !line.startsWith('+++')) loc += 1;
    if (line.startsWith('-') && !line.startsWith('---')) loc += 1;
  }
  return { loc: Math.max(loc, 1), files: Math.max(fileSet.size, 1), tests: Math.max(failToPass.length, 1) };
}

export const DEFAULT_SYNTHETIC_ESCROW_PARAMS = {
  alpha: 0.5,
  beta: 0.3,
  gamma: 0.2,
  loc_normalizer: 100,
  files_normalizer: 5,
  tests_normalizer: 10,
} as const;
