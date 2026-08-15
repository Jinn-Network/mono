#!/usr/bin/env tsx
/**
 * Receipt-bound local Anvil lifecycle evidence for the reviewed Jinn #1422
 * differential admission receipt. The Docker receipt remains the empirical
 * result; this command proves that its bound v2 row completes the real local
 * contract lifecycle.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalJson } from '../src/util/canonical-json.js';
import { cidToDigestHex } from '../src/adapters/mech/ipfs.js';
import {
  hashDifferentialAdmissionReceiptV2,
  verifyDifferentialAdmissionReceiptV2,
} from '../src/solver-types/_swe-rebench-v2-differential-admission.js';
import { parseMintedEnvironmentBindingV1 } from '../src/solver-types/_swe-rebench-v2-minted-pool.js';
import { parseTaskEnvironmentSpecV1 } from '../src/task-creator/environment/contracts.js';
import {
  bindJinnDifferentialReceiptToProof,
  type ReceiptBoundJinnDifferentialProof,
} from '../src/task-creator/proofs/differential-receipt-bound-proof.js';
import { isAcceptedIpfsCid } from '../src/task-creator/proofs/ipfs-cid.js';
import {
  parseJinnDifferentialAttesterPolicyV1,
  type JinnDifferentialAttesterPolicyV1,
} from '../src/task-creator/environment/jinn-differential-policy.js';
import {
  JINN_DIFFERENTIAL_PROOF_SOURCE,
  deriveJinnDifferentialPatches,
  verifyJinnDifferentialReceipt,
  type JinnDifferentialPatches,
} from './task-creator-jinn-differential-proof.js';
import {
  runBoundJinnAnvilContractLifecycle,
  type PublicRepoAnvilEvidence,
} from '../test/task-creator/public-repo-anvil-lifecycle.js';

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;

export type ReceiptBoundJinnAnvilProofCli = {
  environmentSpecPath: string;
  environmentCid: string;
  receiptPath: string;
  receiptCid: string;
  expectedReceiptHash: `sha256:${string}`;
  attesterPolicy: JinnDifferentialAttesterPolicyV1;
  evidenceOutputPath: string;
  repoPath?: string;
};

export type ReceiptBoundJinnAnvilLifecycleEvidence = {
  schemaVersion: 'jinn.receipt-bound-anvil-lifecycle-evidence.v1';
  evidenceKind: 'receipt-bound-local-anvil-lifecycle';
  empiricalResult: {
    kind: 'docker-differential-admission-receipt';
    statement: 'The Docker differential-admission receipt is the empirical result; this Anvil record adds no empirical claim.';
  };
  task: {
    instanceId: string;
    repo: string;
    baseCommit: string;
    fixCommit: string;
    taskId: string;
    taskArtifactCid: string;
  };
  row: PublicRepoAnvilEvidence['row'];
  environment: {
    environmentSpecCid: string;
    environmentHash: `sha256:${string}`;
    image: ReceiptBoundJinnDifferentialProof['environment']['image'];
    parser: ReceiptBoundJinnDifferentialProof['environment']['parser'];
    platform: 'linux/amd64';
    attestation: ReceiptBoundJinnDifferentialProof['environment']['attestation'];
  };
  receipt: {
    receiptCid: string;
    receiptHash: `sha256:${string}`;
    admissionPolicyVersion: string;
    evalSemanticsVersion: string;
    testPaths: Array<{
      testPath: string;
      FAIL_TO_PASS: string[];
      PASS_TO_PASS: string[];
    }>;
  };
  delivery: {
    solution: PublicRepoAnvilEvidence['solutionDelivery'];
    verdict: PublicRepoAnvilEvidence['verdictDelivery'];
  };
  verdict: PublicRepoAnvilEvidence['verdict'];
  corpus: PublicRepoAnvilEvidence['corpusEvidence'];
};

export type ReceiptBoundJinnAnvilProofResult = {
  evidence: ReceiptBoundJinnAnvilLifecycleEvidence;
  evidenceOutputPath: string;
};

export interface ReceiptBoundJinnAnvilProofDependencies {
  readTextFile?: (path: string) => Promise<string>;
  derivePatches?: (repoPath: string) => Promise<JinnDifferentialPatches>;
  verifyReceipt?: typeof verifyJinnDifferentialReceipt;
  bindReceipt?: typeof bindJinnDifferentialReceiptToProof;
  runLifecycle?: (bound: ReceiptBoundJinnDifferentialProof) => Promise<PublicRepoAnvilEvidence>;
  atomicWriteEvidence?: (path: string, contents: string) => Promise<void>;
}

/** Parse every operator-supplied binding before reading artifacts or starting Anvil. */
export function parseReceiptBoundJinnAnvilProofCli(args: string[]): ReceiptBoundJinnAnvilProofCli {
  const parsed = parseArgs({
    args,
    options: {
      'environment-spec': { type: 'string' },
      'environment-cid': { type: 'string' },
      receipt: { type: 'string' },
      'receipt-cid': { type: 'string' },
      'expected-receipt-hash': { type: 'string' },
      'approved-attester': { type: 'string', multiple: true },
      'evidence-output': { type: 'string' },
      'repo-path': { type: 'string' },
    },
    strict: true,
  });
  const environmentSpecPath = requireOption(parsed.values['environment-spec'], '--environment-spec <signed-environment.json>');
  const environmentCid = requireCid(parsed.values['environment-cid'], '--environment-cid');
  const receiptPath = requireOption(parsed.values.receipt, '--receipt <differential-receipt.json>');
  const receiptCid = requireCid(parsed.values['receipt-cid'], '--receipt-cid');
  const expectedReceiptHash = requireSha256(parsed.values['expected-receipt-hash'], '--expected-receipt-hash');
  const evidenceOutputPath = requireOption(parsed.values['evidence-output'], '--evidence-output <evidence.json>');
  const attesterPolicy = parseJinnDifferentialAttesterPolicyV1(parsed.values['approved-attester']);
  return {
    environmentSpecPath,
    environmentCid,
    receiptPath,
    receiptCid,
    expectedReceiptHash,
    attesterPolicy,
    evidenceOutputPath,
    ...(parsed.values['repo-path'] ? { repoPath: parsed.values['repo-path'] } : {}),
  };
}

