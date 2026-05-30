/**
 * Active-operator window + qualification — the shared util the explorer's
 * `/operators` and `/network` handlers use to compute the "active" surface.
 *
 * Definition (per `docs/superpowers/specs/2026-05-30-active-operator-explorer-design.md`):
 *   - The reference window is the last `BLOCK_COUNT` (= 8) completed UTC
 *     `BLOCK_SECONDS`-second blocks (= 6h). The in-progress block is
 *     deliberately excluded — a 0-claim partial bucket would mark every
 *     operator inactive between checkpoints.
 *   - An operator counts as "active" iff their per-block sum of
 *     `rewardDistribution.operatorMinted` is `>= REQUIRED_TJINN_PER_BLOCK`
 *     (= 3 tJINN, mirrored from `client/scripts/check-milestone-1.ts`'s
 *     `3n * 10n ** 18n` literal — intentionally not imported; that script
 *     is out of scope to retrofit).
 *
 * The function is pure: it takes the (multisig, operatorMinted,
 * claimedAtTimestamp) tuples already loaded from `rewardDistribution` and
 * `nowSec`, and returns the window + the set of qualifying multisigs.
 * Multisig strings are compared verbatim — no case normalisation; the
 * upstream `multisig ↔ attempt.operator` join uses the same `t.hex()`
 * representation on both sides.
 */

/** Width of each bucket in seconds (= 6 hours). */
export const BLOCK_SECONDS = 6 * 3600;

/** Number of completed buckets the window spans (= 8 → 48 hours). */
export const BLOCK_COUNT = 8;

/**
 * Per-block tJINN earning floor. `3 × 10^18` wei matches the literal in
 * `client/scripts/check-milestone-1.ts:46`; that script intentionally is
 * not refactored to consume this constant (out of scope).
 */
export const REQUIRED_TJINN_PER_BLOCK = 3n * 10n ** 18n;

export interface ActiveWindow {
  /** UTC seconds — inclusive lower bound of the window. */
  startTs: number;
  /** UTC seconds — exclusive upper bound; the most-recent completed 6h boundary. */
  endTs: number;
  blockSeconds: number;
  blockCount: number;
  /** Floor in wei (`3 × 10^18`). */
  requiredTjinnPerBlock: bigint;
}

export interface ActiveOperatorReward {
  multisig: string;
  operatorMinted: bigint;
  claimedAtTimestamp: bigint;
}

export interface ActiveOperatorResult {
  window: ActiveWindow;
  /** Multisigs that qualified in every one of the `BLOCK_COUNT` buckets. */
  active: Set<string>;
  /**
   * Per-operator qualification breakdown over the window.
   *
   * `blocks` is the per-bucket qualifying flag, length `BLOCK_COUNT`,
   * **oldest-first** — `blocks[0]` is the oldest completed bucket and
   * `blocks[BLOCK_COUNT - 1]` is the newest. `blocksQualified` is the count
   * of `true` entries in `blocks`.
   */
  perOperator: Map<string, { blocks: boolean[]; blocksQualified: number }>;
}

/**
 * Anchor `endTs` to the most-recent completed UTC `BLOCK_SECONDS` boundary
 * via `floor(nowSec / BLOCK_SECONDS) × BLOCK_SECONDS`. When `nowSec` lands
 * exactly on a boundary, that boundary belongs to the in-progress block
 * (the just-completed window stays `[boundary − 8×6h, boundary)`).
 */
export function computeActiveWindow(nowSec: number): ActiveWindow {
  const endTs = Math.floor(nowSec / BLOCK_SECONDS) * BLOCK_SECONDS;
  const startTs = endTs - BLOCK_SECONDS * BLOCK_COUNT;
  return {
    startTs,
    endTs,
    blockSeconds: BLOCK_SECONDS,
    blockCount: BLOCK_COUNT,
    requiredTjinnPerBlock: REQUIRED_TJINN_PER_BLOCK,
  };
}

/**
 * Pure: bucket rewards by `floor((claimedAtTimestamp − startTs) / BLOCK_SECONDS)`,
 * drop any bucket outside `[0, BLOCK_COUNT)`, sum `operatorMinted` per
 * `(multisig, bucket)`, count buckets whose sum is at least
 * `REQUIRED_TJINN_PER_BLOCK`, and mark a multisig "active" iff its qualifying
 * bucket count equals `BLOCK_COUNT`.
 */
export function computeActiveOperators(
  rewards: ActiveOperatorReward[],
  nowSec: number,
): ActiveOperatorResult {
  const window = computeActiveWindow(nowSec);
  // sums[operator][bucket] → bigint
  const sums = new Map<string, bigint[]>();

  for (const r of rewards) {
    const ts = Number(r.claimedAtTimestamp);
    if (!Number.isFinite(ts)) continue;
    const bucket = Math.floor((ts - window.startTs) / BLOCK_SECONDS);
    if (bucket < 0 || bucket >= BLOCK_COUNT) continue;
    let perBucket = sums.get(r.multisig);
    if (!perBucket) {
      perBucket = new Array<bigint>(BLOCK_COUNT).fill(0n);
      sums.set(r.multisig, perBucket);
    }
    perBucket[bucket] = (perBucket[bucket] ?? 0n) + r.operatorMinted;
  }

  const active = new Set<string>();
  const perOperator = new Map<string, { blocks: boolean[]; blocksQualified: number }>();
  for (const [op, perBucket] of sums) {
    // `perBucket` indexing already runs oldest-first because `bucket` is
    // `floor((ts - startTs) / BLOCK_SECONDS)` — index 0 = startTs..startTs+6h
    // = oldest completed block, index BLOCK_COUNT-1 = newest completed.
    const blocks = perBucket.map((sum) => sum >= REQUIRED_TJINN_PER_BLOCK);
    let qualified = 0;
    for (const b of blocks) if (b) qualified += 1;
    perOperator.set(op, { blocks, blocksQualified: qualified });
    if (qualified === BLOCK_COUNT) active.add(op);
  }

  return { window, active, perOperator };
}
