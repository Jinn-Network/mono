/**
 * Active-operator window + qualification over OLAS/JINN staking rewards.
 *
 * The Base Sepolia ERC20 is named JINN in contracts, but it represents OLAS in
 * this testnet setup. Public copy should say OLAS; this helper names the
 * threshold accordingly.
 */

/** Width of each bucket in seconds (= 6 hours). */
export const BLOCK_SECONDS = 6 * 3600;

/** Number of completed buckets the window spans (= 8 -> 48 hours). */
export const BLOCK_COUNT = 8;

/** Per-block OLAS earning floor in wei: any positive earned reward qualifies. */
export const REQUIRED_OLAS_PER_BLOCK = 1n;

/** Lifetime OLAS floor for the Milestone-3 count. */
export const MILESTONE_3_OLAS_FLOOR = 25n * 10n ** 18n;

export interface ActiveWindow {
  /** UTC seconds, inclusive lower bound. */
  startTs: number;
  /** UTC seconds, exclusive upper bound at the latest completed 6h boundary. */
  endTs: number;
  blockSeconds: number;
  blockCount: number;
  /** Floor in wei. */
  requiredOlasPerBlock: bigint;
}

export interface ActiveOperatorReward {
  multisig: string;
  operatorRewarded: bigint;
  claimedAtTimestamp: bigint;
}

export type RewardActivitySource = 'checkpoint' | 'claim-fallback';

export function selectRewardActivityRows(
  checkpointRows: ActiveOperatorReward[],
  claimRows: ActiveOperatorReward[],
  checkpointRowsExist: boolean,
): { source: RewardActivitySource; rows: ActiveOperatorReward[] } {
  if (checkpointRowsExist) {
    return { source: 'checkpoint', rows: checkpointRows };
  }
  return { source: 'claim-fallback', rows: claimRows };
}

export interface ActiveOperatorResult {
  window: ActiveWindow;
  /** Operators whose newest completed bucket has any earned OLAS. */
  active: Set<string>;
  /** Operators whose every bucket in the 48h window has any earned OLAS. */
  sustained: Set<string>;
  /** Per-operator bucket qualification, oldest bucket first. */
  perOperator: Map<string, { blocks: boolean[]; blocksQualified: number }>;
}

export function computeActiveWindow(nowSec: number): ActiveWindow {
  const endTs = Math.floor(nowSec / BLOCK_SECONDS) * BLOCK_SECONDS;
  const startTs = endTs - BLOCK_SECONDS * BLOCK_COUNT;
  return {
    startTs,
    endTs,
    blockSeconds: BLOCK_SECONDS,
    blockCount: BLOCK_COUNT,
    requiredOlasPerBlock: REQUIRED_OLAS_PER_BLOCK,
  };
}

export function computeActiveOperators(
  rewards: ActiveOperatorReward[],
  nowSec: number,
): ActiveOperatorResult {
  const window = computeActiveWindow(nowSec);
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
    perBucket[bucket] = (perBucket[bucket] ?? 0n) + r.operatorRewarded;
  }

  const active = new Set<string>();
  const sustained = new Set<string>();
  const perOperator = new Map<string, { blocks: boolean[]; blocksQualified: number }>();

  for (const [op, perBucket] of sums) {
    const blocks = perBucket.map((sum) => sum >= REQUIRED_OLAS_PER_BLOCK);
    const blocksQualified = blocks.filter(Boolean).length;
    perOperator.set(op, { blocks, blocksQualified });
    if (blocks[BLOCK_COUNT - 1]) active.add(op);
    if (blocksQualified === BLOCK_COUNT) sustained.add(op);
  }

  return { window, active, sustained, perOperator };
}

export function countOperatorsAtMilestone3(
  rows: { multisig: string; operatorRewarded: bigint }[],
): number {
  const perOperator = new Map<string, bigint>();
  for (const r of rows) {
    perOperator.set(r.multisig, (perOperator.get(r.multisig) ?? 0n) + r.operatorRewarded);
  }
  let count = 0;
  for (const total of perOperator.values()) {
    if (total >= MILESTONE_3_OLAS_FLOOR) count += 1;
  }
  return count;
}