/**
 * Strictly validates the local signed environment and canonical Docker receipt,
 * binds their receipt-derived F2P/P2P v2 row, then runs the real local-Anvil
 * lifecycle. No compilation, deployment, or Anvil process is reachable until
 * the verifier and binder both succeed.
 */
export async function runReceiptBoundJinnAnvilProof(
  invocation: ReceiptBoundJinnAnvilProofCli,
  dependencies: ReceiptBoundJinnAnvilProofDependencies = {},
): Promise<ReceiptBoundJinnAnvilProofResult> {
  assertInvocationBindings(invocation);
  const readTextFile = dependencies.readTextFile ?? ((path: string) => readFile(path, 'utf8'));
  const environmentContents = await readRequiredText(readTextFile, invocation.environmentSpecPath, 'signed environment');
  const environmentSpec = parseTaskEnvironmentSpecV1(parseLocalJson(environmentContents, 'signed environment'));
  const receiptContents = await readRequiredText(readTextFile, invocation.receiptPath, 'differential receipt');
  const receipt = verifyDifferentialAdmissionReceiptV2(parseLocalJson(receiptContents, 'differential receipt'));
  if (canonicalJson(receipt) !== receiptContents) {
    throw new Error('differential receipt content is not canonical JSON');
  }
  const receiptHash = hashDifferentialAdmissionReceiptV2(receipt);
  if (receiptHash !== invocation.expectedReceiptHash) {
    throw new Error('differential receipt hash does not match the expected receipt hash');
  }
  assertCanonicalArtifactCid('environment', invocation.environmentCid, environmentSpec);
  assertCanonicalArtifactCid('receipt', invocation.receiptCid, receipt);

  const derivePatches = memoizePatches(
    dependencies.derivePatches ?? deriveJinnDifferentialPatches,
    invocation.repoPath ?? resolve(process.cwd(), '..'),
  );
  const verified = await (dependencies.verifyReceipt ?? verifyJinnDifferentialReceipt)({
    source: JINN_DIFFERENTIAL_PROOF_SOURCE,
    attesterPolicy: invocation.attesterPolicy,
    environmentSpec,
    receiptContents,
    expectedReceiptHash: invocation.expectedReceiptHash,
    derivePatches,
  });
  // Defense in depth: the strict verifier reparses/rebinds artifacts before
  // source derivation, so retain CID checks on its exact verified values too.
  assertCanonicalArtifactCid('environment', invocation.environmentCid, verified.environment);
  assertCanonicalArtifactCid('receipt', invocation.receiptCid, verified.receipt);
  const patches = await derivePatches();
  const bound = await (dependencies.bindReceipt ?? bindJinnDifferentialReceiptToProof)({
    source: JINN_DIFFERENTIAL_PROOF_SOURCE,
    receipt: verified.receipt,
    receiptCid: invocation.receiptCid,
    receiptHash: verified.receiptHash,
    environment: parseMintedEnvironmentBindingV1({
      environmentSpecCid: invocation.environmentCid,
      environmentHash: verified.environment.attestation.environmentHash,
      attestation: verified.environment.attestation,
      parser: verified.environment.execution.parser,
      image: verified.environment.execution.image,
      platform: verified.environment.execution.platform,
    }),
    testPatch: patches.testPatch,
  });
  const lifecycle = await (dependencies.runLifecycle ?? runBoundJinnAnvilContractLifecycle)(bound);
  const evidence = receiptBoundLifecycleEvidence(bound, lifecycle);
  const evidenceOutputPath = resolve(invocation.evidenceOutputPath);
  await (dependencies.atomicWriteEvidence ?? atomicWriteReceiptBoundEvidence)(
    evidenceOutputPath,
    canonicalJson(evidence),
  );
  return { evidence, evidenceOutputPath };
}

