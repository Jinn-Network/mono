/**
 * Best-effort status collection for GET /v1/status (RPC + earning store + SQLite).
 */

import { createPublicClient, http, type PublicClient } from 'viem';

/** Narrow RPC surface for balance fan-out (avoids PublicClient / chain-specific getBlock incompatibilities). */
type StatusBalanceRpc = Pick<PublicClient, 'getBalance' | 'readContract'>;
import { base, baseSepolia } from 'viem/chains';
import type { Store } from '../store/store.js';
import { FleetStateStore } from '../earning/store.js';
import { getChainConfig } from '../earning/contracts.js';
import { JINN_STAKING_ABI } from '../earning/jinn-rewards.js';
import type { FleetState } from '../earning/types.js';
import { displayFleetServiceIndex } from '../earning/fleet-display-index.js';
import {
  assembleStatusV1,
  type GatheredStatusRaw,
  type ServiceBalanceErrorEntry,
  type StatusV1Response,
  resolveMasterDailyEstimateWei,
} from './status-build.js';
import { listStolasClaimTargets } from '../earning/stolas-claim.js';
import { gatherPortfolioV0Status } from './portfolio-v0-build.js';
import type { BalanceCacheEntry } from '../store/store.js';

const ERC20_BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export interface StatusGatherConfig {
  earningDir: string;
  rpcUrl: string;
  network: 'mainnet' | 'testnet';
  pollIntervalMs: number;
  masterEthDailyEstimateWei?: string;
  rewardClaimIntervalMs: number;
  testnetL2DeploymentPath?: string;
  testnetL2TokenDeploymentPath?: string;
  testnetMechDeploymentPath?: string;
  testnetStolasDeploymentPath?: string;
  testnetClaimRegistryDeploymentPath?: string;
}

function chainKey(network: 'mainnet' | 'testnet'): 'base' | 'base-sepolia' {
  return network === 'testnet' ? 'base-sepolia' : 'base';
}

