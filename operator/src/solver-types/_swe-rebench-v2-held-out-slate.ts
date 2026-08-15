/**
 * Held-out task slate for the swe-rebench-v2 RL eval harness (issue #817).
 *
 * A slate is a versioned, content-addressed set of swe-rebench-v2
 * `instance_id`s RESERVED from the training pool. The generator excludes
 * slate instances from the train stream so they never enter training; a
 * future eval orchestrator runs solvers against the slate to measure
 * out-of-sample performance. Scores are only comparable *within* a slate
 * version — a version bump (`v2`, …) is a distinct artifact with a distinct
 * content hash, never compared against an earlier version.
 *
 * The artifact ships as a JSON file under `slates/` next to this module
 * (`held-out-slate.swe-rebench-v2.<version>.json`). It carries a self-declared
 * content hash: the loader recomputes a sha256 over the canonicalised,
 * instance-id-sorted artifact and compares it to the file's `hash` field,
 * failing loud on mismatch. This guards against accidental drift — a hand-edit
 * that adds or removes an instance without re-deriving the hash. It is NOT a
 * tamper-proof anchor: the declared hash lives in the same file it verifies, so
 * a deliberate edit that also re-derives the hash passes, and the check is
 * skipped entirely when the `hash` field is absent. A real trust anchor (an
 * external/on-chain hash) is out of scope here.
 *
 * Hashing mirrors `hashVettedPoolArtifact` in `_swe-rebench-v2-validated-pool`:
 * `sha256(canonicalJson(normalized))` with a `sha256:` prefix.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath, join } from 'node:path';
import { canonicalJson } from '../util/canonical-json.js';
import type { PoolTask } from './_swe-rebench-v2-pool.js';

export const HELD_OUT_SLATE_SCHEMA_VERSION = 'held-out-slate.v1' as const;

export interface HeldOutSlateArtifact {
  schemaVersion: typeof HELD_OUT_SLATE_SCHEMA_VERSION;
  solverType: string;
  version: string;
  generatedAt: string;
  instanceIds: string[];
}

export interface LoadedHeldOutSlate {
  version: string;
  hash: `sha256:${string}`;
  instanceIds: Set<string>;
}

function isObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null;
}

export function parseHeldOutSlateArtifact(raw: unknown): HeldOutSlateArtifact {
  if (!isObject(raw)) throw new Error('held-out slate artifact must be an object');
  if (raw['schemaVersion'] !== HELD_OUT_SLATE_SCHEMA_VERSION) {
    throw new Error(`held-out slate schemaVersion must be ${HELD_OUT_SLATE_SCHEMA_VERSION}`);
  }
  if (typeof raw['solverType'] !== 'string' || raw['solverType'].length === 0) {
    throw new Error('held-out slate solverType must be a non-empty string');
  }
  if (typeof raw['version'] !== 'string' || raw['version'].length === 0) {
    throw new Error('held-out slate version must be a non-empty string');
  }
  if (typeof raw['generatedAt'] !== 'string') {
    throw new Error('held-out slate generatedAt must be a string');
  }
  if (
    !Array.isArray(raw['instanceIds']) ||
    raw['instanceIds'].some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    throw new Error('held-out slate instanceIds must be an array of non-empty strings');
  }
  return {
    schemaVersion: HELD_OUT_SLATE_SCHEMA_VERSION,
    solverType: raw['solverType'],
    version: raw['version'],
    generatedAt: raw['generatedAt'],
    instanceIds: (raw['instanceIds'] as string[]).slice(),
  };
}

function normalizeHeldOutSlateArtifact(artifact: HeldOutSlateArtifact): HeldOutSlateArtifact {
  return {
    schemaVersion: HELD_OUT_SLATE_SCHEMA_VERSION,
    solverType: artifact.solverType,
    version: artifact.version,
    generatedAt: artifact.generatedAt,
    instanceIds: [...artifact.instanceIds].sort((a, b) => a.localeCompare(b)),
  };
}

export function hashHeldOutSlateArtifact(artifact: HeldOutSlateArtifact): `sha256:${string}` {
  const canonical = canonicalJson(normalizeHeldOutSlateArtifact(artifact));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Resolve the slate file directory. At runtime the compiled module lives at
 * `dist/solver-types/<this>.js` and the slate JSON at `dist/solver-types/slates/`
 * (copied during `yarn build`); in dev/test the source module is at
 * `src/solver-types/<this>.ts` with the slate JSON at `src/solver-types/slates/`.
 * `./slates` resolves correctly in both layouts.
 */
