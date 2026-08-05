/**
 * Issue #2407 / spec §5, §5's per-loop admission: LOOP_REGISTRY gains an
 * `admission: 'always' | 'ready-only'` field; `runLoop` consults it (against
 * a supplied — or, by default, the shared module-level — readiness getter)
 * before each tick. `ready-only` loops (the claim/work path) do not tick
 * while the daemon readiness is `degraded`; `always` loops keep running so a
 * self-healing economic condition can clear.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Store } from '../../src/store/store.js';
import {
  LOOP_REGISTRY,
  getLoopAdmission,
  getLoopTick,
  getDaemonReadiness,
  runLoop,
  setDaemonReadiness,
} from '../../src/daemon/loop-heartbeat.js';

describe('LOOP_REGISTRY admission field (#2407)', () => {
  const READY_ONLY = new Set(['creator', 'engine-tick', 'work']);

  it('every entry declares admission: always | ready-only', () => {
    for (const entry of LOOP_REGISTRY) {
      expect(['always', 'ready-only']).toContain(entry.admission);
    }
  });

  it('assigns ready-only exactly to the claim/work path: creator, engine-tick, work', () => {
    const readyOnly = LOOP_REGISTRY.filter((r) => r.admission === 'ready-only').map((r) => r.name);
    expect(new Set(readyOnly)).toEqual(READY_ONLY);
  });

  it('assigns always to every other registered loop', () => {
    const always = LOOP_REGISTRY.filter((r) => r.admission === 'always').map((r) => r.name);
    for (const name of always) {
      expect(READY_ONLY.has(name)).toBe(false);
    }
    expect(always.length).toBe(LOOP_REGISTRY.length - READY_ONLY.size);
  });

  it('getLoopAdmission looks up the registered admission for a loop name', () => {
    expect(getLoopAdmission('creator')).toBe('ready-only');
    expect(getLoopAdmission('work')).toBe('ready-only');
    expect(getLoopAdmission('engine-tick')).toBe('ready-only');
    expect(getLoopAdmission('eviction-check')).toBe('always');
    expect(getLoopAdmission('reward-claim')).toBe('always');
  });
});

describe('shared daemon readiness holder', () => {
  afterEach(() => {
    setDaemonReadiness('ready');
  });

  it('defaults to ready', () => {
    expect(getDaemonReadiness()).toBe('ready');
  });

  it('round-trips a set readiness', () => {
    setDaemonReadiness('degraded');
    expect(getDaemonReadiness()).toBe('degraded');
  });
});

describe('runLoop admission gating (#2407)', () => {
  let store: Store;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store(':memory:');
    setDaemonReadiness('ready');
  });

  afterEach(() => {
    vi.useRealTimers();
    setDaemonReadiness('ready');
    store.close();
  });

  it('a ready-only loop does not tick while readiness is degraded (explicit getter)', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    let stopped = false;
    const running = runLoop({
      name: 'creator',
      store,
      tick,
      intervalMs: 1000,
      stopSignal: () => stopped,
      emitSource: 'creator',
      getReadiness: () => 'degraded',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(tick).not.toHaveBeenCalled();
    // Heartbeat still stamps — an intentionally-paused loop must not look
    // stale to the watchdog.
    expect(getLoopTick(store, 'creator')).not.toBeNull();

    stopped = true;
    await vi.advanceTimersByTimeAsync(1000);
    await running;
  });

  it('an always loop keeps ticking while readiness is degraded', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    let stopped = false;
    const running = runLoop({
      name: 'eviction-check',
      store,
      tick,
      intervalMs: 1000,
      stopSignal: () => stopped,
      emitSource: 'eviction-check',
      getReadiness: () => 'degraded',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    stopped = true;
    await vi.advanceTimersByTimeAsync(1000);
    await running;
  });

  it('a ready-only loop ticks normally once readiness returns to ready', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    let readiness: 'ready' | 'degraded' = 'degraded';
    let stopped = false;
    const running = runLoop({
      name: 'work',
      store,
      tick,
      intervalMs: 1000,
      stopSignal: () => stopped,
      emitSource: 'work',
      getReadiness: () => readiness,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(tick).not.toHaveBeenCalled();

    readiness = 'ready';
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(1);

    stopped = true;
    await vi.advanceTimersByTimeAsync(1000);
    await running;
  });

  it('falls back to the shared readiness holder when no getReadiness is supplied (back-compat default)', async () => {
    setDaemonReadiness('degraded');
    const tick = vi.fn().mockResolvedValue(undefined);
    let stopped = false;
    const running = runLoop({
      name: 'creator',
      store,
      tick,
      intervalMs: 1000,
      stopSignal: () => stopped,
      emitSource: 'creator',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(tick).not.toHaveBeenCalled();

    stopped = true;
    await vi.advanceTimersByTimeAsync(1000);
    await running;
  });

  it('the shared holder default (ready) never gates an existing caller that omits getReadiness', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    let stopped = false;
    const running = runLoop({
      name: 'creator',
      store,
      tick,
      intervalMs: 1000,
      stopSignal: () => stopped,
      emitSource: 'creator',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    stopped = true;
    await vi.advanceTimersByTimeAsync(1000);
    await running;
  });
});
