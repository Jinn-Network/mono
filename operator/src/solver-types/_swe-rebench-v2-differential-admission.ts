/**
 * Canonical repeated differential evidence for hardened public-repository
 * admission. This is evidence collection policy, not a grading semantic.
 */

import { createHash } from 'node:crypto';
import { posix as path } from 'node:path';
import { z } from 'zod/v3';
import { canonicalJson } from '../util/canonical-json.js';
import {
  DigestQualifiedImageV1Schema,
  TrustedParserIdentityV1Schema,
  type CommandSpec,
  type TaskEnvironmentSpecV1,
} from '../task-creator/environment/contracts.js';

const SHA256_RE = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const SHA256_SCHEMA = z.string().regex(SHA256_RE);
const NON_EMPTY = z.string().min(1);

/** The public, versioned policy for repeated causal admission evidence. */
export const DifferentialAdmissionPolicyV2 = {
  admissionPolicyVersion: 'swe-rebench-v2-differential-admission.v2',
  observationsPerSide: 2,
  requireFailToPassPerPath: true,
  requireGloballyUniqueRawAssertionIds: true,
} as const;
export type DifferentialAdmissionPolicyV2 = typeof DifferentialAdmissionPolicyV2;

export const TrustedParserObservationV1Schema = z.object({
  passed: z.array(NON_EMPTY),
  failed: z.array(NON_EMPTY),
  passed_match: z.boolean(),
}).strict().superRefine((observation, ctx) => {
  const identifiers = new Set<string>();
  for (const identifier of [...observation.passed, ...observation.failed]) {
    if (identifiers.has(identifier)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `parser observation repeats raw assertion identifier ${identifier}`,
      });
    }
    identifiers.add(identifier);
  }
});
export type TrustedParserObservationV1 = z.infer<typeof TrustedParserObservationV1Schema>;

const DifferentialPathReceiptV2Schema = z.object({
  testPath: NON_EMPTY,
  commandHash: SHA256_SCHEMA,
  broken: z.array(TrustedParserObservationV1Schema).length(DifferentialAdmissionPolicyV2.observationsPerSide),
  fixed: z.array(TrustedParserObservationV1Schema).length(DifferentialAdmissionPolicyV2.observationsPerSide),
  FAIL_TO_PASS: z.array(NON_EMPTY),
  PASS_TO_PASS: z.array(NON_EMPTY),
}).strict();
export type DifferentialAdmissionPathReceiptV2 = z.infer<typeof DifferentialPathReceiptV2Schema>;

const DifferentialAdmissionReceiptV2Schema = z.object({
  schemaVersion: z.literal('swe-rebench-v2-differential-admission-receipt.v2'),
  admissionPolicyVersion: z.literal(DifferentialAdmissionPolicyV2.admissionPolicyVersion),
  task: z.object({
    instanceId: NON_EMPTY,
    repo: NON_EMPTY,
    baseCommit: z.string().regex(COMMIT_RE),
    fixCommit: z.string().regex(COMMIT_RE),
  }).strict(),
  goldPatchHash: SHA256_SCHEMA,
  testPatchHash: SHA256_SCHEMA,
  testPaths: z.array(DifferentialPathReceiptV2Schema).min(1),
  environment: z.object({
    environmentHash: SHA256_SCHEMA,
    image: DigestQualifiedImageV1Schema,
    parser: TrustedParserIdentityV1Schema,
    platform: z.literal('linux/amd64'),
  }).strict(),
  evalSemanticsVersion: NON_EMPTY,
}).strict();
export type DifferentialAdmissionReceiptV2 = z.infer<typeof DifferentialAdmissionReceiptV2Schema>;

export interface DifferentialAdmissionPathObservationsV2 {
  testPath: string;
  broken: readonly TrustedParserObservationV1[];
  fixed: readonly TrustedParserObservationV1[];
}

export interface CreateDifferentialAdmissionReceiptV2Input {
  task: {
    instanceId: string;
    repo: string;
    baseCommit: string;
    fixCommit: string;
  };
  /** Deliberately a digest only: gold-patch contents are never public receipt data. */
  goldPatchHash: `sha256:${string}`;
  testPatchHash: `sha256:${string}`;
  environment: TaskEnvironmentSpecV1;
  evalSemanticsVersion: string;
  testPaths: readonly DifferentialAdmissionPathObservationsV2[];
}

