#!/usr/bin/env tsx
/**
 * Source-derived, repeated differential evidence for Jinn #1422.
 *
 * Generate mode preflights the exact digest-qualified published image with the
 * operator's ambient Docker authentication, then validates its local binding.
 * The eight empirical invocations intentionally run only that local,
 * digest-bound image with `--pull=never`.
 * It writes a sanitised receipt after all eight Docker invocations validate;
 * publishing that exact canonical content to IPFS is opt-in.
 *
 * A signed environment specification is mandatory.
 */

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalJson } from '../src/util/canonical-json.js';
import type { EvalRunner } from '../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';
import {
  runTargetedEmpiricalTestDerivation,
  type TargetedEmpiricalTestDerivationResult,
} from '../src/solver-types/_swe-rebench-v2-empirical-tests.js';
import {
  extractCommitEchoPatchesAtBase,
} from '../src/solver-types/_swe-rebench-v2-commit-echo-git.js';
import { commandSpecToEvaluatorCommand } from '../src/solver-types/_swe-rebench-v2-harvest.js';
import {
  createDifferentialAdmissionReceiptV2,
  hashDifferentialAdmissionReceiptV2,
  targetRecipeCommandForTestPath,
  verifyDifferentialAdmissionReceiptV2,
  type DifferentialAdmissionReceiptV2,
} from '../src/solver-types/_swe-rebench-v2-differential-admission.js';
import { EVAL_SEMANTICS_VERSION } from '../src/solver-types/_swe-rebench-v2-validated-pool.js';
import {
  parseTaskEnvironmentSpecV1,
  verifyEnvironmentAttestationV1,
  type TaskEnvironmentSpecV1,
} from '../src/task-creator/environment/contracts.js';
import {
  assertJinnDifferentialEnvironmentPolicyV1,
  parseJinnDifferentialAttesterPolicyV1,
  type JinnDifferentialAttesterPolicyV1,
} from '../src/task-creator/environment/jinn-differential-policy.js';
import { TRUSTED_VITEST_JSON_PARSER_V1 } from '../src/task-creator/environment/recipes.js';
import { parseVitestJsonV1 } from '../src/task-creator/proofs/vitest-json-fixture.js';
import {
  JINN_MONO_DIFFERENTIAL_PROOF_SOURCE,
} from '../src/task-creator/proofs/public-repo-fixtures.js';
import { uploadToIpfs } from '../src/adapters/mech/ipfs.js';

const STALE_DOCS_ONLY_MERGE_COMMIT = '5b76bade319857bd09a72c3c4aaf0949cfe078ee';
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;

export const JINN_DIFFERENTIAL_PROOF_SOURCE = JINN_MONO_DIFFERENTIAL_PROOF_SOURCE;
export type JinnDifferentialProofSource = {
  repo: string;
  baseCommit: string;
  fixCommit: string;
  instanceId: string;
  testPaths: readonly string[];
};

export type JinnDifferentialPatches = {
  goldPatch: string;
  testPatch: string;
  testPaths: readonly string[];
  language: string;
};

export interface CreateJinnDifferentialReceiptInput {
  source: JinnDifferentialProofSource;
  /** Explicit governance policy; an authentic self-signed environment is insufficient. */
  attesterPolicy: JinnDifferentialAttesterPolicyV1;
  derivePatches: () => Promise<JinnDifferentialPatches>;
  /** Raw serialised environment artifact; it is strictly parsed and signature-verified before any run. */
  environmentSpec: unknown;
  runner: EvalRunner;
}

export interface WriteJinnDifferentialReceiptInput extends CreateJinnDifferentialReceiptInput {
  outputPath: string;
  /** Explicit opt-in publication endpoint. Omit for local-only proof generation. */
  ipfsRegistryUrl?: string;
  atomicWrite?: (path: string, contents: string) => Promise<void>;
  uploadCanonicalReceipt?: (registryUrl: string, contents: string, receipt: DifferentialAdmissionReceiptV2) => Promise<string>;
}

export type WrittenJinnDifferentialReceipt = {
  receipt: DifferentialAdmissionReceiptV2;
  receiptHash: `sha256:${string}`;
  canonicalContents: string;
  outputPath: string;
  receiptCid?: string;
};

