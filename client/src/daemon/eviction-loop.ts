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
}

// ---------------------------------------------------------------------------
// EvictionLoop
// ---------------------------------------------------------------------------

export class EvictionLoop {
  private stopped = false;

  constructor(private readonly config: EvictionLoopConfig) {}

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
          console.error(
            `[eviction-loop] Service ${displayIndex} (service_id ${svc.service_id}) is evicted; triggering auto-restake`,
          );
          await this.config.recoverEvictedService(svc);
        }
      } catch (err) {
        console.error(
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
        console.error(
          '[eviction-loop] Tick failed (non-fatal):',
          err instanceof Error ? err.message : err,
        );
      }
      await new Promise<void>(r => setTimeout(r, this.config.intervalMs));
    }
  }
}
