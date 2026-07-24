/**
 * Unit tests for CheckpointLoop (issue #505).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckpointLoop } from '../../src/daemon/checkpoint-loop.js';
import { Store } from '../../src/store/store.js';
import { getLoopTick } from '../../src/daemon/loop-heartbeat.js';
import { WatchdogLoop } from '../../src/daemon/watchdog-loop.js';
import { getEventBuffer } from '../../src/events/emitter.js';

const PROXY_A = '0xf358B5C1Ac4dDC4E807b5Baf008826bF193EAb3B';
const PROXY_B = '0x24e34E5037956a5Feca1AAAfaA30297084C228B8';

function svc(overrides: { serviceId?: number | null; staking?: string | null; step?: string } = {}) {
  return {
    index: 1,
    step: overrides.step ?? 'complete',
    service_id: overrides.serviceId === undefined ? 42 : overrides.serviceId,
    staking_address: overrides.staking === undefined ? PROXY_A : overrides.staking,
    agent_address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    safe_address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  };
}

function mockStore(services: ReturnType<typeof svc>[]) {
  return {
    load: vi.fn(async () => ({
      master_address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      services,
      staking_mode: 'standard',
    })),
  } as any;
}

describe('CheckpointLoop', () => {
  it('calls checkpoint() once per unique staking proxy', async () => {
    const writeCheckpoint = vi.fn().mockResolvedValue({ txHash: '0xabc' });
    const loop = new CheckpointLoop({
      intervalMs: 300_000,
      store: mockStore([svc({ serviceId: 1, staking: PROXY_A }), svc({ serviceId: 2, staking: PROXY_A })]),
      chain: 'base-sepolia',
      writeCheckpoint,
    });

    await loop.runOnce();

    expect(writeCheckpoint).toHaveBeenCalledTimes(1);
    expect(writeCheckpoint.mock.calls[0][0].stakingProxy.toLowerCase()).toBe(PROXY_A.toLowerCase());
  });

  it('calls checkpoint() per distinct proxy when services span multiple proxies', async () => {
    const writeCheckpoint = vi.fn().mockResolvedValue({ txHash: '0xabc' });
    const loop = new CheckpointLoop({
      intervalMs: 300_000,
      store: mockStore([svc({ serviceId: 1, staking: PROXY_A }), svc({ serviceId: 2, staking: PROXY_B })]),
      chain: 'base-sepolia',
      writeCheckpoint,
    });

    await loop.runOnce();
    expect(writeCheckpoint).toHaveBeenCalledTimes(2);
    expect(
      writeCheckpoint.mock.calls.map((c) => c[0].stakingProxy.toLowerCase()).sort(),
    ).toEqual([PROXY_A.toLowerCase(), PROXY_B.toLowerCase()].sort());
  });

  it('skips services without service_id or staking_address', async () => {
    const writeCheckpoint = vi.fn();
    const loop = new CheckpointLoop({
      intervalMs: 300_000,
      store: mockStore([
        svc({ serviceId: null }),
        svc({ staking: null }),
      ]),
      chain: 'base-sepolia',
      writeCheckpoint,
    });

    await loop.runOnce();
    expect(writeCheckpoint).not.toHaveBeenCalled();
  });

  it('skips services whose step is not staked-like (e.g. awaiting_funding)', async () => {
    const writeCheckpoint = vi.fn();
    const loop = new CheckpointLoop({
      intervalMs: 300_000,
      store: mockStore([svc({ step: 'awaiting_funding' })]),
      chain: 'base-sepolia',
      writeCheckpoint,
    });

    await loop.runOnce();
    expect(writeCheckpoint).not.toHaveBeenCalled();
  });

  it('swallows per-proxy errors so one bad call does not stop the rest', async () => {
    const writeCheckpoint = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ txHash: '0xok' });
    const loop = new CheckpointLoop({
      intervalMs: 300_000,
      store: mockStore([svc({ serviceId: 1, staking: PROXY_A }), svc({ serviceId: 2, staking: PROXY_B })]),
      chain: 'base-sepolia',
      writeCheckpoint,
    });

    await expect(loop.runOnce()).resolves.toBeUndefined();
    expect(writeCheckpoint).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when intervalMs is 0 (disabled)', async () => {
    const writeCheckpoint = vi.fn();
    const loop = new CheckpointLoop({
      intervalMs: 0,
      store: mockStore([svc()]),
      chain: 'base-sepolia',
      writeCheckpoint,
    });
    await loop.run();
    expect(writeCheckpoint).not.toHaveBeenCalled();
  });

  describe('loop heartbeat (#1056)', () => {
    let jinnStore: Store;

    beforeEach(() => {
      vi.useFakeTimers();
      jinnStore = new Store(':memory:');
    });

    afterEach(() => {
      vi.useRealTimers();
      jinnStore.close();
    });

    it('records checkpoint after each completed iteration', async () => {
      const writeCheckpoint = vi.fn().mockResolvedValue({ txHash: '0xabc' });
      const loop = new CheckpointLoop({
        intervalMs: 300_000,
        store: mockStore([]),
        chain: 'base-sepolia',
        writeCheckpoint,
        jinnStore,
      });

      const running = loop.run();
      await vi.advanceTimersByTimeAsync(0);
      const first = getLoopTick(jinnStore, 'checkpoint');
      expect(first).not.toBeNull();

      await vi.advanceTimersByTimeAsync(300_000);
      const second = getLoopTick(jinnStore, 'checkpoint');
      expect(second).toBeGreaterThan(first!);

      loop.stop();
      await vi.advanceTimersByTimeAsync(300_000);
      await running;
    });

    it('freezes the heartbeat when runOnce hangs', async () => {
      const writeCheckpoint = vi.fn().mockResolvedValue({ txHash: '0xabc' });
      const loop = new CheckpointLoop({
        intervalMs: 300_000,
        store: mockStore([]),
        chain: 'base-sepolia',
        writeCheckpoint,
        jinnStore,
      });
      vi.spyOn(loop, 'runOnce').mockImplementation(() => new Promise<void>(() => {}));

      void loop.run();
      await vi.advanceTimersByTimeAsync(300_000 * 5);
      expect(getLoopTick(jinnStore, 'checkpoint')).toBeNull();

      loop.stop();
    });

    it('is detected by the watchdog when the heartbeat goes stale', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      getEventBuffer().clear();

      const INTERVAL = 300_000;
      const now = 1_000_000_000;
      jinnStore.setConfigValue('loop_heartbeat:checkpoint', String(now - INTERVAL * 100));

      const wd = new WatchdogLoop({
        store: jinnStore,
        loops: [{ name: 'checkpoint', intervalMs: INTERVAL }],
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
      expect(stale?.details?.['loopName']).toBe('checkpoint');
      wd.stop();
    });
  });
});
