/**
 * Held-out task slate for the swe-rebench-v2 RL eval harness (issue #817/#820).
 *
 * A slate is a versioned, content-addressed set of swe-rebench-v2
 * `instance_id`s RESERVED from the training pool. #817 ships the canonical
 * train-stream exclusion in `operator/`; the indexer (this package's consumer)
 * needs the same membership to slate-scope `frozenResolvedRate` (#820 AC#1),
 * but the indexer cannot import from `operator/` (see
 * `packages/indexer/src/handlers.ts` header). So the membership is embedded
 * here, in the SDK both the indexer and clients may depend on.
 *
 * The artifact is embedded (not read from disk) so the SDK stays a pure,
 * bundler-friendly module with no `node:fs` runtime dependency. It carries a
 * self-declared content hash: the loader recomputes a sha256 over the
 * canonicalised, instance-id-sorted artifact and fails loud on mismatch. This
 * preserves #817's fail-loud drift guard — a hand-edit that adds or removes an
 * instance without re-deriving the hash throws. It is NOT a tamper-proof
 * anchor (the declared hash lives beside the data it verifies); a deliberate
 * edit that also re-derives the hash passes.
 *
 * The embedded `instanceIds` + `hash` are kept byte-identical to the client
 * artifact (`operator/src/solver-types/slates/held-out-slate.swe-rebench-v2.v1.json`)
 * by a cross-source drift test. Scores are only comparable WITHIN a version; a
 * slate change is a distinct version (v2, ...), never an in-place edit.
 *
 * Hashing mirrors `_swe-rebench-v2-held-out-slate.ts` in `operator/`:
 * `sha256:` + sha256(RFC 8785 canonical JSON of the normalized artifact). The
 * artifact shape is flat (string scalars + a string array), so a minimal
 * inlined JCS canonicalizer reproduces the client's `canonicalize`-based hash
 * exactly — verified by the drift test.
 */

/// <reference types="node" />
import { createHash } from 'node:crypto';

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
 * `operator/src/solver-types/slates/held-out-slate.swe-rebench-v2.v1.json`.
 * Guarded against drift by `test/solvernets/swe-rebench-v2-held-out-slate-cross-source.test.ts`.
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
 * Minimal RFC 8785 (JCS) serialization for the flat slate artifact: object keys
 * sorted by UTF-16 code-unit order, string values JSON-escaped, arrays in
 * order. Reproduces the client loader's `canonicalize`-based output for this
 * shape exactly (the cross-source drift test locks this against the client
 * artifact's declared hash).
 */
function canonicalJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The hashed projection: schema/solver/version/generatedAt + the sorted
 * instanceIds. Excludes the `hash` field itself (a hash never hashes itself).
 */
function normalizeHeldOutSlateArtifact(artifact: HeldOutSlateArtifact): {
  schemaVersion: string;
  solverType: string;
  version: string;
  generatedAt: string;
  instanceIds: string[];
} {
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
 * Load the held-out slate membership for the swe-rebench-v2 solverType at
 * `version`. Recomputes the content hash and fails loud on mismatch against the
 * artifact's declared `hash` (catching accidental edit-without-rehash drift —
 * not deliberate tampering; see the module header). Throws for an unknown
 * version (scores are only comparable within a known version).
 *
 * `override` is for tests only — it lets the fail-loud guard be exercised
 * against a tampered copy without mutating the canonical embedded artifact.
 */
export function loadHeldOutSlate(
  version: string,
  override?: HeldOutSlateArtifact,
): LoadedHeldOutSlate {
  const artifact = override ?? SLATES_BY_VERSION[version];
  if (!artifact) {
    throw new Error(`held-out slate not found for swe-rebench-v2 version=${version}`);
  }
  if (artifact.version !== version) {
    throw new Error(
      `held-out slate version mismatch: artifact declares ${artifact.version}, requested ${version}`,
    );
  }
  const computed = hashHeldOutSlateArtifact(artifact);
  if (artifact.hash !== computed) {
    throw new Error(
      `held-out slate hash mismatch for swe-rebench-v2 ${version}: declared ${artifact.hash}, computed ${computed} (artifact was edited without re-deriving the hash)`,
    );
  }
  return { version: artifact.version, hash: computed, instanceIds: new Set(artifact.instanceIds) };
}
