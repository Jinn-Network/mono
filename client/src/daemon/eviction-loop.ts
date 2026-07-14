/**
 * Periodic eviction-check + auto-restake loop (jinn-mono-hjex.3).
 *
 * Polls the staking proxy's getStakingState for each complete service. When
 * state === 2 (Evicted) it calls the injected `recoverEvictedService` helper
 * so the service is restaked without requiring a daemon restart.
 *
 * Scheduling: interval from config (default 60s). Set to 0 to disable.
 * Env: JINN_EVICTION_CHECK_INTERVAL_MS
 */

import { getAddress, type PublicClient } from 'viem';
import { STAKING_ABI } from '../earning/contracts.js';
import type { FleetStateStore } from '../earning/store.js';
import type { JinnOnchainNetwork } from '../earning/viem-clients.js';
import { displayFleetServiceIndex } from '../earning/fleet-display-index.js';
import { isStakedLikeServiceStep, type ServiceState } from '../earning/types.js';
import type { Store } from '../store/store.js';
import { recordLoopTick } from './loop-heartbeat.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EvictionLoopReadContract = (opts: {
  address: `0x${string}`;
  abi: typeof STAKING_ABI;
  functionName: 'getStakingState';
  args: [bigint];
}) => Promise<bigint | number>;

export interface EvictionLoopConfig {
  intervalMs: number;
  store: FleetStateStore;
  chain: JinnOnchainNetwork;
  readContract: EvictionLoopReadContract;
  /**
   * Injected recovery function. In production this wraps
   * `recoverEvictedService` from `../earning/bootstrap.js`.
   * Accepts a ServiceState and kicks off the reStake call.
   */
  recoverEvictedService: (svc: ServiceState) => Promise<void>;
  /** Min ms between reStake attempts for the same service. Default 300_000. */
  reStakeThrottleMs?: number;
  /** Injectable clock for tests. Default () => Date.now(). */
  now?: () => number;
  /** Daemon observability store used by the loop watchdog. */
  jinnStore?: Store;
}

// ---------------------------------------------------------------------------
// EvictionLoop
// ---------------------------------------------------------------------------

export class EvictionLoop {
  private stopped = false;
  private readonly lastReStakeAttemptMs = new Map<string, number>();
  private readonly reStakeThrottleMs: number;
  private readonly now: () => number;

  constructor(private readonly config: EvictionLoopConfig) {
    this.reStakeThrottleMs =
      config.reStakeThrottleMs != null && config.reStakeThrottleMs > 0
        ? config.reStakeThrottleMs
        : 300_000;
    this.now = config.now ?? (() => Date.now());
  }

  stop(): void {
    this.stopped = true;
  }

  async runOnce(): Promise<void> {
    const state = await this.config.store.load(this.config.chain);

    for (const svc of state.services) {
      if (!svc.service_id || !svc.staking_address) continue;
      if (!isStakedLikeServiceStep(svc.step)) continue;

      const displayIndex = displayFleetServiceIndex(svc);

      try {
        const stakingState = await this.config.readContract({
          address: getAddress(svc.staking_address) as `0x${string}`,
          abi: STAKING_ABI,
          functionName: 'getStakingState',
          args: [BigInt(svc.service_id)],
        });

        if (Number(stakingState) === 2) {
          const id = String(svc.service_id);
          const last = this.lastReStakeAttemptMs.get(id);
          const ts = this.now();
          if (last !== undefined && ts - last < this.reStakeThrottleMs) {
            console.debug(
              `[eviction-loop] Service ${displayIndex} (service_id ${svc.service_id}) still evicted; reStake throttled (last attempt ${ts - last}ms ago, window ${this.reStakeThrottleMs}ms)`,
            );
            continue;
          }
          console.debug(
            `[eviction-loop] Service ${displayIndex} (service_id ${svc.service_id}) is evicted; triggering auto-restake`,
          );
          this.lastReStakeAttemptMs.set(id, ts); // mark BEFORE awaiting so a revert is throttled like a success
          await this.config.recoverEvictedService(svc);
        }
      } catch (err) {
        console.debug(
          `[eviction-loop] Service ${displayIndex}: error checking staking state (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  async run(): Promise<void> {
    if (this.config.intervalMs <= 0) {
      return;
    }

    while (!this.stopped) {
      try {
        await this.runOnce();
      } catch (err) {
        console.debug(
          '[eviction-loop] Tick failed (non-fatal):',
          err instanceof Error ? err.message : err,
        );
      }
      if (this.config.jinnStore) recordLoopTick(this.config.jinnStore, 'eviction-check');
      await new Promise<void>(r => setTimeout(r, this.config.intervalMs));
    }
  }
}
