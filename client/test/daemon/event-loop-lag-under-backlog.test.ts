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
 * Regression fence for #397 — daemon event-loop micro-spikes under a stale-task
 * backlog. Upstream fixes #393 (work-skip cache + setImmediate yield in
 * `_runEngineWatcherLoop`) and #398 (`skipReadinessProbe` in `canAcceptTask`)
 * already hold `histogram.max` well under the 200 ms target on this branch.
 *
 * Probe choice: in-process `monitorEventLoopDelay`, not an HTTP probe — the
 * histogram is the cleanest event-loop measurement (no routing / socket noise)
 * and keeps the diff to one new test file. See `cargo/.tasks/397/design-note.md`.
 */

function minimalEngineConfig(): DaemonConfig['restorationEngine'] {
  const root = mkdtempSync(join(tmpdir(), 'jinn-397-fence-'));
  // Empty registry forces every canAcceptTask() into the deterministic skip
  // `no Harness registered or enabled for solverType 'unknown.v0'`.
  return {
    implRegistry: new HarnessRegistry(),
    paths: {
      workingDirRoot: join(root, 'work'),
      implStateDirRoot: join(root, 'impl-state'),
    },
  };
}

describe('Daemon event-loop lag under a stale-task backlog (#397 fence)', () => {
  it('keeps histogram.max under the SPA offline-detector threshold', async () => {
    const adapter = new LocalAdapter();

    // Pre-load the backlog before daemon.start() so the engine-watcher iterates
    // every announcement through canAcceptTask -> recordSkip -> continue.
    const BACKLOG_SIZE = 200;
    for (let i = 0; i < BACKLOG_SIZE; i++) {
      await adapter.postTask({
        id: `fence-${i}`,
        description: `fence task ${i}`,
        solverType: 'unknown.v0',
      });
    }

    const daemon = new Daemon({
      adapter,
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      taskSources: [],
      dbPath: ':memory:',
      apiPort: 0, // OS picks an ephemeral port
      restorationEngine: minimalEngineConfig(),
    });

    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();

    try {
      await daemon.start();
      // 2 s comfortably covers the burst drain plus the first engine-tick.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    } finally {
      histogram.disable();
      await daemon.stop();
    }

    // CI multiplier loosens the gate for shared-worker CPU variance; both
    // bounds stay well under the SPA's 3.5 s offline-detector probe window.
    const MAX_LAG_NS = process.env['CI'] ? 400_000_000 : 200_000_000;

    const summary = {
      maxMs: histogram.max / 1_000_000,
      meanMs: histogram.mean / 1_000_000,
      p50Ms: histogram.percentile(50) / 1_000_000,
      p95Ms: histogram.percentile(95) / 1_000_000,
      p99Ms: histogram.percentile(99) / 1_000_000,
      thresholdMs: MAX_LAG_NS / 1_000_000,
    };
    console.log('[#397 fence] event-loop histogram:', summary);

    expect(histogram.max).toBeLessThan(MAX_LAG_NS);
  }, 15_000);
});
