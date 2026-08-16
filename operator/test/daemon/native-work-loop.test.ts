/**
 * #2535. A rejected tick used to set `stopped = true`, `clearInterval(timer)`, and drop the cause
 * into `workFailure` where nothing read it. Live, operator B's solver loop died at 01:29:06; 34
 * minutes later the process was alive, `/health` answered `{"ok":true}`, the checkpoint and
 * eviction loops were still logging, and the only evidence was a gap between timestamps. Only a
 * restart recovered it — it claimed `claim-finalized` immediately on reboot, which is what a
 * transient failure looks like.
 *
 * The three properties that must hold: the cause is always logged; a single rejection is not
 * terminal; and a loop that genuinely cannot continue reports itself unhealthy rather than
 * staying quietly green.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createNativeWorkLoop } from '../../src/daemon/native-work-loop.js';
import { createNativeOperatorHost } from '../../src/daemon/native-operator-host.js';

describe('createNativeWorkLoop', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const loopOptions = (tick: () => Promise<void>, overrides = {}) => ({
    label: 'native-solver',
    tick,
    intervalMs: 5_000,
    maxConsecutiveFailures: 3,
    warn: vi.fn(),
    error: vi.fn(),
    ...overrides,
  });

  it('logs the cause of every rejected tick', async () => {
    const warn = vi.fn();
    let calls = 0;
    const loop = createNativeWorkLoop(loopOptions(async () => {
      calls += 1;
      if (calls > 1) throw new Error('settlement reconciliation failed');
    }, { warn }));

    await loop.start();
    await vi.advanceTimersByTimeAsync(5_000);
    loop.stop();

    expect(warn).toHaveBeenCalled();
    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain('[native-solver]');
    expect(message).toContain('work tick failed');
    // The cause itself, not just that there was one.
    expect(message).toContain('settlement reconciliation failed');
  });

  // The core regression: one rejection must not be the end of the loop.
  it('recovers on the next tick after a single rejection', async () => {
    const ticks: string[] = [];
    let calls = 0;
    const loop = createNativeWorkLoop(loopOptions(async () => {
      calls += 1;
      if (calls === 2) { ticks.push('failed'); throw new Error('transient RPC blip'); }
      ticks.push('ok');
    }));

    await loop.start();
    await vi.advanceTimersByTimeAsync(5_000);   // tick 2 — fails
    await vi.advanceTimersByTimeAsync(5_000);   // backoff elapses — tick 3 succeeds
    loop.stop();

    expect(ticks).toStrictEqual(['ok', 'failed', 'ok']);
    // Still healthy: nothing latched.
    expect(loop.failure()).toBeUndefined();
    expect(loop.consecutiveFailures()).toBe(0);
  });

  it('backs off exponentially between consecutive failures', async () => {
    const warn = vi.fn();
    let calls = 0;
    const loop = createNativeWorkLoop(loopOptions(async () => {
      calls += 1;
      if (calls > 1) throw new Error('still broken');
    }, { warn, maxConsecutiveFailures: 5 }));

    await loop.start();
    await vi.advanceTimersByTimeAsync(5_000);    // failure 1 -> retry in 5s
    await vi.advanceTimersByTimeAsync(5_000);    // failure 2 -> retry in 10s
    await vi.advanceTimersByTimeAsync(10_000);   // failure 3 -> retry in 20s
    loop.stop();

    expect((warn.mock.calls[0]![0] as string)).toContain('retrying in 5000ms');
    expect((warn.mock.calls[1]![0] as string)).toContain('retrying in 10000ms');
    expect((warn.mock.calls[2]![0] as string)).toContain('retrying in 20000ms');
  });

  it('caps the backoff', async () => {
    const warn = vi.fn();
    let calls = 0;
    const loop = createNativeWorkLoop(loopOptions(async () => {
      calls += 1;
      if (calls > 1) throw new Error('still broken');
    }, { warn, maxConsecutiveFailures: 10, maxBackoffMs: 12_000 }));

    await loop.start();
    for (const delay of [5_000, 5_000, 10_000, 12_000, 12_000]) {
      // eslint-disable-next-line no-await-in-loop -- driving the fake clock in order.
      await vi.advanceTimersByTimeAsync(delay);
    }
    loop.stop();

    const delays = warn.mock.calls.map(([m]) => /retrying in (\d+)ms/u.exec(m as string)![1]);
    expect(delays).toStrictEqual(['5000', '10000', '12000', '12000', '12000']);
  });

  it('resets the failure count after a success', async () => {
    let calls = 0;
    const loop = createNativeWorkLoop(loopOptions(async () => {
      calls += 1;
      if (calls === 2 || calls === 3) throw new Error('flap');
    }));

    await loop.start();
    await vi.advanceTimersByTimeAsync(5_000);   // failure 1
    expect(loop.consecutiveFailures()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);   // failure 2
    expect(loop.consecutiveFailures()).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);  // success
    expect(loop.consecutiveFailures()).toBe(0);
    // Never latched — two flaps out of three tolerated ticks is not terminal.
    expect(loop.failure()).toBeUndefined();
    loop.stop();
  });

  it('latches terminal and says so loudly after the tolerance is exhausted', async () => {
    const error = vi.fn();
    let calls = 0;
    const loop = createNativeWorkLoop(loopOptions(async () => {
      calls += 1;
      if (calls > 1) throw new Error('lease is gone');
    }, { error }));

    await loop.start();
    await vi.advanceTimersByTimeAsync(5_000);    // failure 1
    await vi.advanceTimersByTimeAsync(5_000);    // failure 2
    await vi.advanceTimersByTimeAsync(10_000);   // failure 3 -> terminal (maxConsecutiveFailures 3)

    expect(loop.failure()).toBeInstanceOf(Error);
    expect((loop.failure() as Error).message).toBe('lease is gone');
    expect(error).toHaveBeenCalledOnce();
    const message = error.mock.calls[0]![0] as string;
    expect(message).toContain('work loop STOPPED after 3 consecutive failed ticks');
    expect(message).toContain('health will now report unhealthy');
    expect(message).toContain('lease is gone');
    loop.stop();
  });

  it('stops ticking once it has latched', async () => {
    let calls = 0;
    const loop = createNativeWorkLoop(loopOptions(async () => {
      calls += 1;
      if (calls > 1) throw new Error('broken');
    }));

    await loop.start();
    await vi.advanceTimersByTimeAsync(60_000);
    const settled = calls;
    await vi.advanceTimersByTimeAsync(600_000);

    expect(calls).toBe(settled);
  });

  it('propagates a startup failure rather than retrying it', async () => {
    const loop = createNativeWorkLoop(loopOptions(async () => { throw new Error('cannot start'); }));

    await expect(loop.start()).rejects.toThrow('cannot start');
    loop.stop();
  });

  it('runs no further ticks after stop()', async () => {
    let calls = 0;
    const loop = createNativeWorkLoop(loopOptions(async () => { calls += 1; }));

    await loop.start();
    expect(calls).toBe(1);
    loop.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toBe(1);
  });
});

/**
 * The health half of the contract: a latched loop must not read as healthy. `/health` itself stays
 * `{ ok: true }` by design (pure process liveness, spec §6.1 — a 503 there would restart-loop a
 * daemon that is correctly waiting); the native host's health contract is `host.health()`.
 */
