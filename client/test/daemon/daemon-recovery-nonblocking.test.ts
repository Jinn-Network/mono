/**
 * Regression for #1422 — Daemon.start() must NOT block loop startup on
 * in-flight task recovery.
 *
 * RUNNING-state recovery re-executes the task's impl (`runImpl`) and awaits
 * it. For a swe-rebench-v2 evaluation that is a full Docker test-suite run —
 * potentially hours. Before this fix, `start()` awaited
 * `engine.recoverInFlight()` before starting ANY loop, so a single recovered
 * RUNNING task silenced every loop (creator, engine-tick, delivery-watcher,
 * …) AND the #1043 watchdog that exists to catch exactly this class of wedge:
 * zero heartbeats, zero log output, for the full duration of the re-run.
 * Observed live on the evaluator daemon (2026-07-07): "Daemon started" then
 * 40+ minutes of silence while the recovered evaluation's `scripts.eval`
 * child process ran.
 *
 * The fix runs recovery concurrently with the loops (tracked on
 * `recoveryPromise`, not awaited by `start()`), with the engine's
 * `processingRequestIds` dedupe preventing the tick/watcher loops from
 * double-driving a task that recovery is still executing.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Daemon, type DaemonConfig } from '../../src/daemon/daemon.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { SimpleRunner } from '../../src/runner/simple.js';
import { HarnessRegistry } from '../../src/harnesses/engine/registry.js';
import { TaskEngine } from '../../src/harnesses/engine/engine.js';
import { getLoopTick } from '../../src/daemon/loop-heartbeat.js';
import { Store } from '../../src/store/store.js';

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

describe('#1422 — Daemon.start does not block on in-flight recovery', () => {
  let tmp: string;
  let store: Store;
  let daemon: Daemon | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jinn-1422-recovery-'));
    store = new Store(':memory:');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await daemon?.stop().catch(() => undefined);
    store.close();
  });

  it('start() resolves and loops tick while recoverInFlight is still pending', async () => {
    // A recovery that never settles — models a recovered RUNNING task whose
    // re-executed impl (e.g. a Docker evaluation) runs for hours.
    vi.spyOn(TaskEngine.prototype, 'recoverInFlight').mockImplementation(
      () => new Promise(() => {}),
    );

    daemon = new Daemon({
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      store,
      dbPath: ':memory:',
      apiPort: 0,
      pollIntervalMs: 50,
      taskSources: [],
      restorationEngine: minimalEngineConfig(tmp),
    });

    // Pre-fix this await never resolves (the vitest timeout is the failure).
    await daemon.start();

    // The loops must be live: the creator loop records its #1043 heartbeat on
    // every pass, independent of recovery.
    const deadline = Date.now() + 5_000;
    while (getLoopTick(store, 'creator') === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(getLoopTick(store, 'creator')).not.toBeNull();
  }, 15_000);
});
