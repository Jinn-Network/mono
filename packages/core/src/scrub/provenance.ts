/**
 * Scrub provenance for the published redaction manifest (#1974 / design §6.7).
 *
 * Locked Q5: additive optional fields on the existing redaction-manifest shape
 * (`schemaVersion` 2) — no TraceEnvelope rev. Old envelopes remain readable.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJson } from '../canonical-json.js';
import type { ScrubClass } from './finding.js';
import type { Disposition, PolicyTable } from './policy.js';

/** Manifest schema version that includes optional provenance fields. */
export const REDACTION_MANIFEST_SCHEMA_VERSION = 2;

/** Disposition kinds counted in `perClassCounts` (pass is omitted). */
export type CountedDisposition = 'redact' | 'flag' | 'reject';

export interface PolicyHashInput {
  /** Versioned disposition policy table. */
  policy: PolicyTable;
  /** Detector inventory (name + pinned version), order-insensitive. */
  detectors: ReadonlyArray<{ name: string; version: string }>;
  /** ML model id when the ML tier is present; null otherwise. */
  modelId: string | null;
  /** Zero-shot / NER label set hashed into the policy digest. */
  labels: readonly string[];
  /** Digest of the instance allowlist (see {@link computeAllowlistDigest}). */
  allowlistDigest: string;
}

/**
 * Stable key for one class × applied disposition in `perClassCounts`.
 * Reject-publish dispositions are recorded as `reject`.
 */
export function perClassCountKey(
  scrubClass: ScrubClass,
  disposition: CountedDisposition,
): string {
  return `${scrubClass}:${disposition}`;
}

/** Map a policy disposition onto the counted kind (or null for pass). */
export function countedDisposition(disposition: Disposition): CountedDisposition | null {
  if (disposition === 'pass') return null;
  if (disposition === 'reject-publish') return 'reject';
  return disposition;
}

/**
 * sha256 hex over a canonical JSON of allowlist entries sorted by
 * (value, kind). Provenance notes are excluded so the digest is about
 * *what* is allowlisted, not the human rationale string.
 */
export function computeAllowlistDigest(
  entries: ReadonlyArray<{ value: string; kind: string }>,
): string {
  const normalized = [...entries]
    .map((e) => ({ value: e.value.toLowerCase(), kind: e.kind }))
    .sort((a, b) => {
      const byValue = a.value.localeCompare(b.value);
      return byValue !== 0 ? byValue : a.kind.localeCompare(b.kind);
    });
  return sha256Hex(canonicalJson(normalized));
}

/**
 * Reproducible policy/composition hash: same inputs → same hex digest.
 * Payload is RFC 8785 canonical JSON of policy + sorted detectors + model
 * id + sorted labels + allowlist digest, then sha256.
 */
export function computePolicyHash(input: PolicyHashInput): string {
  const detectors = [...input.detectors]
    .map((d) => ({ name: d.name, version: d.version }))
    .sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      return byName !== 0 ? byName : a.version.localeCompare(b.version);
    });
  const labels = [...input.labels].sort((a, b) => a.localeCompare(b));
  const payload = {
    allowlistDigest: input.allowlistDigest,
    detectors,
    labels,
    modelId: input.modelId,
    policy: input.policy,
  };
  return sha256Hex(canonicalJson(payload));
}

/** Increment one class:disposition counter (mutates `counts`). */
export function incrementPerClassCount(
  counts: Record<string, number>,
  scrubClass: ScrubClass,
  disposition: Disposition,
): void {
  const kind = countedDisposition(disposition);
  if (!kind) return;
  const key = perClassCountKey(scrubClass, kind);
  counts[key] = (counts[key] ?? 0) + 1;
}

/** Sum two per-class count maps (missing → empty). */
export function mergePerClassCounts(
  a?: Record<string, number>,
  b?: Record<string, number>,
): Record<string, number> | undefined {
  if (!a && !b) return undefined;
  const out: Record<string, number> = { ...(a ?? {}) };
  for (const [key, n] of Object.entries(b ?? {})) {
    out[key] = (out[key] ?? 0) + n;
  }
  return out;
}

function sha256Hex(utf8: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(utf8)));
}