describe('native operator health over a stopped work loop', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('refuses to report healthy once the work loop has given up', async () => {
    let calls = 0;
    const loop = createNativeWorkLoop({
      label: 'native-solver',
      tick: async () => { calls += 1; if (calls > 1) throw new Error('settlement reconciliation failed'); },
      intervalMs: 5_000,
      maxConsecutiveFailures: 2,
      warn: vi.fn(),
      error: vi.fn(),
    });
    const host = createNativeOperatorHost({
      role: 'solver',
      roleKeyIds: { 'solver-delivery': 'key-1' },
      lease: { acquire() {}, owned: () => true, release() {} },
      bindings: { verify: async () => {} },
      venue: {
        rollbackToFinalized: async () => {},
        health: async () => ({ canonicalBlock: 2n, finalizedBlock: 1n, caughtUp: true }),
        close() {},
      },
      operations: {
        reconcileTransactions: async () => {},
        reconcilePublications: async () => {},
        uncertainCount: () => 0,
      },
      discovery: { sync: async () => ({ lag: 0 }) },
      recovery: { recoverBackends: async () => {} },
      readiness: {
        backendRequired: false,
        evidenceRequired: false,
        backend: async () => true,
        evidence: async () => true,
        publicSource: async () => true,
      },
      work: { start: loop.start, stop: () => { loop.stop(); }, failure: loop.failure },
    });

    await host.start();
    // Healthy while it is merely retrying.
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(host.health()).resolves.toMatchObject({ mode: 'native-v1' });

    // Once it gives up, health refuses — naming the cause.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(loop.failure()).toBeDefined();
    await expect(host.health()).rejects.toThrow(/work loop failed.*settlement reconciliation failed/su);

    await host.close();
  });
});
