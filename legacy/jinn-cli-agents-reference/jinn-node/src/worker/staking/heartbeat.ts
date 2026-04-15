/**
 * Staking Heartbeat — Activity Count Booster
 *
 * v1 staking counts marketplace REQUESTS (mapRequestCounts), so a heartbeat is
 * just a lightweight request.
 *
 * v2 staking counts marketplace DELIVERIES (mapDeliveryCounts), but heartbeat
 * requests are self-targeted and never get naturally delivered by the worker.
 * For those services we submit the request and immediately self-deliver it
 * through the mech's normal Safe -> mech -> marketplace path.
 *
 * Detection: we compare activityChecker.getMultisigNonces(multisig)[1] against
 * marketplace.mapRequestCounts(multisig). If they match, the checker is
 * request-based (v1). If they differ, the checker uses a different metric
 * (currently deliveries in v2).
 *
 * The target is computed dynamically from on-chain livenessRatio and epoch
 * timing, with an optional delay buffer for late checkpoints.
 */

import { ethers } from 'ethers';
import { deliverViaSafe } from '@jinn-network/mech-client-ts/dist/post_deliver.js';
import { workerLogger } from '../../logging/index.js';
import { getServicePrivateKey, getServiceSafeAddress, getMechAddress, getMechChainConfig } from '../../env/operate-profile.js';
// NOTE: getServiceSafeAddress is only used for the warning log comparing worker vs staking multisig
import { submitMarketplaceRequest } from '../MechMarketplaceRequester.js';
import { computeProjectedEpochTarget, readNonNegativeIntEnv, readPositiveIntEnv } from './target.js';
import type { ServiceInfo } from '../ServiceConfigReader.js';
import { config, secrets, createRpcProvider } from '../../config/index.js';
import { acquireSafeLock } from '../safeTxMutex.js';

const log = workerLogger.child({ component: 'HEARTBEAT' });

const DEFAULT_TARGET_ACTIVITIES = 61;
const DEFAULT_CHECKPOINT_DELAY_BUFFER_SEC = 0;
const DEFAULT_SAFETY_MARGIN_ACTIVITIES = 1;

const STAKING_ABI = [
  'function livenessPeriod() view returns (uint256)',
  'function tsCheckpoint() view returns (uint256)',
  'function getNextRewardCheckpointTimestamp() view returns (uint256)',
  'function activityChecker() view returns (address)',
  'function getServiceInfo(uint256 serviceId) view returns (tuple(address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity))',
  'function getStakingState(uint256 serviceId) view returns (uint8)',
];

// OLAS staking states
const STAKING_STATE_STAKED = 1;

const ACTIVITY_CHECKER_ABI = [
  'function livenessRatio() view returns (uint256)',
  'function getMultisigNonces(address multisig) view returns (uint256[] memory)',
];

const MARKETPLACE_ABI = [
  'function mapRequestCounts(address) view returns (uint256)',
];

const MECH_ABI = [
  'function getOperator() view returns (address)',
];

// ── Checker type detection ──────────────────────────────────────────────────

/**
 * Detect whether the activity checker counts marketplace requests (v1)
 * or deliveries (v2).
 * true = request-based (v1)
 * false = delivery-based (v2)
 */
async function detectRequestBasedChecker(
  stakingContractAddress: string,
  marketplaceAddress: string,
  provider: ethers.JsonRpcProvider,
  multisig: string,
): Promise<boolean> {
  try {
    const staking = new ethers.Contract(stakingContractAddress, STAKING_ABI, provider);
    const activityCheckerAddress = await staking.activityChecker();
    const activityChecker = new ethers.Contract(activityCheckerAddress, ACTIVITY_CHECKER_ABI, provider);
    const marketplace = new ethers.Contract(marketplaceAddress, MARKETPLACE_ABI, provider);

    const [checkerNonces, requestCount] = await Promise.all([
      activityChecker.getMultisigNonces(multisig),
      marketplace.mapRequestCounts(multisig),
    ]);

    const checkerActivityCount = BigInt(checkerNonces[1]);
    const marketplaceRequestCount = BigInt(requestCount);
    const isRequestBased = checkerActivityCount === marketplaceRequestCount;

    log.info({
      stakingContract: stakingContractAddress,
      activityChecker: activityCheckerAddress,
      isRequestBased,
    }, isRequestBased
      ? 'Activity checker is request-based (v1)'
      : 'Activity checker is delivery-based (v2)');

    return isRequestBased;
  } catch (error: any) {
    log.warn({ error: error.message }, 'Failed to detect checker type — assuming request-based (v1)');
    return true; // Fail safe: assume v1
  }
}

