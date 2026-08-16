/**
 * Periodic staking-checkpoint loop (issue #505).
 *
 * Calls bare `checkpoint()` on each unique staking proxy hosting one of the
 * fleet's services. This keeps the contract-side `tsCheckpoint` advancing on
 * the operator's pace rather than waiting for someone else to invoke it.
 *
 * Why: `TaskActivityCheckerV3.isRatioPass` compares `weight_delta / ts` to
 * `livenessRatio`, where `ts = now - lastCheckpointTs`. The longer `ts` runs,
 * the higher the activity rate required to pass. Without a proactive checkpoint
 * tx, operators on realistic cadence (e.g. 1 solve every few minutes) silently
 * fail every checkpoint, accrue inactivity, and eventually get evicted by the
 * existing `EvictionLoop` recovery path. A periodic checkpoint matches the
 * activity-window to the contract's `livenessPeriod` (typically 5 minutes), so
 * "deliver ≥1 novel solution per period" is sufficient to earn.
 *
 * Scheduling: interval from config (default 300_000 ms = 5 min, matching
 * `livenessPeriod` on the Base Sepolia stOLAS staking proxy). Set to 0 to
 * disable. Env: JINN_CHECKPOINT_INTERVAL_MS.
 *
 * The actual `checkpoint()` tx is sent via the injected `writeCheckpoint`
 * function so this module stays unit-testable without viem fixtures.
 * Production wires it to the master EOA — `checkpoint()` is permissionless,
 * so no Safe execTransaction is needed.
 */

import { getAddress } from 'viem';
import type { FleetStateStore } from '../earning/store.js';
import type { JinnOnchainNetwork } from '../earning/viem-clients.js';
import { displayFleetServiceIndex } from '../earning/fleet-display-index.js';
import { isStakedLikeServiceStep } from '../earning/types.js';
import type { Store } from '../store/store.js';
import { recordLoopTick } from './loop-heartbeat.js';

export type CheckpointLoopWriter = (opts: {
  stakingProxy: `0x${string}`;
}) => Promise<{ txHash: string }>;

export interface CheckpointLoopConfig {
  /** Tick interval in ms. 0 disables. */
  intervalMs: number;
  store: FleetStateStore;
  chain: JinnOnchainNetwork;
  /** Sends bare `checkpoint()` to the given staking proxy. */
  writeCheckpoint: CheckpointLoopWriter;
  /** Daemon observability store used by the loop watchdog. */
  jinnStore?: Store;
}

export class CheckpointLoop {
  private stopped = false;

  constructor(private readonly config: CheckpointLoopConfig) {}

  stop(): void {
    this.stopped = true;
  }

  async runOnce(): Promise<void> {
    const state = await this.config.store.load(this.config.chain);

    const seenProxies = new Set<string>();
    for (const svc of state.services) {
      if (!svc.service_id || !svc.staking_address) continue;
      if (!isStakedLikeServiceStep(svc.step)) continue;

      const proxy = getAddress(svc.staking_address) as `0x${string}`;
      const key = proxy.toLowerCase();
      if (seenProxies.has(key)) continue;
      seenProxies.add(key);

      const displayIndex = displayFleetServiceIndex(svc);
      try {
        const { txHash } = await this.config.writeCheckpoint({ stakingProxy: proxy });
        console.log(
          `[checkpoint-loop] Service ${displayIndex} (proxy ${proxy}): checkpoint() submitted tx=${txHash}`,
        );
      } catch (err) {
        console.debug(
          `[checkpoint-loop] Service ${displayIndex} (proxy ${proxy}): checkpoint() failed (non-fatal): ${err instanceof Error ? err.message : err}`,
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
          '[checkpoint-loop] Tick failed (non-fatal):',
          err instanceof Error ? err.message : err,
        );
      }
      if (this.config.jinnStore) recordLoopTick(this.config.jinnStore, 'checkpoint');
      await new Promise<void>(r => setTimeout(r, this.config.intervalMs));
    }
  }
}
