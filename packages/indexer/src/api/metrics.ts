/**
 * Pure aggregation and shaping helpers for the /explorer/* routes.
 *
 * These functions have ZERO imports from ponder, ponder:api, ponder:schema,
 * drizzle, or any I/O layer — they operate only on primitive values and plain
 * objects. The route handlers in the /explorer/* files are responsible for
 * running the Drizzle queries and passing the resulting rows here.
 *
 * Unit tests live in test/metrics.test.ts.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single operator row used as input to {@link rankLeaderboard}.
 */
export interface LeaderboardRow {
  operator: `0x${string}`;
  /** Total attempt count (all time). */
  attempts: number;
  /** Count of this operator's attempts on tasks that finalized (settled). */
  settledContribution: number;
  /** Total number of verdicts received across all attempts. */
  verdictsTotal: number;
  /** Number of Pass verdicts (verdictCode === 1). */
  verdictsPass: number;
  /** Pass / total, or null if verdictsTotal === 0. */
  resolvedRate: number | null;
  /**
   * True when the operator has ≥1 recorded on-chain attempt. Defaulted to
   * `false` by the row builder; the `/operators` handler overlays the real
   * value. (Post-pivot the JINN-reward rolling-window qualification was
   * removed; "active" is now pure on-chain activity.)
   */
  active: boolean;
}

// ── verdictResolvedRate ───────────────────────────────────────────────────────

/**
 * Computes the fraction of verdicts that are Pass (verdictCode === 1).
 *
 * @returns Pass / total, or `null` if the input array is empty.
 */
export function verdictResolvedRate(verdicts: { verdictCode: number }[]): number | null {
  if (verdicts.length === 0) return null;
  const pass = verdicts.filter((v) => v.verdictCode === 1).length;
  return pass / verdicts.length;
}

// ── resolvedRateFromCounts ────────────────────────────────────────────────────

/**
 * Computes the resolved rate from pre-counted pass and total verdict counts.
 *
 * Use this when call sites already have integer counts rather than raw verdict
 * arrays. For array-based call sites, use {@link verdictResolvedRate} instead.
 *
 * @param pass - Number of Pass verdicts (verdictCode === 1).
 * @param total - Total number of verdicts.
 * @returns `pass / total`, or `null` if `total === 0`.
 */
export function resolvedRateFromCounts(pass: number, total: number): number | null {
  return total === 0 ? null : pass / total;
}

// ── attemptFinalization ───────────────────────────────────────────────────────

/**
 * Derives finalization status and outcome for a single task attempt.
 *
 * `finalized` is true iff `verdicts.length >= normalized requiredVerdicts`.
 * The current tokenless router omits `requiredVerdicts` and finalizes on the
 * first delivered verdict; rows that persisted the omission as 0 are normalized
 * to 1 here to match handler finalization (#1304).
 * When finalized, `passed` is true iff a strict majority of verdicts are Pass
 * (`pass * 2 > verdicts.length`).
 *
 * NOTE: This is a documented v1 proxy for the on-chain `passThreshold`. The
 * on-chain contract does not emit `passThreshold` in its events, so this
 * function approximates the majority rule. Route handlers should note this
 * limitation in their API responses when it is relevant.
 */
export function attemptFinalization(
  verdicts: { verdictCode: number }[],
  requiredVerdicts: number,
): { finalized: boolean; passed: boolean } {
  const normalizedRequiredVerdicts = requiredVerdicts <= 0 ? 1 : requiredVerdicts;
  if (verdicts.length < normalizedRequiredVerdicts) {
    return { finalized: false, passed: false };
  }
  const pass = verdicts.filter((v) => v.verdictCode === 1).length;
  const passed = pass * 2 > verdicts.length;
  return { finalized: true, passed };
}

// ── bucketResolvedRate ────────────────────────────────────────────────────────

/** A single resolved-rate data point for one block bucket. */
export interface BucketEntry {
  /** Decimal string of the first block in this bucket. */
  bucketStartBlock: string;
  /** Total number of samples in the bucket. */
  total: number;
  /** Number of Pass samples in the bucket. */
  pass: number;
  /**
   * Pass / total for this bucket. Typed as `number | null` for caller
   * convenience, but is never null for a non-empty bucket.
   */
  rate: number | null;
}

