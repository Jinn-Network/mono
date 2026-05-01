/**
 * Pure assembly for GET /v1/status JSON (testable without RPC or filesystem).
 */

import {
  isOperationalServiceStep,
  isStakedLikeServiceStep,
  type FleetState,
} from '../earning/types.js';
import type { EarningMigrationArchive } from '../earning/store.js';
import type { PortfolioV0Status } from './portfolio-v0-build.js';

const DEFAULT_MASTER_ETH_DAILY_WEI = 1_000_000_000_000_000n;

export type StatusHintsScope = 'full' | 'sqlite_only';

export interface ServiceBalanceErrorEntry {
  agent?: string;
  multisig?: string;
}

export interface GatheredStatusRaw {
  /** sqlite_only: only SQLite-backed fields (e2e / API without fleet context). */
  hintsScope?: StatusHintsScope;
  shutdownState: string | null;
  daemonStartedAt?: string | null;
  dbPath: string;
  earningDir?: string;
  activityCounts: Record<string, number>;
  recentActivity: Array<{
    id: number;
    ts: string | null;
    kind: string;
    requestId: string | null;
    serviceIndex: number | null;
    txHash: string | null;
    specKind: string | null;
    outcome: string | null;
  }>;
  lastRewardClaimTickAt: string | null;
  rewardClaimIntervalMs: number;
  fleet: FleetState | null;
  rpc: { ok: boolean; chainId?: number; blockNumber?: string; error?: string };
  master: {
    address: string | null;
    balanceWei?: string;
    error?: string;
  };
  pendingStakingRewardsWei?: string;
  pendingRewardsError?: string;
  /** ISO timestamp when the staking contract will next accept a checkpoint. */
  nextCheckpointAt?: string;
  pollIntervalMs: number;
  /** Resolved daily burn estimate for runway (wei string). */
  masterDailyEstimateWei: string;
  minMasterEthWei?: string;
  /** portfolio.v0 lifecycle data — populated by gather-status from the SQLite store. */
  portfolioV0?: PortfolioV0Status;
  serviceBalances?: Record<number, { agentNativeWei: string; safeNativeWei: string; safeBondWei: string }>;
  /** Last balance fetch error per service (display index). Present when a fetch failed. */
  serviceBalanceErrors?: Record<number, ServiceBalanceErrorEntry>;
  perServiceActivity?: Record<
    number,
    { counts: Record<string, number>; lastEventAt: string | null }
  >;
  pendingByService?: Record<number, string>;
  claimedByService?: Record<number, { total: string; lastAt: string; lastTxHash: string }>;
  migrationArchive?: EarningMigrationArchive;
}

export interface StatusV1Response {
  statusMode: 'full' | 'sqlite_only';
  daemon: {
    shutdownState: string | null;
    startedAt: string | null;
    dbPath: string;
    timestamp: string;
  };
  rpc: GatheredStatusRaw['rpc'];
  fleet: {
    loaded: boolean;
    chain?: string;
    stakingMode?: string;
    masterAddress?: string | null;
    services: Array<{
      index: number;
      step: string;
      serviceId: number | null;
      safeAddress: string | null;
      mechAddress: string | null;
      stakingAddress: string | null;
      agentId: string | null;
      identityRegistryAddress: string | null;
      safeBoundToAgent: boolean;
      identityBindingStatus: 'bound' | 'pending' | 'not_applicable';
    }>;
    stakedLikeCount: number;
    completeCount: number;
  };
  activity: {
    counts: Record<string, number>;
    recent: GatheredStatusRaw['recentActivity'];
  };
  rewards: {
    claimLoopIntervalMs: number;
    lastClaimTickAt: string | null;
    pendingStakingRewardsWei?: string;
    claimedStakingRewardsWei: string;
    totalStakingRewardsWei?: string;
    pendingRewardsError?: string;
  };
  masterGas: {
    address: string | null;
    balanceWei?: string;
    dailyEstimateWei: string;
    /** Approximate days of excess ETH above minimum at daily estimate (if computable). */
    runwayDaysExcess?: string;
    minEthWei?: string;
    error?: string;
  };
  earnings: {
    hint: string;
  };
  nextActions: string[];
  /** portfolio.v0 lifecycle data — optional, absent when not available. */
  portfolioV0?: PortfolioV0Status;
}

/**
 * Match bootstrap heuristic for master daily gas when config omits JINN_MASTER_ETH_DAILY_WEI.
 */