export interface VerifyJinnDifferentialReceiptInput {
  source: JinnDifferentialProofSource;
  /** Explicit governance policy; an authentic self-signed environment is insufficient. */
  attesterPolicy: JinnDifferentialAttesterPolicyV1;
  /** Raw serialised environment artifact; signature and source bindings are rechecked. */
  environmentSpec: unknown;
  /** Exact receipt bytes; verification requires canonical JSON, not merely equivalent JSON. */
  receiptContents: string;
  /** The independently declared canonical receipt hash that must bind these exact bytes. */
  expectedReceiptHash: `sha256:${string}`;
  /** Re-derives public test and private gold hashes from the reviewed source without running Docker. */
  derivePatches: () => Promise<JinnDifferentialPatches>;
}

export type VerifiedJinnDifferentialReceipt = {
  receipt: DifferentialAdmissionReceiptV2;
  receiptHash: `sha256:${string}`;
  environment: TaskEnvironmentSpecV1;
};

export type JinnDifferentialProofCli =
  | {
    mode: 'verify';
    receiptPath: string;
    environmentSpecPath: string;
    expectedReceiptHash: `sha256:${string}`;
    attesterPolicy: JinnDifferentialAttesterPolicyV1;
    repoPath?: string;
  }
  | {
    mode: 'generate';
    outputPath: string;
    environmentSpecPath: string;
    attesterPolicy: JinnDifferentialAttesterPolicyV1;
    repoPath?: string;
    ipfsRegistryUrl?: string;
  };

/** Parse the production CLI before any environment, Docker, or publication work starts. */
export function parseJinnDifferentialProofCli(args: string[]): JinnDifferentialProofCli {
  const parsed = parseArgs({
    args,
    options: {
      output: { type: 'string' },
      verify: { type: 'string' },
      'repo-path': { type: 'string' },
      'environment-spec': { type: 'string' },
      'expected-receipt-hash': { type: 'string' },
      'ipfs-registry': { type: 'string' },
      'approved-attester': { type: 'string', multiple: true },
    },
    strict: true,
  });
  const environmentSpecPath = parsed.values['environment-spec'];
  if (!environmentSpecPath) throw new Error('pass --environment-spec <signed-environment.json>');
  const attesterPolicy = parseJinnDifferentialAttesterPolicyV1(parsed.values['approved-attester']);

  const verifyPath = parsed.values.verify;
  if (verifyPath) {
    if (parsed.values.output) throw new Error('--verify must not be combined with --output');
    if (parsed.values['ipfs-registry']) throw new Error('--verify must not be combined with --ipfs-registry');
    const expectedReceiptHash = parsed.values['expected-receipt-hash'];
    if (!expectedReceiptHash || !SHA256_DIGEST_RE.test(expectedReceiptHash)) {
      throw new Error('pass --expected-receipt-hash sha256:<64-lowercase-hex> with --verify');
    }
    return {
      mode: 'verify',
      receiptPath: verifyPath,
      environmentSpecPath,
      expectedReceiptHash: expectedReceiptHash as `sha256:${string}`,
      attesterPolicy,
      ...(parsed.values['repo-path'] ? { repoPath: parsed.values['repo-path'] } : {}),
    };
  }

  if (parsed.values['expected-receipt-hash']) {
    throw new Error('--expected-receipt-hash is valid only with --verify');
  }
  const outputPath = parsed.values.output;
  if (!outputPath) throw new Error('pass --output <receipt.json> or --verify <receipt.json>');
  return {
    mode: 'generate',
    outputPath,
    environmentSpecPath,
    attesterPolicy,
    ...(parsed.values['repo-path'] ? { repoPath: parsed.values['repo-path'] } : {}),
    ...(parsed.values['ipfs-registry'] ? { ipfsRegistryUrl: parsed.values['ipfs-registry'] } : {}),
  };
}