/** Write canonical evidence by rename so interrupted writes cannot look complete. */
export async function atomicWriteReceiptBoundEvidence(path: string, contents: string): Promise<void> {
  const outputPath = resolve(path);
  const outputDirectory = dirname(outputPath);
  const temporaryPath = join(outputDirectory, `.${basename(outputPath)}.${randomUUID()}.tmp`);
  await mkdir(outputDirectory, { recursive: true });
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function receiptBoundLifecycleEvidence(
  bound: ReceiptBoundJinnDifferentialProof,
  lifecycle: PublicRepoAnvilEvidence,
): ReceiptBoundJinnAnvilLifecycleEvidence {
  return {
    schemaVersion: 'jinn.receipt-bound-anvil-lifecycle-evidence.v1',
    evidenceKind: 'receipt-bound-local-anvil-lifecycle',
    empiricalResult: {
      kind: 'docker-differential-admission-receipt',
      statement: 'The Docker differential-admission receipt is the empirical result; this Anvil record adds no empirical claim.',
    },
    task: {
      instanceId: bound.source.instanceId,
      repo: bound.source.repo,
      baseCommit: bound.source.baseCommit,
      fixCommit: bound.source.fixCommit,
      taskId: lifecycle.taskId,
      taskArtifactCid: lifecycle.taskArtifactCid,
    },
    row: lifecycle.row,
    environment: {
      environmentSpecCid: bound.environment.environmentSpecCid,
      environmentHash: bound.environment.environmentHash,
      image: bound.environment.image,
      parser: bound.environment.parser,
      platform: bound.environment.platform,
      attestation: bound.environment.attestation,
    },
    receipt: {
      receiptCid: bound.receiptCid,
      receiptHash: bound.receiptHash,
      admissionPolicyVersion: bound.receipt.admissionPolicyVersion,
      evalSemanticsVersion: bound.receipt.evalSemanticsVersion,
      testPaths: bound.receipt.testPaths.map((path) => ({
        testPath: path.testPath,
        FAIL_TO_PASS: [...path.FAIL_TO_PASS],
        PASS_TO_PASS: [...path.PASS_TO_PASS],
      })),
    },
    delivery: {
      solution: lifecycle.solutionDelivery,
      verdict: lifecycle.verdictDelivery,
    },
    verdict: lifecycle.verdict,
    corpus: lifecycle.corpusEvidence,
  };
}

function requireOption(value: string | undefined, usage: string): string {
  if (!value) throw new Error(`pass ${usage}`);
  return value;
}

function requireCid(value: string | undefined, option: string): string {
  const cid = requireOption(value, `${option} <IPFS CID>`);
  if (!isAcceptedIpfsCid(cid)) throw new Error(`${option} must be a CIDv0 or lowercase-base32 CIDv1`);
  return cid;
}

function requireSha256(value: string | undefined, option: string): `sha256:${string}` {
  if (!value || !SHA256_DIGEST_RE.test(value)) {
    throw new Error(`pass ${option} sha256:<64-lowercase-hex>`);
  }
  return value as `sha256:${string}`;
}

/**
 * uploadToIpfs publishes JCS canonical JSON; accepted CIDs must therefore
 * carry the sha2-256 digest of these exact validated bytes. This rejects a
 * well-formed CID for another published artifact before it can enter a row.
 */
function assertCanonicalArtifactCid(label: 'environment' | 'receipt', cid: string, artifact: unknown): void {
  const expectedDigest = `0x${createHash('sha256').update(canonicalJson(artifact)).digest('hex')}`;
  let actualDigest: string;
  try {
    actualDigest = cidToDigestHex(cid);
  } catch (error) {
    throw new Error(`${label} CID must encode a sha2-256 canonical artifact digest: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (actualDigest.toLowerCase() !== expectedDigest) {
    throw new Error(`${label} CID does not bind the canonical validated local artifact bytes`);
  }
}

function assertInvocationBindings(invocation: ReceiptBoundJinnAnvilProofCli): void {
  requireOption(invocation.environmentSpecPath, '--environment-spec <signed-environment.json>');
  requireCid(invocation.environmentCid, '--environment CID');
  requireOption(invocation.receiptPath, '--receipt <differential-receipt.json>');
  requireCid(invocation.receiptCid, '--receipt CID');
  requireSha256(invocation.expectedReceiptHash, '--expected-receipt-hash');
  requireOption(invocation.evidenceOutputPath, '--evidence-output <evidence.json>');
  if (!invocation.attesterPolicy.approvedAttesters.length) {
    throw new Error('pass --approved-attester <operatorSafe:signer>; the Jinn differential proof has no implicit attester trust');
  }
}

async function readRequiredText(
  readTextFile: (path: string) => Promise<string>,
  path: string,
  label: string,
): Promise<string> {
  try {
    return await readTextFile(path);
  } catch (error) {
    throw new Error(`could not read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseLocalJson(contents: string, label: string): unknown {
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function memoizePatches(
  derive: (repoPath: string) => Promise<JinnDifferentialPatches>,
  repoPath: string,
): () => Promise<JinnDifferentialPatches> {
  let result: Promise<JinnDifferentialPatches> | undefined;
  return () => {
    result ??= derive(repoPath);
    return result;
  };
}

async function main(): Promise<void> {
  const result = await runReceiptBoundJinnAnvilProof(
    parseReceiptBoundJinnAnvilProofCli(process.argv.slice(2)),
  );
  console.log(JSON.stringify({
    evidenceKind: result.evidence.evidenceKind,
    evidenceOutputPath: result.evidenceOutputPath,
    receiptCid: result.evidence.receipt.receiptCid,
    receiptHash: result.evidence.receipt.receiptHash,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`[task-creator-jinn-differential-anvil-proof] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