// Cached staking multisig per service — resolved from on-chain getServiceInfo()
const resolvedMultisigByService = new Map<number, string>();

async function getStakingMultisig(
  stakingContract: string,
  serviceId: number,
  provider: ethers.JsonRpcProvider,
): Promise<string> {
  const cached = resolvedMultisigByService.get(serviceId);
  if (cached) return cached;

  const staking = new ethers.Contract(stakingContract, STAKING_ABI, provider);
  const serviceInfo = await staking.getServiceInfo(serviceId);
  const multisig: string = serviceInfo.multisig;
  resolvedMultisigByService.set(serviceId, multisig);
  return multisig;
}

/**
 * Calculate how many more activities we need this epoch.
 *
 * Uses activityChecker.getMultisigNonces() for the current count and
 * nonces[1] from getServiceInfo for the baseline — both come from the
 * same activity checker, so the subtraction is always consistent.
 */
async function getActivityDeficit(
  stakingContract: string,
  serviceId: number,
  marketplaceAddress: string,
): Promise<{ deficit: number; current: number; target: number; epochSecondsRemaining: number; multisig: string }> {
  const provider = createRpcProvider(secrets.rpcUrl);

  const staking = new ethers.Contract(stakingContract, STAKING_ABI, provider);
  const overrideTarget = readPositiveIntEnv('WORKER_STAKING_TARGET');
  const delayBufferSeconds = readPositiveIntEnv('WORKER_STAKING_CHECKPOINT_DELAY_SEC') ?? DEFAULT_CHECKPOINT_DELAY_BUFFER_SEC;
  const safetyMarginActivities = readNonNegativeIntEnv('WORKER_STAKING_SAFETY_MARGIN') ?? DEFAULT_SAFETY_MARGIN_ACTIVITIES;

  const [tsCheckpoint, nextCheckpoint, serviceInfo, activityCheckerAddress, livenessPeriod] = await Promise.all([
    staking.tsCheckpoint().then(Number),
    staking.getNextRewardCheckpointTimestamp().then(Number),
    staking.getServiceInfo(serviceId),
    staking.activityChecker(),
    staking.livenessPeriod().then(Number),
  ]);

  // Use the staking multisig from on-chain (may differ from worker Safe)
  const multisig: string = serviceInfo.multisig;
  const cachedMultisig = resolvedMultisigByService.get(serviceId);
  if (!cachedMultisig) {
    const workerSafe = getServiceSafeAddress();
    if (workerSafe?.toLowerCase() !== multisig.toLowerCase()) {
      log.warn({ workerSafe, stakingMultisig: multisig }, 'Worker Safe differs from staking multisig — using staking multisig for heartbeats');
    }
    resolvedMultisigByService.set(serviceId, multisig);
  }

  // Read current activity count from the activity checker (v1/v2 agnostic)
  const activityChecker = new ethers.Contract(activityCheckerAddress, ACTIVITY_CHECKER_ABI, provider);
  const currentNonces = await activityChecker.getMultisigNonces(multisig);

  // Baseline from on-chain nonces[1] — authoritative epoch-start activity count
  const baselineActivityCount = Number(serviceInfo.nonces[1]);
  const currentActivityCount = Number(currentNonces[1]);
  const targetData = await computeProjectedEpochTarget({
    provider,
    activityCheckerAddress,
    tsCheckpoint,
    livenessPeriod,
    delayBufferSeconds,
    overrideTarget,
    safetyMarginActivities,
  });
  const target = targetData.target || DEFAULT_TARGET_ACTIVITIES;

  const now = Math.floor(Date.now() / 1000);
  const epochSecondsRemaining = Math.max(0, nextCheckpoint - now);

  const activitiesThisEpoch = currentActivityCount - baselineActivityCount;
  const deficit = Math.max(0, target - activitiesThisEpoch);

  log.info({
    multisig,
    baseline: baselineActivityCount,
    current: currentActivityCount,
    activitiesThisEpoch,
    target,
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
    deficit,
    epochSecondsRemaining,
  }, 'Epoch deficit check');

  return { deficit, current: currentActivityCount, target, epochSecondsRemaining, multisig };
}

/**
 * Submit a single heartbeat request to the marketplace.
 * Uses the active service context for credentials (single-service mode).
 */
