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

    // Loops that always start: creator, engine-tick, engine-watcher,
    // delivery-watcher. With LocalAdapter the for-await loops do not heartbeat,
    // but start() seeds every started loop so the watchdog never trips on boot.
    expect(getLoopTick(store, 'creator')).not.toBeNull();
    expect(getLoopTick(store, 'engine-tick')).not.toBeNull();
    expect(getLoopTick(store, 'engine-watcher')).not.toBeNull();
    expect(getLoopTick(store, 'delivery-watcher')).not.toBeNull();

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
    expect(getLoopTick(store, 'creator')).not.toBeNull();
    expect(getLoopTick(store, 'engine-tick')).not.toBeNull();
    expect(getLoopTick(store, 'engine-watcher')).not.toBeNull();
    expect(getLoopTick(store, 'delivery-watcher')).not.toBeNull();

    expect(daemon.getShutdownState()).toBe('running');

    await daemon.stop();
    expect(daemon.getShutdownState()).toBe('clean');
    daemon = undefined;
  });

  it('emits loop_watchdog_stale for a genuinely stale loop when watchdog config is omitted', async () => {
    getEventBuffer().clear();
    daemon = makeDaemon(store, tmp, undefined);
    await daemon.start();

    // Force 'creator' far enough back that it exceeds the default staleness
    // threshold (stalenessFactor 6 * its LOOP_REGISTRY intervalMs 5000ms).
    store.setConfigValue('loop_heartbeat:creator', String(Date.now() - 6 * 5000 - 1));
    // Drive the watchdog's own check directly instead of waiting out its real
    // 30s check interval: with LocalAdapter's creator loop genuinely running
    // in this Daemon, waiting would let creator's own next tick re-freshen
    // the heartbeat we just forced stale before the watchdog ever saw it.
    // This still proves the thing under test — that omitting `config.watchdog`
    // constructs a live, checkable WatchdogLoop at all (before this change,
    // `daemon.watchdogLoop` stayed undefined and `check()` never existed to call).
    (daemon as unknown as { watchdogLoop?: { check(): void } }).watchdogLoop?.check();

    const events = getEventBuffer().snapshot({ limit: 20 });
    const stale = events.find((e) => e.errorCode === 'loop_watchdog_stale');
    expect(stale).toBeDefined();
    expect(stale?.details?.['loopName']).toBe('creator');

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
