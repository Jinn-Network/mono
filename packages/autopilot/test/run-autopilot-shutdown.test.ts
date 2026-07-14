import { describe, it, expect, vi, afterEach } from 'vitest';
import { runLoop } from '../scripts/run-autopilot.js';

// Regression test for jinn-mono#490 — graceful SIGINT/SIGTERM shutdown.
// Drives the exported `runLoop` in-process with an injected scheduler and a
// controllable `isShuttingDown` predicate. NO real OS signals, NO real timers.

function makeManualScheduler() {
  let pending: (() => void) | null = null;
  const schedule = (cb: () => void, _delayMs: number) => {
    pending = cb;
  };
  const flush = async () => {
    const cb = pending;
    pending = null;
    if (cb) {
      cb();
      await Promise.resolve();
    }
    return cb != null;
  };
  const hasPending = () => pending != null;
  return { schedule, flush, hasPending };
}

describe('runLoop graceful shutdown (jinn-mono#490)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Test A — no regression: keeps re-arming when not shutting down', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { schedule, flush, hasPending } = makeManualScheduler();
    const runOnce = vi.fn().mockResolvedValue(1000);

    await runLoop({ runOnce, schedule, isShuttingDown: () => false });
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(hasPending()).toBe(true);

    await flush();
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(hasPending()).toBe(true);
  });

  it('Test B — AC1: stops arming new cycles once shutting down', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { schedule, flush, hasPending } = makeManualScheduler();
    const runOnce = vi.fn().mockResolvedValue(1000);
    let shutting = false;

    await runLoop({ runOnce, schedule, isShuttingDown: () => shutting });
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(hasPending()).toBe(true);

    shutting = true;
    // Flush the in-flight timer: its continuation runs runOnce once more
    // (the cycle that was already armed), then declines to re-arm.
    await flush();
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(hasPending()).toBe(false);
  });

  it('Test C — AC1+AC2: shutdown mid-cycle finishes in-flight, no new cycle', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { schedule, hasPending } = makeManualScheduler();
    let resolveCycle!: (d: number) => void;
    const runOnce = vi.fn(() => new Promise<number>((r) => { resolveCycle = r; }));
    let shutting = false;

    const p = runLoop({ runOnce, schedule, isShuttingDown: () => shutting });
    // First cycle is now in-flight (promise unresolved).
    expect(runOnce).toHaveBeenCalledTimes(1);

    shutting = true;
    resolveCycle(1000);
    await p;

    expect(runOnce).toHaveBeenCalledTimes(1); // in-flight cycle completed (AC2)
    expect(hasPending()).toBe(false); // no new cycle armed (AC1)
  });

  it('Test D — defensive: shutdown before first cycle still runs first, no re-arm', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { schedule, hasPending } = makeManualScheduler();
    const runOnce = vi.fn().mockResolvedValue(1000);

    await runLoop({ runOnce, schedule, isShuttingDown: () => true });
    expect(runOnce).toHaveBeenCalledTimes(1); // first cycle always runs
    expect(hasPending()).toBe(false);
  });
});