function canonicalSha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function fail(message: string): never {
  throw new Error(`differential admission: ${message}`);
}

function validateRelativeSegments(rawPath: string, label: string): string[] {
  if (!rawPath) fail(`${label} must not be empty`);
  if (path.isAbsolute(rawPath)) fail(`${label} must be repository-relative, not absolute`);
  const rawSegments = rawPath.split('/');
  if (rawSegments.some((segment) => segment === '..')) fail(`${label} must not contain traversal`);
  if (rawSegments.some((segment) => segment.startsWith('-'))) fail(`${label} must not contain option-shaped segments`);
  const normalized = path.normalize(rawPath);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    fail(`${label} escapes the repository workspace`);
  }
  return normalized.split('/').filter((segment) => segment !== '.' && segment !== '');
}

function commandCwdSegments(environment: TaskEnvironmentSpecV1, command: CommandSpec): string[] {
  if (!command.cwd) return [];
  const workspace = environment.execution.workspace;
  if (!path.isAbsolute(workspace) || workspace.split('/').includes('..')) {
    fail('environment workspace is unsafe');
  }
  if (path.isAbsolute(command.cwd)) {
    const normalizedWorkspace = path.normalize(workspace);
    const normalizedCwd = path.normalize(command.cwd);
    if (normalizedCwd === normalizedWorkspace) return [];
    if (!normalizedCwd.startsWith(`${normalizedWorkspace}/`)) {
      fail('test command cwd escapes the repository workspace');
    }
    return validateRelativeSegments(normalizedCwd.slice(normalizedWorkspace.length + 1), 'test command cwd');
  }
  return validateRelativeSegments(command.cwd, 'test command cwd');
}

function isPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  return prefix.every((segment, index) => value[index] === segment);
}

/**
 * Select the only admissible command template and add exactly one path scoped
 * to that command's working directory. The returned command remains
 * structured until the evaluator edge serialises it.
 */
export function targetRecipeCommandForTestPath(
  environment: TaskEnvironmentSpecV1,
  repositoryRelativeTestPath: string,
): CommandSpec {
  const templates = environment.execution.testCommands;
  if (templates.length !== 1) {
    fail('exactly one targetable test command template is required');
  }
  const template = templates[0];
  if (!template) fail('missing targetable test command template');

  const pathSegments = validateRelativeSegments(repositoryRelativeTestPath, 'test path');
  const cwdSegments = commandCwdSegments(environment, template);
  if (!isPrefix(cwdSegments, pathSegments)) {
    fail('test path is outside the test command workspace');
  }
  const targetSegments = pathSegments.slice(cwdSegments.length);
  if (targetSegments.length === 0) fail('test path must name a file below the test command workspace');

  return {
    ...template,
    args: [...template.args, targetSegments.join('/')],
    ...(template.environment ? { environment: { ...template.environment } } : {}),
  };
}

function stableObservation(
  observations: readonly TrustedParserObservationV1[],
  side: 'broken' | 'fixed',
  testPath: string,
): TrustedParserObservationV1 {
  if (observations.length !== DifferentialAdmissionPolicyV2.observationsPerSide) {
    fail(`${side} observations for ${testPath} must have exactly ${DifferentialAdmissionPolicyV2.observationsPerSide} runs`);
  }
  const parsed = observations.map((observation) => TrustedParserObservationV1Schema.parse(observation));
  const [first] = parsed;
  if (!first) fail(`${side} observations for ${testPath} are missing`);
  if (parsed.some((observation) => canonicalJson(observation) !== canonicalJson(first))) {
    fail(`${side} observations for ${testPath} are not stable`);
  }
  return first;
}

function deriveStableSets(
  before: TrustedParserObservationV1,
  after: TrustedParserObservationV1,
): Pick<DifferentialAdmissionPathReceiptV2, 'FAIL_TO_PASS' | 'PASS_TO_PASS'> {
  const beforePassed = new Set(before.passed);
  const afterPassed = new Set(after.passed);
  const allTests = [...new Set([...before.passed, ...before.failed, ...after.passed, ...after.failed])];
  return {
    FAIL_TO_PASS: allTests.filter((identifier) => !beforePassed.has(identifier) && afterPassed.has(identifier)),
    PASS_TO_PASS: allTests.filter((identifier) => beforePassed.has(identifier) && afterPassed.has(identifier)),
  };
}

