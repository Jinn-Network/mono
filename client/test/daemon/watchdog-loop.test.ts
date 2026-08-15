/**
 * #1043 — loop watchdog supervisor. A synchronous, network-free loop that
 * reads each registered loop's heartbeat (getLoopTick) and, when one exceeds
 * max(stalenessFactor * intervalMs, floorMs), ALWAYS loud-logs + emits a
 * structured `loop_watchdog_stale` event. The process-exit recovery is gated
 * behind `autoRestart` (default OFF, per the locked Option A decision): when
 * on, onStale fires; when off, detection happens but onStale does not.
 *
 * onStale fires exactly once per stale episode (re-armed when the heartbeat
 * advances again), and never for a healthy sibling. The watchdog is inert
 * while isActive() is false (shutdown drain).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Store } from '../../src/store/store.js';
import { recordLoopTick } from '../../src/daemon/loop-heartbeat.js';
import {
  WATCHDOG_EXIT_CODE,
  WatchdogLoop,
} from '../../src/daemon/watchdog-loop.js';
import { getEventBuffer } from '../../src/events/emitter.js';

const INTERVAL = 10_000;
const CHECK = 30_000;

describe('#1043 WatchdogLoop', () => {
  let store: Store;
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store(':memory:');
    now = 1_000_000_000;
    getEventBuffer().clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
    vi.restoreAllMocks();
  });

  function check(loops: { name: string; intervalMs: number; floorMs?: number }[], opts: {
    autoRestart?: boolean;
    onStale?: (name: string) => void;
    isActive?: () => boolean;
  } = {}) {
    return new WatchdogLoop({
      store,
      loops: loops as never,
      stalenessFactor: 6,
      checkIntervalMs: CHECK,
      autoRestart: opts.autoRestart ?? false,
      onStale: opts.onStale,
      isActive: opts.isActive ?? (() => true),
      now: () => now,
    });
  }

  it('fires onStale exactly once for a stale loop and never for a healthy sibling', () => {
    const onStale = vi.fn();
    // healthy ticked just now; stale ticked long ago.
    recordLoopTick(store, 'checkpoint');
    store.setConfigValue('loop_heartbeat:work', String(now));
    store.setConfigValue('loop_heartbeat:checkpoint', String(now - INTERVAL * 100));

    const wd = check(
      [
        { name: 'checkpoint', intervalMs: INTERVAL },
        { name: 'work', intervalMs: INTERVAL },
      ],
      { autoRestart: true, onStale },
    );

    wd.check();
    wd.check(); // still stale — must NOT fire again this episode

    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledWith('checkpoint');
  });

  it('re-arms onStale after the loop recovers and goes stale again', () => {
    const onStale = vi.fn();
    store.setConfigValue('loop_heartbeat:checkpoint', String(now - INTERVAL * 100));
    const wd = check([{ name: 'checkpoint', intervalMs: INTERVAL }], { autoRestart: true, onStale });

    wd.check();
    expect(onStale).toHaveBeenCalledTimes(1);

    // Heartbeat advances → loop healthy again → episode cleared.
    store.setConfigValue('loop_heartbeat:checkpoint', String(now));
    wd.check();
    expect(onStale).toHaveBeenCalledTimes(1);

    // Goes stale a second time → new episode → fires again.
    store.setConfigValue('loop_heartbeat:checkpoint', String(now - INTERVAL * 100));
    wd.check();
    expect(onStale).toHaveBeenCalledTimes(2);
  });

  it('detects + emits a structured event but does NOT call onStale when autoRestart is OFF', () => {
    const onStale = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.setConfigValue('loop_heartbeat:checkpoint', String(now - INTERVAL * 100));

    const wd = check([{ name: 'checkpoint', intervalMs: INTERVAL }], { autoRestart: false, onStale });
    wd.check();

    expect(onStale).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    const events = getEventBuffer().snapshot({ limit: 10 });
    const stale = events.find((e) => e.errorCode === 'loop_watchdog_stale');
    expect(stale).toBeDefined();
    expect(stale?.details?.['loopName']).toBe('checkpoint');
  });

  it('calls onStale when autoRestart is ON', () => {
    const onStale = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    store.setConfigValue('loop_heartbeat:checkpoint', String(now - INTERVAL * 100));

    const wd = check([{ name: 'checkpoint', intervalMs: INTERVAL }], { autoRestart: true, onStale });
    wd.check();

    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledWith('checkpoint');
  });

  it('the production default onStale exits the process with WATCHDOG_EXIT_CODE', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    store.setConfigValue('loop_heartbeat:checkpoint', String(now - INTERVAL * 100));

    // No onStale provided → defaults to the prod process-exit handler.
    const wd = check([{ name: 'checkpoint', intervalMs: INTERVAL }], { autoRestart: true });
    wd.check();

    expect(exit).toHaveBeenCalledWith(WATCHDOG_EXIT_CODE);
    expect(WATCHDOG_EXIT_CODE).not.toBe(0);
  });

  it('is inert while isActive() is false (shutdown drain)', () => {
    const onStale = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    store.setConfigValue('loop_heartbeat:checkpoint', String(now - INTERVAL * 100));

    const wd = check(
      [{ name: 'checkpoint', intervalMs: INTERVAL }],
      { autoRestart: true, onStale, isActive: () => false },
    );
    // run() gates check() on isActive(); calling run for one cycle proves the gate.
    void wd.run();
    expect(onStale).not.toHaveBeenCalled();
    wd.stop();
  });

  it('skips loops that have never ticked (null heartbeat)', () => {
    const onStale = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // checkpoint never ticked → no heartbeat row at all.
    const wd = check([{ name: 'checkpoint', intervalMs: INTERVAL }], { autoRestart: true, onStale });
    wd.check();
    expect(onStale).not.toHaveBeenCalled();
  });

  it('uses the generous floorMs threshold for the for-await loops', () => {
    const onStale = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const FLOOR = 5 * 60_000;
    // 7 intervals stale (> 6 * interval) but well under the 5-min floor.
    store.setConfigValue('loop_heartbeat:projector', String(now - INTERVAL * 7));

    const wd = check(
      [{ name: 'projector', intervalMs: INTERVAL, floorMs: FLOOR }],
      { autoRestart: true, onStale },
    );
    wd.check();
    expect(onStale).not.toHaveBeenCalled();

    // Past the floor → stale.
    store.setConfigValue('loop_heartbeat:projector', String(now - FLOOR - 1));
    wd.check();
    expect(onStale).toHaveBeenCalledTimes(1);
  });
});