async function submitHeartbeat(
  multisig: string,
  mechAddress: string,
  serviceId: number,
  marketplaceAddress: string,
  isRequestBased: boolean,
): Promise<boolean> {
  const privateKey = getServicePrivateKey();
  if (!privateKey) {
    log.warn('No service private key — cannot submit heartbeat');
    return false;
  }
  return submitHeartbeatWithCredentials(multisig, mechAddress, privateKey, serviceId, marketplaceAddress, isRequestBased);
}

/**
 * Resolve the Safe authorized to call mech.deliverToMarketplace().
 */
async function getMechOperatorSafe(
  mechAddress: string,
  provider: ethers.JsonRpcProvider,
): Promise<string> {
  const mech = new ethers.Contract(mechAddress, MECH_ABI, provider);
  return mech.getOperator();
}

/**
 * Delivery helper for v2 heartbeats.
 * Routes the dummy delivery through the same Safe/mech path used by normal jobs.
 */
async function deliverHeartbeat(
  requestId: string,
  mechAddress: string,
  requesterMultisig: string,
  agentEoaPrivateKey: string,
  rpcUrl: string,
  chainConfig: string,
): Promise<boolean> {
  try {
    const provider = createRpcProvider(rpcUrl);
    const operatorSafe = await getMechOperatorSafe(mechAddress, provider);
    const configuredSafe = getServiceSafeAddress();

    if (configuredSafe && configuredSafe.toLowerCase() !== operatorSafe.toLowerCase()) {
      log.warn({
        requestId,
        configuredSafe,
        operatorSafe,
      }, 'Configured Safe differs from on-chain mech operator — using on-chain operator for heartbeat delivery');
    }

    if (requesterMultisig.toLowerCase() !== operatorSafe.toLowerCase()) {
      log.info({
        requestId,
        requesterMultisig,
        operatorSafe,
      }, 'Heartbeat requester differs from mech operator — request counts accrue to requester, delivery is sent via mech operator');
    }

    const releaseLock = await acquireSafeLock(operatorSafe);
    try {
      const delivery = await (deliverViaSafe as any)({
        chainConfig,
        requestId,
        resultContent: {
          heartbeat: true,
          delivered: true,
          ts: Date.now(),
        },
        targetMechAddress: mechAddress,
        safeAddress: operatorSafe,
        privateKey: agentEoaPrivateKey,
        rpcHttpUrl: rpcUrl,
        wait: true,
      });

      if (delivery?.status !== 'confirmed') {
        log.warn({
          requestId,
          txHash: delivery?.tx_hash,
          status: delivery?.status,
        }, 'Heartbeat self-delivery did not confirm');
        return false;
      }

      log.info({
        requestId,
        txHash: delivery?.tx_hash,
        operatorSafe,
      }, 'Heartbeat successfully self-delivered via Safe/mech');
      return true;
    } finally {
      releaseLock();
    }
  } catch (err: any) {
    log.warn({ requestId, error: err.message }, 'Failed to self-deliver heartbeat via Safe/mech');
    return false;
  }
}

/**
 * Submit a single heartbeat request with explicit credentials.
 * Used by multi-service mode to submit for any service without swapping context.
 */
export async function submitHeartbeatWithCredentials(
  multisig: string,
  mechAddress: string,
  privateKey: string,
  serviceId: number,
  marketplaceAddress: string,
  isRequestBased: boolean,
  chainConfig: string = getMechChainConfig(),
): Promise<boolean> {
  const rpcUrl = secrets.rpcUrl;

  const prompt = JSON.stringify({
    heartbeat: true,
    ts: Date.now(),
    service: serviceId,
  });

  const result = await submitMarketplaceRequest({
    serviceSafeAddress: multisig,
    agentEoaPrivateKey: privateKey,
    mechContractAddress: mechAddress,
    mechMarketplaceAddress: marketplaceAddress,
    prompt,
    rpcUrl,
    ipfsExtraAttributes: {
      heartbeat: true,
      jobName: '__heartbeat__',
    },
  });

  if (result.success && result.requestIds && result.requestIds[0]) {
    log.info({ txHash: result.transactionHash, gasUsed: result.gasUsed, serviceId, requestId: result.requestIds[0] }, 'Heartbeat request submitted');

    if (!isRequestBased) {
      log.info({
        serviceId,
        requestId: result.requestIds[0],
        chainConfig,
      }, 'Checker is v2 (delivery-based) — executing self-delivery via Safe/mech to increment mapDeliveryCounts');
      await deliverHeartbeat(result.requestIds[0], mechAddress, multisig, privateKey, rpcUrl, chainConfig);
    }

  } else if (!result.success) {
    log.warn({ error: result.error, serviceId }, 'Heartbeat request failed');
  } else {
    log.warn({ txHash: result.transactionHash, serviceId }, 'Heartbeat submitted, but no requestId extracted. Cannot self-deliver.');
  }

  return result.success;
}

