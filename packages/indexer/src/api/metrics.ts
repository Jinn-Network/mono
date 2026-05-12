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
  /** Operator's share of settled task budget (0..1). */
  settledContribution: number;
  /** Total number of verdicts received across all attempts. */
  verdictsTotal: number;
  /** Number of Pass verdicts (verdictCode === 1). */
  verdictsPass: number;
  /** Pass / total, or null if verdictsTotal === 0. */
  resolvedRate: number | null;
  /** JINN tokens earned (raw bigint from chain). */
  jinnEarned: bigint;
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

// ── attemptFinalization ───────────────────────────────────────────────────────

/**
 * Derives finalization status and outcome for a single task attempt.
 *
 * `finalized` is true iff `requiredVerdicts > 0 && verdicts.length >= requiredVerdicts`.
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
  if (requiredVerdicts <= 0 || verdicts.length < requiredVerdicts) {
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
 * Partitions and ranks operator leaderboard rows.
 *
 * Rows whose `verdictsTotal >= minResolvedAttempts` go into `ranked`; the rest
 * go into `lowVolume`. Both groups are sorted by:
 *   1. `resolvedRate` desc (null sorts last, after any numeric rate)
 *   2. `attempts` desc
 *   3. `operator` asc (lexicographic)
 *
 * The `ranked` group has sequential 1-based `rank` fields appended.
 * The `lowVolume` group keeps the same sort order but no `rank` field.
 */
export function rankLeaderboard(
  rows: LeaderboardRow[],
  minResolvedAttempts: number,
): {
  ranked: (LeaderboardRow & { rank: number })[];
  lowVolume: LeaderboardRow[];
} {
  const comparator = (a: LeaderboardRow, b: LeaderboardRow): number => {
    // resolvedRate desc — null sorts after any numeric rate
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
  };

  const ranked: LeaderboardRow[] = [];
  const lowVolume: LeaderboardRow[] = [];
  for (const row of rows) {
    if (row.verdictsTotal >= minResolvedAttempts) {
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
