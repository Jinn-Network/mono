/**
 * Pool-validation gate for the swe-rebench-v2 task generator.
 *
 * SWE-rebench's leaderboard split contains instances that can't be scored in
 * our eval environment — the dataset `test_cmd` runs a superset of the named
 * tests, a `PASS_TO_PASS` test ERRORs without a service the container doesn't
 * provide, the gold patch doesn't reproduce the expected transition, etc.
 * Posting tasks for those just produces verdicts that say nothing about the
 * solver. Standard practice (SWE-bench Verified by hand, SWE-rebench's pipeline
 * automatically) is to validate each instance and only keep the scorable ones.
 *
 * `validatePoolInstances` does that validation: run the *gold* patch through
 * our `PythonEvalRunner` and mark the instance scorable iff it resolves
 * (`passed_match: true` under our SWE-bench "resolved" semantics). Results are
 * cached per `(instance_id, evalSemanticsVersion)` in `<stateDir>/validated-pool.json`.
 * The generator (`filterToScorablePool`) restricts its posting pool to the
 * scorable set; absent validation data it falls back to Python-only instances
 * (the languages our pytest `test_cmd` override supports) as a conservative floor.
 *
 * Refs: jinn-mono-uy6v.9.
 */

import { readFile, writeFile, mkdir, stat, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { resolve as resolvePath, dirname, join } from 'node:path';
import type { PoolTask } from './_swe-rebench-v2-pool.js';
import type { EvalRunner, HfFetcher, HfRow } from '../harnesses/impls/swe-rebench-v2-evaluator/index.js';
import {
  computeRowHash,
  defaultCommandRunner,
  resolveImageDigest,
  resolveUpstreamEvalCommit,
  type CommandRunner,
} from './_swe-rebench-v2-substrate.js';
import { canonicalJson } from '../util/canonical-json.js';
import { DifferentialAdmissionPolicyV2 } from './_swe-rebench-v2-differential-admission.js';

// In-process mutex map: serialises concurrent record() calls against the
// same file. Entries are never removed; bounded by the number of distinct
// validated-pool.json paths used in this process (typically 1).
//
// Cross-process safety is NOT provided: if two separate node processes run
// `jinn solver-nets validate-pool` simultaneously against the same file,
// the atomic POSIX rename guarantees only that the file is never
// torn — one of the concurrent writes may still clobber the other's
// entries. This is an acceptable limitation for a manual admin CLI;
// operators should not run validate-pool concurrently against the same
// state dir.
const writeLocks: Map<string, Promise<void>> = new Map();
function withWriteLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(file) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => { release = res; });
  writeLocks.set(file, next);
  return prev.then(fn).finally(release) as Promise<T>;
}

/**
 * Bump when the eval grading semantics change (verdict re-derivation,
 * ungradeable classification, test-command construction) so cached validation
 * results from an older harness are treated as stale and re-checked.
 *
 *   '1' — original exact-set `passed_match`.
 *   '2' — SWE-bench "resolved" semantics + run-the-named-tests `test_cmd`
 *         override (jinn-mono-uy6v.8).
 *   '3' — adds verdict-time substrate recheck (`rowHash`, `imageDigest`,
 *         `upstreamEvalCommit`) and extended ungradeable classifier
 *         (venv collision, missing pytest, dependency warnings, conftest
 *         import/setup failures) — jinn-mono-fufn.
 *   '4' — adds the buildTestCommands pytest-install guard (#493): for
 *         parse_log_pytest rows whose install_config.install does not
 *         already mention pytest, prepend a best-effort install line so
 *         the `ungradeable:pytest_missing` bucket (the highest-yield
 *         capacity blocker on the Stage-1 histogram) becomes scorable.
 *         The v3→v4 transition is a *targeted* migration, not a wholesale
 *         invalidation: only `ungradeable:pytest_missing` entries can flip
 *         under the install guard, so they alone are dropped (re-validated);
 *         every other verdict (scorable, gold-patch-not-resolved,
 *         transient/error/other ungradeable) is carried forward verbatim
 *         (see {@link loadOrMigrateFile}).
 */
export const EVAL_SEMANTICS_VERSION = '4';

const SCHEMA_VERSION = 'swe-rebench-v2-validated-pool.v1' as const;
export const SWE_REBENCH_V2_VETTED_POOL_ARTIFACT_TYPE = 'swe-rebench-v2-vetted-pool.v1' as const;
export const SOLVERNET_ARTIFACT_REF_SCHEMA_VERSION = 'solvernet.artifact-ref.v1' as const;
export const VETTED_POOL_REF_ELIGIBILITY_KEY = 'vettedPoolRef' as const;
const PUBLICATION_SCHEMA_VERSION = 'swe-rebench-v2-vetted-pool-publication.v1' as const;
const PUBLICATION_FILE = 'vetted-pool-artifact-publication.json';

/** Public admission binding for an explicit-environment minted-pool.v2 row. */
export interface V2MintedEnvironmentAdmissionBinding {
  environmentSpecCid: string;
  environmentHash: `sha256:${string}`;
  parser: {
    id: string;
    version: string;
    digest: `sha256:${string}`;
    bundleId: string;
  };
  image: {
    reference: string;
    digest: `sha256:${string}`;
  };
  platform: 'linux/amd64';
}

/** Public receipt pointer mirrored from a hardened minted-pool.v2 row. */
export interface V2DifferentialAdmissionBinding {
  admissionPolicyVersion: typeof DifferentialAdmissionPolicyV2.admissionPolicyVersion;
  receiptCid: string;
  receiptHash: `sha256:${string}`;
}

export interface ValidatedPoolEntry {
  scorable: boolean;
  /**
   * Why scorable/unscorable — `'gold-patch-resolves'`, `'ungradeable:<reason>'`,
   * `'transient:HF-429:<msg>'`, `'error:HF-429-permanent-after-5-passes'`, etc.
   *
   * Reason prefixes:
   *   - `transient:` — non-terminal; the next `validatePoolInstances` pass
   *     re-processes the entry until `transientRetryCount` hits {@link MAX_TRANSIENT_PASSES}.
   *   - everything else (including `error:`, `ungradeable:`, etc.) — terminal
   *     under the skip-check; only re-processed when `opts.force` is set.
   */
  reason: string;
  checkedAt: string; // ISO timestamp
  /** Canonical-JSON SHA-256 over the HF row fields used for grading. v3+. */
  rowHash?: string;
  /** Full image reference (`<repo>:<tag>`) the validation pulled. v3+. */
  imageName?: string;
  /** Image digest resolved from `docker image inspect` after validation. v3+. */
  imageDigest?: string;
  /** `git rev-parse HEAD` of the enabled upstream SWE-rebench repo at validation time. v3+. */
  upstreamEvalCommit?: string;
  /**
   * Number of consecutive `validatePoolInstances` passes that have recorded a
   * `transient:` reason for this instance under this `evalSemanticsVersion`.
   * Bumped on each pass; flips the reason to `error:HF-429-permanent-after-5-passes`
   * once it hits {@link MAX_TRANSIENT_PASSES} (issue #578). Undefined for
   * non-transient entries (treated as `0` on read).
   */
  transientRetryCount?: number;
  /** ISO timestamp of the most recent transient pass. Undefined for non-transient entries. */
  lastTransientAt?: string;
  /**
   * Whether a known-bad patch (empty patch) is rejected by the grader. v5+ /
   * task-creator rung 0 (D3). `unchecked` for entries validated before the
   * discrimination check existed.
   */
  discrimination?: 'pass' | 'fail' | 'unchecked';
  /**
   * v2 public-repository admission. It is intentionally separate from the
   * legacy HF `rowHash`: `publicRowHash` excludes gold material and binds the
   * explicit evaluator environment instead.
   */
  rowHashVersion?: 2;
  publicRowHash?: `sha256:${string}`;
  v2Environment?: V2MintedEnvironmentAdmissionBinding;
  /** Public fix identity mirrored from a hardened minted-pool.v2 row. */
  v2FixCommit?: string;
  differentialAdmission?: V2DifferentialAdmissionBinding;
}

