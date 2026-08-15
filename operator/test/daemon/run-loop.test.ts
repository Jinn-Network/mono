/**
 * #1578 — runLoop() shared helper. A single loop-runner owns the
 * tick → onError/default-emit → afterTick → heartbeat → stop-check → sleep
 * skeleton that every supervised while+sleep daemon loop previously inlined.
 *
 * These tests pin the helper's contract in isolation (fake timers + an
 * in-memory Store), independent of any concrete loop. The concrete loops'
 * existing tests are the untouched regression gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Store } from '../../src/store/store.js';
import { getLoopTick, runLoop } from '../../src/daemon/loop-heartbeat.js';

describe('#1578 runLoop helper', () => {
  let store: Store;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store(':memory:');
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  it('stamps the heartbeat after a healthy tick and re-stamps once per interval', async () => {
    let stopped = false;
    const running = runLoop({
      name: 'reward-claim',
      store,
      tick: async () => {},
      intervalMs: 10_000,
      stopSignal: () => stopped,
      emitSource: 'reward-claim',
    });

    // First iteration completes synchronously up to the heartbeat write.
    await vi.advanceTimersByTimeAsync(0);
    const first = getLoopTick(store, 'reward-claim');
    expect(first).not.toBeNull();

    // Advance past one interval → the next iteration re-stamps.
    vi.setSystemTime(Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    const second = getLoopTick(store, 'reward-claim');
    expect(second).not.toBeNull();
    expect(second!).toBeGreaterThan(first!);

    stopped = true;
    await vi.advanceTimersByTimeAsync(10_000);
    await running;
  });

  it('freezes the heartbeat when tick hangs (never resolves)', async () => {
    let stopped = false;
    void runLoop({
      name: 'reward-claim',
      store,
      tick: () => new Promise<void>(() => {}),
      intervalMs: 10_000,
      stopSignal: () => stopped,
      emitSource: 'reward-claim',
    });

    await vi.advanceTimersByTimeAsync(10_000 * 5);
    // The heartbeat line is past the awaited tick, so it is never reached.
    expect(getLoopTick(store, 'reward-claim')).toBeNull();

    stopped = true;
  });

  it('emits a default tick_error/failed row on a throwing tick and still stamps the heartbeat', async () => {
    let stopped = false;
    const running = runLoop({
      name: 'work',
      store,
      tick: async () => {
        throw new Error('boom');
      },
      intervalMs: 10_000,
      stopSignal: () => stopped,
      emitSource: 'work',
    });

    await vi.advanceTimersByTimeAsync(0);

    const events = store.getRecentActivityEvents(50);
    const tickError = events.find((e) => e.kind === 'tick_error');
    expect(tickError).toBeDefined();
    expect(tickError!.outcome).toBe('failed');
    expect(tickError!.detail).toBe('boom');

    // Heartbeat still stamped despite the throw.
    expect(getLoopTick(store, 'work')).not.toBeNull();

    stopped = true;
    await vi.advanceTimersByTimeAsync(10_000);
    await running;
  });

  it('routes a throwing tick through onError and suppresses the default emit', async () => {
    let stopped = false;
    const onError = vi.fn();
    const running = runLoop({
      name: 'work',
      store,
      tick: async () => {
        throw new Error('boom');
      },
      intervalMs: 10_000,
      stopSignal: () => stopped,
      emitSource: 'work',
      onError,
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    // No default tick_error row written when onError is supplied.
    const events = store.getRecentActivityEvents(50);
    expect(events.find((e) => e.kind === 'tick_error')).toBeUndefined();

    stopped = true;
    await vi.advanceTimersByTimeAsync(10_000);
    await running;
  });

  it('evaluates a variable-interval thunk each iteration', async () => {
    let stopped = false;
    const delays = [1000, 5000, 9000];
    let call = 0;
    const intervalMs = vi.fn(() => delays[Math.min(call++, delays.length - 1)]!);

    void runLoop({
      name: 'work',
      store,
      tick: async () => {},
      intervalMs,
      stopSignal: () => stopped,
      emitSource: 'work',
    });

    // Iteration 1: heartbeat stamped, then sleep(1000).
    await vi.advanceTimersByTimeAsync(0);
    expect(intervalMs).toHaveBeenCalledTimes(1);

    // Advance the first delay → iteration 2 schedules sleep(5000).
    await vi.advanceTimersByTimeAsync(1000);
    expect(intervalMs).toHaveBeenCalledTimes(2);

    // Advance the second delay → iteration 3 schedules sleep(9000).
    await vi.advanceTimersByTimeAsync(5000);
    expect(intervalMs).toHaveBeenCalledTimes(3);

    stopped = true;
    await vi.advanceTimersByTimeAsync(9000);
  });

  it('with a stopPromise, resolving it mid-sleep ends the loop promptly', async () => {
    let stopped = false;
    let resolveStop!: () => void;
    const stopPromise = new Promise<void>((r) => {
      resolveStop = r;
    });
    let ticks = 0;
    const running = runLoop({
      name: 'work',
      store,
      tick: async () => {
        ticks++;
      },
      intervalMs: 100_000, // long sleep; only stopPromise can cut it short
      stopSignal: () => stopped,
      stopPromise,
      emitSource: 'work',
    });

    // One tick, then the loop is parked in a 100s sleep raced against stopPromise.
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks).toBe(1);

    // Flip the signal and resolve the stop promise — the race resolves without
    // waiting for the 100s timer.
    stopped = true;
    resolveStop();
    await running; // resolves promptly

    expect(ticks).toBe(1);
  });

  it('without a stopPromise, the loop exits only after the current sleep timer fires', async () => {
    let stopped = false;
    let ticks = 0;
    const running = runLoop({
      name: 'work',
      store,
      tick: async () => {
        ticks++;
      },
      intervalMs: 10_000,
      stopSignal: () => stopped,
      emitSource: 'work',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(ticks).toBe(1);

    // Signal stop mid-sleep. With a plain setTimeout the loop cannot notice
    // until the timer fires.
    stopped = true;
    let done = false;
    void running.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);

    // Fire the sleep timer → loop wakes, sees stopSignal true, exits.
    await vi.advanceTimersByTimeAsync(10_000);
    await running;
    expect(done).toBe(true);
    expect(ticks).toBe(1);
  });

  it('runs afterTick after the tick and before the heartbeat stamp', async () => {
    let stopped = false;
    const order: string[] = [];
    const running = runLoop({
      name: 'reward-claim',
      store,
      tick: async () => {
        order.push('tick');
      },
      intervalMs: 10_000,
      stopSignal: () => stopped,
      emitSource: 'reward-claim',
      afterTick: () => {
        // At this point the heartbeat must NOT yet be stamped for this round.
        order.push(getLoopTick(store, 'reward-claim') === null ? 'afterTick-before-heartbeat' : 'afterTick-after-heartbeat');
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['tick', 'afterTick-before-heartbeat']);
    expect(getLoopTick(store, 'reward-claim')).not.toBeNull();

    stopped = true;
    await vi.advanceTimersByTimeAsync(10_000);
    await running;
  });

  it('does not tick at all when stopSignal is already true on entry', async () => {
    let ticks = 0;
    await runLoop({
      name: 'harvest',
      store,
      tick: async () => {
        ticks++;
      },
      intervalMs: 10_000,
      stopSignal: () => true,
      emitSource: 'harvest',
    });

    expect(ticks).toBe(0);
    expect(getLoopTick(store, 'harvest')).toBeNull();
  });
});