/** Reject historical merge metadata and any drift from the reviewed #1422 source. */
export function assertJinnDifferentialSource(source: JinnDifferentialProofSource): void {
  if (source.fixCommit === STALE_DOCS_ONLY_MERGE_COMMIT) {
    throw new Error(`Jinn differential proof rejects stale docs-only merge ${STALE_DOCS_ONLY_MERGE_COMMIT}; use ${JINN_DIFFERENTIAL_PROOF_SOURCE.fixCommit}`);
  }
  if (
    source.repo !== JINN_DIFFERENTIAL_PROOF_SOURCE.repo ||
    source.baseCommit !== JINN_DIFFERENTIAL_PROOF_SOURCE.baseCommit ||
    source.fixCommit !== JINN_DIFFERENTIAL_PROOF_SOURCE.fixCommit ||
    source.instanceId !== JINN_DIFFERENTIAL_PROOF_SOURCE.instanceId
  ) {
    throw new Error('Jinn differential proof source must use the reviewed #1422 repository, parent, fix, and instance id');
  }
  if (
    source.testPaths.length !== JINN_DIFFERENTIAL_PROOF_SOURCE.testPaths.length ||
    source.testPaths.some((path, index) => path !== JINN_DIFFERENTIAL_PROOF_SOURCE.testPaths[index])
  ) {
    throw new Error('Jinn differential proof requires both reviewed target paths in their canonical order');
  }
}

/** Extract the reviewed source diff from the fix's exact parent, never a GitHub merge result. */
export async function deriveJinnDifferentialPatches(repoPath: string): Promise<JinnDifferentialPatches> {
  const source = JINN_DIFFERENTIAL_PROOF_SOURCE;
  assertJinnDifferentialSource(source);
  return extractCommitEchoPatchesAtBase(repoPath, {
    baseCommit: source.baseCommit,
    fixCommit: source.fixCommit,
  });
}

/**
 * Consume the published evaluator-environment artifact, not a local stand-in.
 * The receipt must bind the same signed image, parser, commands, and hash that
 * mint admission and evaluation later re-derive.
 */
export async function parseJinnDifferentialEnvironment(
  input: unknown,
  attesterPolicy: JinnDifferentialAttesterPolicyV1,
): Promise<TaskEnvironmentSpecV1> {
  const environment = parseTaskEnvironmentSpecV1(input);
  if (!await verifyEnvironmentAttestationV1(environment.attestation)) {
    throw new Error('Jinn differential proof environment attestation signature is invalid');
  }
  if (
    environment.source.repo !== JINN_DIFFERENTIAL_PROOF_SOURCE.repo ||
    environment.source.repoUrl !== 'https://github.com/Jinn-Network/mono.git' ||
    environment.source.baseCommit !== JINN_DIFFERENTIAL_PROOF_SOURCE.baseCommit
  ) {
    throw new Error('Jinn differential proof environment source does not bind the reviewed repository and base commit');
  }
  const parser = environment.execution.parser;
  if (
    parser.id !== TRUSTED_VITEST_JSON_PARSER_V1.id ||
    parser.version !== TRUSTED_VITEST_JSON_PARSER_V1.version ||
    parser.digest !== TRUSTED_VITEST_JSON_PARSER_V1.digest ||
    parser.bundleId !== TRUSTED_VITEST_JSON_PARSER_V1.bundleId
  ) {
    throw new Error('Jinn differential proof environment does not bind the trusted Vitest JSON parser');
  }
  assertJinnDifferentialEnvironmentPolicyV1(environment, attesterPolicy);
  return environment;
}

