/**
 * Activity Monitor — On-chain activity eligibility checker for multi-service rotation
 *
 * Periodically queries staking contracts and activity checkers to determine
 * which services have met their activity requirements for the current epoch.
 *
 * The eligibility formula (confirmed in Pearl olas-operate-app):
 *   effectivePeriod = max(livenessPeriod, now - tsCheckpoint)
 *   requiredActivities = ceil(effectivePeriod * livenessRatio / 1e18) + SAFETY_MARGIN
 *   eligibleActivities = currentActivityCount - baselineAtCheckpoint
 *   isEligibleForRewards = eligibleActivities >= requiredActivities
 *
 * Data sources (all gas-free view calls):
 *   StakingContract.livenessPeriod()           — epoch length (immutable per contract)
 *   StakingContract.tsCheckpoint()             — last checkpoint time (changes once/epoch)
 *   StakingContract.getServiceInfo(serviceId)  — baseline nonces at checkpoint
 *   StakingContract.activityChecker()          — activity checker address (immutable)
 *   ActivityChecker.livenessRatio()            — required rate in 1e18 (immutable)
 *   ActivityChecker.getMultisigNonces(multisig) — current [safeNonce, activityCount]
 */

import { ethers } from 'ethers';
import { logger } from '../../logging/index.js';
import { createRpcProvider } from '../../config/index.js';

const rotationLogger = logger.child({ component: 'ACTIVITY-MONITOR' });

const SAFETY_MARGIN = 1;

// ABIs (from scripts/wallet/restake.ts and scripts/archive/query-service-165-activity-requirements.ts)
const STAKING_ABI = [
  'function livenessPeriod() view returns (uint256)',
  'function tsCheckpoint() view returns (uint256)',
  'function getServiceInfo(uint256 serviceId) view returns (tuple(address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity))',
  'function activityChecker() view returns (address)',
  'function rewardsPerSecond() view returns (uint256)',
  'function getServiceIds() view returns (uint256[])',
  // Dashboard extensions (from Pearl olas-operate-app STAKING_TOKEN_PROXY_ABI)
  'function calculateStakingReward(uint256 serviceId) view returns (uint256 reward)',
  'function epochCounter() view returns (uint256)',
  'function getNextRewardCheckpointTimestamp() view returns (uint256 tsNext)',
  'function getStakingState(uint256 serviceId) view returns (uint8 stakingState)',
  'function minStakingDeposit() view returns (uint256)',
  'function maxNumServices() view returns (uint256)',
  'function maxNumInactivityPeriods() view returns (uint256)',
];

const ACTIVITY_CHECKER_ABI = [
  'function livenessRatio() view returns (uint256)',
  'function getMultisigNonces(address multisig) view returns (uint256[] memory)',
];

export interface ServiceActivityStatus {
  serviceConfigId: string;
  serviceId: number;
  multisig: string;
  stakingContract: string;

  // On-chain data
  livenessPeriod: number;
  tsCheckpoint: number;
  livenessRatio: bigint;
  currentActivityCount: bigint;
  baselineActivityCount: bigint;

  // Computed
  requiredActivities: number;
  eligibleActivities: number;
  isEligibleForRewards: boolean;
  activitiesNeeded: number;

  // Meta
  fetchedAt: number;
  error?: string;
}

export interface ServiceCheckInput {
  serviceConfigId: string;
  serviceId: number;
  multisig: string;
  stakingContract: string;
}

export interface ServiceDashboardStatus extends ServiceActivityStatus {
  // Rewards
  accruedRewards: bigint;
  rewardsPerSecond: bigint;
  estimatedEpochReward: bigint;

  // Epoch
  currentEpoch: number;
  epochEndTimestamp: number;
  epochProgressPct: number;

  // Staking health
  stakingState: number;          // 0=NotStaked, 1=Staked, 2=Evicted
  inactivityCount: number;
  maxInactivityPeriods: number;
  tsStart: number;               // When service was staked

  // Contract info
  minStakingDeposit: bigint;
  maxNumServices: number;
  currentStakedCount: number;
}

