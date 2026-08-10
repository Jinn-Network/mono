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
import { WatchdogLoop } from '../../src/daemon/watchdog-loop.js';
import { getEventBuffer } from '../../src/events/emitter.js';

describe('LOOP_REGISTRY admission field (#2407)', () => {
  // `posting` (one-swap M5, #2461) is the native counterpart of `creator` — the claim/work-path
  // requester leg — so it is `ready-only` too. `evaluator` (one-swap M4a, #2461) is the native
  // counterpart of `work` — the evaluator claim/verdict-settlement path — so it is `ready-only`.
  const READY_ONLY = new Set(['creator', 'posting', 'engine-tick', 'work', 'evaluator']);

  it('every entry declares admission: always | ready-only', () => {
    for (const entry of LOOP_REGISTRY) {
      expect(['always', 'ready-only']).toContain(entry.admission);
    }
  });

  it('assigns ready-only exactly to the claim/work path: creator, posting, engine-tick, work, evaluator', () => {
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

/**
 * Decision 3 (2026-08-10 operator standup, #2461/#2540): the watchdog now
 * defaults to armed (daemon.ts), so this exclusion — previously moot because
 * nothing armed the watchdog to observe it — now actually matters in
 * production. It is NOT new plumbing: `runLoop` (above) already stamps a
 * `ready-only` loop's heartbeat every interval regardless of admission, so a
 * loop legitimately sitting out a `degraded` window (funding shortfall,
 * incomplete fleet, spec §5/#2407) never accumulates heartbeat age. These
 * tests prove that guarantee end-to-end against a real `WatchdogLoop`, so a
 * regression in the heartbeat-regardless-of-admission behavior is caught
 * here, not just at the `runLoop` unit level above.
 */
describe('watchdog + admission: a legitimately-paused ready-only loop never looks stale (#2461 decision 3)', () => {
  let store: Store;
  const intervalMs = 5000;
  const stalenessFactor = 6;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store(':memory:');
    setDaemonReadiness('degraded');
    getEventBuffer().clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    setDaemonReadiness('ready');
    store.close();
  });

  it('does not emit loop_watchdog_stale even past the staleness threshold while degraded', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    let stopped = false;
    // 'work' is ready-only (claim/work path) and uses the shared readiness
    // holder by default, which this test set to 'degraded'.
    const running = runLoop({
      name: 'work',
      store,
      tick,
      intervalMs,
      stopSignal: () => stopped,
      emitSource: 'work',
    });

    // Advance well past the watchdog's staleness threshold. If the loop's
    // heartbeat were frozen (the pre-decision-3 risk this task calls out),
    // this alone would be enough to trip the watchdog below.
    await vi.advanceTimersByTimeAsync(stalenessFactor * intervalMs * 3);
    expect(tick).not.toHaveBeenCalled(); // never admitted -> never actually ticked

    const wd = new WatchdogLoop({
      store,
      loops: [{ name: 'work', intervalMs }],
      stalenessFactor,
      isActive: () => true,
    });
    wd.check();

    const events = getEventBuffer().snapshot({ limit: 10 });
    expect(events.find((e) => e.errorCode === 'loop_watchdog_stale')).toBeUndefined();

    stopped = true;
    await vi.advanceTimersByTimeAsync(intervalMs);
    await running;
  });

  it('control: the same threshold DOES trip the watchdog when the heartbeat is not refreshed', () => {
    // Simulates what round-8 found: a loop whose heartbeat genuinely stopped
    // advancing. Proves the test above is discriminating, not vacuous.
    store.setConfigValue(
      'loop_heartbeat:work',
      String(Date.now() - stalenessFactor * intervalMs - 1),
    );
    const wd = new WatchdogLoop({
      store,
      loops: [{ name: 'work', intervalMs }],
      stalenessFactor,
      isActive: () => true,
    });
    wd.check();

    const events = getEventBuffer().snapshot({ limit: 10 });
    expect(events.find((e) => e.errorCode === 'loop_watchdog_stale')).toBeDefined();
  });
});