function assertJinnDifferentialPatches(
  source: JinnDifferentialProofSource,
  patches: JinnDifferentialPatches,
): void {
  if (patches.goldPatch.trim() === '' || patches.testPatch.trim() === '') {
    throw new Error('Jinn differential proof requires non-empty code and test patches derived from the reviewed fix');
  }
  if (
    patches.testPaths.length !== source.testPaths.length ||
    patches.testPaths.some((path, index) => path !== source.testPaths[index])
  ) {
    throw new Error('Jinn differential proof source test paths do not match both reviewed target paths');
  }
  for (const testPath of source.testPaths) {
    const diffHeader = `diff --git a/${testPath} b/${testPath}`;
    if (patches.goldPatch.includes(diffHeader) || !patches.testPatch.includes(diffHeader)) {
      throw new Error(`Jinn differential proof did not split regression path ${testPath} into the public test patch`);
    }
  }
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertReceiptEnvironmentBinding(
  receipt: DifferentialAdmissionReceiptV2,
  environment: TaskEnvironmentSpecV1,
): void {
  if (
    receipt.environment.environmentHash !== environment.attestation.environmentHash ||
    !sameCanonical(receipt.environment.image, environment.execution.image) ||
    !sameCanonical(receipt.environment.parser, environment.execution.parser) ||
    receipt.environment.platform !== environment.execution.platform
  ) {
    throw new Error('Jinn differential proof receipt environment binding drifted from the signed environment');
  }
}

function assertReceiptTaskAndCommands(
  source: JinnDifferentialProofSource,
  receipt: DifferentialAdmissionReceiptV2,
  environment: TaskEnvironmentSpecV1,
): void {
  if (!sameCanonical(receipt.task, {
    instanceId: source.instanceId,
    repo: source.repo,
    baseCommit: source.baseCommit,
    fixCommit: source.fixCommit,
  })) {
    throw new Error('Jinn differential proof receipt task identity drifted from the reviewed source');
  }
  if (!sameCanonical(receipt.testPaths.map((path) => path.testPath), source.testPaths)) {
    throw new Error('Jinn differential proof receipt target paths drifted from the reviewed source');
  }
  for (const pathReceipt of receipt.testPaths) {
    const expectedCommandHash = sha256(canonicalJson(targetRecipeCommandForTestPath(environment, pathReceipt.testPath)));
    if (pathReceipt.commandHash !== expectedCommandHash) {
      throw new Error(`Jinn differential proof receipt command binding drifted for ${pathReceipt.testPath}`);
    }
  }
}

/**
 * Revalidate a stored receipt without Docker, registry access, or IPFS writes.
 * It checks the exact canonical receipt bytes, source-derived patches, signed
 * environment, evaluator semantics, and every per-path command binding.
 */
export async function verifyJinnDifferentialReceipt(
  input: VerifyJinnDifferentialReceiptInput,
): Promise<VerifiedJinnDifferentialReceipt> {
  assertJinnDifferentialSource(input.source);
  const environment = await parseJinnDifferentialEnvironment(input.environmentSpec, input.attesterPolicy);

  let rawReceipt: unknown;
  try {
    rawReceipt = JSON.parse(input.receiptContents);
  } catch (error) {
    throw new Error(`Jinn differential proof receipt is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const receipt = verifyDifferentialAdmissionReceiptV2(rawReceipt);
  if (canonicalJson(receipt) !== input.receiptContents) {
    throw new Error('Jinn differential proof receipt content is not canonical JSON');
  }
  const receiptHash = hashDifferentialAdmissionReceiptV2(receipt);
  if (receiptHash !== input.expectedReceiptHash) {
    throw new Error('Jinn differential proof receipt hash does not match the expected receipt hash');
  }

  const patches = await input.derivePatches();
  assertJinnDifferentialPatches(input.source, patches);
  if (receipt.goldPatchHash !== sha256(patches.goldPatch)) {
    throw new Error('Jinn differential proof receipt gold-patch hash drifted from the reviewed fix');
  }
  if (receipt.testPatchHash !== sha256(patches.testPatch)) {
    throw new Error('Jinn differential proof receipt test-patch hash drifted from the reviewed fix');
  }
  if (receipt.evalSemanticsVersion !== EVAL_SEMANTICS_VERSION) {
    throw new Error('Jinn differential proof receipt evaluator semantics version drifted');
  }
  assertReceiptEnvironmentBinding(receipt, environment);
  assertReceiptTaskAndCommands(input.source, receipt, environment);

  return {
    receipt,
    receiptHash,
    environment,
  };
}

/**
 * Execute two broken and two fixed targeted runs for each reviewed test path,
 * then let the receipt contract reject missing, unstable, duplicated, or
 * non-discriminating observations before any artifact write occurs.
 */
export async function createJinnDifferentialReceipt(
  input: CreateJinnDifferentialReceiptInput,
): Promise<DifferentialAdmissionReceiptV2> {
  assertJinnDifferentialSource(input.source);
  const environment = await parseJinnDifferentialEnvironment(input.environmentSpec, input.attesterPolicy);
  const patches = await input.derivePatches();
  assertJinnDifferentialPatches(input.source, patches);

  const observations: TargetedEmpiricalTestDerivationResult[] = [];
  for (const testPath of input.source.testPaths) {
    const command = targetRecipeCommandForTestPath(environment, testPath);
    observations.push(await runTargetedEmpiricalTestDerivation({
      instance_id: input.source.instanceId,
      repo: input.source.repo,
      image: environment.execution.image.reference,
      test_patch: patches.testPatch,
      test_cmd: commandSpecToEvaluatorCommand(command),
      log_parser: environment.execution.parser.id,
      gold_patch: patches.goldPatch,
      broken_patch: '',
      normalizedTestPath: testPath,
    }, input.runner));
  }

  return createDifferentialAdmissionReceiptV2({
    task: {
      instanceId: input.source.instanceId,
      repo: input.source.repo,
      baseCommit: input.source.baseCommit,
      fixCommit: input.source.fixCommit,
    },
    goldPatchHash: sha256(patches.goldPatch),
    testPatchHash: sha256(patches.testPatch),
    environment,
    evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
    testPaths: observations,
  });
}

/** Atomically write only canonical, independently revalidated public receipt bytes. */
export async function writeJinnDifferentialReceipt(
  input: WriteJinnDifferentialReceiptInput,
): Promise<WrittenJinnDifferentialReceipt> {
  const receipt = verifyDifferentialAdmissionReceiptV2(await createJinnDifferentialReceipt(input));
  const receiptHash = hashDifferentialAdmissionReceiptV2(receipt);
  const canonicalContents = canonicalJson(receipt);
  const write = input.atomicWrite ?? atomicWriteCanonicalReceipt;
  await write(input.outputPath, canonicalContents);

  let receiptCid: string | undefined;
  if (input.ipfsRegistryUrl !== undefined) {
    const upload = input.uploadCanonicalReceipt ?? uploadCanonicalReceipt;
    receiptCid = await upload(input.ipfsRegistryUrl, canonicalContents, receipt);
    if (!receiptCid.trim()) throw new Error('Jinn differential proof IPFS publication returned no receipt CID');
  }
  return { receipt, receiptHash, canonicalContents, outputPath: input.outputPath, ...(receiptCid ? { receiptCid } : {}) };
}

async function atomicWriteCanonicalReceipt(outputPath: string, contents: string): Promise<void> {
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  const written = await readFile(target, 'utf8');
  if (written !== contents) throw new Error('Jinn differential proof atomic receipt write did not preserve canonical contents');
  verifyDifferentialAdmissionReceiptV2(JSON.parse(written));
}

/** Existing IPFS adapter serialises JCS bytes; assert that they are the exact validated contents first. */
async function uploadCanonicalReceipt(
  registryUrl: string,
  contents: string,
  receipt: DifferentialAdmissionReceiptV2,
): Promise<string> {
  if (canonicalJson(verifyDifferentialAdmissionReceiptV2(receipt)) !== contents) {
    throw new Error('Jinn differential proof refused to publish bytes that differ from the validated receipt');
  }
  return uploadToIpfs(registryUrl, receipt);
}

export type DockerResult = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };
export type DockerCommand = (args: string[], options: { timeoutMs: number }) => Promise<DockerResult>;

export type PreparedPublishedJinnDifferentialImage = {
  /** Exact digest-qualified reference from the signed evaluator environment. */
  reference: string;
  /** Docker's immutable local config ID, verified after the digest pull. */
  localImageId: `sha256:${string}`;
};

const PUBLISHED_IMAGE_PREPARE_TIMEOUT_MS = 5 * 60_000;

/**
 * Make the signed evaluator image available before the local runner begins.
 *
 * This deliberately runs in the operator's ambient Docker configuration so
 * its existing registry credential helper can authenticate the explicit pull.
 * It is outside the isolated environment builder; the runner below continues
 * to use `--pull=never`, so none of the eight observations can substitute a
 * different registry image after this digest/platform binding is inspected.
 */
export async function ensurePublishedJinnDifferentialImage(
  environment: TaskEnvironmentSpecV1,
  runDocker: DockerCommand = docker,
): Promise<PreparedPublishedJinnDifferentialImage> {
  const image = environment.execution.image;
  const pulled = await runDocker([
    'pull', '--platform', 'linux/amd64', image.reference,
  ], { timeoutMs: PUBLISHED_IMAGE_PREPARE_TIMEOUT_MS });
  if (pulled.timedOut) {
    throw new Error(`Jinn differential proof timed out pulling published image after ${PUBLISHED_IMAGE_PREPARE_TIMEOUT_MS}ms`);
  }
  if (pulled.exitCode !== 0) {
    throw new Error(`Jinn differential proof could not pull published signed image ${image.reference}: ${pulled.stderr || pulled.stdout}`);
  }

  const inspected = await runDocker([
    'image', 'inspect', image.reference, '--format', '{{json .}}',
  ], { timeoutMs: PUBLISHED_IMAGE_PREPARE_TIMEOUT_MS });
  if (inspected.timedOut) {
    throw new Error(`Jinn differential proof timed out inspecting published image after ${PUBLISHED_IMAGE_PREPARE_TIMEOUT_MS}ms`);
  }
  if (inspected.exitCode !== 0) {
    throw new Error(`Jinn differential proof could not inspect published signed image ${image.reference}: ${inspected.stderr || inspected.stdout}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(inspected.stdout);
  } catch {
    throw new Error('Jinn differential proof published image inspect was not valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Jinn differential proof published image inspect must be an object');
  }
  const imageInspect = value as Record<string, unknown>;
  if (imageInspect.Os !== 'linux' || imageInspect.Architecture !== 'amd64') {
    throw new Error('Jinn differential proof published image inspect did not confirm linux/amd64');
  }
  if (typeof imageInspect.Id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(imageInspect.Id)) {
    throw new Error('Jinn differential proof published image inspect did not return an immutable image ID');
  }
  if (!Array.isArray(imageInspect.RepoDigests) || !imageInspect.RepoDigests.every((digest) => typeof digest === 'string')) {
    throw new Error('Jinn differential proof published image inspect did not return immutable repository digests');
  }
  if (!imageInspect.RepoDigests.includes(image.reference)) {
    throw new Error('Jinn differential proof published image immutable digest binding does not match the signed environment');
  }
  return { reference: image.reference, localImageId: imageInspect.Id as `sha256:${string}` };
}

/** Minimal bounded Docker adapter for the trusted Vitest JSON report contract. */
export class LocalJinnVitestRunner implements EvalRunner {
  private readonly timeoutMs: number;

  constructor(
    private readonly image: string,
    timeoutSeconds: number,
    private readonly runDocker: DockerCommand = docker,
  ) {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new Error('Jinn differential proof requires a positive integer environment timeout');
    }
    this.timeoutMs = timeoutSeconds * 1_000;
  }

  async runEval(args: Parameters<EvalRunner['runEval']>[0]): ReturnType<EvalRunner['runEval']> {
    if (args.image !== this.image) throw new Error('Jinn differential proof runner image binding drift');
    if (typeof args.test_cmd !== 'string' || args.test_cmd.trim() === '') {
      throw new Error('Jinn differential proof requires exactly one concrete targeted test command');
    }
    const temp = await mkdtemp(join(tmpdir(), 'jinn-differential-proof-'));
    let container: string | undefined;
    try {
      const testPatchPath = join(temp, 'test.patch');
      const candidatePatchPath = join(temp, 'candidate.patch');
      const reportPath = join(temp, 'vitest-results.json');
      await writeFile(testPatchPath, args.test_patch, { encoding: 'utf8', mode: 0o600 });
      await writeFile(candidatePatchPath, args.patch, { encoding: 'utf8', mode: 0o600 });

      const patchCommands = [
        'git apply --whitespace=nowarn /tmp/task-creator-test.patch',
        ...(args.patch.trim() ? ['git apply --whitespace=nowarn /tmp/task-creator-candidate.patch'] : []),
      ];
      const created = await this.runDocker([
        // A proof runs only the digest-qualified image already made available
        // by the published environment workflow. It does not read or use
        // Docker credential configuration to pull a substitute image.
        'create', '--pull=never', '--platform', 'linux/amd64', '--entrypoint', 'sh', this.image, '-lc',
        ['set -eu', 'cd /testbed', ...patchCommands, args.test_cmd].join('; '),
      ], { timeoutMs: this.timeoutMs });
      if (created.timedOut) throw new Error(`Jinn differential proof Docker create timed out after ${this.timeoutMs}ms`);
      if (created.exitCode !== 0 || !/^[0-9a-f]{12,}$/i.test(created.stdout.trim())) {
        throw new Error(`Jinn differential proof could not create evaluator container: ${created.stderr || created.stdout}`);
      }
      container = created.stdout.trim();
      await this.requireDockerSuccess(['cp', testPatchPath, `${container}:/tmp/task-creator-test.patch`], 'copying test patch');
      await this.requireDockerSuccess(['cp', candidatePatchPath, `${container}:/tmp/task-creator-candidate.patch`], 'copying candidate patch');
      const started = await this.runDocker(['start', '-a', container], { timeoutMs: this.timeoutMs });
      if (started.timedOut) throw new Error(`Jinn differential proof Docker test run timed out after ${this.timeoutMs}ms`);
      const copied = await this.runDocker(['cp', `${container}:/tmp/vitest-results.json`, reportPath], { timeoutMs: this.timeoutMs });
      if (copied.timedOut) throw new Error(`Jinn differential proof Docker report copy timed out after ${this.timeoutMs}ms`);
      if (copied.exitCode !== 0) {
        throw new Error(`Jinn differential proof run produced no Vitest JSON report (exit ${started.exitCode}): ${(started.stderr || started.stdout).slice(-1000)}`);
      }
      const parsed = parseVitestJsonV1(await readFile(reportPath, 'utf8'));
      return {
        passed_match: false,
        passed: parsed.passed,
        failed: parsed.failed,
        log: (started.stdout + started.stderr).slice(-16_000),
        exitCode: started.exitCode,
      };
    } finally {
      if (container) {
        try {
          await this.runDocker(['rm', '-f', container], { timeoutMs: this.timeoutMs });
        } catch {
          // A cleanup failure cannot leave the original error hidden; Docker's
          // forced remove was still attempted under the environment timeout.
        }
      }
      await rm(temp, { recursive: true, force: true });
    }
  }

  private async requireDockerSuccess(args: string[], action: string): Promise<void> {
    const result = await this.runDocker(args, { timeoutMs: this.timeoutMs });
    if (result.timedOut) throw new Error(`Jinn differential proof ${action} timed out after ${this.timeoutMs}ms`);
    if (result.exitCode !== 0) throw new Error(`Jinn differential proof failed ${action}: ${result.stderr || result.stdout}`);
  }
}

function docker(args: string[], options: { timeoutMs: number }): Promise<DockerResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      forceKillTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 5_000);
      forceKillTimer.unref?.();
    }, options.timeoutMs);
    timeout.unref?.();
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolveResult({ exitCode: code ?? 1, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) });
    });
  });
}

