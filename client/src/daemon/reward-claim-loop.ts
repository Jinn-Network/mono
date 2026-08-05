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
import type { Store } from '../store/store.js';
import { emitEvent } from '../observability/emit-event.js';
import { claimRewardsIntent } from '../intents/claim-rewards.js';
import { runLoop } from './loop-heartbeat.js';

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

export class RewardClaimLoop {
  private stopped = false;

  constructor(private readonly config: RewardClaimLoopConfig) {}

  stop(): void {
    this.stopped = true;
  }

  async runOnce(): Promise<void> {
    // Delegates entirely to the intent module (client/src/intents/claim-rewards.ts)
    // — tick, record, and the module-level single-flight that serializes this
    // loop's ticks against the CLI verb's and the admin route's. `strict` is
    // omitted (loop mode): per-service failures are counted, never thrown.
    await claimRewardsIntent({
      publicClient: this.config.publicClient,
      masterWallet: this.config.masterWallet,
      fleetStore: this.config.store,
      chain: this.config.chain,
      distributorAddress: this.config.distributorAddress,
      jinnStore: this.config.jinnStore,
      source: 'reward-claim',
    });
  }

  async run(): Promise<void> {
    if (this.config.intervalMs <= 0) {
      return;
    }

    const jinnStore = this.config.jinnStore;
    if (!jinnStore) {
      // Without a Store there is no heartbeat surface; keep the minimal inline
      // loop so runLoop's always-stamp behavior can't fire without a store.
      while (!this.stopped) {
        try {
          await this.runOnce();
        } catch (err) {
          console.debug('[reward-claim] Tick failed (non-fatal):', err instanceof Error ? err.message : err);
        }
        await new Promise(r => setTimeout(r, this.config.intervalMs));
      }
      return;
    }

    await runLoop({
      name: 'reward-claim',
      store: jinnStore,
      tick: () => this.runOnce(),
      intervalMs: this.config.intervalMs,
      stopSignal: () => this.stopped,
      emitSource: 'reward-claim',
      onError: (err) => {
        console.debug('[reward-claim] Tick failed (non-fatal):', err instanceof Error ? err.message : err);
        emitEvent(jinnStore, {
          kind: 'tick_error',
          outcome: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        }, 'reward-claim');
      },
      afterTick: () => jinnStore.setConfigValue('last_reward_claim_tick_at', new Date().toISOString()),
    });
  }
}
