/**
 * #1043 — Daemon wiring for the loop watchdog.
 *
 * When DaemonConfig.watchdog is supplied, start() seeds a heartbeat for every
 * loop it actually started (so first boot never trips) and runs the watchdog;
 * stop() stops it cleanly. When watchdog is omitted (the default in unit
 * tests), the daemon constructs no watchdog and nothing changes.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Daemon, type DaemonConfig } from '../../src/daemon/daemon.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { SimpleRunner } from '../../src/runner/simple.js';
import { Store } from '../../src/store/store.js';
import { getLoopTick } from '../../src/daemon/loop-heartbeat.js';

function makeDaemon(store: Store, watchdog?: DaemonConfig['watchdog']): Daemon {
  return new Daemon({
    adapter: new LocalAdapter(),
    runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
    store,
    dbPath: ':memory:',
    apiPort: 0,
    pollIntervalMs: 60_000,
    taskSources: [],
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
    daemon = makeDaemon(store, { autoRestart: false });
    await daemon.start();

    // Minimal daemon starts creator only; engine-tick/engine-watcher retired at
    // cutover stage 2.
    expect(getLoopTick(store, 'creator')).not.toBeNull();

    expect(daemon.getShutdownState()).toBe('running');

    await daemon.stop();
    expect(daemon.getShutdownState()).toBe('clean');
    daemon = undefined;
  });

  it('does not seed heartbeats or trip when watchdog config is omitted', async () => {
    daemon = makeDaemon(store, undefined);
    await daemon.start();

    expect(daemon.getShutdownState()).toBe('running');

    await daemon.stop();
    expect(daemon.getShutdownState()).toBe('clean');
    daemon = undefined;
  });
});
