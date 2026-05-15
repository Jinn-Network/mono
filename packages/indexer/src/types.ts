/**
 * Utility functions for the Jinn protocol indexer package.
 *
 * This file provides pure utility functions used by the Ponder event handlers
 * in src/index.ts. The DiscoveryAPI type mirrors that previously lived here
 * have been removed — the canonical types live in the daemon at
 * client/src/discovery/types.ts, and the GraphQL adapter has moved to
 * client/src/discovery/http.ts (jinn-mono-280n.4).
 *
 * The three functions below are the only things that belong here:
 *   - tierFromRaw: maps uint8 evidence tier to a string evidence tier value
 *   - parseEnvelopeKey: identifies and parses envelope metadata keys
 *   - parseSolverNetManifestKey: identifies SolverNet manifest metadata keys
 *
 * These operate solely on primitive values (strings, numbers) and have no
 * dependency on DiscoveryAPI shapes.
 */

// ── Evidence tier mapping ─────────────────────────────────────────────────────

/**
 * Maps the uint8 tier value from ABI-decoded payloads to the string
 * representation used by the Envelope schema column.
 */
export function tierFromRaw(value: number): 'self-signed' | 'committed' | 'attested' | 'unknown' {
  if (value === 0) return 'self-signed';
  if (value === 1) return 'committed';
  if (value === 3) return 'attested';
  return 'unknown';
}

/**
 * Parses the key of an IdentityRegistry.MetadataSet event to determine its
 * kind and CID. Returns null if the key does not match any known pattern.
 *
 * Known key patterns (from client/src/corpus/onchain-query.ts):
 *   `envelope:<cid>`    — execution evidence
 *   `evaluation:<cid>`  — evaluation verdict
 *   `capture:<cid>`     — capture
 */
export function parseEnvelopeKey(key: string): { kind: string; cid: string } | null {
  const colon = key.indexOf(':');
  if (colon <= 0 || colon === key.length - 1) return null;
  const kind = key.slice(0, colon);
  if (kind !== 'envelope' && kind !== 'evaluation' && kind !== 'capture') return null;
  return { kind, cid: key.slice(colon + 1) };
}

/**
 * Returns the CID from a SolverNet manifest metadata key
 * (`solvernet-manifest:<cid>`), or null if the key does not match.
 */
export const SOLVERNET_MANIFEST_KEY_PREFIX = 'solvernet-manifest:';

export function parseSolverNetManifestKey(key: string): string | null {
  if (!key.startsWith(SOLVERNET_MANIFEST_KEY_PREFIX)) return null;
  const cid = key.slice(SOLVERNET_MANIFEST_KEY_PREFIX.length);
  return cid.length > 0 ? cid : null;
}

// ── HarnessCheckpoint key parsing ─────────────────────────────────────────────

export const HARNESS_CHECKPOINT_KEY_PREFIX = 'harness.checkpoint:';

/**
 * Returns the manifest CID from a `harness.checkpoint:<cid>` key, or null.
 * Mirrors parseSolverNetManifestKey.
 */
export function parseHarnessCheckpointKey(key: string): string | null {
  if (!key.startsWith(HARNESS_CHECKPOINT_KEY_PREFIX)) return null;
  const cid = key.slice(HARNESS_CHECKPOINT_KEY_PREFIX.length);
  return cid.length > 0 ? cid : null;
}