function slatesDir(): string {
  return resolvePath(dirname(fileURLToPath(import.meta.url)), 'slates');
}

function slateFileName(solverType: string, version: string): string {
  if (!/^v\d+$/.test(version)) {
    throw new Error(
      `held-out slate version must match /^v\\d+$/ (got ${JSON.stringify(version)})`,
    );
  }
  return `held-out-slate.${solverType.replace(/\.v\d+$/, '')}.${version}.json`;
}

/**
 * Load the held-out slate for `solverType` at `version`. Validates the version
 * shape, that the file's declared `solverType`/`version` match the request, and
 * (when a `hash` field is present) that the recomputed content hash matches it —
 * catching accidental edit-without-rehash drift, not deliberate tampering (see
 * the module header). Throws if no slate file exists for the requested version
 * (scores are only comparable within a known version).
 *
 * `opts.dir` overrides the slate file directory; it defaults to the
 * module-relative `slatesDir()`. Production callers omit it (and so resolve the
 * shipped slates); tests inject a temp dir to drive the fail-loud throw paths
 * against malformed fixtures.
 */
export function loadHeldOutSlate(
  solverType: string,
  version: string,
  opts: { dir?: string } = {},
): LoadedHeldOutSlate {
  const path = join(opts.dir ?? slatesDir(), slateFileName(solverType, version));
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `held-out slate not found for solverType=${solverType} version=${version} (expected ${path})`,
    );
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const artifact = parseHeldOutSlateArtifact(parsed);
  if (artifact.version !== version) {
    throw new Error(
      `held-out slate version mismatch: file declares ${artifact.version}, requested ${version}`,
    );
  }
  if (artifact.solverType !== solverType) {
    throw new Error(
      `held-out slate solverType mismatch: file declares ${artifact.solverType}, requested ${solverType}`,
    );
  }
  const hash = hashHeldOutSlateArtifact(artifact);
  const declared = parsed['hash'];
  if (typeof declared === 'string' && declared !== hash) {
    throw new Error(
      `held-out slate hash mismatch for ${solverType} ${version}: declared ${declared}, computed ${hash} (artifact was edited without re-deriving the hash)`,
    );
  }
  return { version: artifact.version, hash, instanceIds: new Set(artifact.instanceIds) };
}

/**
 * Drop any pool task whose `instance_id` is in the held-out slate. This is the
 * single train-stream exclusion (issue #817 AC#2): the generator is the sole
 * train-stream chokepoint, so a slate instance filtered here is never posted,
 * never claimable, and never trains.
 */
export function excludeHeldOutSlate(pool: PoolTask[], slateIds: Set<string>): PoolTask[] {
  if (slateIds.size === 0) return pool;
  return pool.filter((task) => !slateIds.has(task.instance_id));
}

/**
 * Slate versions currently used as held-out exams. The generator excludes the
 * UNION of these from the train stream, so every active exam stays out of
 * training while non-slate instances of every repo remain trainable. Add a
 * version here ONLY when its slate file exists (loadHeldOutSlate fails loud on
 * a missing file).
 */
export const ACTIVE_HELD_OUT_SLATE_VERSIONS = ['v1', 'v2', 'v3'] as const;

/** Union of instance ids across the given active slate versions. */
export function loadActiveHeldOutSlateIds(
  solverType: string,
  versions: readonly string[],
  opts: { dir?: string } = {},
): Set<string> {
  const ids = new Set<string>();
  for (const version of versions) {
    for (const id of loadHeldOutSlate(solverType, version, opts).instanceIds) ids.add(id);
  }
  return ids;
}