export function resolveMasterDailyEstimateWei(
  explicit: string | undefined,
  pollIntervalMs: number,
): bigint {
  if (explicit !== undefined && /^\d+$/.test(explicit.trim())) {
    return BigInt(explicit.trim());
  }
  const interval = Math.max(pollIntervalMs, 1000);
  const pollsPerDay = 86400000 / interval;
  const txsPerDay = Math.min(Math.ceil(pollsPerDay / 600), 12);
  const txCostWei = 150_000n * 2_000_000_000n;
  const fromPoll = BigInt(txsPerDay) * txCostWei;
  return fromPoll > DEFAULT_MASTER_ETH_DAILY_WEI ? fromPoll : DEFAULT_MASTER_ETH_DAILY_WEI;
}

function fleetSummary(fleet: FleetState | null): StatusV1Response['fleet'] {
  if (!fleet) {
    return {
      loaded: false,
      services: [],
      stakedLikeCount: 0,
      completeCount: 0,
    };
  }
  const services = fleet.services.map(s => ({
    index: s.index,
    step: s.step,
    serviceId: s.service_id,
    safeAddress: s.safe_address,
    mechAddress: s.mech_address,
    stakingAddress: s.staking_address,
    agentId: s.agent_id ?? null,
    identityRegistryAddress: s.identity_registry_address ?? null,
    safeBoundToAgent: s.safe_bound_to_agent === true,
    identityBindingStatus: (
      s.safe_bound_to_agent === true
        ? 'bound'
        : s.agent_id && s.safe_address
          ? 'pending'
          : 'not_applicable'
    ) as 'bound' | 'pending' | 'not_applicable',
  }));
  const stakedLikeCount = fleet.services.filter(s => isStakedLikeServiceStep(s.step)).length;
  const completeCount = fleet.services.filter(s => isOperationalServiceStep(s.step)).length;
  return {
    loaded: true,
    chain: fleet.chain,
    stakingMode: fleet.staking_mode,
    masterAddress: fleet.master_address,
    services,
    stakedLikeCount,
    completeCount,
  };
}

function computeRunwayDaysExcess(
  balanceWei: bigint,
  minWei: bigint | undefined,
  daily: bigint,
): string | undefined {
  if (daily === 0n) return undefined;
  if (minWei !== undefined) {
    if (balanceWei <= minWei) return '0';
    const excess = balanceWei - minWei;
    if (excess <= 0n) return '0';
    return (excess / daily).toString();
  }
  if (balanceWei <= 0n) return '0';
  return (balanceWei / daily).toString();
}

function sumClaimedRewardsWei(raw: GatheredStatusRaw): bigint {
  let total = 0n;
  for (const claim of Object.values(raw.claimedByService ?? {})) {
    try {
      total += BigInt(claim.total);
    } catch {
      /* ignore malformed legacy rows */
    }
  }
  return total;
}

function buildEarningsHint(raw: GatheredStatusRaw, fleetSum: StatusV1Response['fleet']): string {
  if (raw.hintsScope === 'sqlite_only') {
    return 'Fleet and on-chain earnings hints omitted in API-only mode.';
  }
  if (raw.pendingRewardsError) {
    return `Could not read pending staking rewards: ${raw.pendingRewardsError}`;
  }
  if (raw.pendingStakingRewardsWei !== undefined) {
    const n = fleetSum.stakedLikeCount;
    return `Sum of on-chain calculateStakingReward (wei) across eligible services: ${raw.pendingStakingRewardsWei} (${n} staked-like service(s) in local state).`;
  }
  if (!fleetSum.loaded || fleetSum.services.length === 0) {
    return 'No fleet services in local state — earnings accrue after staking completes.';
  }
  return 'Pending reward sum not available (no RPC or no staking proxies on services).';
}

