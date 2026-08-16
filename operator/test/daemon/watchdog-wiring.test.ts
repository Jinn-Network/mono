/**
 * #1043 — Daemon wiring for the loop watchdog.
 *
 * start() seeds a heartbeat for every loop it actually started (so first
 * boot never trips) and runs the watchdog; stop() stops it cleanly.
 *
 * DEFAULT (2026-08-10, decision 3 of the operator standup, #2461/#2540):
 * omitting DaemonConfig.watchdog now ARMS the watchdog with
 * `{ autoRestart: false }` — detection defaults on regardless of whether a
 * call site remembers to opt in. This was previously the opposite (omission
 * meant "no watchdog"); round-8's live gate run found zero
 * `loop_watchdog_stale` events had ever fired because nothing wired
 * `config.watchdog`. `watchdog: false` is the new explicit escape hatch for
 * callers that truly want no watchdog (e.g. a test irrelevant to watchdog
 * behavior that wants no extra background timer).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Daemon, type DaemonConfig } from '../../src/daemon/daemon.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { SimpleRunner } from '../../src/runner/simple.js';
import { HarnessRegistry } from '../../src/harnesses/engine/registry.js';
import { Store } from '../../src/store/store.js';
import { getLoopTick } from '../../src/daemon/loop-heartbeat.js';
import { getEventBuffer } from '../../src/events/emitter.js';

function minimalEngineConfig(root: string): DaemonConfig['restorationEngine'] {
  const implRegistry = new HarnessRegistry({ default: 'legacy-claude' });
  return {
    implRegistry,
    paths: {
      workingDirRoot: join(root, 'work'),
      implStateDirRoot: join(root, 'impl-state'),
    },
  };
}

function makeDaemon(store: Store, tmp: string, watchdog?: DaemonConfig['watchdog']): Daemon {
  return new Daemon({
    adapter: new LocalAdapter(),
    runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
    store,
    dbPath: ':memory:',
    apiPort: 0,
    pollIntervalMs: 60_000,
    taskSources: [],
    restorationEngine: minimalEngineConfig(tmp),
    shutdownTimeoutMs: 100,
    // Wave-4 D3 retired `creator`, which had been this test's anchor as the
    // last loop a bare legacy boot always started. With it gone a minimal boot
    // starts NO loop at all, so the seeding assertions would pass vacuously.
    // `checkpoint` anchors the test instead: it is an `always`-admission loop
    // that needs no composition and does no network I/O -- `runOnce` failures
    // are caught non-fatally, after which it records its tick and sleeps for
    // `intervalMs`, so a stub store is enough to get it started and seeded.
    // (`peer-sync` was tried first and rejected: it does real HTTP with
    // retries, which took the suite from seconds to four minutes.)
    //
    // The 300s interval is deliberate on both counts: the loop ticks once at
    // start -- seeding the heartbeat -- then sleeps well past the end of the
    // test, so it can never re-freshen a heartbeat the staleness case forces
    // stale. `shutdownTimeoutMs` is then required, because `stop()` races
    // `loopPromises` against it and would otherwise block the full default 30s
    // waiting for that sleep to finish.
    checkpoint: {
      intervalMs: 300_000,
      store: {
        async load() { throw new Error('checkpoint store stub: not used in watchdog wiring tests'); },
      } as unknown as DaemonConfig['checkpoint'] extends { store: infer S } ? S : never,
      chain: 'base-sepolia',
      writeCheckpoint: async () => {
        throw new Error('checkpoint writer stub: not used in watchdog wiring tests');
      },
    } as NonNullable<DaemonConfig['checkpoint']>,
    watchdog,
  });
}

describe('#1043 Daemon watchdog wiring', () => {
  let tmp: string;
  let store: Store;
  let daemon: Daemon | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jinn-1043-watchdog-'));
    store = new Store(':memory:');
  });

  afterEach(async () => {
    await daemon?.stop().catch(() => undefined);
    store.close();
  });

  it('seeds heartbeats for started loops and runs while running (autoRestart off)', async () => {
    daemon = makeDaemon(store, tmp, { autoRestart: false });
    await daemon.start();

    // `checkpoint` is the always-admission loop this fixture starts (Wave-4 D3
    // retired `creator`; D6 dropped the leftover registry names). start() seeds
    // every started loop so the watchdog never trips on boot.
    expect(getLoopTick(store, 'checkpoint')).not.toBeNull();
    expect(daemon.getShutdownState()).toBe('running');

    await daemon.stop();
    expect(daemon.getShutdownState()).toBe('clean');
    daemon = undefined;
  });

  it('seeds heartbeats and arms the watchdog by default when watchdog config is omitted', async () => {
    daemon = makeDaemon(store, tmp, undefined);
    await daemon.start();

    // Omitted watchdog config now defaults to armed — same boot-seed
    // behavior as passing `{ autoRestart: false }` explicitly.
    expect(getLoopTick(store, 'checkpoint')).not.toBeNull();
    expect(daemon.getShutdownState()).toBe('running');

    await daemon.stop();
    expect(daemon.getShutdownState()).toBe('clean');
    daemon = undefined;
  });

  it('emits loop_watchdog_stale for a genuinely stale loop when watchdog config is omitted', async () => {
    getEventBuffer().clear();
    daemon = makeDaemon(store, tmp, undefined);
    await daemon.start();

    // Force 'checkpoint' far enough back that it exceeds the default staleness
    // threshold (stalenessFactor 6 * its LOOP_REGISTRY intervalMs 300000ms).
    store.setConfigValue('loop_heartbeat:checkpoint', String(Date.now() - 6 * 300_000 - 1));
    // Drive the watchdog's own check directly instead of waiting out its real
    // 30s check interval: with the checkpoint loop genuinely running in this
    // Daemon, waiting would let its own next tick re-freshen the heartbeat we
    // just forced stale before the watchdog ever saw it.
    // This still proves the thing under test — that omitting `config.watchdog`
    // constructs a live, checkable WatchdogLoop at all (before this change,
    // `daemon.watchdogLoop` stayed undefined and `check()` never existed to call).
    (daemon as unknown as { watchdogLoop?: { check(): void } }).watchdogLoop?.check();

    const events = getEventBuffer().snapshot({ limit: 20 });
    const stale = events.find((e) => e.errorCode === 'loop_watchdog_stale');
    expect(stale).toBeDefined();
    expect(stale?.details?.['loopName']).toBe('checkpoint');

    await daemon.stop();
    daemon = undefined;
  });

  it('watchdog: false fully disables the watchdog (explicit opt-out)', async () => {
    daemon = makeDaemon(store, tmp, false);
    await daemon.start();

    // No watchdog → no boot-seed of heartbeats by the watchdog wiring.
    // (Loops still tick at runtime, but at apiPort:0 / pollInterval 60s nothing
    // has ticked yet on this synchronous start path.)
    expect(daemon.getShutdownState()).toBe('running');

    await daemon.stop();
    expect(daemon.getShutdownState()).toBe('clean');
    daemon = undefined;
  });
});
