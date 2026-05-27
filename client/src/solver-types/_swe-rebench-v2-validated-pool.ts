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
import { canonicalJson } from '../harnesses/engine/canonical-json.js';

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
 */
export const EVAL_SEMANTICS_VERSION = '4';

const SCHEMA_VERSION = 'swe-rebench-v2-validated-pool.v1' as const;
export const SWE_REBENCH_V2_VETTED_POOL_ARTIFACT_TYPE = 'swe-rebench-v2-vetted-pool.v1' as const;
export const SOLVERNET_ARTIFACT_REF_SCHEMA_VERSION = 'solvernet.artifact-ref.v1' as const;
export const VETTED_POOL_REF_ELIGIBILITY_KEY = 'vettedPoolRef' as const;
const PUBLICATION_SCHEMA_VERSION = 'swe-rebench-v2-vetted-pool-publication.v1' as const;
const PUBLICATION_FILE = 'vetted-pool-artifact-publication.json';

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
}

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

function parseVettedPoolArtifactEntry(raw: unknown): SweRebenchV2VettedPoolArtifactEntry | null {
  if (!isObject(raw)) return null;
  if (typeof raw['instance_id'] !== 'string' || raw['instance_id'].length === 0) return null;
  if (raw['scorable'] !== true) return null;
  if (typeof raw['reason'] !== 'string') return null;
  if (typeof raw['checkedAt'] !== 'string') return null;
  const entry: SweRebenchV2VettedPoolArtifactEntry = {
    instance_id: raw['instance_id'],
    scorable: true,
    reason: raw['reason'],
    checkedAt: raw['checkedAt'],
    ...(typeof raw['rowHash'] === 'string' ? { rowHash: raw['rowHash'] } : {}),
    ...(typeof raw['imageName'] === 'string' ? { imageName: raw['imageName'] } : {}),
    ...(typeof raw['imageDigest'] === 'string' ? { imageDigest: raw['imageDigest'] } : {}),
    ...(typeof raw['upstreamEvalCommit'] === 'string' ? { upstreamEvalCommit: raw['upstreamEvalCommit'] } : {}),
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
    this.cache = isValidFile(raw, evalSemanticsVersion) ? raw : freshFile(evalSemanticsVersion);
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
    const ids = isValidFile(raw, evalSemanticsVersion)
      ? new Set(Object.entries(raw.entries).filter(([, e]) => e.scorable).map(([id]) => id))
      : null;
    this.scorableIdsCache = { mtimeMs, semanticsVersion: evalSemanticsVersion, ids };
    return ids;
  }

  async getScorableEntries(evalSemanticsVersion: string): Promise<{
    entries: Record<string, ValidatedPoolEntry>;
    updatedAt: string;
  } | null> {
    const raw = await this.readRaw();
    if (!isValidFile(raw, evalSemanticsVersion)) return null;
    return {
      updatedAt: raw.updatedAt,
      entries: Object.fromEntries(Object.entries(raw.entries).filter(([, entry]) => entry.scorable)),
    };
  }

  /** The entry for `instanceId`, or `null` if not validated for this semantics version. */
  async getEntry(instanceId: string, evalSemanticsVersion: string): Promise<ValidatedPoolEntry | null> {
    const f = await this.loadForWrite(evalSemanticsVersion);
    return f.entries[instanceId] ?? null;
  }

  async record(instanceId: string, entry: ValidatedPoolEntry, evalSemanticsVersion: string): Promise<void> {
    return withWriteLock(this.file, async () => {
      // Reload from disk so a concurrent write isn't lost. The in-memory cache
      // is invalidated; the next read re-loads.
      this.cache = null;
      this.scorableIdsCache = null;
      const raw = await this.readRaw();
      const file = isValidFile(raw, evalSemanticsVersion) ? raw : freshFile(evalSemanticsVersion);
      file.entries[instanceId] = entry;
      file.updatedAt = new Date().toISOString();
      await this.writeAtomic(file);
      this.cache = file;
    });
  }
}