/**
 * Groups pass/fail samples by block bucket and returns per-bucket resolved
 * rates, sorted ascending by bucketStartBlock.
 *
 * Bucket boundaries are computed via integer division:
 *   `bucketStart = (block / bucketBlocks) * bucketBlocks`
 *
 * @param samples - Chronologically unordered pass/fail samples.
 * @param bucketBlocks - The bucket width in blocks. Must be > 0n.
 * @throws If `bucketBlocks <= 0n`.
 */
export function bucketResolvedRate(
  samples: { block: bigint; pass: boolean }[],
  bucketBlocks: bigint,
): BucketEntry[] {
  if (bucketBlocks <= 0n) {
    throw new Error(`bucketBlocks must be > 0; received ${bucketBlocks}`);
  }
  if (samples.length === 0) return [];

  const buckets = new Map<bigint, { total: number; pass: number }>();
  for (const { block, pass } of samples) {
    const start = (block / bucketBlocks) * bucketBlocks;
    const existing = buckets.get(start);
    if (existing) {
      existing.total += 1;
      if (pass) existing.pass += 1;
    } else {
      buckets.set(start, { total: 1, pass: pass ? 1 : 0 });
    }
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([start, { total, pass }]) => ({
      bucketStartBlock: String(start),
      total,
      pass,
      rate: pass / total,
    }));
}

// ── rollingResolvedRate ───────────────────────────────────────────────────────

/**
 * Computes a rolling resolved rate over a chronologically-sorted boolean array.
 *
 * Element `i` of the result is the mean of `passes[max(0, i-k+1) .. i]` —
 * the trailing window of up to `k` elements.
 *
 * @param passes - Chronologically sorted pass (true) / fail (false) values.
 * @param k - Window size. Must be >= 1.
 * @throws If `k < 1`.
 */
export function rollingResolvedRate(passes: boolean[], k: number): number[] {
  if (k < 1) {
    throw new Error(`k must be >= 1; received ${k}`);
  }
  if (passes.length === 0) return [];

  const result: number[] = [];
  for (let i = 0; i < passes.length; i++) {
    const start = Math.max(0, i - k + 1);
    const window = passes.slice(start, i + 1);
    const passCount = window.filter(Boolean).length;
    result.push(passCount / window.length);
  }
  return result;
}

// ── rankLeaderboard ───────────────────────────────────────────────────────────

/**
 * Default comparator used by the `/operators` leaderboard and the per-SolverNet
 * train/frozen leaderboards.
 *
 * Sort key:
 *   1. `resolvedRate` desc (null rates sort last)
 *   2. `attempts` desc
 *   3. `operator` asc (lexicographic)
 *
 * This is the meaningful quality-first ordering. Post-pivot the JINN-reward
 * (`jinnEarned`) sort was removed with the token economy, so `/operators` uses
 * this comparator too.
 */
export function compareByResolvedRateAttempts(a: LeaderboardRow, b: LeaderboardRow): number {
  // resolvedRate desc, nulls last.
  const aRate = a.resolvedRate;
  const bRate = b.resolvedRate;
  if (aRate !== bRate) {
    if (aRate === null) return 1;
    if (bRate === null) return -1;
    return bRate - aRate;
  }
  // attempts desc
  if (a.attempts !== b.attempts) return b.attempts - a.attempts;
  // operator asc
  return a.operator < b.operator ? -1 : a.operator > b.operator ? 1 : 0;
}

/**
 * Partitions and ranks operator leaderboard rows.
 *
 * Rows whose `verdictsTotal >= minVerdicts` go into `ranked`; the rest go into
 * `lowVolume`. Both groups are sorted by `comparator` — defaults to
 * {@link compareByResolvedRateAttempts}, the quality-first ordering used by
 * both the per-SolverNet boards and `/operators`.
 *
 * The `ranked` group has sequential 1-based `rank` fields appended.
 * The `lowVolume` group keeps the same sort order but no `rank` field.
 */
export function rankLeaderboard<R extends LeaderboardRow>(
  rows: R[],
  minVerdicts: number,
  comparator: (a: LeaderboardRow, b: LeaderboardRow) => number = compareByResolvedRateAttempts,
): {
  ranked: (R & { rank: number })[];
  lowVolume: R[];
} {
  const ranked: R[] = [];
  const lowVolume: R[] = [];
  for (const row of rows) {
    if (row.verdictsTotal >= minVerdicts) {
      ranked.push(row);
    } else {
      lowVolume.push(row);
    }
  }

  ranked.sort(comparator);
  lowVolume.sort(comparator);

  return {
    ranked: ranked.map((row, i) => ({ ...row, rank: i + 1 })),
    lowVolume,
  };
}

