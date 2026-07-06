/**
 * Pure format helpers for the Jinn network explorer.
 *
 * All functions are null-safe: null/undefined inputs return a dash '—'.
 * Numeric text uses tabular-nums (apply CSS class "data" at the callsite).
 * No side effects, no imports.
 */

// ── pct ──────────────────────────────────────────────────────────────────────

/**
 * Format a resolved rate (0–1 float) as a percentage string.
 *
 * @param n     ratio 0–1, or null/undefined
 * @param digits decimal places (default 1)
 * @returns e.g. `"96.9%"` or `"—"`
 */
export function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

// ── int ──────────────────────────────────────────────────────────────────────

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/**
 * Format an integer with thousands grouping.
 *
 * @returns e.g. `"1,234"` or `"—"`
 */
export function int(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return intFmt.format(Math.round(n));
}

// ── block ─────────────────────────────────────────────────────────────────────

/**
 * Format a block number. Block numbers arrive as bigint-serialised decimal
 * strings from the API; this function accepts both strings and numbers.
 *
 * @returns e.g. `"12,456,789"` or `"—"`
 */
export function block(s: string | number | null | undefined): string {
  if (s === null || s === undefined || s === '') return '—';
  const n = Number(s);
  if (!Number.isFinite(n)) return '—';
  return intFmt.format(Math.round(n));
}

// ── jinn ─────────────────────────────────────────────────────────────────────

/**
 * Format a raw Base Sepolia JINN/OLAS wei string as a decimal OLAS amount.
 *
 * Uses BigInt arithmetic for the integer part to avoid precision loss, then
 * derives the fractional display with modulo arithmetic.
 *
 * @param weiStr  decimal string e.g. "100500000000000000044"
 * @param decimals token decimals (default 18)
 * @param digits  display decimal places (default 2)
 * @returns e.g. `"100.50 OLAS"` or `"0 OLAS"` for zero/null/empty
 */
export function jinn(
  weiStr: string | null | undefined,
  decimals = 18,
  digits = 2,
): string {
  if (!weiStr || weiStr === '0') return '0 OLAS';
  let raw: bigint;
  try {
    raw = BigInt(weiStr);
  } catch {
    return '—';
  }
  if (raw === 0n) return '0 OLAS';

  const divisor = 10n ** BigInt(decimals);
  const wholePart = raw / divisor;
  const fracRaw = raw % divisor;

  // Build fractional string with leading zeros
  const fracStr = fracRaw.toString().padStart(decimals, '0').slice(0, digits);

  const wholeFormatted = intFmt.format(wholePart);
  if (wholePart === 0n && /^0+$/.test(fracStr)) {
    const floor = digits <= 0 ? '1' : `0.${'0'.repeat(digits - 1)}1`;
    return `<${floor} OLAS`;
  }
  return `${wholeFormatted}.${fracStr} OLAS`;
}

// ── shortAddr ─────────────────────────────────────────────────────────────────

/**
 * Shorten an Ethereum hex address to `0x1234…abcd` (first 6 + last 4 hex chars).
 *
 * @returns shortened form, or the original string if it doesn't look like an address
 */
export function shortAddr(hex: string | null | undefined): string {
  if (!hex) return '—';
  // Must look like 0x + at least 10 hex chars
  if (!/^0x[0-9a-fA-F]{10,}$/.test(hex)) return hex;
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

// ── shortCid ──────────────────────────────────────────────────────────────────

/**
 * Shorten a CIDv1 string.
 *
 * @param cid  full CID string, e.g. "bafkreiabcdefgh…xyz"
 * @param head characters to keep from the start (default 8)
 * @param tail characters to keep from the end (default 6)
 * @returns e.g. `"bafkrei…x4lcv4"` or `"—"`
 */
export function shortCid(
  cid: string | null | undefined,
  head = 8,
  tail = 6,
): string {
  if (!cid) return '—';
  if (cid.length <= head + tail + 1) return cid;
  return `${cid.slice(0, head)}…${cid.slice(-tail)}`;
}

// ── external-link mapping (spec §3.4) ──────────────────────────────────────────

/** Base Sepolia basescan base — the explorer's pinned chain (spec §3.8). */
const BASESCAN_SEPOLIA = 'https://sepolia.basescan.org';

/** Autonolas IPFS gateway — the corpus content resolver. */
const IPFS_GATEWAY = 'https://gateway.autonolas.tech/ipfs';

/**
 * Build a basescan URL for a transaction hash on Base Sepolia, or null when
 * the hash is absent/degenerate ('0x' placeholder from an un-enriched anchor).
 */
export function basescanTxUrl(txHash: string | null | undefined): string | null {
  if (!txHash || !/^0x[0-9a-fA-F]{2,}$/.test(txHash) || txHash === '0x') return null;
  return `${BASESCAN_SEPOLIA}/tx/${txHash}`;
}

/**
 * Build an IPFS gateway URL for a CID, or null when the CID is absent. The cid
 * is attacker-influenceable (it comes from an on-chain key), so it is
 * percent-encoded before interpolation into the gateway path — matching the
 * internal-link treatment (scheme + host are fixed, so this is low-risk).
 */
export function ipfsUrl(cid: string | null | undefined): string | null {
  if (!cid) return null;
  return `${IPFS_GATEWAY}/${encodeURIComponent(cid)}`;
}

// ── relUnix ─────────────────────────────────────────────────────────────────

/**
 * Human-readable relative time from a unix-seconds timestamp (number), or null.
 * Mirrors relTime but for the numeric block-timestamp the corpus carries.
 *
 * @returns e.g. `"just now"`, `"3m ago"`, `"2h ago"`, `"5d ago"`, or `"—"`
 */
export function relUnix(unixSeconds: number | null | undefined): string {
  if (unixSeconds === null || unixSeconds === undefined || !Number.isFinite(unixSeconds) || unixSeconds <= 0) {
    return '—';
  }
  return relTime(new Date(unixSeconds * 1000).toISOString());
}

// ── relTime ───────────────────────────────────────────────────────────────────

/**
 * Human-readable relative time from an ISO 8601 string.
 *
 * @returns e.g. `"just now"`, `"14s ago"`, `"3m ago"`, `"2h ago"`, `"5d ago"`, or `"—"`
 */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffMs = now - then;
  const diffS = Math.round(diffMs / 1000);
  if (diffS < 5) return 'just now';
  if (diffS < 60) return `${diffS}s ago`;
  const diffM = Math.round(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.round(diffM / 60);
  if (diffH < 48) return `${diffH}h ago`;
  const diffD = Math.round(diffH / 24);
  return `${diffD}d ago`;
}