async function sumPendingStakingRewards(
  rpcUrl: string,
  network: 'mainnet' | 'testnet',
  fleet: FleetState,
): Promise<{ sum: string; pendingByService: Record<number, string>; nextCheckpointAt?: string } | { error: string }> {
  const targets = listStolasClaimTargets(fleet.services);
  if (targets.length === 0) {
    return { sum: '0', pendingByService: {} };
  }

  const chain = network === 'testnet' ? baseSepolia : base;
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  let total = 0n;
  const pendingByService: Record<number, string> = {};
  let nextCheckpointAt: string | undefined;
  try {
    for (const t of targets) {
      const pending = await client.readContract({
        address: t.stakingProxy as `0x${string}`,
        abi: JINN_STAKING_ABI,
        functionName: 'calculateStakingReward',
        args: [BigInt(t.serviceId)],
      });
      total += pending;
      const svc = fleet.services.find((s) => s.service_id === t.serviceId);
      if (svc) {
        pendingByService[displayFleetServiceIndex(svc)] = pending.toString();
      }
    }
    // All staked services in a Phase 1b fleet share the same staking proxy;
    // a single read of the earliest checkpoint timestamp is sufficient.
    try {
      const nextTs = await client.readContract({
        address: targets[0]!.stakingProxy as `0x${string}`,
        abi: JINN_STAKING_ABI,
        functionName: 'getNextRewardCheckpointTimestamp',
      });
      if (nextTs > 0n) {
        nextCheckpointAt = new Date(Number(nextTs) * 1000).toISOString();
      }
    } catch {
      // Non-fatal: older staking proxy deploys may not expose this function;
      // rewards-build keeps nextCheckpointAt as null in that case.
    }
    return nextCheckpointAt
      ? { sum: total.toString(), pendingByService, nextCheckpointAt }
      : { sum: total.toString(), pendingByService };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function hasUsefulCacheValues(entry: BalanceCacheEntry, isAgentRole: boolean): boolean {
  if (isAgentRole) return entry.nativeWei != null;
  return entry.nativeWei != null || entry.bondWei != null;
}

async function gatherServiceBalances(
  store: Store,
  rpcClient: StatusBalanceRpc,
  fleet: FleetState,
  chainCfg: ReturnType<typeof getChainConfig>,
): Promise<{
  byDisplay: Record<
    number,
    { agentNativeWei: string; safeNativeWei: string; safeBondWei: string }
  >;
  errorsByDisplay: Record<number, ServiceBalanceErrorEntry>;
}> {
  const ttlMs = 30_000;
  const now = Date.now();
  const cache = new Map(store.getBalanceCache().map((e) => [e.role, e]));
  const out: Record<
    number,
    { agentNativeWei: string; safeNativeWei: string; safeBondWei: string }
  > = {};
  const errorsByDisplay: Record<number, ServiceBalanceErrorEntry> = {};

  async function getCachedOrFetch(
    role: string,
    address: string,
    isAgentRole: boolean,
    fetcher: () => Promise<{ nativeWei?: string; bondWei?: string; assetExtraJson?: string }>,
  ): Promise<BalanceCacheEntry> {
    const cached = cache.get(role);
    if (cached && cached.address.toLowerCase() === address.toLowerCase()) {
      const age = now - Date.parse(cached.fetchedAt);
      const canUseTtl =
        Number.isFinite(age) && age <= ttlMs && (!cached.error || hasUsefulCacheValues(cached, isAgentRole));
      if (canUseTtl) return cached;
    }
    try {
      const fresh = await fetcher();
      const entry: BalanceCacheEntry = {
        role,
        address,
        nativeWei: fresh.nativeWei ?? null,
        bondWei: fresh.bondWei ?? null,
        assetExtraJson: fresh.assetExtraJson ?? null,
        fetchedAt: new Date(now).toISOString(),
        error: null,
      };
      store.upsertBalanceCache(entry);
      cache.set(role, entry);
      return entry;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const keepTs =
        cached &&
        hasUsefulCacheValues(cached, isAgentRole) &&
        cached.fetchedAt;
      const entry: BalanceCacheEntry = {
        role,
        address,
        nativeWei: cached?.nativeWei ?? null,
        bondWei: cached?.bondWei ?? null,
        assetExtraJson: cached?.assetExtraJson ?? null,
        fetchedAt: (keepTs ? keepTs : new Date(now).toISOString()) as string,
        error: errMsg,
      };
      store.upsertBalanceCache(entry);
      cache.set(role, entry);
      return entry;
    }
  }

  await Promise.all(
    fleet.services.map(async (svc) => {
      const displayIndex = displayFleetServiceIndex(svc);
      const agentAddr = svc.agent_address;
      const safeAddr = svc.safe_address;
      if (!agentAddr && !safeAddr) return;

      const agentRole = `service.${displayIndex}.agent`;
      const safeRole = `service.${displayIndex}.multisig`;
      const [agent, safe] = await Promise.all([
        agentAddr
          ? getCachedOrFetch(agentRole, agentAddr, true, async () => {
              const native = await rpcClient.getBalance({ address: agentAddr as `0x${string}` });
              return { nativeWei: native.toString() };
            })
          : Promise.resolve<BalanceCacheEntry>({
              role: agentRole, address: '0x', nativeWei: '0', bondWei: '0', fetchedAt: new Date(now).toISOString(),
            }),
        safeAddr
          ? getCachedOrFetch(safeRole, safeAddr, false, async () => {
              const [native, bond] = await Promise.all([
                rpcClient.getBalance({ address: safeAddr as `0x${string}` }),
                rpcClient.readContract({
                  address: chainCfg.olasToken as `0x${string}`,
                  abi: ERC20_BALANCE_OF_ABI,
                  functionName: 'balanceOf',
                  args: [safeAddr as `0x${string}`],
                }),
              ]);
              return { nativeWei: native.toString(), bondWei: bond.toString() };
            })
          : Promise.resolve<BalanceCacheEntry>({
              role: safeRole, address: '0x', nativeWei: '0', bondWei: '0', fetchedAt: new Date(now).toISOString(),
            }),
      ]);
      const agentWei = agent.nativeWei ?? '0';
      const safeNWei = safe.nativeWei ?? '0';
      const safeBWei = safe.bondWei ?? '0';
      const rowErr: ServiceBalanceErrorEntry = {};
      if (agent.error) rowErr.agent = agent.error;
      if (safe.error) rowErr.multisig = safe.error;
      if (Object.keys(rowErr).length) errorsByDisplay[displayIndex] = rowErr;
      out[displayIndex] = {
        agentNativeWei: agentWei,
        safeNativeWei: safeNWei,
        safeBondWei: safeBWei,
      };
    }),
  );
  return { byDisplay: out, errorsByDisplay };
}

/** Collect status inputs without assembling the legacy mega-response. */
export async function gatherGatheredStatusRaw(
  store: Store,
  status: StatusGatherConfig | undefined,
): Promise<GatheredStatusRaw> {
  const shutdownState = store.getShutdownState();
  const daemonStartedAt = store.getDaemonStartedAt();
  const activityCounts = store.getActivityCountsByKind();
  const recentActivity = store.getRecentActivityEvents(12).map((row) => ({
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    requestId: row.requestId,
    serviceIndex: row.serviceIndex,
    txHash: row.txHash,
    specKind: row.specKind,
    outcome: row.outcome,
  }));
  const lastRewardClaimTickAt = store.getConfigValue('last_reward_claim_tick_at');
  const daily = resolveMasterDailyEstimateWei(
    status?.masterEthDailyEstimateWei,
    status?.pollIntervalMs ?? 5000,
  );

  // portfolio.v0 lifecycle data — best-effort, never throws
  let portfolioV0: ReturnType<typeof gatherPortfolioV0Status> | undefined;
  try {
    portfolioV0 = gatherPortfolioV0Status(store);
  } catch {
    portfolioV0 = undefined;
  }

  const baseRaw: GatheredStatusRaw = {
    shutdownState,
    daemonStartedAt,
    dbPath: store.path,
    earningDir: status?.earningDir,
    activityCounts,
    recentActivity,
    lastRewardClaimTickAt,
    rewardClaimIntervalMs: status?.rewardClaimIntervalMs ?? 0,
    fleet: null,
    rpc: { ok: true },
    master: { address: null },
    pollIntervalMs: status?.pollIntervalMs ?? 5000,
    masterDailyEstimateWei: daily.toString(),
    portfolioV0,
    serviceBalances: {},
    pendingByService: {},
    claimedByService: store.getClaimedRewardsByService(),
  };

  if (!status) {
    return { ...baseRaw, hintsScope: 'sqlite_only' };
  }

  const earningStore = new FleetStateStore(status.earningDir);
  const fleet = await earningStore.tryLoadExisting();

  const vk = chainKey(status.network);
  const chainCfg = getChainConfig(vk, {
    testnetL2DeploymentPath: status.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: status.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: status.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: status.testnetStolasDeploymentPath,
    testnetClaimRegistryDeploymentPath: status.testnetClaimRegistryDeploymentPath,
  });

  const raw: GatheredStatusRaw = {
    ...baseRaw,
    fleet,
    rpc: { ok: false, error: undefined },
    minMasterEthWei: chainCfg.minEoaGasEth.toString(),
    master: {
      address: fleet?.master_address ?? null,
    },
    rewardClaimIntervalMs: status.rewardClaimIntervalMs,
  };

  const viemChain = status.network === 'testnet' ? baseSepolia : base;
  const client = createPublicClient({
    chain: viemChain,
    transport: http(status.rpcUrl),
  });

  try {
    const [blockNumber, chainId] = await Promise.all([
      client.getBlockNumber(),
      client.getChainId(),
    ]);
    raw.rpc = {
      ok: true,
      chainId,
      blockNumber: blockNumber.toString(),
    };
  } catch (e) {
    raw.rpc = {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  if (fleet?.master_address) {
    try {
      const bal = await client.getBalance({
        address: fleet.master_address as `0x${string}`,
      });
      raw.master = {
        address: fleet.master_address,
        balanceWei: bal.toString(),
      };
    } catch (e) {
      raw.master = {
        address: fleet.master_address,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  if (fleet && raw.rpc.ok) {
    const pr = await sumPendingStakingRewards(status.rpcUrl, status.network, fleet);
    if ('sum' in pr) {
      raw.pendingStakingRewardsWei = pr.sum;
      raw.pendingByService = pr.pendingByService;
      if (pr.nextCheckpointAt) raw.nextCheckpointAt = pr.nextCheckpointAt;
    } else {
      raw.pendingRewardsError = pr.error;
    }
  }

  if (fleet) {
    const per: Record<
      number,
      { counts: Record<string, number>; lastEventAt: string | null }
    > = {};
    for (const svc of fleet.services) {
      const di = displayFleetServiceIndex(svc);
      per[di] = {
        counts: store.getActivityCountsForService(di),
        lastEventAt: store.getLastEventAtForService(di),
      };
    }
    raw.perServiceActivity = per;
    const bal = await gatherServiceBalances(store, client, fleet, chainCfg);
    raw.serviceBalances = bal.byDisplay;
    if (Object.keys(bal.errorsByDisplay).length > 0) {
      raw.serviceBalanceErrors = bal.errorsByDisplay;
    }
  }

  return raw;
}

export async function gatherStatusForApi(
  store: Store,
  status: StatusGatherConfig | undefined,
): Promise<StatusV1Response> {
  const raw = await gatherGatheredStatusRaw(store, status);
  return assembleStatusV1(raw);
}
