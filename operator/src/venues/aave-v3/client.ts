import type { PublicClient } from 'viem';

export const AAVE_POOL_ABI = [
  {
    name: 'getReserveData',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'configuration', type: 'uint256' },
      { name: 'liquidityIndex', type: 'uint128' },
      { name: 'currentLiquidityRate', type: 'uint128' },
      { name: 'variableBorrowIndex', type: 'uint128' },
      { name: 'currentVariableBorrowRate', type: 'uint128' },
      { name: 'currentStableBorrowRate', type: 'uint128' },
      { name: 'lastUpdateTimestamp', type: 'uint40' },
      { name: 'id', type: 'uint16' },
      { name: 'aTokenAddress', type: 'address' },
      { name: 'stableDebtTokenAddress', type: 'address' },
      { name: 'variableDebtTokenAddress', type: 'address' },
      { name: 'interestRateStrategyAddress', type: 'address' },
      { name: 'accruedToTreasury', type: 'uint128' },
      { name: 'unbacked', type: 'uint128' },
      { name: 'isolationModeTotalDebt', type: 'uint128' },
    ],
  },
] as const;

const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000n;

export interface ReserveRateReading {
  blockNumber: bigint;
  blockTimestampMs: number;
  currentLiquidityRateRay: bigint;
}

export interface TwaApyBpsResult {
  twApyBps: number;
  sampleCount: number;
  sampleTimestampsMs: number[];
}

export function scheduleSampleTimestamps(windowEndTs: number, twaWindowSeconds: number, sampleCount: number): number[] {
  if (sampleCount < 2) throw new Error('sampleCount must be >= 2');
  const windowMs = twaWindowSeconds * 1000;
  const start = windowEndTs - windowMs;
  if (start < 0) throw new Error('twa window starts before unix epoch');
  const step = Math.floor(windowMs / (sampleCount - 1));
  if (step <= 0) throw new Error('sample spacing must be positive');
  const ts: number[] = [];
  for (let i = 0; i < sampleCount; i++) ts.push(start + i * step);
  ts[ts.length - 1] = windowEndTs;
  return ts;
}

export function liquidityRateRayToApyBps(rateRay: bigint): number {
  const apr = Number(rateRay) / Number(RAY);
  const apy = Math.pow(1 + apr / Number(SECONDS_PER_YEAR), Number(SECONDS_PER_YEAR)) - 1;
  return Math.round(apy * 10_000);
}

export async function findBlockAtOrBeforeTimestamp(
  publicClient: PublicClient,
  targetTsMs: number,
  options?: { minBlock?: bigint },
): Promise<{ number: bigint; timestampMs: number }> {
  const latest = await publicClient.getBlock({ blockTag: 'latest' });
  let lo = options?.minBlock ?? 0n;
  if (lo > latest.number) {
    lo = 0n;
  }
  let hi = latest.number;
  let best = 0n;
  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    const block = await publicClient.getBlock({ blockNumber: mid });
    const tsMs = Number(block.timestamp) * 1000;
    if (tsMs <= targetTsMs) {
      best = mid;
      lo = mid + 1n;
    } else {
      hi = mid - 1n;
    }
  }
  const b = await publicClient.getBlock({ blockNumber: best });
  return { number: b.number, timestampMs: Number(b.timestamp) * 1000 };
}

export async function readReserveRateAtTimestamp(
  publicClient: PublicClient,
  pool: `0x${string}`,
  reserve: `0x${string}`,
  timestampMs: number,
  options?: { minBlockForSearch?: bigint },
): Promise<ReserveRateReading> {
  const block = await findBlockAtOrBeforeTimestamp(publicClient, timestampMs, {
    minBlock: options?.minBlockForSearch,
  });
  const reserveData = await publicClient.readContract({
    address: pool,
    abi: AAVE_POOL_ABI,
    functionName: 'getReserveData',
    args: [reserve],
    blockNumber: block.number,
  });
  return {
    blockNumber: block.number,
    blockTimestampMs: block.timestampMs,
    currentLiquidityRateRay: reserveData[2],
  };
}

export async function twApyBpsOverWindow(params: {
  publicClient: PublicClient;
  pool: `0x${string}`;
  reserve: `0x${string}`;
  windowEndTs: number;
  twaWindowSeconds: number;
  sampleCount: number;
}): Promise<TwaApyBpsResult> {
  const sampleTs = scheduleSampleTimestamps(params.windowEndTs, params.twaWindowSeconds, params.sampleCount);
  let sum = 0;
  let minBlock: bigint | undefined;
  for (const ts of sampleTs) {
    const r = await readReserveRateAtTimestamp(params.publicClient, params.pool, params.reserve, ts, {
      minBlockForSearch: minBlock,
    });
    minBlock = r.blockNumber;
    sum += liquidityRateRayToApyBps(r.currentLiquidityRateRay);
  }
  return {
    twApyBps: Math.round(sum / sampleTs.length),
    sampleCount: sampleTs.length,
    sampleTimestampsMs: sampleTs,
  };
}