// Contract-level cache (immutable data cached permanently)
interface ContractLevelCache {
  livenessPeriod: number;
  livenessRatio: bigint;
  activityCheckerAddress: string;
  rewardsPerSecond: bigint;
}

// Extended immutable contract data (for dashboard)
interface ContractDashboardCache {
  minStakingDeposit: bigint;
  maxNumServices: number;
  maxInactivityPeriods: number;
}

// Checkpoint-level cache (changes once per epoch)
interface CheckpointCache {
  tsCheckpoint: number;
  fetchedAt: number;
}

export class ActivityMonitor {
  private provider: ethers.JsonRpcProvider;
  private cacheTtlMs: number;

  // Permanent cache for immutable contract data (keyed by staking contract address)
  private contractCache = new Map<string, ContractLevelCache>();

  // TTL cache for checkpoint data (keyed by staking contract address)
  private checkpointCache = new Map<string, CheckpointCache>();

  // Permanent cache for extended dashboard data (keyed by staking contract address)
  private dashboardCache = new Map<string, ContractDashboardCache>();

  constructor(rpcUrl: string, cacheTtlMs: number = 60_000) {
    this.provider = createRpcProvider(rpcUrl);
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * Get contract-level data (immutable, cached permanently)
   */
  private async getContractData(stakingContract: string): Promise<ContractLevelCache> {
    const key = stakingContract.toLowerCase();
    const cached = this.contractCache.get(key);
    if (cached) return cached;

    const contract = new ethers.Contract(stakingContract, STAKING_ABI, this.provider);

    const [livenessPeriod, activityCheckerAddress, rewardsPerSecond] = await Promise.all([
      contract.livenessPeriod(),
      contract.activityChecker(),
      contract.rewardsPerSecond(),
    ]);

    const activityChecker = new ethers.Contract(activityCheckerAddress, ACTIVITY_CHECKER_ABI, this.provider);
    const livenessRatio = await activityChecker.livenessRatio();

    const data: ContractLevelCache = {
      livenessPeriod: Number(livenessPeriod),
      livenessRatio: BigInt(livenessRatio),
      activityCheckerAddress,
      rewardsPerSecond: BigInt(rewardsPerSecond),
    };

    this.contractCache.set(key, data);

    rotationLogger.info({
      stakingContract: key,
      livenessPeriod: data.livenessPeriod,
      livenessRatio: data.livenessRatio.toString(),
      activityChecker: activityCheckerAddress,
    }, 'Cached contract-level data');

    return data;
  }

  /**
   * Get checkpoint timestamp (cached with TTL, changes once per epoch)
   */
  private async getCheckpointTs(stakingContract: string): Promise<number> {
    const key = stakingContract.toLowerCase();
    const cached = this.checkpointCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.tsCheckpoint;
    }

    const contract = new ethers.Contract(stakingContract, STAKING_ABI, this.provider);
    const tsCheckpoint = Number(await contract.tsCheckpoint());

    this.checkpointCache.set(key, { tsCheckpoint, fetchedAt: Date.now() });
    return tsCheckpoint;
  }

