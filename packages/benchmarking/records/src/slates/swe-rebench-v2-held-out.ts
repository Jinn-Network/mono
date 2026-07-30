/**
 * Held-out task slate for the swe-rebench-v2 RL eval harness (issue #817/#820).
 *
 * Canonical home per the 2026-07-30 marketplace-surfaces design (§7 step 1):
 * this module is the surviving single source of the held-out membership as
 * the SolverNet-era copies (client artifact, legacy sdk embed) retire. The
 * cross-source parity test beside this file holds all copies byte-identical
 * until then.
 *
 * This is a **data module**: it embeds the frozen v1 artifact and loads it by
 * version. It does not recompute or verify the declared `hash` at runtime —
 * there is no canonicalizer, no string comparator, and no `node:crypto` import
 * here, deliberately, per the records tree's ban on locale-sensitive APIs in
 * production source (`.github/scripts/benchmarking-source-boundaries.test.mjs`;
 * canonical/hashed bytes must stay host-independent).
 *
 * The v1 `hash` below was historically derived (in the legacy client module
 * this artifact was copied from) by sorting `instanceIds` with
 * `Array.prototype.sort` + `String.prototype.localeCompare` before hashing —
 * a known latent environment-dependence (locale-default collation can differ
 * host to host) that predates this module and is carried here only as a
 * frozen, already-computed value, never re-derived. Recomputing it here would
 * either (a) reproduce that same locale dependence in a tree that explicitly
 * bans it, or (b) use a different (locale-independent) comparator and risk a
 * different sort order — and therefore a different hash — which would be an
 * in-place identity change of a versioned slate, forbidden by the slate's own
 * versioning rule (a membership change is a new version, never an edit).
 *
 * Drift protection is therefore CI-time, not runtime: the parity test beside
 * this file recomputes the historical (locale-based) hash from these
 * constants and asserts it against both the declared `HELD_OUT_SLATE_V1.hash`
 * and the client artifact's hash. This trades the old loader's fail-loud
 * runtime self-verification for a CI-time guarantee. Any future slate version
 * (v2+) must derive its hash with UTF-16 code-unit ordering
 * (`compareCodeUnitStrings` in `../order.js`) per the stack's sealing rule —
 * never locale-based collation.
 *
 * The embedded `instanceIds` + `hash` are kept byte-identical to the client
 * artifact (`client/src/solver-types/slates/held-out-slate.swe-rebench-v2.v1.json`)
 * by the cross-source parity test. Scores are only comparable WITHIN a
 * version; a slate change is a distinct version (v2, ...), never an in-place
 * edit.
 */

export const HELD_OUT_SLATE_SCHEMA_VERSION = 'held-out-slate.v1' as const;

export interface HeldOutSlateArtifact {
  schemaVersion: typeof HELD_OUT_SLATE_SCHEMA_VERSION;
  solverType: string;
  version: string;
  generatedAt: string;
  instanceIds: string[];
  /** Declared content hash (sha256 over the canonical, sorted artifact). */
  hash: `sha256:${string}`;
}

export interface LoadedHeldOutSlate {
  version: string;
  hash: `sha256:${string}`;
  instanceIds: Set<string>;
}

/**
 * Embedded v1 slate. Byte-identical (sans the `comment` doc field, which is not
 * part of the hashed artifact) to
 * `client/src/solver-types/slates/held-out-slate.swe-rebench-v2.v1.json`.
 * Guarded against drift by the parity test beside this file, and by
 * `packages/sdk/test/solvernets/swe-rebench-v2-held-out-slate-cross-source.test.ts`
 * for the sdk ↔ client pair.
 */
export const HELD_OUT_SLATE_V1: HeldOutSlateArtifact = {
  schemaVersion: 'held-out-slate.v1',
  solverType: 'swe-rebench-v2.v1',
  version: 'v1',
  generatedAt: '2026-05-29T00:00:00.000Z',
  hash: 'sha256:2b029de15e271d5d2de35fe6477af98aef9fdc46f357e59139179edab1a42b15',
  instanceIds: [
    'ASPP__pelita-863',
    'ASPP__pelita-875',
    'AbsaOSS__generate-release-notes-207',
    'All-Hands-AI__OpenHands-11914',
    'BQSKit__bqskit-337',
    'BerriAI__litellm-14715',
    'BerriAI__litellm-15753',
    'BrianPugh__cyclopts-609',
    'carsdotcom__skelebot-280',
    'pandas-dev__pandas-60736',
  ],
};

const SLATES_BY_VERSION: Record<string, HeldOutSlateArtifact> = {
  v1: HELD_OUT_SLATE_V1,
};

/**
 * Load the held-out slate membership for the swe-rebench-v2 solverType at
 * `version`. Returns the frozen, declared `hash` as-is (see module header —
 * this module never recomputes it). Throws for an unknown version (scores
 * are only comparable within a known version).
 */
export function loadHeldOutSlate(version: string): LoadedHeldOutSlate {
  const artifact = SLATES_BY_VERSION[version];
  if (!artifact) {
    throw new Error(`held-out slate not found for swe-rebench-v2 version=${version}`);
  }
  if (artifact.version !== version) {
    throw new Error(
      `held-out slate version mismatch: artifact declares ${artifact.version}, requested ${version}`,
    );
  }
  return { version: artifact.version, hash: artifact.hash, instanceIds: new Set(artifact.instanceIds) };
}
