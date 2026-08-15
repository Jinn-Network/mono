/**
 * Shared utility for extracting an Ethereum transaction hash from a string.
 *
 * The same regex is needed by the bootstrap state machine (to surface a
 * block-explorer link in fatal error envelopes) and by the SPA Onboarding
 * region (to render that link). The SPA cannot import from this file directly
 * due to bundler boundaries, so a copy lives at:
 *   operator/src/dashboard/spa/src/lib/extract-tx-hash.ts
 * Keep the two in sync when changing the regex or signature.
 */

const TX_HASH_RE = /(0x[a-fA-F0-9]{64})/;

/**
 * Returns the first Ethereum transaction hash found in `s`, or `null` if none.
 */
export function extractTxHashFromString(s: string): string | null {
  const m = TX_HASH_RE.exec(s);
  return m ? m[1] ?? null : null;
}
