/**
 * Regression for #3037 — loop-crash emissions must carry the `Error.cause`
 * chain.
 *
 * `Daemon.start()` attaches a crash handler to every long-running loop. Those
 * handlers used to build `details: { error: err instanceof Error ? err.message
 * : String(err) }`, which reads only the outermost `.message` and therefore
 * drops the nested cause an RPC/viem failure carries. `emitStructured`
 * sanitizes `details` centrally, so this was never a leak — it was a thinner
 * diagnostic than the adapter's `claim_failed` path produces for the same
 * class of failure. `sanitizeErrorText` walks the chain (and masks URLs with
 * the same host-only dialect), so the handler must go through it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Daemon, emitLoopCrash, type DaemonConfig } from '../../src/daemon/daemon.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { SimpleRunner } from '../../src/runner/simple.js';
import { Store } from '../../src/store/store.js';
import { getEventBuffer } from '../../src/events/emitter.js';

function lastEvent() {
  const all = getEventBuffer().snapshot({ limit: 1 });
  return all[0];
}

describe('#3037 — loop-crash emission preserves the cause chain', () => {
  beforeEach(() => {
    getEventBuffer().clear();
  });

  it('walks Error.cause instead of reading only the outermost message', () => {
    const err = new Error('checkpoint tx failed', {
      cause: new Error('HTTP request failed: https://secret-key.example/rpc'),
    });

    emitLoopCrash('checkpoint', 'checkpoint_crashed', err);

    const event = lastEvent();
    expect(event.errorCode).toBe('checkpoint_crashed');
    expect(event.message).toBe('checkpoint loop crashed');
    const detail = String((event.details as Record<string, unknown>).error);
    expect(detail).toContain('checkpoint tx failed');
    // The cause is the part the old `.message`-only read dropped.
    expect(detail).toContain('caused by: HTTP request failed');
    // Still masked by the shared host-only dialect — no second vocabulary.
    expect(detail).not.toContain('secret-key.example/rpc');
  });

  it('still renders a non-Error rejection', () => {
    emitLoopCrash('work', 'work_crashed', 'boom');

    const event = lastEvent();
    expect(event.errorCode).toBe('work_crashed');
    expect((event.details as Record<string, unknown>).error).toBe('boom');
  });
});

describe('#3110 — Daemon.start() wires every loop crash through emitLoopCrash', () => {
  let store: Store;
  let daemon: Daemon | undefined;

  beforeEach(() => {
    getEventBuffer().clear();
    store = new Store(':memory:');
  });

  afterEach(async () => {
    await daemon?.stop().catch(() => undefined);
    daemon = undefined;
    vi.restoreAllMocks();
    store.close();
  });

  it('carries the cause chain from a real started loop, not just the helper', async () => {
    // `checkpoint` is the representative loop: it is an always-admission loop
    // that needs no composition and no network, and — unlike the watchdog — it
    // is constructed in the Daemon *constructor*, so its crash can be forced
    // with a plain spy on the real instance rather than a module mock. The
    // fixture shape is watchdog-wiring.test.ts's.
    daemon = new Daemon({
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      store,
      dbPath: ':memory:',
      apiPort: 0,
      pollIntervalMs: 60_000,
      shutdownTimeoutMs: 100,
      checkpoint: {
        intervalMs: 300_000,
        store: {
          async load() { throw new Error('checkpoint store stub: not used here'); },
        } as unknown as NonNullable<DaemonConfig['checkpoint']>['store'],
        chain: 'base-sepolia',
        writeCheckpoint: async () => {
          throw new Error('checkpoint writer stub: not used here');
        },
      } as NonNullable<DaemonConfig['checkpoint']>,
      // Explicit escape hatch (watchdog-wiring.test.ts header): no extra
      // background timer for a test that is not about the watchdog.
      watchdog: false,
    });

    const loop = (daemon as unknown as { checkpointLoop: { run(): Promise<void> } }).checkpointLoop;
    vi.spyOn(loop, 'run').mockRejectedValue(
      new Error('checkpoint tx failed', {
        cause: new Error('HTTP request failed: https://secret-key.example/rpc'),
      }),
    );

    await daemon.start();
    // stop() awaits loopPromises, so the .catch handler is guaranteed to have
    // run by the time it resolves — deterministic, no polling, no waitFor.
    await daemon.stop();
    daemon = undefined;

    const event = getEventBuffer()
      .snapshot({ limit: 50 })
      .find((e) => e.errorCode === 'checkpoint_crashed');
    expect(event).toBeDefined();
    expect(event!.message).toBe('checkpoint loop crashed');
    const detail = String((event!.details as Record<string, unknown>).error);
    expect(detail).toContain('checkpoint tx failed');
    // The cause is the part the pre-#3037 `.message`-only read dropped.
    expect(detail).toContain('caused by:');
    expect(detail).not.toContain('secret-key.example/rpc');
  });

  it('routes every .run().catch( site in daemon.ts through emitLoopCrash', () => {
    // A behavioral test covers one loop. This covers the class: a twelfth loop
    // added with an inline handler, or any one of the existing sites reverted,
    // is the exact regression shape #3037 arrived in.
    const source = readFileSync(
      fileURLToPath(new URL('../../src/daemon/daemon.ts', import.meta.url)),
      'utf8',
    );
    const sites = [...source.matchAll(/\.run\(\)\.catch\(\s*(?:err|error)\s*=>\s*(\w+)\(/g)];
    // 11 is a maintenance constant, not an invariant: it is how many loops
    // `Daemon.start()` arms today. Retiring a loop is legitimate (CLAUDE.md
    // records Wave-4 D1-D6 retiring five), and lowers this floor — if that is
    // why this line went red, update the number. A red here means "the count
    // moved", not by itself "the wiring broke"; the per-site assertion below
    // is what proves the wiring.
    expect(sites.length).toBeGreaterThanOrEqual(11);
    for (const site of sites) {
      expect(site[1]).toBe('emitLoopCrash');
    }
    // A handler written in any other shape would not match the regex at all,
    // so also pin the raw call count.
    //
    // Known boundary: a site written as `.run().then(...).catch(err => ...)`
    // contains neither token and is invisible to both counts. All eleven
    // sites use the direct `.run().catch(` shape, and the behavioral test
    // above is the actual #3110 criterion; this pin covers the class, not
    // every possible spelling of it.
    expect(source.split('.run().catch(').length - 1).toBe(sites.length);
  });
});
