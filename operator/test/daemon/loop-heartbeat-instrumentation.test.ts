/**
 * #1043 — the while+sleep loops record a heartbeat at the end of each
 * iteration (AFTER runOnce returns-or-throws, BEFORE sleep). A healthy loop
 * advances its heartbeat once per interval; a loop hung inside runOnce never
 * reaches the heartbeat line, so the tick freezes — which is exactly what the
 * watchdog must be able to observe.
 *
 * RewardClaimLoop is the representative subject: its runOnce() is the seam we
 * stub. The instrumentation is identical across the six while+sleep loops.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Store } from '../../src/store/store.js';
import {
  RewardClaimLoop,
  type RewardClaimLoopConfig,
} from '../../src/daemon/reward-claim-loop.js';
import { getLoopTick } from '../../src/daemon/loop-heartbeat.js';

const INTERVAL = 10_000;

function makeConfig(jinnStore: Store): RewardClaimLoopConfig {
  return {
    intervalMs: INTERVAL,
    publicClient: {} as never,
    masterWallet: {} as never,
    store: {} as never,
    chain: 'base-sepolia',
    distributorAddress: undefined,
    jinnStore,
  };
}

describe('#1043 while+sleep loop heartbeat instrumentation', () => {
  let store: Store;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store(':memory:');
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  it('advances the heartbeat once per healthy iteration', async () => {
    const loop = new RewardClaimLoop(makeConfig(store));
    vi.spyOn(loop, 'runOnce').mockResolvedValue(undefined);

    const running = loop.run();

    // First iteration completes synchronously up to the heartbeat write.
    await vi.advanceTimersByTimeAsync(0);
    const first = getLoopTick(store, 'reward-claim');
    expect(first).not.toBeNull();

    // Advance past one interval; the next iteration must re-stamp the tick.
    vi.setSystemTime(Date.now() + INTERVAL);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    const second = getLoopTick(store, 'reward-claim');
    expect(second).not.toBeNull();
    expect(second!).toBeGreaterThan(first!);

    loop.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await running;
  });

  it('freezes the heartbeat when runOnce hangs', async () => {
    const loop = new RewardClaimLoop(makeConfig(store));
    // runOnce never resolves — the loop is wedged mid-iteration.
    vi.spyOn(loop, 'runOnce').mockImplementation(() => new Promise<void>(() => {}));

    void loop.run();

    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    // The heartbeat line is past the awaited runOnce, so it is never reached.
    expect(getLoopTick(store, 'reward-claim')).toBeNull();

    loop.stop();
  });
});
