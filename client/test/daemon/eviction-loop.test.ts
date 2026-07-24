/**
 * Unit tests for the EvictionLoop daemon loop.
 *
 * jinn-mono-hjex.3 — surface service eviction + in-process auto-restake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvictionLoop } from '../../src/daemon/eviction-loop.js';
import { Store } from '../../src/store/store.js';
import { getLoopTick } from '../../src/daemon/loop-heartbeat.js';
import { WatchdogLoop } from '../../src/daemon/watchdog-loop.js';
import { getEventBuffer } from '../../src/events/emitter.js';

// Valid checksummed Ethereum addresses
const STAKING_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

function makeService(overrides: { serviceId?: number; stakingAddress?: string; step?: string } = {}) {
  return {
    index: 1,
    step: overrides.step ?? 'complete',
    service_id: overrides.serviceId ?? 42,
    staking_address: overrides.stakingAddress ?? STAKING_ADDR,
    agent_address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    safe_address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  };
}

function mockStore(services: ReturnType<typeof makeService>[]) {
  return {
    load: vi.fn(async () => ({
      master_address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      services,
      staking_mode: 'standard',
    })),
  } as any;
}

describe('EvictionLoop', () => {
  it('detects state=2 and calls recoverEvictedService (jinn-mono-hjex.3)', async () => {
    const readContract = vi.fn().mockResolvedValue(2n); // 2 = Evicted
    const recoverEvicted = vi.fn().mockResolvedValue(undefined);
    const loop = new EvictionLoop({
      intervalMs: 60_000,
      store: mockStore([makeService()]),
      chain: 'base-sepolia',
      readContract,
      recoverEvictedService: recoverEvicted,
    });

    await loop.runOnce();

    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'getStakingState', args: [42n] }),
    );
    expect(recoverEvicted).toHaveBeenCalledWith(
      expect.objectContaining({ service_id: 42 }),
    );
  });

  it('does not call recoverEvictedService when state=1 (Staked)', async () => {
    const readContract = vi.fn().mockResolvedValue(1n); // 1 = Staked
    const recoverEvicted = vi.fn();
    const loop = new EvictionLoop({
      intervalMs: 60_000,
      store: mockStore([makeService()]),
      chain: 'base-sepolia',
      readContract,
      recoverEvictedService: recoverEvicted,
    });

    await loop.runOnce();
    expect(recoverEvicted).not.toHaveBeenCalled();
  });

  it('skips services without service_id', async () => {
    const readContract = vi.fn().mockResolvedValue(2n);
    const recoverEvicted = vi.fn();
    const loop = new EvictionLoop({
      intervalMs: 60_000,
      store: mockStore([{ ...makeService(), service_id: null as any }]),
      chain: 'base-sepolia',
      readContract,
      recoverEvictedService: recoverEvicted,
    });

    await loop.runOnce();
    expect(readContract).not.toHaveBeenCalled();
    expect(recoverEvicted).not.toHaveBeenCalled();
  });

  it('skips services without staking_address', async () => {
    const readContract = vi.fn().mockResolvedValue(2n);
    const recoverEvicted = vi.fn();
    const loop = new EvictionLoop({
      intervalMs: 60_000,
      store: mockStore([{ ...makeService(), staking_address: null as any }]),
      chain: 'base-sepolia',
      readContract,
      recoverEvictedService: recoverEvicted,
    });

    await loop.runOnce();
    expect(readContract).not.toHaveBeenCalled();
    expect(recoverEvicted).not.toHaveBeenCalled();
  });

  it('does not crash when readContract fails (non-fatal)', async () => {
    const readContract = vi.fn().mockRejectedValue(new Error('RPC error'));
    const recoverEvicted = vi.fn();
    const loop = new EvictionLoop({
      intervalMs: 60_000,
      store: mockStore([makeService()]),
      chain: 'base-sepolia',
      readContract,
      recoverEvictedService: recoverEvicted,
    });

    await expect(loop.runOnce()).resolves.toBeUndefined();
    expect(recoverEvicted).not.toHaveBeenCalled();
  });

  it('does not re-fire reStake for the same service within the throttle window (#917)', async () => {
    const readContract = vi.fn().mockResolvedValue(2n); // 2 = Evicted
    const recoverEvicted = vi.fn().mockResolvedValue(undefined);
    let nowMs = 1_000_000;
    const loop = new EvictionLoop({
      intervalMs: 60_000,
      store: mockStore([makeService()]),
      chain: 'base-sepolia',
      readContract,
      recoverEvictedService: recoverEvicted,
      reStakeThrottleMs: 300_000,
      now: () => nowMs,
    });

    await loop.runOnce(); // first tick: attempt fires
    nowMs += 100; // 100ms later
    await loop.runOnce(); // second tick: still evicted, throttle active
    expect(recoverEvicted).toHaveBeenCalledTimes(1);

    // Boundary: after the full window the throttle expires and a third tick fires again.
    nowMs += 300_000;
    await loop.runOnce();
    expect(recoverEvicted).toHaveBeenCalledTimes(2);
  });

  it('keeps a reverted reStake attempt throttled within the window (#917)', async () => {
    const readContract = vi.fn().mockResolvedValue(2n); // 2 = Evicted
    const recoverEvicted = vi.fn().mockRejectedValue(new Error('reStake reverted'));
    let nowMs = 1_000_000;
    const loop = new EvictionLoop({
      intervalMs: 60_000,
      store: mockStore([makeService()]),
      chain: 'base-sepolia',
      readContract,
      recoverEvictedService: recoverEvicted,
      reStakeThrottleMs: 300_000,
      now: () => nowMs,
    });

    await loop.runOnce(); // first tick: attempt fires (and reverts, caught non-fatally)
    nowMs += 100; // 100ms later
    await loop.runOnce(); // second tick: still throttled despite the revert
    expect(recoverEvicted).toHaveBeenCalledTimes(1);
  });

  it('treats reStakeThrottleMs: 0 as the default window, not disabled (#917)', async () => {
    const readContract = vi.fn().mockResolvedValue(2n); // 2 = Evicted
    const recoverEvicted = vi.fn().mockResolvedValue(undefined);
    let nowMs = 1_000_000;
    const loop = new EvictionLoop({
      intervalMs: 60_000,
      store: mockStore([makeService()]),
      chain: 'base-sepolia',
      readContract,
      recoverEvictedService: recoverEvicted,
      reStakeThrottleMs: 0, // 0 must fall back to the positive default, not disable the throttle
      now: () => nowMs,
    });

    await loop.runOnce(); // first tick: attempt fires
    nowMs += 100; // 100ms later — well inside the default window
    await loop.runOnce(); // second tick: still evicted, throttle active
    expect(recoverEvicted).toHaveBeenCalledTimes(1);
  });

  it('exits immediately when intervalMs is 0', async () => {
    const readContract = vi.fn().mockResolvedValue(1n);
    const recoverEvicted = vi.fn();
    const store = mockStore([makeService()]);
    const loop = new EvictionLoop({
      intervalMs: 0,
      store,
      chain: 'base-sepolia',
      readContract,
      recoverEvictedService: recoverEvicted,
    });

    await expect(loop.run()).resolves.toBeUndefined();
    expect(store.load).not.toHaveBeenCalled();
  });

  describe('loop heartbeat', () => {
    let jinnStore: Store;

    beforeEach(() => {
      vi.useFakeTimers();
      jinnStore = new Store(':memory:');
    });

    afterEach(() => {
      vi.useRealTimers();
      jinnStore.close();
    });

    it('records eviction-check after each completed iteration', async () => {
      const loop = new EvictionLoop({
        intervalMs: 60_000,
        store: mockStore([]),
        chain: 'base-sepolia',
        readContract: vi.fn(),
        recoverEvictedService: vi.fn(),
        jinnStore,
      });

      const running = loop.run();
      await vi.advanceTimersByTimeAsync(0);
      const first = getLoopTick(jinnStore, 'eviction-check');

      expect(first).not.toBeNull();

      await vi.advanceTimersByTimeAsync(60_000);
      const second = getLoopTick(jinnStore, 'eviction-check');
      expect(second).toBeGreaterThan(first!);

      loop.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      await running;
    });

    it('freezes the heartbeat when runOnce hangs', async () => {
      const loop = new EvictionLoop({
        intervalMs: 60_000,
        store: mockStore([]),
        chain: 'base-sepolia',
        readContract: vi.fn(),
        recoverEvictedService: vi.fn(),
        jinnStore,
      });
      vi.spyOn(loop, 'runOnce').mockImplementation(() => new Promise<void>(() => {}));

      void loop.run();
      await vi.advanceTimersByTimeAsync(60_000 * 5);
      expect(getLoopTick(jinnStore, 'eviction-check')).toBeNull();

      loop.stop();
    });

    it('is detected by the watchdog when the heartbeat goes stale', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      getEventBuffer().clear();

      const INTERVAL = 60_000;
      const now = 1_000_000_000;
      jinnStore.setConfigValue('loop_heartbeat:eviction-check', String(now - INTERVAL * 100));

      const wd = new WatchdogLoop({
        store: jinnStore,
        loops: [{ name: 'eviction-check', intervalMs: INTERVAL }],
        stalenessFactor: 3,
        checkIntervalMs: 10_000,
        autoRestart: false,
        isActive: () => true,
        now: () => now,
      });
      wd.check();

      const stale = getEventBuffer()
        .snapshot({ limit: 10 })
        .find((e) => e.errorCode === 'loop_watchdog_stale');
      expect(stale?.details?.['loopName']).toBe('eviction-check');
      wd.stop();
    });
  });
});