function buildNextActions(raw: GatheredStatusRaw, fleetSum: StatusV1Response['fleet']): string[] {
  const actions: string[] = [];

  if (raw.hintsScope === 'sqlite_only') {
    return [
      'Full operations status requires daemon start with status context, or run `npm run status` while the daemon is up.',
    ];
  }

  if (!raw.rpc.ok) {
    actions.push('Restore RPC access (check rpcUrl / network) for live balances and rewards.');
  }

  if (!fleetSum.loaded) {
    actions.push('Run bootstrap (`jinn run` with JINN_PASSWORD) to create fleet and staking state.');
  } else {
    if (!raw.fleet?.master_address) {
      actions.push('Complete earning bootstrap so master_address is recorded.');
    }
    for (const s of raw.fleet?.services ?? []) {
      if (s.error) {
        actions.push(`Service ${s.index}: ${s.error}`);
      }
      if (!isOperationalServiceStep(s.step)) {
        actions.push(`Resume service ${s.index}: local step "${s.step}" — re-run jinn run.`);
      } else if (s.step === 'safe_binding_pending') {
        actions.push(`Service ${s.index}: identity binding pending; daemon will retry setAgentWallet on next bootstrap.`);
      }
    }
  }

  if (raw.master.address && raw.minMasterEthWei && raw.master.balanceWei !== undefined) {
    const bal = BigInt(raw.master.balanceWei);
    const min = BigInt(raw.minMasterEthWei);
    if (bal < min) {
      actions.push('Fund master EOA with more ETH for gas (below configured minimum).');
    }
  }

  const daily = BigInt(raw.masterDailyEstimateWei);
  if (
    daily > 0n &&
    raw.master.balanceWei !== undefined &&
    raw.minMasterEthWei !== undefined
  ) {
    const bal = BigInt(raw.master.balanceWei);
    const min = BigInt(raw.minMasterEthWei);
    const excess = bal > min ? bal - min : 0n;
    const days = excess / daily;
    if (days < 3n && raw.rpc.ok) {
      actions.push('Master ETH runway is low; top up the master wallet soon.');
    }
  }

  if (raw.rewardClaimIntervalMs > 0 && !raw.lastRewardClaimTickAt && fleetSum.stakedLikeCount > 0) {
    actions.push('Reward claim loop is enabled; last tick time will appear after the first distributor pass.');
  }

  const dedup = [...new Set(actions)];
  if (dedup.length === 0) {
    dedup.push('No urgent actions — daemon loops and reward claims run on schedule.');
  }
  return dedup;
}

export function assembleStatusV1(raw: GatheredStatusRaw): StatusV1Response {
  const fleetSum = fleetSummary(raw.fleet);
  const mode: 'full' | 'sqlite_only' = raw.hintsScope === 'sqlite_only' ? 'sqlite_only' : 'full';
  const claimedRewardsWei = sumClaimedRewardsWei(raw);
  let pendingRewardsWei: bigint | undefined;
  if (raw.pendingStakingRewardsWei !== undefined) {
    try {
      pendingRewardsWei = BigInt(raw.pendingStakingRewardsWei);
    } catch {
      pendingRewardsWei = undefined;
    }
  }
  const runway =
    raw.master.balanceWei !== undefined
      ? computeRunwayDaysExcess(
          BigInt(raw.master.balanceWei),
          raw.minMasterEthWei !== undefined ? BigInt(raw.minMasterEthWei) : undefined,
          BigInt(raw.masterDailyEstimateWei),
        )
      : undefined;

  return {
    statusMode: mode,
    daemon: {
      shutdownState: raw.shutdownState,
      startedAt: raw.daemonStartedAt ?? null,
      dbPath: raw.dbPath,
      timestamp: new Date().toISOString(),
    },
    rpc: raw.rpc,
    fleet: fleetSum,
    activity: {
      counts: raw.activityCounts,
      recent: raw.recentActivity,
    },
    rewards: {
      claimLoopIntervalMs: raw.rewardClaimIntervalMs,
      lastClaimTickAt: raw.lastRewardClaimTickAt,
      pendingStakingRewardsWei: raw.pendingStakingRewardsWei,
      claimedStakingRewardsWei: claimedRewardsWei.toString(),
      totalStakingRewardsWei:
        pendingRewardsWei !== undefined
          ? (claimedRewardsWei + pendingRewardsWei).toString()
          : claimedRewardsWei.toString(),
      pendingRewardsError: raw.pendingRewardsError,
    },
    masterGas: {
      address: raw.master.address,
      balanceWei: raw.master.balanceWei,
      dailyEstimateWei: raw.masterDailyEstimateWei,
      runwayDaysExcess:
        raw.master.balanceWei !== undefined && runway !== undefined ? runway : undefined,
      minEthWei: raw.minMasterEthWei,
      error: raw.master.error,
    },
    earnings: {
      hint: buildEarningsHint(raw, fleetSum),
    },
    nextActions: buildNextActions(raw, fleetSum),
    ...(raw.portfolioV0 !== undefined ? { portfolioV0: raw.portfolioV0 } : {}),
  };
}
