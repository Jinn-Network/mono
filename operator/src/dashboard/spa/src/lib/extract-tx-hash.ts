/**
 * SPA-local copy of the extractTxHashFromString utility.
 *
 * The SPA cannot import from operator/src/util/ due to bundler boundaries, so
 * this file duplicates the implementation.
 * Keep in sync with operator/src/util/extract-tx-hash.ts when changing the
 * regex or signature.
 */

const TX_HASH_RE = /(0x[a-fA-F0-9]{64})/;

/**
 * Returns the first Ethereum transaction hash found in `s`, or `null` if none.
 */
export function extractTxHashFromString(s: string): string | null {
  const m = TX_HASH_RE.exec(s);
  return m ? m[1] ?? null : null;
}
