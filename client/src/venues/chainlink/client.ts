/**
 * Chainlink AggregatorV3 read client.
 *
 * §7 of spec/2026-04-20-prediction-v0-pis-phase-1-design.md
 */
import type { PublicClient } from 'viem';

export const AGGREGATOR_V3_ABI = [
  {
    name: 'latestRoundData',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
  {
    name: 'getRoundData',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '_roundId', type: 'uint80' }],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'description',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

export interface RoundReading {
  roundId: bigint;
  answer: bigint;         // raw int256
  startedAt: number;      // ms epoch
  updatedAt: number;      // ms epoch
  answeredInRound: bigint;
  decimals: number;
}

/** Scale a raw Chainlink int256 answer to a decimal string. */
export function scaleToDecimal(answer: bigint, decimals: number): string {
  if (answer < 0n) {
    throw new Error(`scaleToDecimal: negative value not supported in v0 (got ${answer})`);
  }
  const s = answer.toString();
  if (decimals === 0) return s;
  if (s.length <= decimals) {
    const frac = s.padStart(decimals, '0').replace(/0+$/, '');
    return frac.length > 0 ? `0.${frac}` : '0';
  }
  const intPart = s.slice(0, s.length - decimals);
  const fracRaw = s.slice(s.length - decimals);
  const frac = fracRaw.replace(/0+$/, '');
  return frac.length > 0 ? `${intPart}.${frac}` : intPart;
}

export async function readChainlinkLatest(
  feed: `0x${string}`,
  publicClient: PublicClient,
): Promise<RoundReading> {
  const [latest, decimals] = await Promise.all([
    publicClient.readContract({
      address: feed,
      abi: AGGREGATOR_V3_ABI,
      functionName: 'latestRoundData',
    }),
    publicClient.readContract({
      address: feed,
      abi: AGGREGATOR_V3_ABI,
      functionName: 'decimals',
    }),
  ]);
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = latest as [bigint, bigint, bigint, bigint, bigint];
  return {
    roundId,
    answer,
    // Chainlink timestamps are SECONDS → convert to ms for consistency with rest of codebase
    startedAt: Number(startedAt) * 1000,
    updatedAt: Number(updatedAt) * 1000,
    answeredInRound,
    decimals: decimals as number,
  };
}

export async function readChainlinkRound(
  feed: `0x${string}`,
  roundId: bigint,
  publicClient: PublicClient,
  decimals: number,
): Promise<RoundReading> {
  const round = await publicClient.readContract({
    address: feed,
    abi: AGGREGATOR_V3_ABI,
    functionName: 'getRoundData',
    args: [roundId],
  });
  const [rid, answer, startedAt, updatedAt, answeredInRound] = round as [bigint, bigint, bigint, bigint, bigint];
  return {
    roundId: rid,
    answer,
    startedAt: Number(startedAt) * 1000,
    updatedAt: Number(updatedAt) * 1000,
    answeredInRound,
    decimals,
  };
}

export interface SpanningResult {
  /** Round R with updatedAt ≤ resolveTs. */
  round: RoundReading;
  /** Round R+1 with updatedAt > resolveTs. null if no newer round exists yet. */
  nextRound: RoundReading | null;
  /** True iff nextRound exists — then the spanning property is satisfied. */
  spanning: boolean;
}

/**
 * Find the Chainlink round that "spans" resolveTs: round R where
 * R.updatedAt ≤ resolveTs < (R+1).updatedAt.
 *
 * If the latest round's updatedAt ≤ resolveTs (i.e. no newer round yet),
 * returns { round: latest, nextRound: null, spanning: false }. Caller should
 * retry later (availability check will mark SKIP → INDETERMINATE verdict).
 */
export async function oraclePriceAtResolveTs(
  feed: `0x${string}`,
  resolveTs: number,
  publicClient: PublicClient,
): Promise<SpanningResult> {
  const latest = await readChainlinkLatest(feed, publicClient);
  // Case A: latest is at-or-before resolveTs → no newer round yet
  if (latest.updatedAt <= resolveTs) {
    return { round: latest, nextRound: null, spanning: false };
  }
  // Case B: latest is after resolveTs → walk back to find spanning round
  let nextRound = latest;
  let cursor = latest.roundId - 1n;
  while (cursor > 0n) {
    const r = await readChainlinkRound(feed, cursor, publicClient, latest.decimals);
    if (r.updatedAt <= resolveTs) {
      return { round: r, nextRound, spanning: true };
    }
    nextRound = r;
    cursor -= 1n;
  }
  // Walked back to round 0 without finding a pre-resolveTs round — oracle is
  // newer than the window. Surface as not-spanning so caller INDETERMINATE-s.
  return { round: latest, nextRound: null, spanning: false };
}
