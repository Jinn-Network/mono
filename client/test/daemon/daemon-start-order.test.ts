/**
 * Regression for #649 AC3 — Daemon.start() must NOT mutate shared store state
 * or emit the `startup` activity event until startApiServer has resolved.
 *
 * If the order is wrong, a racing process can corrupt shutdown_state /
 * daemon_started_at / activity_events even when EADDRINUSE later kills the
 * race.
 *
 * Strategy: mock `startApiServer` (the real port-bind call inside
 * `Daemon.start()`) to push a marker into a shared call log before
 * delegating to the real implementation — so its position in the call log is
 * a faithful proxy for "the moment the API server is about to bind". Spy on
 * every store mutator and the `startup` activity emission, then assert that
 * the apiServer marker is recorded BEFORE all three store-touching steps.
 *
 * #1393 review finding 5: this test used to use a `corpusFactory` marker,
 * but #1393 hoisted corpus construction into the Daemon *constructor* (so the
 * TaskEngine and the API server can share one instance) — which runs before
 * `start()` is ever called, making the old marker fire unconditionally
 * before the ordering it was meant to prove. Mocking startApiServer keeps
 * the marker inside `start()`, at the exact call this test is about, so it
 * still varies with (and falsifies) the #649 ordering constraint.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Daemon, type DaemonConfig } from '../../src/daemon/daemon.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { SimpleRunner } from '../../src/runner/simple.js';
import { HarnessRegistry } from '../../src/harnesses/engine/registry.js';
import { Store } from '../../src/store/store.js';

const marker = vi.hoisted(() => ({ calls: [] as string[] }));

// MOCK_JUSTIFICATION: wraps the real startApiServer (still called through —
// the port really binds) to record when the port-bind call happens, which is
// the marker this test's ordering assertions depend on. Not mocking
// network/chain I/O.
vi.mock('../../src/api/server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/server.js')>();
  return {
    ...actual,
    startApiServer: vi.fn(async (opts: Parameters<typeof actual.startApiServer>[0]) => {
      marker.calls.push('apiServer:ready');
      return actual.startApiServer(opts);
    }),
  };
});

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

describe('#649 — Daemon.start binds API before mutating store', () => {
  let tmp: string;
  let store: Store;
  let daemon: Daemon | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jinn-649-start-order-'));
    store = new Store(':memory:');
    marker.calls.length = 0;
  });

  afterEach(async () => {
    await daemon?.stop().catch(() => undefined);
    store.close();
  });

  it('invokes startApiServer (port bind) BEFORE setShutdownState / setDaemonStartedAt / startup event', async () => {
    // The 'apiServer:ready' marker (pushed by the mocked startApiServer,
    // above) shares this same array with the store-mutation spies below, so
    // their relative order in `marker.calls` is a faithful proxy for the
    // #649 ordering constraint. Under the fixed Daemon.start() ordering the
    // marker fires BEFORE the store mutations; under the broken (pre-#649)
    // ordering it would fire after them.
    vi.spyOn(store, 'setShutdownState').mockImplementation((s) => {
      marker.calls.push(`setShutdownState:${s}`);
    });
    vi.spyOn(store, 'setDaemonStartedAt').mockImplementation(() => {
      marker.calls.push('setDaemonStartedAt');
    });
    const realRecord = store.recordActivityEvent.bind(store);
    vi.spyOn(store, 'recordActivityEvent').mockImplementation((e) => {
      marker.calls.push(`activity:${e.kind}`);
      return realRecord(e);
    });

    daemon = new Daemon({
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      store,
      dbPath: ':memory:',
      apiPort: 0, // OS picks an ephemeral port
      pollIntervalMs: 60_000,
      taskSources: [],
      restorationEngine: minimalEngineConfig(tmp),
    });

    await daemon.start();

    const apiIdx = marker.calls.indexOf('apiServer:ready');
    const shutdownIdx = marker.calls.indexOf('setShutdownState:running');
    const startedAtIdx = marker.calls.indexOf('setDaemonStartedAt');
    const startupIdx = marker.calls.indexOf('activity:startup');

    expect(apiIdx).toBeGreaterThanOrEqual(0);
    expect(shutdownIdx).toBeGreaterThan(apiIdx);
    expect(startedAtIdx).toBeGreaterThan(apiIdx);
    expect(startupIdx).toBeGreaterThan(apiIdx);
  });
});
