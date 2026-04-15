/**
 * Staking Epoch Gate
 *
 * Checks whether the service has met its activity target for the current
 * staking epoch. The staking contract's activity checker exposes
 * getMultisigNonces(multisig) which returns [safeNonce, activityCount].
 * For v1 (WhitelistedRequesterActivityChecker) activityCount = mapRequestCounts.
 * For v2 (DeliveryActivityChecker) activityCount = mapDeliveryCounts.
 *
 * We read the same on-chain value via the activity checker and compare
 * against nonces[1] from getServiceInfo — the authoritative epoch-start
 * baseline recorded by the staking contract at checkpoint time.
 *
 * When the target is met the worker should stop claiming new jobs
 * to save gas and API quota.
 */

import { ethers } from 'ethers';
import { workerLogger } from '../../logging/index.js';
import { computeProjectedEpochTarget, readNonNegativeIntEnv, readPositiveIntEnv } from './target.js';
import { config, secrets, createRpcProvider } from '../../config/index.js';

const log = workerLogger.child({ component: 'EPOCH_GATE' });

const DEFAULT_TARGET_ACTIVITIES = 61;
const DEFAULT_CHECKPOINT_DELAY_BUFFER_SEC = 0;
const DEFAULT_SAFETY_MARGIN_ACTIVITIES = 1;
const EPOCH_CACHE_TTL_MS = 5 * 60_000; // 5 min — checkpoint only changes daily
const ACTIVITY_CACHE_TTL_MS = 2 * 60_000; // 2 min — activity counts change frequently

const STAKING_ABI = [
  'function livenessPeriod() view returns (uint256)',
  'function tsCheckpoint() view returns (uint256)',
  'function getNextRewardCheckpointTimestamp() view returns (uint256)',
  'function activityChecker() view returns (address)',
  'function getServiceInfo(uint256 serviceId) view returns (tuple(address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity))',
];

const ACTIVITY_CHECKER_ABI = [
  'function livenessRatio() view returns (uint256)',
  'function getMultisigNonces(address multisig) view returns (uint256[] memory)',
];

export interface EpochGateResult {
  targetMet: boolean;
  activityCount: number;
  target: number;
  nextCheckpoint: number; // unix timestamp of epoch reset
  /** The on-chain staking multisig — authoritative source */
  multisig: string;
}

// ── Caches ──────────────────────────────────────────────────────────────────

const cachedEpochByStakingContract = new Map<string, { tsCheckpoint: number; nextCheckpoint: number; fetchedAt: number }>();
const cachedGateByService = new Map<string, { result: EpochGateResult; fetchedAt: number }>();

function getEpochCacheKey(stakingContractAddress: string): string {
  return stakingContractAddress.toLowerCase();
}

function getGateCacheKey(
  stakingContractAddress: string,
  serviceId: number,
  marketplaceAddress: string,
): string {
  return `${stakingContractAddress.toLowerCase()}::${serviceId}::${marketplaceAddress.toLowerCase()}`;
}

async function getEpochBounds(
  stakingContract: ethers.Contract,
  stakingContractAddress: string,
): Promise<{ tsCheckpoint: number; nextCheckpoint: number }> {
  const cacheKey = getEpochCacheKey(stakingContractAddress);
  const cachedEpoch = cachedEpochByStakingContract.get(cacheKey);
  if (cachedEpoch && Date.now() - cachedEpoch.fetchedAt < EPOCH_CACHE_TTL_MS) {
    return { tsCheckpoint: cachedEpoch.tsCheckpoint, nextCheckpoint: cachedEpoch.nextCheckpoint };
  }

  const [tsCheckpoint, nextCheckpoint] = await Promise.all([
    stakingContract.tsCheckpoint().then(Number),
    stakingContract.getNextRewardCheckpointTimestamp().then(Number),
  ]);

  cachedEpochByStakingContract.set(cacheKey, { tsCheckpoint, nextCheckpoint, fetchedAt: Date.now() });
  return { tsCheckpoint, nextCheckpoint };
}

/**
 * Read epoch activity count using the activity checker's getMultisigNonces().
 * nonces[1] from the checker = current activity count (requests for v1, deliveries for v2).
 * Baseline comes from getServiceInfo().nonces[1] — the authoritative epoch-start value.
 * This is restart-proof — the baseline comes from the staking contract, not in-memory state.
 */