// Minimum seconds between heartbeat submissions to avoid gas waste
const HEARTBEAT_MIN_INTERVAL_SEC = config.heartbeat.minIntervalSec;

const lastHeartbeatTimestampByService = new Map<number, number>();
const lastHeartbeatTimestampBySigner = new Map<string, number>();

function getSignerKeyForService(service: ServiceInfo): string | null {
  if (service.agentEoaAddress) return service.agentEoaAddress.toLowerCase();
  if (!service.agentPrivateKey) return null;
  try {
    return ethers.computeAddress(service.agentPrivateKey).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Maybe submit heartbeat requests to meet the staking liveness requirement.
 * Called periodically from the worker loop.
 *
 * Only submits if:
 * 1. The service is below the current epoch target.
 * 2. For request-based checkers (v1), the heartbeat request itself counts.
 * 3. For delivery-based checkers (v2), the heartbeat request is immediately
 *    self-delivered through the mech so the delivery counter increments too.
 *
 * Submits one request per call to compensate for slow worker cycles.
 */
export async function maybeSubmitHeartbeat(
  stakingContract: string,
  serviceId: number,
  marketplaceAddress: string,
): Promise<void> {
  log.info({ stakingContract, serviceId }, 'Heartbeat check starting');
  const mechAddress = getMechAddress();

  if (!mechAddress) {
    log.warn('No mech address — skipping heartbeat');
    return;
  }

  const provider = createRpcProvider(secrets.rpcUrl);

  // Check staking state — skip heartbeats for evicted/unstaked services to avoid wasting gas
  try {
    const staking = new ethers.Contract(stakingContract, STAKING_ABI, provider);
    const stakingState = Number(await staking.getStakingState(serviceId));
    if (stakingState !== STAKING_STATE_STAKED) {
      log.warn({ serviceId, stakingState }, 'Service is not staked (evicted or unstaked) — skipping heartbeat');
      return;
    }
  } catch (err: any) {
    log.warn({ serviceId, error: err.message }, 'Failed to check staking state — proceeding with heartbeat');
  }

  // Detect checker type — v1 counts requests, v2 counts deliveries
  // We no longer skip heartbeat for v2, instead we use this flag to explicitly self-deliver the heartbeat.
  const multisig = await getStakingMultisig(stakingContract, serviceId, provider);

  const isRequestBased = await detectRequestBasedChecker(stakingContract, marketplaceAddress, provider, multisig);

  // Throttle: don't submit more often than HEARTBEAT_MIN_INTERVAL_SEC
  const now = Math.floor(Date.now() / 1000);
  const lastHeartbeatTimestamp = lastHeartbeatTimestampByService.get(serviceId) ?? 0;
  if (now - lastHeartbeatTimestamp < HEARTBEAT_MIN_INTERVAL_SEC) {
    log.info({ serviceId, secondsSinceLast: now - lastHeartbeatTimestamp, minInterval: HEARTBEAT_MIN_INTERVAL_SEC }, 'Heartbeat throttled');
    return;
  }

  try {
    const { deficit, current, target, epochSecondsRemaining, multisig: resolvedMultisig } = await getActivityDeficit(stakingContract, serviceId, marketplaceAddress);

    if (deficit <= 0) {
      log.info({ current, target, deficit: 0 }, 'Activity target met for this epoch — no heartbeat needed');
      return;
    }

    // NOTE: Do NOT skip heartbeats when the epoch is "ending" or overdue.
    // checkpoint() hasn't been called yet, so nonces[1] (the baseline) hasn't
    // updated — requests submitted now still count toward the CURRENT epoch.
    // Skipping here causes a race condition: heartbeats stop but checkpoint
    // fires later, freezing the count below the liveness target.

    // Submit only 1 request per call — the worker cycles frequently enough
    // and the on-chain baseline is authoritative, preventing overshoot.
    log.info({
      deficit,
      currentActivityCount: current,
      target,
      epochSecondsRemaining,
      multisig: resolvedMultisig,
    }, `Activity deficit: ${deficit} — submitting 1 heartbeat`);

    await submitHeartbeat(resolvedMultisig, mechAddress, serviceId, marketplaceAddress, isRequestBased);

    lastHeartbeatTimestampByService.set(serviceId, Math.floor(Date.now() / 1000));
  } catch (error: any) {
    log.warn({ error: error.message }, 'Heartbeat check failed (non-fatal)');
  }
}

/**
 * Submit heartbeat for a specific service using explicit credentials.
 * Used in multi-service mode to submit heartbeats for ALL staked services,
 * not just the currently active one.
 */
export async function maybeSubmitHeartbeatForService(
  stakingContract: string,
  serviceId: number,
  marketplaceAddress: string,
  service: ServiceInfo,
): Promise<void> {
  if (!service.mechContractAddress || !service.agentPrivateKey) {
    log.warn({ serviceId, serviceConfigId: service.serviceConfigId }, 'Missing mech or key — skipping heartbeat for service');
    return;
  }

  log.info({ stakingContract, serviceId, serviceConfigId: service.serviceConfigId }, 'Heartbeat check starting');

  const provider = createRpcProvider(secrets.rpcUrl);

  // Check staking state — skip heartbeats for evicted/unstaked services to avoid wasting gas
  try {
    const staking = new ethers.Contract(stakingContract, STAKING_ABI, provider);
    const stakingState = Number(await staking.getStakingState(serviceId));
    if (stakingState !== STAKING_STATE_STAKED) {
      log.warn({ serviceId, stakingState, serviceConfigId: service.serviceConfigId }, 'Service is not staked (evicted or unstaked) — skipping heartbeat');
      return;
    }
  } catch (err: any) {
    log.warn({ serviceId, error: err.message }, 'Failed to check staking state — proceeding with heartbeat');
  }

  // Throttle per service
  const now = Math.floor(Date.now() / 1000);
  const lastHeartbeatTimestamp = lastHeartbeatTimestampByService.get(serviceId) ?? 0;
  if (now - lastHeartbeatTimestamp < HEARTBEAT_MIN_INTERVAL_SEC) {
    log.info({ serviceId, secondsSinceLast: now - lastHeartbeatTimestamp, minInterval: HEARTBEAT_MIN_INTERVAL_SEC }, 'Heartbeat throttled');
    return;
  }

  const signerKey = getSignerKeyForService(service);
  if (signerKey) {
    const lastBySigner = lastHeartbeatTimestampBySigner.get(signerKey) ?? 0;
    if (now - lastBySigner < HEARTBEAT_MIN_INTERVAL_SEC) {
      log.info({
        serviceId,
        signer: signerKey,
        secondsSinceLast: now - lastBySigner,
        minInterval: HEARTBEAT_MIN_INTERVAL_SEC,
      }, 'Heartbeat throttled by signer');
      return;
    }
  }

  try {
    // Detect checker type
    const detectionMultisig = await getStakingMultisig(stakingContract, serviceId, provider);
    const isRequestBased = await detectRequestBasedChecker(stakingContract, marketplaceAddress, provider, detectionMultisig);

    const { deficit, current, target, epochSecondsRemaining, multisig } = await getActivityDeficit(stakingContract, serviceId, marketplaceAddress);

    if (deficit <= 0) {
      log.info({ serviceId, current, target, deficit: 0 }, 'Request target met for this epoch — no heartbeat needed');
      return;
    }

    // NOTE: Do NOT skip heartbeats when the epoch is ending/overdue.
    // checkpoint() hasn't fired yet — requests still count toward current epoch.

    log.info({
      deficit,
      currentRequestCount: current,
      target,
      epochSecondsRemaining,
      multisig,
      serviceId,
    }, `Request deficit: ${deficit} — submitting 1 heartbeat`);

    await submitHeartbeatWithCredentials(
      multisig,
      service.mechContractAddress,
      service.agentPrivateKey,
      serviceId,
      marketplaceAddress,
      isRequestBased,
      service.chain,
    );

    lastHeartbeatTimestampByService.set(serviceId, Math.floor(Date.now() / 1000));
    if (signerKey) {
      lastHeartbeatTimestampBySigner.set(signerKey, Math.floor(Date.now() / 1000));
    }
  } catch (error: any) {
    log.warn({ error: error.message, serviceId }, 'Heartbeat check failed (non-fatal)');
  }
}