  /**
   * Check activity status for a single service
   */
  async checkService(input: ServiceCheckInput): Promise<ServiceActivityStatus> {
    const { serviceConfigId, serviceId, multisig, stakingContract } = input;
    const now = Math.floor(Date.now() / 1000);

    try {
      // Get contract-level data (cached permanently)
      const contractData = await this.getContractData(stakingContract);

      // Get checkpoint timestamp (cached with TTL)
      const tsCheckpoint = await this.getCheckpointTs(stakingContract);

      // Get per-service data (always fresh)
      const stakingContractInstance = new ethers.Contract(stakingContract, STAKING_ABI, this.provider);
      const activityChecker = new ethers.Contract(
        contractData.activityCheckerAddress, ACTIVITY_CHECKER_ABI, this.provider
      );

      const [serviceInfo, currentNonces] = await Promise.all([
        stakingContractInstance.getServiceInfo(serviceId),
        activityChecker.getMultisigNonces(multisig),
      ]);

      // serviceInfo.nonces[1] = activity count at last checkpoint
      // (requests for v1 checker, deliveries for v2 checker)
      const baselineActivityCount = BigInt(serviceInfo.nonces[1] ?? 0n);
      // currentNonces[1] = current activity count from checker
      const currentActivityCount = BigInt(currentNonces[1] ?? 0n);

      // Apply the Pearl eligibility formula
      const effectivePeriod = Math.max(contractData.livenessPeriod, now - tsCheckpoint);
      const requiredActivities = Math.ceil(
        effectivePeriod * Number(contractData.livenessRatio) / 1e18
      ) + SAFETY_MARGIN;
      const eligibleActivities = Number(currentActivityCount - baselineActivityCount);
      const isEligibleForRewards = eligibleActivities >= requiredActivities;
      const activitiesNeeded = Math.max(0, requiredActivities - eligibleActivities);

      const status: ServiceActivityStatus = {
        serviceConfigId,
        serviceId,
        multisig,
        stakingContract,
        livenessPeriod: contractData.livenessPeriod,
        tsCheckpoint,
        livenessRatio: contractData.livenessRatio,
        currentActivityCount,
        baselineActivityCount,
        requiredActivities,
        eligibleActivities,
        isEligibleForRewards,
        activitiesNeeded,
        fetchedAt: Date.now(),
      };

      rotationLogger.debug({
        serviceId,
        eligible: isEligibleForRewards,
        activitiesNeeded,
        required: requiredActivities,
        current: eligibleActivities,
      }, 'Activity check');

      return status;
    } catch (error: any) {
      rotationLogger.error({
        serviceId,
        stakingContract,
        error: error?.message || String(error),
      }, 'Activity check failed');

      return {
        serviceConfigId,
        serviceId,
        multisig,
        stakingContract,
        livenessPeriod: 0,
        tsCheckpoint: 0,
        livenessRatio: 0n,
        currentActivityCount: 0n,
        baselineActivityCount: 0n,
        requiredActivities: 0,
        eligibleActivities: 0,
        isEligibleForRewards: false,
        activitiesNeeded: -1,
        fetchedAt: Date.now(),
        error: error?.message || String(error),
      };
    }
  }

  /**
   * Check activity status for all services
   * Groups queries by staking contract for efficiency
   */
  async checkAllServices(inputs: ServiceCheckInput[]): Promise<ServiceActivityStatus[]> {
    if (inputs.length === 0) return [];

    // Pre-warm contract caches for all unique staking contracts (parallel)
    const uniqueContracts = [...new Set(inputs.map(i => i.stakingContract.toLowerCase()))];
    await Promise.all(uniqueContracts.map(c => this.getContractData(c).catch(() => null)));
    await Promise.all(uniqueContracts.map(c => this.getCheckpointTs(c).catch(() => 0)));

    // Check each service (per-service data must be fresh)
    return Promise.all(inputs.map(input => this.checkService(input)));
  }

  /**
   * Get extended contract data for dashboard (immutable, cached permanently)
   */
  private async getContractDashboardData(stakingContract: string): Promise<ContractDashboardCache> {
    const key = stakingContract.toLowerCase();
    const cached = this.dashboardCache.get(key);
    if (cached) return cached;

    const contract = new ethers.Contract(stakingContract, STAKING_ABI, this.provider);

    const [minStakingDeposit, maxNumServices, maxInactivityPeriods] = await Promise.all([
      contract.minStakingDeposit(),
      contract.maxNumServices(),
      contract.maxNumInactivityPeriods(),
    ]);

    const data: ContractDashboardCache = {
      minStakingDeposit: BigInt(minStakingDeposit),
      maxNumServices: Number(maxNumServices),
      maxInactivityPeriods: Number(maxInactivityPeriods),
    };

    this.dashboardCache.set(key, data);
    return data;
  }

