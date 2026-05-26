import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { describe, it, expect } from 'vitest';
import { Daemon, type DaemonConfig } from '../../src/daemon/daemon.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { SimpleRunner } from '../../src/runner/simple.js';
import { HarnessRegistry } from '../../src/harnesses/engine/registry.js';

/**
 * Regression fence for #397 — daemon event-loop micro-spikes under
 * on-chain-history load. The upstream fixes #393 (work-skip cache +
 * setImmediate yield in _runEngineWatcherLoop, commit 653fb9f7) and #398
 * (skipReadinessProbe in canAcceptTask, commit b916c82a) should keep
 * `histogram.max` well under the 200 ms target on this branch.
 *
 * Failure modes this test catches:
 *   - A future change re-introduces per-task blocking I/O on the
 *     engine-watcher hot path (e.g. a synchronous `spawnSync`, a heavy
 *     `JSON.parse`, a per-task `decodeEventLog` loop without yield).
 *   - The setImmediate macrotask yield in `_runEngineWatcherLoop` is
 *     removed or pushed past the announcement-batch size.
 *
 * NOT covered (deliberately out of scope; flag as follow-up if it bites):
 *   - The mech adapter's per-RPC-chunk `decodeEventLog` loop
 *     (`client/src/adapters/mech/contracts.ts:811-873`) — needs a real
 *     RPC mock with synthetic logs.
 *   - The on-chain discovery floor's decode loop
 *     (`client/src/discovery/onchain.ts:647-675`, `746-765`).
 *   - `engine.tick()` → `reapWorkDirsNow()` filesystem scan
 *     (`work-dir-reaper.ts:81-128`) — needs a populated workingDir.
 *
 * Probe choice: `node:perf_hooks.monitorEventLoopDelay` directly, NOT an
 * HTTP probe. The design note (cargo/.tasks/397/design-note.md) considered
 * adding a `/health` route to the Hono app, but the in-process histogram
 * is the cleanest event-loop measurement (no routing / socket noise) and
 * keeps the diff minimal. Adding `/health` is a discretionary follow-up.
 */

function minimalEngineConfig(): DaemonConfig['restorationEngine'] {
  const root = mkdtempSync(join(tmpdir(), 'jinn-397-fence-'));
  // Empty registry — no `default`, no registered harnesses. Forces every
  // canAcceptTask() to return `no Harness registered or enabled for
  // solverType 'unknown.v0'` (see runnableFailureReason in
  // client/src/harnesses/engine/engine.ts:1049-1057).
  const implRegistry = new HarnessRegistry();
  return {
    implRegistry,
    paths: {
      workingDirRoot: join(root, 'work'),
      implStateDirRoot: join(root, 'impl-state'),
    },
  };
}

describe('Daemon event-loop lag under a stale-task backlog (#397 fence)', () => {
  it('keeps histogram.max under the SPA offline-detector threshold', async () => {
    const adapter = new LocalAdapter();

    // Pre-load 200 announcements that ALL hit the same deterministic skip
    // reason. The engine-watcher will iterate every one of them through
    // canAcceptTask -> recordSkip -> shouldLog -> continue, exercising the
    // exact hot path the issue's symptom blames.
    const BACKLOG_SIZE = 200;
    for (let i = 0; i < BACKLOG_SIZE; i++) {
      await adapter.postTask({
        id: `fence-${i}`,
        description: `fence task ${i}`,
        solverType: 'unknown.v0',
        // No solverNetManifestCid: manifestBackedValidation returns null
        // early without resolving a manifest (engine.ts:832-840).
      });
    }

    const config: DaemonConfig = {
      adapter,
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      taskSources: [],
      dbPath: ':memory:',
      restorationEngine: minimalEngineConfig(),
    };

    const daemon = new Daemon(config);

    // Enable the event-loop histogram BEFORE start() so we capture the
    // backlog burst. resolution=10ms is the smallest practical bucket;
    // the assertion compares max in nanoseconds.
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();

    try {
      await daemon.start();

      // Hold for ~2 s of engine-watcher activity. The backlog (200 events
      // at 10/batch with a setImmediate yield) drains in well under a
      // second on a fast machine; the extra time captures any tail spikes
      // from the engine-tick loop's first tick.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    } finally {
      histogram.disable();
      await daemon.stop();
    }

    // CI workers run on shared hardware with variable CPU; loosen the
    // threshold there but keep it well under the SPA's 3.5 s probe window.
    // Local: 200 ms (the issue's documented target). CI: 400 ms.
    // Boundary discipline per handbook rule 7: tight enough to catch
    // regressions, not so loose CI flakes.
    const MAX_LAG_NS = process.env['CI'] ? 400_000_000 : 200_000_000;

    // Helpful diagnostic if the assertion fires.
    const summary = {
      maxMs: histogram.max / 1_000_000,
      meanMs: histogram.mean / 1_000_000,
      p50Ms: histogram.percentile(50) / 1_000_000,
      p95Ms: histogram.percentile(95) / 1_000_000,
      p99Ms: histogram.percentile(99) / 1_000_000,
      thresholdMs: MAX_LAG_NS / 1_000_000,
    };
    // eslint-disable-next-line no-console
    console.log('[#397 fence] event-loop histogram:', summary);

    expect(histogram.max).toBeLessThan(MAX_LAG_NS);
  }, 15_000); // 15 s test timeout; the body uses ~2.5 s including teardown.
});
