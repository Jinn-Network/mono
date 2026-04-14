/**
 * Periodic stOLAS distributor reward claims for all staked fleet services.
 *
 * Scheduling: interval from config (default 10 minutes). OLAS/Jinn checkpoints are gated by
 * liveness periods (often much longer on mainnet); polling at this cadence is a balance between
 * catching rewards before eviction and RPC/gas overhead. Operators can tune via
 * rewardClaimIntervalMs / JINN_REWARD_CLAIM_INTERVAL_MS. Set interval to 0 to disable.
 */

import type { JsonRpcProvider, Signer } from 'ethers';
import { FleetStateStore } from '../earning/store.js';
import {
  listStolasClaimTargets,
  tickStolasDistributorClaims,
  type StolasClaimTickResult,
} from '../earning/stolas-claim.js';
import type { Store } from '../store/store.js';

export interface RewardClaimLoopConfig {
  intervalMs: number;
  provider: JsonRpcProvider;
  /** Master EOA — same signer as distributor.stake() in bootstrap (pays gas). */
  masterSigner: Signer;
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
  return tickStolasDistributorClaims(cfg.provider, cfg.masterSigner, {
    distributorAddress: cfg.distributorAddress,
    stakingMode: state.staking_mode,
    targets,
    strict: cfg.strict,
  });
}

export class RewardClaimLoop {
  private stopped = false;

  constructor(private readonly config: RewardClaimLoopConfig) {}

  stop(): void {
    this.stopped = true;
  }

  async runOnce(): Promise<void> {
    await runRewardClaimOnce(this.config);
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
      }
      this.config.jinnStore?.setConfigValue('last_reward_claim_tick_at', new Date().toISOString());
      await new Promise(r => setTimeout(r, this.config.intervalMs));
    }
  }
}