function validateReceiptPolicy(receipt: DifferentialAdmissionReceiptV2): void {
  const seenPaths = new Set<string>();
  const rawIdOwners = new Map<string, string>();
  for (const testPath of receipt.testPaths) {
    const normalized = validateRelativeSegments(testPath.testPath, 'receipt test path').join('/');
    if (normalized !== testPath.testPath) fail(`receipt test path ${testPath.testPath} is not normalized`);
    if (seenPaths.has(testPath.testPath)) fail(`receipt repeats test path ${testPath.testPath}`);
    seenPaths.add(testPath.testPath);

    const broken = stableObservation(testPath.broken, 'broken', testPath.testPath);
    const fixed = stableObservation(testPath.fixed, 'fixed', testPath.testPath);
    const derived = deriveStableSets(broken, fixed);
    if (canonicalJson(derived.FAIL_TO_PASS) !== canonicalJson(testPath.FAIL_TO_PASS) ||
        canonicalJson(derived.PASS_TO_PASS) !== canonicalJson(testPath.PASS_TO_PASS)) {
      fail(`stable F2P/P2P sets for ${testPath.testPath} do not match its observations`);
    }
    if (testPath.FAIL_TO_PASS.length === 0) {
      fail(`test path ${testPath.testPath} has no fail-to-pass assertion`);
    }

    for (const identifier of new Set([...broken.passed, ...broken.failed, ...fixed.passed, ...fixed.failed])) {
      const owner = rawIdOwners.get(identifier);
      if (owner && owner !== testPath.testPath) {
        fail(`duplicate raw assertion identifier ${identifier} in ${owner} and ${testPath.testPath}`);
      }
      rawIdOwners.set(identifier, testPath.testPath);
    }
  }
}

/** Parse, re-derive, and validate a public receipt before it can be reused. */
export function verifyDifferentialAdmissionReceiptV2(raw: unknown): DifferentialAdmissionReceiptV2 {
  const receipt = DifferentialAdmissionReceiptV2Schema.parse(raw);
  validateReceiptPolicy(receipt);
  return receipt;
}

/** Canonical content hash used by IPFS/vetted-pool bindings; it is not self-referential receipt data. */
export function hashDifferentialAdmissionReceiptV2(receipt: DifferentialAdmissionReceiptV2): `sha256:${string}` {
  return canonicalSha256(verifyDifferentialAdmissionReceiptV2(receipt));
}

/** Build one sanitised public receipt from trusted, per-path repeated observations. */
export function createDifferentialAdmissionReceiptV2(
  input: CreateDifferentialAdmissionReceiptV2Input,
): DifferentialAdmissionReceiptV2 {
  if (input.task.repo !== input.environment.source.repo || input.task.baseCommit !== input.environment.source.baseCommit) {
    fail('task identity does not match the evaluator environment source');
  }
  const paths = input.testPaths.map((pathObservations) => {
    const command = targetRecipeCommandForTestPath(input.environment, pathObservations.testPath);
    const testPath = validateRelativeSegments(pathObservations.testPath, 'test path').join('/');
    const broken = stableObservation(pathObservations.broken, 'broken', testPath);
    const fixed = stableObservation(pathObservations.fixed, 'fixed', testPath);
    return {
      testPath,
      commandHash: canonicalSha256(command),
      broken: [broken, broken],
      fixed: [fixed, fixed],
      ...deriveStableSets(broken, fixed),
    };
  });
  return verifyDifferentialAdmissionReceiptV2({
    schemaVersion: 'swe-rebench-v2-differential-admission-receipt.v2',
    admissionPolicyVersion: DifferentialAdmissionPolicyV2.admissionPolicyVersion,
    task: input.task,
    goldPatchHash: input.goldPatchHash,
    testPatchHash: input.testPatchHash,
    testPaths: paths,
    environment: {
      environmentHash: input.environment.attestation.environmentHash,
      image: input.environment.execution.image,
      parser: input.environment.execution.parser,
      platform: input.environment.execution.platform,
    },
    evalSemanticsVersion: input.evalSemanticsVersion,
  });
}