async function getEpochActivityCount(
  activityChecker: ethers.Contract,
  multisig: string,
  baselineActivityCount: number,
): Promise<number> {
  const currentNonces = await activityChecker.getMultisigNonces(multisig);
  const currentCount = Number(currentNonces[1]);
  return currentCount - baselineActivityCount;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function checkEpochGate(
  stakingContractAddress: string,
  serviceId: number,
  marketplaceAddress: string,
): Promise<EpochGateResult> {
  const overrideTarget = readPositiveIntEnv('WORKER_STAKING_TARGET');
  const delayBufferSeconds = readPositiveIntEnv('WORKER_STAKING_CHECKPOINT_DELAY_SEC') ?? DEFAULT_CHECKPOINT_DELAY_BUFFER_SEC;
  const safetyMarginActivities = readNonNegativeIntEnv('WORKER_STAKING_SAFETY_MARGIN') ?? DEFAULT_SAFETY_MARGIN_ACTIVITIES;
  const fallbackTarget = overrideTarget ?? DEFAULT_TARGET_ACTIVITIES;

  const gateCacheKey = getGateCacheKey(stakingContractAddress, serviceId, marketplaceAddress);

  // Return cached result if fresh enough
  const cachedGate = cachedGateByService.get(gateCacheKey);
  if (cachedGate && Date.now() - cachedGate.fetchedAt < ACTIVITY_CACHE_TTL_MS) {
    return cachedGate.result;
  }

  try {
    const provider = createRpcProvider(secrets.rpcUrl);
    const stakingContract = new ethers.Contract(stakingContractAddress, STAKING_ABI, provider);

    const [{ tsCheckpoint, nextCheckpoint }, serviceInfo, activityCheckerAddress, livenessPeriod] = await Promise.all([
      getEpochBounds(stakingContract, stakingContractAddress),
      stakingContract.getServiceInfo(serviceId),
      stakingContract.activityChecker(),
      stakingContract.livenessPeriod().then(Number),
    ]);

    const activityChecker = new ethers.Contract(activityCheckerAddress, ACTIVITY_CHECKER_ABI, provider);

    // Use the staking contract's multisig — authoritative source
    const multisig: string = serviceInfo.multisig;
    // nonces[1] is the activity count baseline recorded at epoch checkpoint
    // (requests for v1 checker, deliveries for v2 checker)
    const baselineActivityCount = Number(serviceInfo.nonces[1]);
    const activityCount = await getEpochActivityCount(activityChecker, multisig, baselineActivityCount);
    const targetData = await computeProjectedEpochTarget({
      provider,
      activityCheckerAddress,
      tsCheckpoint,
      livenessPeriod,
      delayBufferSeconds,
      overrideTarget,
      safetyMarginActivities,
    });
    const target = targetData.target;

    const result: EpochGateResult = {
      targetMet: activityCount >= target,
      activityCount,
      target,
      nextCheckpoint,
      multisig,
    };

    log.debug({
      activityCount,
      target,
      targetMet: result.targetMet,
      baselineActivityCount,
      multisig,
      tsCheckpoint,
      nextCheckpoint,
      livenessPeriod,
      effectivePeriodSeconds: targetData.effectivePeriodSeconds,
      effectivePeriodSecondsWithoutBuffer: targetData.effectivePeriodSecondsWithoutBuffer,
      baselineTimestamp: targetData.baselineTimestamp,
      livenessRatio: targetData.livenessRatio.toString(),
      delayBufferSeconds,
      safetyMarginActivities: targetData.safetyMarginActivities,
      targetFromOverride: targetData.usedOverride,
      epochStart: new Date(tsCheckpoint * 1000).toISOString(),
      epochEnd: new Date(nextCheckpoint * 1000).toISOString(),
    }, 'Epoch gate check');

    cachedGateByService.set(gateCacheKey, { result, fetchedAt: Date.now() });
    return result;
  } catch (error: any) {
    log.warn({ error: error.message }, 'Epoch gate check failed — allowing job pickup');
    // Fail open: if we can't check, don't block work
    return { targetMet: false, activityCount: 0, target: fallbackTarget, nextCheckpoint: 0, multisig: '' };
  }
}