  /**
   * Get enriched dashboard data for a service (activity + rewards + staking health)
   */
  async getDashboardData(input: ServiceCheckInput): Promise<ServiceDashboardStatus> {
    const { serviceConfigId, serviceId, multisig, stakingContract } = input;
    const now = Math.floor(Date.now() / 1000);

    // Get base activity status first
    const activity = await this.checkService(input);

    if (activity.error) {
      // Return with zeroed dashboard fields on error
      return {
        ...activity,
        accruedRewards: 0n,
        rewardsPerSecond: 0n,
        estimatedEpochReward: 0n,
        currentEpoch: 0,
        epochEndTimestamp: 0,
        epochProgressPct: 0,
        stakingState: 0,
        inactivityCount: 0,
        maxInactivityPeriods: 0,
        tsStart: 0,
        minStakingDeposit: 0n,
        maxNumServices: 0,
        currentStakedCount: 0,
      };
    }

    try {
      const contractData = await this.getContractData(stakingContract);
      const dashboardData = await this.getContractDashboardData(stakingContract);
      const contract = new ethers.Contract(stakingContract, STAKING_ABI, this.provider);

      // Fetch dashboard-specific data (parallel)
      const [accruedRewards, epochCounter, nextCheckpointTs, stakingState, serviceIds, serviceInfo] = await Promise.all([
        contract.calculateStakingReward(serviceId).catch(() => 0n),
        contract.epochCounter().catch(() => 0n),
        contract.getNextRewardCheckpointTimestamp().catch(() => 0n),
        contract.getStakingState(serviceId).catch(() => 0),
        contract.getServiceIds().catch(() => []),
        contract.getServiceInfo(serviceId),
      ]);

      const tsCheckpoint = activity.tsCheckpoint;
      const livenessPeriod = activity.livenessPeriod;
      const epochEndTs = Number(nextCheckpointTs) || (tsCheckpoint + livenessPeriod);
      const elapsed = now - tsCheckpoint;
      const epochProgressPct = livenessPeriod > 0
        ? Math.min(100, Math.round((elapsed / livenessPeriod) * 100))
        : 0;

      return {
        ...activity,
        accruedRewards: BigInt(accruedRewards),
        rewardsPerSecond: contractData.rewardsPerSecond,
        estimatedEpochReward: contractData.rewardsPerSecond * BigInt(livenessPeriod),
        currentEpoch: Number(epochCounter),
        epochEndTimestamp: epochEndTs,
        epochProgressPct,
        stakingState: Number(stakingState),
        inactivityCount: Number(serviceInfo.inactivity ?? 0),
        maxInactivityPeriods: dashboardData.maxInactivityPeriods,
        tsStart: Number(serviceInfo.tsStart ?? 0),
        minStakingDeposit: dashboardData.minStakingDeposit,
        maxNumServices: dashboardData.maxNumServices,
        currentStakedCount: Array.isArray(serviceIds) ? serviceIds.length : 0,
      };
    } catch (error: any) {
      rotationLogger.error({
        serviceId,
        error: error?.message || String(error),
      }, 'Dashboard data fetch failed');

      return {
        ...activity,
        accruedRewards: 0n,
        rewardsPerSecond: 0n,
        estimatedEpochReward: 0n,
        currentEpoch: 0,
        epochEndTimestamp: 0,
        epochProgressPct: 0,
        stakingState: 0,
        inactivityCount: 0,
        maxInactivityPeriods: 0,
        tsStart: 0,
        minStakingDeposit: 0n,
        maxNumServices: 0,
        currentStakedCount: 0,
      };
    }
  }

  /**
   * Get dashboard data for all services
   */
  async getAllDashboardData(inputs: ServiceCheckInput[]): Promise<ServiceDashboardStatus[]> {
    if (inputs.length === 0) return [];

    // Pre-warm caches
    const uniqueContracts = [...new Set(inputs.map(i => i.stakingContract.toLowerCase()))];
    await Promise.all(uniqueContracts.map(c => this.getContractData(c).catch(() => null)));
    await Promise.all(uniqueContracts.map(c => this.getContractDashboardData(c).catch(() => null)));
    await Promise.all(uniqueContracts.map(c => this.getCheckpointTs(c).catch(() => 0)));

    return Promise.all(inputs.map(input => this.getDashboardData(input)));
  }

  /**
   * Clear all caches (for testing or when staking state changes)
   */
  clearCache(): void {
    this.contractCache.clear();
    this.checkpointCache.clear();
    this.dashboardCache.clear();
    rotationLogger.debug('Activity monitor caches cleared');
  }
}
