/**
 * Periodic stOLAS distributor reward claims for all staked fleet services.
 *
 * Scheduling: interval from config (default 10 minutes). OLAS/Jinn checkpoints are gated by
 * liveness periods (often much longer on mainnet); polling at this cadence is a balance between
 * catching rewards before eviction and RPC/gas overhead. Operators can tune via
 * rewardClaimIntervalMs / JINN_REWARD_CLAIM_INTERVAL_MS. Set interval to 0 to disable.
 */

import type { PublicClient } from 'viem';
import type { WalletClient } from 'viem';
import { FleetStateStore } from '../earning/store.js';
import {
  listStolasClaimTargets,
  tickStolasDistributorClaims,
  type StolasClaimTickResult,
} from '../earning/stolas-claim.js';
import type { FleetState } from '../earning/types.js';
import type { Store } from '../store/store.js';
import { emitEvent } from '../observability/emit-event.js';
import { displayFleetServiceIndex } from '../earning/fleet-display-index.js';
import { recordLoopTick } from './loop-heartbeat.js';

export interface RewardClaimLoopConfig {
  intervalMs: number;
  publicClient: PublicClient;
  /** Master EOA — same signer as distributor.stake() in bootstrap (pays gas). */
  masterWallet: WalletClient;
  store: FleetStateStore;
  chain: 'base' | 'base-sepolia';
  /** Resolved from getChainConfig (artifact overrides). */
  distributorAddress: string | undefined;
  /** When set, records last claim-loop tick time for GET /v1/status. */
  jinnStore?: Store;
}

export type RewardClaimTickConfig = Omit<RewardClaimLoopConfig, 'intervalMs'> & {
  /** When true, per-service claim failures can throw (CLI); daemon omits. */
  strict?: boolean;
};

export async function runRewardClaimOnce(cfg: RewardClaimTickConfig): Promise<StolasClaimTickResult> {
  const state = await cfg.store.load(cfg.chain);
  const targets = listStolasClaimTargets(state.services);
  return tickStolasDistributorClaims(cfg.publicClient, cfg.masterWallet, {
    distributorAddress: cfg.distributorAddress,
    stakingMode: state.staking_mode,
    targets,
    strict: cfg.strict,
  });
}

export function recordRewardClaimResult(
  jinnStore: Store,
  state: FleetState,
  result: StolasClaimTickResult,
  distributorAddress: string | undefined,
  source = 'reward-claim',
): void {
  if (result.claims.length === 0) return;
  const serviceByStakingId = new Map<number, (typeof state.services)[number]>();
  for (const svc of state.services) {
    if (svc.service_id != null) serviceByStakingId.set(svc.service_id, svc);
  }
  for (const claim of result.claims) {
    const svc = serviceByStakingId.get(claim.serviceId);
    if (!svc) continue;
    const serviceIndex = displayFleetServiceIndex(svc);
    jinnStore.recordRewardClaim({
      ts: new Date().toISOString(),
      serviceIndex,
      serviceId: claim.serviceId,
      stakingProxy: claim.stakingProxy,
      distributor: distributorAddress ?? '0x',
      txHash: claim.txHash,
      amountWei: claim.amountWei,
    });
    emitEvent(jinnStore, {
      kind: 'reward_claimed',
      serviceIndex,
      txHash: claim.txHash,
      outcome: 'ok',
      detail: `Submitted distributor.claim for service ${claim.serviceId} (pre-split queue: ${claim.amountWei} wei; operator collector-slot share only)`,
    }, source);
  }
}

export class RewardClaimLoop {
  private stopped = false;

  constructor(private readonly config: RewardClaimLoopConfig) {}

  stop(): void {
    this.stopped = true;
  }

  async runOnce(): Promise<void> {
    const result = await runRewardClaimOnce(this.config);
    if (!this.config.jinnStore || result.claims.length === 0) return;
    const state = await this.config.store.load(this.config.chain);
    recordRewardClaimResult(
      this.config.jinnStore,
      state,
      result,
      this.config.distributorAddress,
      'reward-claim',
    );
  }

  async run(): Promise<void> {
    if (this.config.intervalMs <= 0) {
      return;
    }

    while (!this.stopped) {
      try {
        await this.runOnce();
      } catch (err) {
        console.error('[reward-claim] Tick failed (non-fatal):', err instanceof Error ? err.message : err);
        this.config.jinnStore && emitEvent(this.config.jinnStore, {
          kind: 'tick_error',
          outcome: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        }, 'reward-claim');
      }
      this.config.jinnStore?.setConfigValue('last_reward_claim_tick_at', new Date().toISOString());
      if (this.config.jinnStore) recordLoopTick(this.config.jinnStore, 'reward-claim'); // #1043 loop watchdog
      await new Promise(r => setTimeout(r, this.config.intervalMs));
    }
  }
}