async function main(): Promise<void> {
  const invocation = parseJinnDifferentialProofCli(process.argv.slice(2));
  const repoPath = invocation.repoPath ?? resolve(process.cwd(), '..');
  const source = JINN_DIFFERENTIAL_PROOF_SOURCE;
  let rawEnvironment: unknown;
  try {
    rawEnvironment = JSON.parse(await readFile(invocation.environmentSpecPath, 'utf8'));
  } catch (error) {
    throw new Error(`could not read serialised environment spec ${invocation.environmentSpecPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (invocation.mode === 'verify') {
    let receiptContents: string;
    try {
      receiptContents = await readFile(invocation.receiptPath, 'utf8');
    } catch (error) {
      throw new Error(`could not read differential receipt ${invocation.receiptPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const verified = await verifyJinnDifferentialReceipt({
      source,
      attesterPolicy: invocation.attesterPolicy,
      environmentSpec: rawEnvironment,
      receiptContents,
      expectedReceiptHash: invocation.expectedReceiptHash,
      derivePatches: () => deriveJinnDifferentialPatches(repoPath),
    });
    console.log(JSON.stringify({
      verified: true,
      receiptHash: verified.receiptHash,
      receiptPath: resolve(invocation.receiptPath),
    }, null, 2));
    return;
  }

  const environment = await parseJinnDifferentialEnvironment(rawEnvironment, invocation.attesterPolicy);
  await ensurePublishedJinnDifferentialImage(environment);
  const runner = new LocalJinnVitestRunner(
    environment.execution.image.reference,
    environment.execution.timeoutSeconds,
  );
  const result = await writeJinnDifferentialReceipt({
    outputPath: invocation.outputPath,
    source,
    attesterPolicy: invocation.attesterPolicy,
    derivePatches: () => deriveJinnDifferentialPatches(repoPath),
    environmentSpec: environment,
    runner,
    ...(invocation.ipfsRegistryUrl ? { ipfsRegistryUrl: invocation.ipfsRegistryUrl } : {}),
  });
  console.log(JSON.stringify({
    receiptHash: result.receiptHash,
    outputPath: resolve(result.outputPath),
    ...(result.receiptCid ? { receiptCid: result.receiptCid } : {}),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`[task-creator-jinn-differential-proof] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
