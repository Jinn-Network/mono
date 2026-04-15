import { ethers } from 'ethers';

const ACTIVITY_CHECKER_ABI = [
  'function livenessRatio() view returns (uint256)',
];

const ONE_ETHER = 1_000_000_000_000_000_000n;
const livenessRatioCache = new Map<string, bigint>();

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

export function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;

  return parsed;
}

export function readNonNegativeIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;

  return parsed;
}

export interface ProjectedEpochTargetInput {
  provider: ethers.Provider;
  activityCheckerAddress: string;
  tsCheckpoint: number;
  livenessPeriod: number;
  delayBufferSeconds: number;
  overrideTarget?: number;
  safetyMarginActivities?: number;
  nowTimestamp?: number;
}

export interface ProjectedEpochTargetResult {
  target: number;
  baselineTimestamp: number;
  effectivePeriodSeconds: number;
  effectivePeriodSecondsWithoutBuffer: number;
  livenessRatio: bigint;
  usedOverride: boolean;
  safetyMarginActivities: number;
}

export async function computeProjectedEpochTarget(
  input: ProjectedEpochTargetInput,
): Promise<ProjectedEpochTargetResult> {
  if (input.overrideTarget && input.overrideTarget > 0) {
    return {
      target: input.overrideTarget,
      baselineTimestamp: input.tsCheckpoint,
      effectivePeriodSeconds: 0,
      effectivePeriodSecondsWithoutBuffer: 0,
      livenessRatio: 0n,
      usedOverride: true,
      safetyMarginActivities: 0,
    };
  }

  const cacheKey = input.activityCheckerAddress.toLowerCase();
  let livenessRatio = livenessRatioCache.get(cacheKey);
  if (!livenessRatio) {
    const checker = new ethers.Contract(
      input.activityCheckerAddress,
      ACTIVITY_CHECKER_ABI,
      input.provider,
    );
    livenessRatio = BigInt(await checker.livenessRatio());
    livenessRatioCache.set(cacheKey, livenessRatio);
  }

  const nowTimestamp = input.nowTimestamp ?? Math.floor(Date.now() / 1000);
  const elapsedSinceCheckpoint = Math.max(0, nowTimestamp - input.tsCheckpoint);
  const effectivePeriodSecondsWithoutBuffer = Math.max(input.livenessPeriod, elapsedSinceCheckpoint);
  const effectivePeriodSeconds = Math.max(
    input.livenessPeriod,
    elapsedSinceCheckpoint + Math.max(0, input.delayBufferSeconds),
  );
  const safetyMarginActivities = Math.max(0, input.safetyMarginActivities ?? 0);

  let targetBigInt = ceilDiv(BigInt(effectivePeriodSeconds) * livenessRatio, ONE_ETHER)
    + BigInt(safetyMarginActivities);
  if (effectivePeriodSeconds > 0 && targetBigInt === 0n) {
    // For very short windows, still require at least one activity.
    targetBigInt = 1n;
  }

  if (targetBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Projected staking target overflowed JS number range: ${targetBigInt}`);
  }

  return {
    target: Number(targetBigInt),
    baselineTimestamp: input.tsCheckpoint,
    effectivePeriodSeconds,
    effectivePeriodSecondsWithoutBuffer,
    livenessRatio,
    usedOverride: false,
    safetyMarginActivities,
  };
}