/**
 * Collapse a stored `reason` string into a histogram bucket. Diagnostic
 * detail (`(f2p X, p2p_broke Y)`, the verbatim HF 429 message) is kept on
 * the entry for debugging, but the bucket name is what matters for the
 * #493 reason-histogram CLI. Unknown reasons pass through unchanged.
 */
export function normalizeReason(reason: string): string {
  if (reason.startsWith('gold-patch-not-resolved')) return 'gold-patch-not-resolved';
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

export async function exportScorableVettedPoolArtifact(
  store: ValidatedPoolStore,
  evalSemanticsVersion: string,
  opts: { generatedAt?: string } = {},
): Promise<SweRebenchV2VettedPoolArtifact | null> {
  const scorable = await store.getScorableEntries(evalSemanticsVersion);
  if (!scorable) return null;
  const entries = Object.entries(scorable.entries)
    .map(([instance_id, entry]) => ({
      instance_id,
      scorable: true as const,
      reason: entry.reason,
      checkedAt: entry.checkedAt,
      ...(entry.rowHash ? { rowHash: entry.rowHash } : {}),
      ...(entry.imageName ? { imageName: entry.imageName } : {}),
      ...(entry.imageDigest ? { imageDigest: entry.imageDigest } : {}),
      ...(entry.upstreamEvalCommit ? { upstreamEvalCommit: entry.upstreamEvalCommit } : {}),
    }))
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
 * dashboard cannot today distinguish "no publication yet" from "stale
 * publication blocked by version mismatch". Surface that distinction
 * with this helper so downstream callers can render a one-line
 * "re-publish needed" hint (#493).
 *
 * TODO(#493): wire this into the operator-dashboard's SolverNet detail
 * view (separate PR — the dashboard data model lives in
 * client/OPERATOR-APP-SPEC.md and the wiring path is non-trivial).
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
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(publicationPath(args.stateDir), 'utf8'));
  } catch {
    return null;
  }
  const publication = parsePublication(raw);
  if (args.manifestCid !== undefined && publication.ref.manifestCid !== args.manifestCid) return null;
  return publication;
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

/**
 * Validate pool instances by running their gold patch through the eval harness.
 * Idempotent: instances already recorded for `semanticsVersion` are skipped
 * unless `opts.force`. `opts.limit` caps how many gold-evals one run does.
 */
export async function validatePoolInstances(
  pool: PoolTask[],
  deps: ValidatePoolDeps,
  opts: { limit?: number; force?: boolean } = {},
): Promise<ValidatePoolSummary> {
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
    if (!isPythonInstance(task)) {
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
        entry = { scorable: true, reason: 'gold-patch-resolves', ...substrate };
      } else {
        entry = { scorable: false, reason: `gold-patch-not-resolved (f2p ${res.passed.length}, p2p_broke ${res.failed.length})`, ...substrate };
      }
    } catch (err) {
      const httpStatus = typeof (err as { httpStatus?: unknown } | null)?.httpStatus === 'number'
        ? (err as { httpStatus: number }).httpStatus
        : undefined;
      const checkedAt = new Date().toISOString();
      if (httpStatus === 429) {
        // Transient HF rate-limit: classify so the next pass re-processes
        // (issue #578). Re-read the prior entry inside the catch so the
        // count reflects the persisted state, not a stale in-memory copy.
        const priorEntry = await deps.store.getEntry(task.instance_id, deps.semanticsVersion);
        const prior = priorEntry?.transientRetryCount ?? 0;
        const next = prior + 1;
        const msg = (err instanceof Error ? err.message : String(err)).slice(0, 200);
        const reason = next >= MAX_TRANSIENT_PASSES
          ? PERMANENT_HF_429_REASON
          : `transient:HF-429:${msg}`;
        entry = {
          scorable: false,
          reason,
          checkedAt,
          transientRetryCount: next,
          lastTransientAt: checkedAt,
          ...(rowHash ? { rowHash } : {}),
          ...(row ? { imageName: row.image_name } : {}),
          ...(upstreamEvalCommit ? { upstreamEvalCommit } : {}),
        };
      } else {
        const reason = nameOf(err) === 'EvalCouldNotGradeError'
          ? `ungradeable:${reasonOf(err)}`
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