/** Instances whose known-bad patch passes are weak-suite — excluded from
 *  distillation and contested-band targeting; minted instances are hard-rejected. */
export const WEAK_SUITE_REASON = 'weak-suite' as const;

export type ValidatePoolSource = 'benchmark' | 'minted';

/**
 * Cap on consecutive transient passes before an instance flips to the
 * terminal `error:HF-429-permanent-after-5-passes` reason. Issue #578: the
 * AC says "the failure is still recorded for visibility, but the validation
 * pipeline distinguishes transient from permanent so the next run reprocesses
 * these instances"; this is the convergence boundary that keeps a
 * permanently-broken split from churning forever.
 */
export const MAX_TRANSIENT_PASSES = 5;
const PERMANENT_HF_429_REASON = `error:HF-429-permanent-after-${MAX_TRANSIENT_PASSES}-passes`;

/**
 * The operator-environment subset of `EvalCouldNotGradeError` reasons that are
 * worth a bounded retry rather than being cached terminal (issue #811). These
 * may differ on a later pass — Docker comes back, a stale `.venv` is cleaned,
 * the host's missing venv is provisioned. `image_arch_mismatch` is fixed
 * per-machine, but the bounded retry caps the waste: it converges to the
 * terminal `ungradeable:` reason after {@link MAX_TRANSIENT_PASSES}, so there
 * is no infinite loop.
 *
 * Every OTHER `EvalCouldNotGradeError` reason (pytest_missing,
 * install_build_failed, conftest_import_error, requests_dep_mismatch,
 * eval_setup_error, …) is a real per-instance problem where a blind retry
 * won't help; those stay `ungradeable:` terminal. `pytest_missing` in
 * particular needs the #493 code fix, not a retry.
 */
export const TRANSIENT_INFRA_REASONS: ReadonlySet<string> = new Set([
  'docker_unavailable',
  'venv_collision',
  'venv_missing',
  'image_arch_mismatch',
]);

interface ValidatedPoolFile {
  schemaVersion: typeof SCHEMA_VERSION;
  evalSemanticsVersion: string;
  updatedAt: string;
  entries: Record<string, ValidatedPoolEntry>;
}

export interface SweRebenchV2VettedPoolArtifactEntry extends ValidatedPoolEntry {
  instance_id: string;
  scorable: true;
}

export interface SweRebenchV2VettedPoolArtifact {
  schemaVersion: typeof SWE_REBENCH_V2_VETTED_POOL_ARTIFACT_TYPE;
  evalSemanticsVersion: string;
  generatedAt: string;
  entries: SweRebenchV2VettedPoolArtifactEntry[];
}

export interface SolverNetArtifactRef {
  schemaVersion: typeof SOLVERNET_ARTIFACT_REF_SCHEMA_VERSION;
  manifestCid: string;
  artifactType: typeof SWE_REBENCH_V2_VETTED_POOL_ARTIFACT_TYPE;
  artifactCid: string;
  artifactHash: `sha256:${string}`;
  evalSemanticsVersion: string;
  publishedAt: string;
}

export interface VettedPoolArtifactPublication {
  schemaVersion: typeof PUBLICATION_SCHEMA_VERSION;
  updatedAt: string;
  ref: SolverNetArtifactRef;
  artifact: SweRebenchV2VettedPoolArtifact;
}

export interface ScorableVettedPoolArtifactEntries {
  ids: Set<string>;
  byId: Map<string, SweRebenchV2VettedPoolArtifactEntry>;
}

function freshFile(evalSemanticsVersion: string): ValidatedPoolFile {
  return { schemaVersion: SCHEMA_VERSION, evalSemanticsVersion, updatedAt: new Date().toISOString(), entries: {} };
}

function isValidFile(raw: unknown, evalSemanticsVersion: string): raw is ValidatedPoolFile {
  return (
    typeof raw === 'object' && raw !== null &&
    (raw as ValidatedPoolFile).schemaVersion === SCHEMA_VERSION &&
    (raw as ValidatedPoolFile).evalSemanticsVersion === evalSemanticsVersion &&
    typeof (raw as ValidatedPoolFile).entries === 'object' && (raw as ValidatedPoolFile).entries !== null
  );
}

/** Structurally a `ValidatedPoolFile` at *any* semantics version (schema + entries shape). */
function hasValidShape(raw: unknown): raw is ValidatedPoolFile {
  return (
    typeof raw === 'object' && raw !== null &&
    (raw as ValidatedPoolFile).schemaVersion === SCHEMA_VERSION &&
    typeof (raw as ValidatedPoolFile).evalSemanticsVersion === 'string' &&
    typeof (raw as ValidatedPoolFile).entries === 'object' && (raw as ValidatedPoolFile).entries !== null
  );
}

/**
 * Explicit, version-keyed carry-forward migrations. A migration maps the source
 * version's entries onto the target version's entries; only verdict classes that
 * the target's grading change could flip are dropped (so the validate loop
 * re-processes them), everything else is carried forward verbatim.
 *
 * Why: the only thing the v4 buildTestCommands pytest-install guard can alter is a
 * `parse_log_pytest` instance whose install lacked pytest — i.e. exactly the
 * `ungradeable:pytest_missing` bucket. Every other verdict (scorable
 * `gold-patch-resolves`, `gold-patch-not-resolved`, transient/error/other
 * ungradeable) ran the test runner or is install-independent, so its verdict
 * cannot change under v4 and is carried forward unchanged. A future v4→vN bump
 * must add its own entry here choosing which verdicts it can flip — this is NOT a
 * general "carry forward everything except pytest_missing" rule.
 */
const MIGRATIONS: Record<string, Record<string, (entries: Record<string, ValidatedPoolEntry>) => Record<string, ValidatedPoolEntry>>> = {
  // from version '3' → to version '4'
  '3': {
    '4': (entries) => Object.fromEntries(
      Object.entries(entries).filter(([, e]) => e.reason !== 'ungradeable:pytest_missing'),
    ),
  },
};

/**
 * Load `raw` for `targetVersion`, applying a defined migration where one exists.
 * Pure — callers persist the result via their own write path.
 *
 *   - already valid at `targetVersion` → returned as-is.
 *   - structurally valid at a prior version with a defined migration → migrated
 *     file (carried-forward entries keep their original `checkedAt`/verdict).
 *   - otherwise (unknown/unmapped version, wrong schema, garbage) → `freshFile`.
 */
function loadOrMigrateFile(raw: unknown, targetVersion: string): ValidatedPoolFile {
  if (isValidFile(raw, targetVersion)) return raw;
  if (hasValidShape(raw)) {
    const migrate = MIGRATIONS[raw.evalSemanticsVersion]?.[targetVersion];
    if (migrate) {
      return {
        schemaVersion: SCHEMA_VERSION,
        evalSemanticsVersion: targetVersion,
        updatedAt: new Date().toISOString(),
        entries: migrate(raw.entries),
      };
    }
  }
  return freshFile(targetVersion);
}