// ── composition ──────────────────────────────────────────────────────────────

/**
 * Groups `items` by the string produced by `key`, counts occurrences per
 * group, and computes each group's share of the total item count.
 *
 * Returns an array sorted by count descending, with ties broken by value
 * ascending (lexicographic). Returns `[]` for an empty `items` array.
 *
 * Typical use: `byMode` = composition(enrichedRows, r => r.mode);
 *              `byHarness` = composition(enrichedRows, r => r.implName);
 *
 * @param items - The input array.
 * @param key - Extractor function that maps each item to its bucket key.
 */
export function composition<T>(
  items: T[],
  key: (t: T) => string,
): { value: string; count: number; share: number }[] {
  if (items.length === 0) return [];

  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const total = items.length;
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count, share: count / total }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
    });
}

// ── detectFreezeViolations ────────────────────────────────────────────────────

/**
 * Detects operators whose frozen-mode attempts use inconsistent code digests.
 *
 * `rows` should already be filtered to `mode === 'frozen'` by the caller (the
 * function treats every row as a frozen attempt). For each distinct operator it
 * finds the modal `codeDigest` (most frequent; ties broken by lexicographically
 * smallest digest), then counts rows whose `codeDigest` differs from the modal
 * as violations.
 *
 * Returns one entry per operator that has at least one row, sorted by
 * `violatingCount` descending, with ties broken by `operator` ascending.
 * Returns `[]` for an empty input.
 *
 * @param rows - Per-attempt rows already filtered to frozen mode.
 */
export function detectFreezeViolations(
  rows: { operator: string; codeDigest: string }[],
): { operator: string; modalCodeDigest: string; total: number; violatingCount: number }[] {
  if (rows.length === 0) return [];

  // Group by operator
  const byOperator = new Map<string, string[]>();
  for (const { operator, codeDigest } of rows) {
    const existing = byOperator.get(operator);
    if (existing) {
      existing.push(codeDigest);
    } else {
      byOperator.set(operator, [codeDigest]);
    }
  }

  const result: { operator: string; modalCodeDigest: string; total: number; violatingCount: number }[] = [];

  for (const [operator, digests] of byOperator.entries()) {
    // Count each digest's frequency
    const freq = new Map<string, number>();
    for (const d of digests) {
      freq.set(d, (freq.get(d) ?? 0) + 1);
    }

    // Find modal: most frequent; ties → lexicographically smallest
    let modalDigest = '';
    let modalCount = 0;
    for (const [digest, cnt] of freq.entries()) {
      if (
        cnt > modalCount ||
        (cnt === modalCount && digest < modalDigest)
      ) {
        modalDigest = digest;
        modalCount = cnt;
      }
    }

    const total = digests.length;
    const violatingCount = digests.filter((d) => d !== modalDigest).length;

    result.push({
      operator,
      modalCodeDigest: modalDigest,
      total,
      violatingCount,
    });
  }

  // Sort by violatingCount desc, then operator asc
  result.sort((a, b) => {
    if (b.violatingCount !== a.violatingCount) return b.violatingCount - a.violatingCount;
    return a.operator < b.operator ? -1 : a.operator > b.operator ? 1 : 0;
  });

  return result;
}

// ── freshness ─────────────────────────────────────────────────────────────────

/**
 * Shapes indexer freshness metadata into the form used by /explorer/* responses.
 *
 * @param lastIndexedBlock - The most recently indexed block number.
 * @param lastIndexedAtIso - ISO 8601 timestamp of when that block was indexed.
 * @param headBlock - The current chain head block, if known.
 * @returns An object with string-serialised block numbers and a numeric lag.
 */
export function freshness(
  lastIndexedBlock: bigint,
  lastIndexedAtIso: string,
  headBlock?: bigint,
): { lastIndexedBlock: string; lastIndexedAt: string; behindHead: number | null } {
  return {
    lastIndexedBlock: String(lastIndexedBlock),
    lastIndexedAt: lastIndexedAtIso,
    behindHead: headBlock !== undefined ? Number(headBlock - lastIndexedBlock) : null,
  };
}