function publicationPath(stateDir: string): string {
  return resolvePath(join(stateDir, PUBLICATION_FILE));
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  try {
    await rename(tmp, file); // POSIX rename is atomic
  } catch (err) {
    // Best-effort tempfile cleanup — don't mask the original error.
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

function isObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null;
}

function isSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isCommitSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function parseV2MintedEnvironmentAdmissionBinding(raw: unknown): V2MintedEnvironmentAdmissionBinding | null {
  if (!isObject(raw)) return null;
  const parser = raw['parser'];
  const image = raw['image'];
  if (!isObject(parser) || !isObject(image)) return null;
  if (typeof raw['environmentSpecCid'] !== 'string' || raw['environmentSpecCid'].length === 0) return null;
  if (!isSha256(raw['environmentHash'])) return null;
  if (
    typeof parser['id'] !== 'string' || parser['id'].length === 0 ||
    typeof parser['version'] !== 'string' || parser['version'].length === 0 ||
    !isSha256(parser['digest']) ||
    typeof parser['bundleId'] !== 'string' || parser['bundleId'].length === 0
  ) return null;
  if (
    typeof image['reference'] !== 'string' ||
    !/@sha256:[0-9a-f]{64}$/u.test(image['reference']) ||
    !isSha256(image['digest']) ||
    !image['reference'].endsWith(`@${image['digest']}`)
  ) return null;
  if (raw['platform'] !== 'linux/amd64') return null;
  return {
    environmentSpecCid: raw['environmentSpecCid'],
    environmentHash: raw['environmentHash'],
    parser: {
      id: parser['id'], version: parser['version'], digest: parser['digest'], bundleId: parser['bundleId'],
    },
    image: { reference: image['reference'], digest: image['digest'] },
    platform: 'linux/amd64',
  };
}

function parseV2DifferentialAdmissionBinding(raw: unknown): V2DifferentialAdmissionBinding | null {
  if (!isObject(raw)) return null;
  if (raw['admissionPolicyVersion'] !== DifferentialAdmissionPolicyV2.admissionPolicyVersion) return null;
  if (typeof raw['receiptCid'] !== 'string' || raw['receiptCid'].length === 0) return null;
  if (!isSha256(raw['receiptHash'])) return null;
  return {
    admissionPolicyVersion: DifferentialAdmissionPolicyV2.admissionPolicyVersion,
    receiptCid: raw['receiptCid'],
    receiptHash: raw['receiptHash'],
  };
}

function v2AdmissionFields(raw: Record<string, unknown>): {
  rowHashVersion: 2;
  publicRowHash: `sha256:${string}`;
  v2Environment: V2MintedEnvironmentAdmissionBinding;
  v2FixCommit?: string;
  differentialAdmission?: V2DifferentialAdmissionBinding;
} | null {
  const present = raw['rowHashVersion'] !== undefined || raw['publicRowHash'] !== undefined || raw['v2Environment'] !== undefined || raw['v2FixCommit'] !== undefined || raw['differentialAdmission'] !== undefined;
  if (!present) return null;
  if (raw['rowHashVersion'] !== 2 || !isSha256(raw['publicRowHash'])) return null;
  const v2Environment = parseV2MintedEnvironmentAdmissionBinding(raw['v2Environment']);
  if (!v2Environment) return null;
  const differentialAdmission = raw['differentialAdmission'] === undefined
    ? undefined
    : parseV2DifferentialAdmissionBinding(raw['differentialAdmission']);
  if (raw['differentialAdmission'] !== undefined && !differentialAdmission) return null;
  const v2FixCommit = raw['v2FixCommit'] === undefined ? undefined : raw['v2FixCommit'];
  if (v2FixCommit !== undefined && !isCommitSha(v2FixCommit)) return null;
  if (differentialAdmission && !v2FixCommit) return null;
  return {
    rowHashVersion: 2,
    publicRowHash: raw['publicRowHash'],
    v2Environment,
    ...(v2FixCommit ? { v2FixCommit } : {}),
    ...(differentialAdmission ? { differentialAdmission } : {}),
  };
}

function parseVettedPoolArtifactEntry(raw: unknown): SweRebenchV2VettedPoolArtifactEntry | null {
  if (!isObject(raw)) return null;
  if (typeof raw['instance_id'] !== 'string' || raw['instance_id'].length === 0) return null;
  if (raw['scorable'] !== true) return null;
  if (typeof raw['reason'] !== 'string') return null;
  if (typeof raw['checkedAt'] !== 'string') return null;
  const v2 = v2AdmissionFields(raw);
  if (
    (raw['rowHashVersion'] !== undefined || raw['publicRowHash'] !== undefined || raw['v2Environment'] !== undefined || raw['v2FixCommit'] !== undefined || raw['differentialAdmission'] !== undefined) &&
    !v2
  ) return null;
  const entry: SweRebenchV2VettedPoolArtifactEntry = {
    instance_id: raw['instance_id'],
    scorable: true,
    reason: raw['reason'],
    checkedAt: raw['checkedAt'],
    ...(typeof raw['rowHash'] === 'string' ? { rowHash: raw['rowHash'] } : {}),
    ...(typeof raw['imageName'] === 'string' ? { imageName: raw['imageName'] } : {}),
    ...(typeof raw['imageDigest'] === 'string' ? { imageDigest: raw['imageDigest'] } : {}),
    ...(typeof raw['upstreamEvalCommit'] === 'string' ? { upstreamEvalCommit: raw['upstreamEvalCommit'] } : {}),
    ...(v2 ?? {}),
  };
  return entry;
}

export function parseVettedPoolArtifact(raw: unknown): SweRebenchV2VettedPoolArtifact {
  if (!isObject(raw)) throw new Error('vetted pool artifact must be an object');
  if (raw['schemaVersion'] !== SWE_REBENCH_V2_VETTED_POOL_ARTIFACT_TYPE) {
    throw new Error(`vetted pool artifact schemaVersion must be ${SWE_REBENCH_V2_VETTED_POOL_ARTIFACT_TYPE}`);
  }
  if (typeof raw['evalSemanticsVersion'] !== 'string') {
    throw new Error('vetted pool artifact evalSemanticsVersion must be a string');
  }
  if (typeof raw['generatedAt'] !== 'string') {
    throw new Error('vetted pool artifact generatedAt must be a string');
  }
  if (!Array.isArray(raw['entries'])) {
    throw new Error('vetted pool artifact entries must be an array');
  }
  const entries = raw['entries'].map(parseVettedPoolArtifactEntry);
  if (entries.some((e) => e === null)) {
    throw new Error('vetted pool artifact contains an invalid or unscorable entry');
  }
  return {
    schemaVersion: SWE_REBENCH_V2_VETTED_POOL_ARTIFACT_TYPE,
    evalSemanticsVersion: raw['evalSemanticsVersion'],
    generatedAt: raw['generatedAt'],
    entries: (entries as SweRebenchV2VettedPoolArtifactEntry[]).sort((a, b) => a.instance_id.localeCompare(b.instance_id)),
  };
}

function normalizeVettedPoolArtifact(artifact: SweRebenchV2VettedPoolArtifact): SweRebenchV2VettedPoolArtifact {
  return {
    schemaVersion: SWE_REBENCH_V2_VETTED_POOL_ARTIFACT_TYPE,
    evalSemanticsVersion: artifact.evalSemanticsVersion,
    generatedAt: artifact.generatedAt,
    entries: [...artifact.entries]
      .map((entry) => ({ ...entry, scorable: true as const }))
      .sort((a, b) => a.instance_id.localeCompare(b.instance_id)),
  };
}

export function hashVettedPoolArtifact(artifact: SweRebenchV2VettedPoolArtifact): `sha256:${string}` {
  const canonical = canonicalJson(normalizeVettedPoolArtifact(artifact));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function loadVettedPoolArtifactScorableEntries(raw: unknown): ScorableVettedPoolArtifactEntries {
  const artifact = parseVettedPoolArtifact(raw);
  const byId = new Map<string, SweRebenchV2VettedPoolArtifactEntry>();
  for (const entry of artifact.entries) {
    byId.set(entry.instance_id, entry);
  }
  return { ids: new Set(byId.keys()), byId };
}

/**
 * Substrate-level held-out exclusion (#986). Returns a copy of the artifact with
 * the `excludeIds` instances dropped, so the PUBLISHED vetted-pool artifact — the
 * shared substrate every generator can source its postable set from — never lists
 * the held-out exam. This moves the exclusion up from each generator's posting
 * decision (which only a generator running the slate code honours) to the artifact
 * itself, so a fresh-recovery / independent / unguarded generator that reads the
 * artifact cannot post the exam tasks either. Pure; never mutates its input. The
 * caller re-hashes via `hashVettedPoolArtifact`.
 */
export function excludeFromVettedPoolArtifact(
  artifact: SweRebenchV2VettedPoolArtifact,
  excludeIds: ReadonlySet<string>,
): SweRebenchV2VettedPoolArtifact {
  if (excludeIds.size === 0) return artifact;
  return { ...artifact, entries: artifact.entries.filter((e) => !excludeIds.has(e.instance_id)) };
}

/**
 * Republication decision (#986). The published artifact is authoritative and
 * write-once: it is NOT re-synced to local scorable unless the validated pool is
 * strictly newer (the prior timestamp-gated behaviour, preserved here). But a
 * timestamp-only check never fires when the *held-out set* changes while the
 * validated pool is unchanged — so adding the exclusion in code, or activating a
 * new slate version (e.g. `v3`), would leave the live artifact stale (still
 * listing now-held-out instances) indefinitely. The narrow extra trigger:
 * republish when the existing publication is CONTAMINATED — it still lists a
 * now-held-out instance. This forces exactly the rollout / slate-bump refresh
 * and nothing more (it does NOT republish merely because the publication diverges
 * from local scorable, which would break the write-once / published-authoritative
 * contract other operators recover against).
 */
export function shouldRepublishVettedPool(args: {
  existingIds: ReadonlySet<string> | null;
  heldOutIds: ReadonlySet<string>;
  validatedNewer: boolean;
}): boolean {
  if (!args.existingIds) return true;
  if (args.validatedNewer) return true;
  for (const id of args.existingIds) {
    if (args.heldOutIds.has(id)) return true;
  }
  return false;
}

export function createVettedPoolArtifactRef(args: {
  manifestCid: string;
  artifactCid: string;
  artifactHash: `sha256:${string}`;
  evalSemanticsVersion: string;
  publishedAt: string;
}): SolverNetArtifactRef {
  return {
    schemaVersion: SOLVERNET_ARTIFACT_REF_SCHEMA_VERSION,
    manifestCid: args.manifestCid,
    artifactType: SWE_REBENCH_V2_VETTED_POOL_ARTIFACT_TYPE,
    artifactCid: args.artifactCid,
    artifactHash: args.artifactHash,
    evalSemanticsVersion: args.evalSemanticsVersion,
    publishedAt: args.publishedAt,
  };
}

export function sweRebenchV2VettedPoolArtifactMetadataKey(manifestCid: string): string {
  return `solvernet-artifact:${manifestCid}:swe-rebench-v2-vetted-pool`;
}

export function parseVettedPoolArtifactRef(raw: unknown): SolverNetArtifactRef {
  if (!isObject(raw)) throw new Error('vetted pool artifact ref must be an object');
  if (raw['schemaVersion'] !== SOLVERNET_ARTIFACT_REF_SCHEMA_VERSION) {
    throw new Error(`vetted pool artifact ref schemaVersion must be ${SOLVERNET_ARTIFACT_REF_SCHEMA_VERSION}`);
  }
  if (raw['artifactType'] !== SWE_REBENCH_V2_VETTED_POOL_ARTIFACT_TYPE) {
    throw new Error(`vetted pool artifact ref artifactType must be ${SWE_REBENCH_V2_VETTED_POOL_ARTIFACT_TYPE}`);
  }
  if (typeof raw['manifestCid'] !== 'string' || raw['manifestCid'].length === 0) {
    throw new Error('vetted pool artifact ref manifestCid must be a string');
  }
  if (typeof raw['artifactCid'] !== 'string' || raw['artifactCid'].length === 0) {
    throw new Error('vetted pool artifact ref artifactCid must be a string');
  }
  if (!isSha256(raw['artifactHash'])) {
    throw new Error('vetted pool artifact ref artifactHash must be sha256:<64 hex>');
  }
  if (typeof raw['evalSemanticsVersion'] !== 'string') {
    throw new Error('vetted pool artifact ref evalSemanticsVersion must be a string');
  }
  if (typeof raw['publishedAt'] !== 'string') {
    throw new Error('vetted pool artifact ref publishedAt must be a string');
  }
  return {
    schemaVersion: SOLVERNET_ARTIFACT_REF_SCHEMA_VERSION,
    manifestCid: raw['manifestCid'],
    artifactType: SWE_REBENCH_V2_VETTED_POOL_ARTIFACT_TYPE,
    artifactCid: raw['artifactCid'],
    artifactHash: raw['artifactHash'],
    evalSemanticsVersion: raw['evalSemanticsVersion'],
    publishedAt: raw['publishedAt'],
  };
}

export function vettedPoolArtifactRefFromEligibility(eligibility: Record<string, unknown> | undefined): SolverNetArtifactRef | null {
  const raw = eligibility?.[VETTED_POOL_REF_ELIGIBILITY_KEY];
  if (raw === undefined) return null;
  return parseVettedPoolArtifactRef(raw);
}

/**
 * gh #300 — solver-side ghost-task admission, Tier 1 (zero-fetch).
 *
 * Returns a human-readable reason string when the task's on-chain
 * `vettedPoolRef` announces an `evalSemanticsVersion` that no local evaluator
 * could grade under the current {@link EVAL_SEMANTICS_VERSION}, otherwise
 * `null`. This is the symmetric counterpart to the evaluator's hard gate in
 * `loadPublishedPoolRow` (swe-rebench-v2-evaluator/harness.ts): the evaluator
 * already rejects semantics-skewed tasks at verdict time; this lets the
 * solver reject them at claim time instead of burning compute on a task its
 * own evaluator will refuse to score.
 *
 * Deliberately **fails open when the ref is absent** (returns `null`): pre-
 * `vettedPoolRef` and `python-floor` tasks carry no ref and are still guarded
 * by the recency floor (`DEFAULT_TASK_DISCOVERY_FROM_BLOCK`). Closing those
 * fail-closed is a network-wide behavioural change deferred to Tier 2 (see
 * `spec/2026-05-29-ghost-task-admission-symmetric-gate.md`). A malformed ref
 * surfaces as a mismatch reason rather than throwing, so the claim path never
 * crashes on a bad ref.
 */
export function vettedPoolRefSemanticsMismatch(
  eligibility: Record<string, unknown> | undefined,
): string | null {
  let ref: SolverNetArtifactRef | null;
  try {
    ref = vettedPoolArtifactRefFromEligibility(eligibility);
  } catch (err) {
    return `vettedPoolRef invalid: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!ref) return null; // no ref → fail open (recency floor guards these)
  if (ref.evalSemanticsVersion !== EVAL_SEMANTICS_VERSION) {
    return `vettedPoolRef evalSemanticsVersion=${ref.evalSemanticsVersion} cannot be graded under local EVAL_SEMANTICS_VERSION=${EVAL_SEMANTICS_VERSION} (ghost task, gh #300)`;
  }
  return null;
}

export class ValidatedPoolStore {
  private readonly file: string;
  private cache: ValidatedPoolFile | null = null;
  /** mtime-keyed cache for `getScorableIds`. The generator's tick reads this
   *  every poll (every few seconds); the file only changes during infrequent
   *  `validate-pool` CLI runs. Invalidate on mtime change. */
  private scorableIdsCache: { mtimeMs: number; semanticsVersion: string; ids: Set<string> | null } | null = null;

  constructor(opts: { stateDir: string }) {
    this.file = resolvePath(join(opts.stateDir, 'validated-pool.json'));
  }

  private async readRaw(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  private async loadForWrite(evalSemanticsVersion: string): Promise<ValidatedPoolFile> {
    if (this.cache && this.cache.evalSemanticsVersion === evalSemanticsVersion) return this.cache;
    const raw = await this.readRaw();
    this.cache = loadOrMigrateFile(raw, evalSemanticsVersion);
    return this.cache;
  }

  private async writeAtomic(file: ValidatedPoolFile): Promise<void> {
    await writeJsonAtomic(this.file, file);
  }

  /** The set of instance ids known scorable for `evalSemanticsVersion`, or
   *  `null` if there is no validation data for this semantics version (the
   *  on-disk file is absent or built for a different version). Memoised by
   *  mtime so the generator's tick doesn't re-parse the JSON every poll. */
  async getScorableIds(evalSemanticsVersion: string): Promise<Set<string> | null> {
    const mtimeMs = await stat(this.file).then((s) => s.mtimeMs).catch(() => -1);
    const cached = this.scorableIdsCache;
    if (cached && cached.mtimeMs === mtimeMs && cached.semanticsVersion === evalSemanticsVersion) {
      return cached.ids;
    }
    const raw = await this.readRaw();
    // No data on disk (or wrong schema/unmapped version) stays `null` — the
    // generator's no-validation-data floor. A migratable prior version yields
    // the carried-forward scorable set, never `null`.
    const ids = (isValidFile(raw, evalSemanticsVersion) || (hasValidShape(raw) && MIGRATIONS[raw.evalSemanticsVersion]?.[evalSemanticsVersion]))
      ? new Set(Object.entries(loadOrMigrateFile(raw, evalSemanticsVersion).entries)
        .filter(([, e]) => e.scorable && e.discrimination !== 'fail')
        .map(([id]) => id))
      : null;
    this.scorableIdsCache = { mtimeMs, semanticsVersion: evalSemanticsVersion, ids };
    return ids;
  }

  async getScorableEntries(evalSemanticsVersion: string): Promise<{
    entries: Record<string, ValidatedPoolEntry>;
    updatedAt: string;
  } | null> {
    const raw = await this.readRaw();
    if (!isValidFile(raw, evalSemanticsVersion) && !(hasValidShape(raw) && MIGRATIONS[raw.evalSemanticsVersion]?.[evalSemanticsVersion])) return null;
    const file = loadOrMigrateFile(raw, evalSemanticsVersion);
    return {
      updatedAt: file.updatedAt,
      entries: Object.fromEntries(Object.entries(file.entries).filter(([, entry]) => entry.scorable && entry.discrimination !== 'fail')),
    };
  }

  /** The entry for `instanceId`, or `null` if not validated for this semantics version. */
  async getEntry(instanceId: string, evalSemanticsVersion: string): Promise<ValidatedPoolEntry | null> {
    const f = await this.loadForWrite(evalSemanticsVersion);
    return f.entries[instanceId] ?? null;
  }

  async getDiscriminationFailIds(evalSemanticsVersion: string): Promise<Set<string>> {
    const raw = await this.readRaw();
    if (!isValidFile(raw, evalSemanticsVersion) && !(hasValidShape(raw) && MIGRATIONS[raw.evalSemanticsVersion]?.[evalSemanticsVersion])) {
      return new Set();
    }
    const file = loadOrMigrateFile(raw, evalSemanticsVersion);
    return new Set(
      Object.entries(file.entries)
        .filter(([, e]) => e.discrimination === 'fail')
        .map(([id]) => id),
    );
  }

  async record(instanceId: string, entry: ValidatedPoolEntry, evalSemanticsVersion: string): Promise<void> {
    return withWriteLock(this.file, async () => {
      // Reload from disk so a concurrent write isn't lost. The in-memory cache
      // is invalidated; the next read re-loads.
      this.cache = null;
      this.scorableIdsCache = null;
      const raw = await this.readRaw();
      const file = loadOrMigrateFile(raw, evalSemanticsVersion);
      file.entries[instanceId] = entry;
      file.updatedAt = new Date().toISOString();
      await this.writeAtomic(file);
      this.cache = file;
    });
  }
}

/**
 * Histogram bucket for gold-patch-not-resolved entries whose PASS_TO_PASS
 * tests broke (`p2p_broke > 0`). These are usually an environment/setup
 * problem (missing system deps, a pytest/plugin version mismatch) rather
 * than a non-resolving gold patch — a chase-able evaluator-capacity blocker,
 * the same shape as `ungradeable:pytest_missing`. See issue #806.
 */
export const GOLD_PATCH_NOT_RESOLVED_P2P_BROKE_REASON = 'gold-patch-not-resolved:p2p-broke';

/**
 * Collapse a stored `reason` string into a histogram bucket. Diagnostic
 * detail (`(f2p X, p2p_broke Y)`, the verbatim HF 429 message) is kept on
 * the entry for debugging, but the bucket name is what matters for the
 * #493 reason-histogram CLI. Unknown reasons pass through unchanged.
 *
 * Per #806, `gold-patch-not-resolved` is split by PASS_TO_PASS breakage:
 * entries with `p2p_broke > 0` map to a distinct
 * `gold-patch-not-resolved:p2p-broke` bucket (environment broke — chase-able),
 * while `p2p_broke == 0` keeps the base bucket (patch genuinely doesn't
 * resolve — leave alone). The split is display-only; the per-entry `reason`
 * string keeps the full `(f2p X, p2p_broke Y)` detail.
 */
export function normalizeReason(reason: string): string {
  if (reason.startsWith('gold-patch-not-resolved')) {
    const p2pBroke = reason.match(/p2p_broke (\d+)/);
    if (p2pBroke && Number(p2pBroke[1]) > 0) return GOLD_PATCH_NOT_RESOLVED_P2P_BROKE_REASON;
    return 'gold-patch-not-resolved';
  }
  if (reason.startsWith('transient:HF-429:')) return 'transient:HF-429';
  // Pre-#578 legacy: 429s recorded as `error:HF datasets-server returned 429 for ...`.
  if (/^error:HF datasets-server returned 429\b/.test(reason)) return 'error:HF-429';
  return reason;
}

export interface ValidatedPoolHistogramBucket {
  reason: string;
  count: number;
}

export interface ValidatedPoolSummary {
  totalEntries: number;
  scorable: number;
  unscorable: number;
  byReason: ValidatedPoolHistogramBucket[];
}

/**
 * Read-only summary of a `validated-pool.json` file. Counts entries by
 * normalised reason (see {@link normalizeReason}) and returns the buckets
 * sorted descending by count, with ties broken alphabetically by reason.
 */
export function summarizeValidatedPool(file: unknown): ValidatedPoolSummary {
  if (!isObject(file) || !isObject(file['entries'])) {
    throw new Error('summarizeValidatedPool: file must include an `entries` object');
  }
  let scorable = 0;
  let unscorable = 0;
  const counts = new Map<string, number>();
  for (const entry of Object.values(file['entries'])) {
    if (!isObject(entry)) continue;
    const raw = typeof entry['reason'] === 'string' ? entry['reason'] : 'unknown';
    const reason = normalizeReason(raw);
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    if (entry['scorable'] === true) scorable += 1; else unscorable += 1;
  }
  const byReason = [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => (b.count - a.count) || a.reason.localeCompare(b.reason));
  return { totalEntries: scorable + unscorable, scorable, unscorable, byReason };
}

export interface WeakSuiteSummary {
  /** Scorable entries with a discrimination verdict (`'pass'` or `'fail'`). */
  checked: number;
  /** Of those, `discrimination === 'fail'` — the weak-suite count. */
  flagged: number;
  /** Scorable entries with `discrimination === undefined`, split by whether a
   *  current pool row exists to re-fetch for recheck. */
  unchecked: {
    /** Awaiting recheck and present in the current pool. */
    backlog: number;
    /** Awaiting recheck but absent from the current pool — permanently skipped. */
    orphaned: number;
  };
  /** `flagged / checked`, or `null` when `checked === 0`. */
  rate: number | null;
}

/**
 * D3 second half: the weak-suite rate — the fraction of scorable pool
 * entries whose known-bad patch incorrectly passes — over entries that carry
 * a discrimination verdict. Entries still `discrimination: undefined` are
 * reported as `unchecked` and excluded from the rate (see
 * {@link recheckDiscrimination}); unscorable entries never carry a
 * discrimination verdict for the benchmark pool and are excluded entirely.
 */
export function summarizeWeakSuite(file: unknown, poolInstanceIds?: ReadonlySet<string>): WeakSuiteSummary {
  if (!isObject(file) || !isObject(file['entries'])) {
    throw new Error('summarizeWeakSuite: file must include an `entries` object');
  }
  let flagged = 0;
  let passed = 0;
  let uncheckedBacklog = 0;
  let uncheckedOrphaned = 0;
  for (const [instanceId, entry] of Object.entries(file['entries'])) {
    if (!isObject(entry) || entry['scorable'] !== true) continue;
    if (entry['discrimination'] === 'fail') flagged += 1;
    else if (entry['discrimination'] === 'pass') passed += 1;
    else if (poolInstanceIds === undefined || poolInstanceIds.has(instanceId)) uncheckedBacklog += 1;
    else uncheckedOrphaned += 1;
  }
  const checked = flagged + passed;
  return {
    checked,
    flagged,
    unchecked: { backlog: uncheckedBacklog, orphaned: uncheckedOrphaned },
    rate: checked > 0 ? flagged / checked : null,
  };
}

export async function exportScorableVettedPoolArtifact(
  store: ValidatedPoolStore,
  evalSemanticsVersion: string,
  opts: { generatedAt?: string } = {},
): Promise<SweRebenchV2VettedPoolArtifact | null> {
  const scorable = await store.getScorableEntries(evalSemanticsVersion);
  if (!scorable) return null;
  const entries = Object.entries(scorable.entries)
    .map(([instance_id, entry]) => {
      const v2 = v2AdmissionFields(entry as unknown as Record<string, unknown>);
      if (
        (entry.rowHashVersion !== undefined || entry.publicRowHash !== undefined || entry.v2Environment !== undefined || entry.v2FixCommit !== undefined || entry.differentialAdmission !== undefined) &&
        !v2
      ) {
        throw new Error(`invalid v2 minted admission for ${instance_id}`);
      }
      return {
      instance_id,
      scorable: true as const,
      reason: entry.reason,
      checkedAt: entry.checkedAt,
      ...(entry.rowHash ? { rowHash: entry.rowHash } : {}),
      ...(entry.imageName ? { imageName: entry.imageName } : {}),
      ...(entry.imageDigest ? { imageDigest: entry.imageDigest } : {}),
      ...(entry.upstreamEvalCommit ? { upstreamEvalCommit: entry.upstreamEvalCommit } : {}),
      ...(v2 ?? {}),
    };
    })
    .sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  return {
    schemaVersion: SWE_REBENCH_V2_VETTED_POOL_ARTIFACT_TYPE,
    evalSemanticsVersion,
    generatedAt: opts.generatedAt ?? scorable.updatedAt,
    entries,
  };
}

function parsePublication(raw: unknown): VettedPoolArtifactPublication {
  if (!isObject(raw) || raw['schemaVersion'] !== PUBLICATION_SCHEMA_VERSION) {
    throw new Error(`vetted pool publication schemaVersion must be ${PUBLICATION_SCHEMA_VERSION}`);
  }
  if (typeof raw['updatedAt'] !== 'string') {
    throw new Error('vetted pool publication updatedAt must be a string');
  }
  const ref = parseVettedPoolArtifactRef(raw['ref']);
  const artifact = parseVettedPoolArtifact(raw['artifact']);
  const actualHash = hashVettedPoolArtifact(artifact);
  if (actualHash !== ref.artifactHash) {
    throw new Error(`vetted pool publication hash mismatch: ref=${ref.artifactHash} artifact=${actualHash}`);
  }
  return {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    updatedAt: raw['updatedAt'],
    ref,
    artifact,
  };
}

/**
 * Detect whether a vetted-pool publication was built against an older
 * EVAL_SEMANTICS_VERSION than the running daemon expects. The daemon's
 * read helpers filter mismatched publications to null, so the operator-
 * dashboard cannot otherwise distinguish "no publication yet" from "stale
 * publication blocked by version mismatch". Surface that distinction with
 * this helper so downstream callers can render a one-line "re-publish
 * needed" hint (#796).
 */
export function isPublicationStale(
  publication: VettedPoolArtifactPublication | null,
  currentEvalSemanticsVersion: string,
): boolean {
  if (publication === null) return false;
  return publication.ref.evalSemanticsVersion !== currentEvalSemanticsVersion;
}

/**
 * Like {@link readVettedPoolArtifactPublication} but does not filter by
 * `evalSemanticsVersion`. Returns the publication regardless of version
 * mismatch so callers can use {@link isPublicationStale} to render a
 * stale-publication hint.
 */
export async function readVettedPoolArtifactPublicationUnfiltered(args: {
  stateDir: string;
  manifestCid?: string;
}): Promise<VettedPoolArtifactPublication | null> {
  // Delegate to the filtered reader, omitting evalSemanticsVersion so the
  // version filter stays inactive — that is the whole "unfiltered" difference.
  return readVettedPoolArtifactPublication(args);
}

export async function readVettedPoolArtifactPublication(args: {
  stateDir: string;
  manifestCid?: string;
  evalSemanticsVersion?: string;
}): Promise<VettedPoolArtifactPublication | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(publicationPath(args.stateDir), 'utf8'));
  } catch {
    return null;
  }
  const publication = parsePublication(raw);
  if (args.manifestCid !== undefined && publication.ref.manifestCid !== args.manifestCid) return null;
  if (args.evalSemanticsVersion !== undefined && publication.ref.evalSemanticsVersion !== args.evalSemanticsVersion) return null;
  return publication;
}

export async function writeVettedPoolArtifactPublication(args: {
  stateDir: string;
  ref: SolverNetArtifactRef;
  artifact: SweRebenchV2VettedPoolArtifact;
  updatedAt?: string;
}): Promise<VettedPoolArtifactPublication> {
  const artifact = parseVettedPoolArtifact(args.artifact);
  const ref = parseVettedPoolArtifactRef(args.ref);
  const artifactHash = hashVettedPoolArtifact(artifact);
  if (artifactHash !== ref.artifactHash) {
    throw new Error(`vetted pool publication hash mismatch: ref=${ref.artifactHash} artifact=${artifactHash}`);
  }
  const publication: VettedPoolArtifactPublication = {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    updatedAt: args.updatedAt ?? new Date().toISOString(),
    ref,
    artifact,
  };
  await writeJsonAtomic(publicationPath(args.stateDir), publication);
  return publication;
}

export type AdmissionMode = 'required' | 'python-floor';

/**
 * Restrict the generator's posting pool.
 *
 * Required mode (default for launched/public generators): only admitted
 * scorable instances are eligible. Absent or stale admission data → empty
 * pool. The generator is expected to surface a startup warning instructing
 * the operator to run `jinn solver-nets validate-pool`.
 *
 * Python-floor mode (local/dev opt-in): if admission data is present, use
 * it; otherwise fall back to Python-only instances (today's pre-fufn
 * behaviour). Preserved so contributors can iterate without running a
 * full validation pass.
 *
 * The `nebius/SWE-rebench-leaderboard` rows don't carry an explicit `language`
 * field (it's `undefined`/`null` on every row), so we also infer from the
 * patch file extensions — mirroring `inferLanguageFromPatch` in the solver-type.
 */
export function filterToScorablePool(
  pool: PoolTask[],
  scorableIds: Set<string> | null,
  admissionMode: AdmissionMode = 'required',
): { pool: PoolTask[]; mode: 'validated' | 'python-floor' | 'admission-required-no-data' } {
  if (scorableIds) {
    return { pool: pool.filter((t) => scorableIds.has(t.instance_id)), mode: 'validated' };
  }
  if (admissionMode === 'python-floor') {
    return { pool: pool.filter(isPythonInstance), mode: 'python-floor' };
  }
  return { pool: [], mode: 'admission-required-no-data' };
}

function isPythonInstance(task: PoolTask): boolean {
  if (task.language === 'python') return true;
  if (task.language && task.language !== 'python') return false;
  // language unset → infer from `.py` in any patch path.
  return looksPython(task.patch) || looksPython(task.test_patch);
}

function looksPython(patch: string | undefined): boolean {
  if (!patch) return false;
  // Match `--- a/<p>` / `+++ b/<p>` / `diff --git a/<p>` ending in .py
  return /(?:^|\n)(?:---|\+\+\+|diff --git) [ab]\/\S+\.py(?:\s|$)/.test(patch);
}

export interface ValidatePoolDeps {
  fetcher: HfFetcher;
  runner: EvalRunner;
  store: ValidatedPoolStore;
  semanticsVersion: string;
  /** v3+: directory of the enabled upstream SWE-rebench repo — used to resolve `upstreamEvalCommit`. Required: every caller must opt in to v3 semantics explicitly. */
  upstreamRepoDir: string;
  /** Defaults to spawn-based runner; tests inject a stub. */
  commandRunner?: CommandRunner;
  log?: (msg: string) => void;
}

export interface ValidatePoolSummary {
  checked: number;     // instances we ran the gold-eval for this run
  scorable: number;    // of those, marked scorable
  unscorable: number;  // of those, marked unscorable
  skipped: number;     // non-Python instances we didn't even try
}

function nameOf(err: unknown): string {
  return typeof err === 'object' && err !== null && typeof (err as { name?: unknown }).name === 'string'
    ? (err as { name: string }).name : '';
}
function reasonOf(err: unknown): string {
  return typeof err === 'object' && err !== null && typeof (err as { reason?: unknown }).reason === 'string'
    ? (err as { reason: string }).reason : 'unknown';
}

/** Known-bad patch for discrimination: empty unified diff must not resolve. */
export const KNOWN_BAD_DISCRIMINATION_PATCH = '';

export async function runDiscriminationCheck(args: {
  task: PoolTask;
  row: HfRow;
  runner: EvalRunner;
  poolSource: ValidatePoolSource;
  substrate: Pick<ValidatedPoolEntry, 'checkedAt' | 'rowHash' | 'imageName' | 'imageDigest' | 'upstreamEvalCommit'>;
}): Promise<Pick<ValidatedPoolEntry, 'scorable' | 'reason' | 'discrimination'>> {
  const badRes = await args.runner.runEval({
    instance_id: args.task.instance_id,
    repo: args.task.repo ?? args.row.repo,
    image: args.row.image_name,
    patch: KNOWN_BAD_DISCRIMINATION_PATCH,
    test_patch: args.row.test_patch ?? args.task.test_patch,
    install: args.row.install_config.install,
    test_cmd: args.row.install_config.test_cmd,
    log_parser: args.row.install_config.log_parser,
    fail_to_pass: args.row.FAIL_TO_PASS,
    pass_to_pass: args.row.PASS_TO_PASS,
  });
  if (badRes.passed_match) {
    if (args.poolSource === 'minted') {
      return { scorable: false, reason: WEAK_SUITE_REASON, discrimination: 'fail' };
    }
    return {
      scorable: true,
      reason: 'gold-patch-resolves',
      discrimination: 'fail',
    };
  }
  return { scorable: true, reason: 'gold-patch-resolves', discrimination: 'pass' };
}

export interface RecheckDiscriminationOpts {
  /** Same `PoolTask[]` `validatePoolInstances` consumes — a `ValidatedPoolEntry`
   *  doesn't itself carry `hf_dataset`/`hf_split`, so the pool is needed to
   *  re-fetch each instance's HF row for the eval. */
  pool: PoolTask[];
  store: ValidatedPoolStore;
  fetcher: HfFetcher;
  runner: EvalRunner;
  semanticsVersion: string;
  /** Optional batch bound for long pools. */
  limit?: number;
  log?: (msg: string) => void;
}

export interface RecheckDiscriminationSkipped {
  /** Entry already carries `discrimination: 'pass' | 'fail'`. */
  alreadyVerdicted: number;
  /** Batch bound (`opts.limit`) reached before this entry was reached. */
  limitExceeded: number;
  /** No matching `PoolTask` in `opts.pool` — nothing to re-fetch. */
  orphanedPoolTask: number;
  /** Fetch or eval failed; entry stays unchecked for a future retry. */
  evalError: number;
}

export function emptyRecheckDiscriminationSkipped(): RecheckDiscriminationSkipped {
  return { alreadyVerdicted: 0, limitExceeded: 0, orphanedPoolTask: 0, evalError: 0 };
}

export interface RecheckDiscriminationSummary {
  checked: number;
  flagged: string[];
  skipped: RecheckDiscriminationSkipped;
}

/**
 * D3 second half: retroactively run the known-bad discrimination eval
 * ({@link runDiscriminationCheck}) against already-scorable entries validated
 * before the check existed (`discrimination === undefined`). Never re-runs
 * the gold patch — only the cheap known-bad-patch eval.
 *
 * Benchmark pool ⇒ flag only: a flagged entry keeps `scorable: true` (matches
 * `runDiscriminationCheck`'s `poolSource: 'benchmark'` branch) — existing pool
 * entries are never hard-rejected by a recheck.
 *
 * Entries already carrying a verdict (`discrimination === 'pass' | 'fail'`)
 * are skipped, as are entries with no matching `PoolTask` in `pool` (nothing
 * to re-fetch the HF row with) and entries beyond `opts.limit`. A fetch/eval
 * error for one instance is logged and counted as skipped rather than
 * aborting the whole pass — the entry's `discrimination` stays `undefined`
 * so a future recheck retries it.
 */
export async function recheckDiscrimination(opts: RecheckDiscriminationOpts): Promise<RecheckDiscriminationSummary> {
  const log = opts.log ?? (() => {});
  const scorable = await opts.store.getScorableEntries(opts.semanticsVersion);
  const flagged: string[] = [];
  let checked = 0;
  const skipped = emptyRecheckDiscriminationSkipped();
  if (!scorable) return { checked, flagged, skipped };

  const taskById = new Map(opts.pool.map((t) => [t.instance_id, t]));
  for (const [instanceId, entry] of Object.entries(scorable.entries)) {
    if (entry.discrimination !== undefined) { skipped.alreadyVerdicted += 1; continue; }
    const task = taskById.get(instanceId);
    if (!task) { skipped.orphanedPoolTask += 1; continue; }
    if (opts.limit !== undefined && checked >= opts.limit) { skipped.limitExceeded += 1; continue; }
    try {
      const row = await opts.fetcher.fetchTaskRow({ hf_dataset: task.hf_dataset, hf_split: task.hf_split, instance_id: instanceId });
      const disc = await runDiscriminationCheck({
        task,
        row,
        runner: opts.runner,
        poolSource: 'benchmark',
        substrate: { checkedAt: new Date().toISOString() },
      });
      checked += 1;
      if (disc.discrimination === 'fail') flagged.push(instanceId);
      await opts.store.record(instanceId, { ...entry, discrimination: disc.discrimination }, opts.semanticsVersion);
      log(`[recheck-discrimination] ${instanceId} → ${disc.discrimination}`);
    } catch (err) {
      skipped.evalError += 1;
      log(`[recheck-discrimination] ${instanceId} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { checked, flagged, skipped };
}

/**
 * Build a bounded-transient `ValidatedPoolEntry`. Shared by the HF-429 branch
 * and the operator-environment infra branch (issue #811): both record a
 * `transient:` reason that the next non-force pass re-processes, bumping
 * `transientRetryCount` until it reaches {@link MAX_TRANSIENT_PASSES}, at which
 * point the reason converges to a permanent terminal so a permanently-broken
 * instance stops churning.
 */
function buildBoundedTransientEntry(args: {
  priorCount: number;
  transientReason: string;
  permanentReason: string;
  checkedAt: string;
  rowHash?: string;
  imageName?: string;
  // `null` is accepted (the upstream-commit resolver returns null when the repo
  // dir is unavailable) and dropped by the truthiness spread below.
  upstreamEvalCommit?: string | null;
}): ValidatedPoolEntry {
  const next = args.priorCount + 1;
  const reason = next >= MAX_TRANSIENT_PASSES ? args.permanentReason : args.transientReason;
  return {
    scorable: false,
    reason,
    checkedAt: args.checkedAt,
    transientRetryCount: next,
    lastTransientAt: args.checkedAt,
    ...(args.rowHash ? { rowHash: args.rowHash } : {}),
    ...(args.imageName ? { imageName: args.imageName } : {}),
    ...(args.upstreamEvalCommit ? { upstreamEvalCommit: args.upstreamEvalCommit } : {}),
  };
}

/**
 * Validate pool instances by running their gold patch through the eval harness.
 * Idempotent: instances already recorded for `semanticsVersion` are skipped
 * unless `opts.force`. `opts.limit` caps how many gold-evals one run does.
 */
export async function validatePoolInstances(
  pool: PoolTask[],
  deps: ValidatePoolDeps,
  opts: {
    limit?: number;
    force?: boolean;
    poolSource?: ValidatePoolSource;
    /** Explicit G0b environments have an admitted non-pytest parser. */
    allowNonPythonInstanceIds?: ReadonlySet<string>;
  } = {},
): Promise<ValidatePoolSummary> {
  const poolSource = opts.poolSource ?? 'benchmark';
  const log = deps.log ?? (() => {});
  const runner = deps.commandRunner ?? defaultCommandRunner;
  const summary: ValidatePoolSummary = { checked: 0, scorable: 0, unscorable: 0, skipped: 0 };

  // Resolve the upstream eval commit once per run — it doesn't change mid-run.
  const upstreamEvalCommit = await resolveUpstreamEvalCommit(deps.upstreamRepoDir, runner);

  for (const task of pool) {
    if (opts.limit != null && summary.checked >= opts.limit) break;

    // Only pytest (Python) instances are supported by the eval-runner `test_cmd`
    // override; everything else can't be scored cleanly today. The leaderboard
    // rows don't carry an explicit language field — infer from the patch when
    // unset.
    if (!isPythonInstance(task) && !opts.allowNonPythonInstanceIds?.has(task.instance_id)) {
      await deps.store.record(task.instance_id, { scorable: false, reason: 'non-pytest-unsupported', checkedAt: new Date().toISOString() }, deps.semanticsVersion);
      summary.skipped += 1;
      continue;
    }
    if (!opts.force) {
      const priorEntry = await deps.store.getEntry(task.instance_id, deps.semanticsVersion);
      if (priorEntry !== null) {
        // Transient entries below the convergence boundary are intentionally
        // re-processed on the next pass (issue #578 AC2 — "the next run
        // reprocesses these instances"). Everything else (terminal) is
        // skipped under the existing idempotence guard.
        const isTransient = priorEntry.reason.startsWith('transient:');
        const count = priorEntry.transientRetryCount ?? 0;
        if (!(isTransient && count < MAX_TRANSIENT_PASSES)) {
          continue; // already validated (terminal) for this semantics version
        }
      }
    }
    if (!task.patch || !task.test_patch) {
      await deps.store.record(task.instance_id, { scorable: false, reason: 'missing-gold-patch', checkedAt: new Date().toISOString() }, deps.semanticsVersion);
      summary.checked += 1; summary.unscorable += 1;
      continue;
    }

    log(`[validate-pool] ${task.instance_id} …`);
    let row: HfRow | undefined;
    let rowHash: string | undefined;
    let entry: ValidatedPoolEntry;
    try {
      row = await deps.fetcher.fetchTaskRow({ hf_dataset: task.hf_dataset, hf_split: task.hf_split, instance_id: task.instance_id });
      rowHash = computeRowHash({
        hf_dataset: task.hf_dataset,
        hf_split: task.hf_split,
        instance_id: task.instance_id,
        repo: task.repo ?? row.repo,
        // PoolTask.base_commit is optional in the schema but in practice is always
        // present for SWE-rebench leaderboard rows. Falling back to the 40-hex zero
        // sentinel matches what the task generator stamps on-chain for rows that lack
        // a base_commit, ensuring the stored rowHash is byte-identical to the hash
        // recheckSubstrate recomputes at verdict time from the Zod-parsed task.
        base_commit: task.base_commit ?? '0000000000000000000000000000000000000000',
        image_name: row.image_name,
        patch: task.patch,
        test_patch: row.test_patch ?? task.test_patch,
        install_config: { ...row.install_config, install: row.install_config.install ?? [] },
        FAIL_TO_PASS: row.FAIL_TO_PASS,
        PASS_TO_PASS: row.PASS_TO_PASS,
      });
      const res = await deps.runner.runEval({
        instance_id: task.instance_id,
        repo: task.repo ?? row.repo,
        image: row.image_name,
        patch: task.patch,
        test_patch: row.test_patch ?? task.test_patch,
        install: row.install_config.install,
        test_cmd: row.install_config.test_cmd,
        log_parser: row.install_config.log_parser,
        fail_to_pass: row.FAIL_TO_PASS,
        pass_to_pass: row.PASS_TO_PASS,
      });
      const checkedAt = new Date().toISOString();
      // Prefer the digest captured by a real runner before per-round pruning.
      // Test runners that do not carry it still use the legacy post-eval
      // Docker inspect fallback.
      const imageDigest = res.imageDigest ?? await resolveImageDigest(row.image_name, runner);
      const substrate = {
        checkedAt,
        rowHash,
        imageName: row.image_name,
        ...(imageDigest ? { imageDigest } : {}),
        ...(upstreamEvalCommit ? { upstreamEvalCommit } : {}),
      };
      if (!imageDigest) {
        // Every admission must carry a digest. No digest → not admissible.
        entry = { scorable: false, reason: 'unresolvable-image-digest', ...substrate };
      } else if (res.passed_match) {
        const disc = await runDiscriminationCheck({
          task,
          row,
          runner: deps.runner,
          poolSource,
          substrate: {
            checkedAt,
            rowHash,
            imageName: row.image_name,
            ...(imageDigest ? { imageDigest } : {}),
            ...(upstreamEvalCommit ? { upstreamEvalCommit } : {}),
          },
        });
        entry = { ...disc, ...substrate };
      } else {
        entry = { scorable: false, reason: `gold-patch-not-resolved (f2p ${res.passed.length}, p2p_broke ${res.failed.length})`, ...substrate };
      }
    } catch (err) {
      const httpStatus = typeof (err as { httpStatus?: unknown } | null)?.httpStatus === 'number'
        ? (err as { httpStatus: number }).httpStatus
        : undefined;
      const checkedAt = new Date().toISOString();
      const evalInfraReason = nameOf(err) === 'EvalCouldNotGradeError' ? reasonOf(err) : null;
      if (httpStatus === 429) {
        // Transient HF rate-limit: classify so the next pass re-processes
        // (issue #578). Re-read the prior entry inside the catch so the
        // count reflects the persisted state, not a stale in-memory copy.
        const priorEntry = await deps.store.getEntry(task.instance_id, deps.semanticsVersion);
        const msg = (err instanceof Error ? err.message : String(err)).slice(0, 200);
        entry = buildBoundedTransientEntry({
          priorCount: priorEntry?.transientRetryCount ?? 0,
          transientReason: `transient:HF-429:${msg}`,
          permanentReason: PERMANENT_HF_429_REASON,
          checkedAt,
          rowHash,
          imageName: row?.image_name,
          upstreamEvalCommit,
        });
      } else if (evalInfraReason !== null && TRANSIENT_INFRA_REASONS.has(evalInfraReason)) {
        // Operator-environment infra failure that may differ on a retry
        // (issue #811). Route through the same bounded-transient path as
        // HF-429 instead of caching it terminal. Re-read the prior entry so
        // the count reflects persisted state. After MAX_TRANSIENT_PASSES it
        // converges to the terminal `ungradeable:<reason>` — the same resting
        // state today's code reaches immediately, just after bounded retries.
        //
        // Histogram: the transient reason is `transient:<infra_reason>` with no
        // message suffix, so it is already a clean self-describing bucket and
        // needs no normalize rule (unlike `transient:HF-429:<msg>`).
        const priorEntry = await deps.store.getEntry(task.instance_id, deps.semanticsVersion);
        entry = buildBoundedTransientEntry({
          priorCount: priorEntry?.transientRetryCount ?? 0,
          transientReason: `transient:${evalInfraReason}`,
          permanentReason: `ungradeable:${evalInfraReason}`,
          checkedAt,
          rowHash,
          imageName: row?.image_name,
          upstreamEvalCommit,
        });
      } else {
        const reason = evalInfraReason !== null
          ? `ungradeable:${evalInfraReason}`
          : `error:${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
        entry = {
          scorable: false,
          reason,
          checkedAt,
          ...(rowHash ? { rowHash } : {}),
          ...(row ? { imageName: row.image_name } : {}),
          ...(upstreamEvalCommit ? { upstreamEvalCommit } : {}),
        };
      }
    }
    await deps.store.record(task.instance_id, entry, deps.semanticsVersion);
    summary.checked += 1;
    if (entry.scorable) summary.scorable += 1; else summary.unscorable += 1;
    log(`[validate-pool] ${task.instance_id} → ${entry.scorable ? 'SCORABLE' : 'unscorable'} (${entry.reason})`);
  }
  return summary;
}
