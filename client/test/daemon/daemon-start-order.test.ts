/**
 * Regression for #649 AC3 — Daemon.start() must NOT mutate shared store state
 * or emit the `startup` activity event until startApiServer has resolved.
 *
 * If the order is wrong, a racing process can corrupt shutdown_state /
 * daemon_started_at / activity_events even when EADDRINUSE later kills the
 * race.
 *
 * Strategy: provide a `corpusFactory` that pushes a marker into a shared call
 * log. The factory is invoked immediately before the `startApiServer({ … })`
 * block in `Daemon.start()` — so its position in the call log is a faithful
 * proxy for "the moment the API server is about to bind". Spy on every store
 * mutator and the `startup` activity emission, then assert that the corpus /
 * apiServer marker is recorded BEFORE all three store-touching steps.
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
  });

  afterEach(async () => {
    await daemon?.stop().catch(() => undefined);
    store.close();
  });

  it('invokes corpusFactory (api-server prep) BEFORE setShutdownState / setDaemonStartedAt / startup event', async () => {
    const calls: string[] = [];

    vi.spyOn(store, 'setShutdownState').mockImplementation((s) => {
      calls.push(`setShutdownState:${s}`);
    });
    vi.spyOn(store, 'setDaemonStartedAt').mockImplementation(() => {
      calls.push('setDaemonStartedAt');
    });
    const realRecord = store.recordActivityEvent.bind(store);
    vi.spyOn(store, 'recordActivityEvent').mockImplementation((e) => {
      calls.push(`activity:${e.kind}`);
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
      // The factory is invoked at exactly the moment the API-server block runs.
      // Under the fixed Daemon.start() ordering it runs BEFORE store mutations;
      // under the broken (pre-#649) ordering it runs AFTER them.
      corpusFactory: (s) => {
        calls.push('apiServer:ready');
        // Return a stub Corpus — Daemon only wires it through to startApiServer,
        // which itself does not call into it during start().
        return {
          publish: async () => undefined,
          search: async () => [],
          getDocument: async () => undefined,
          acquireDocument: async () => undefined,
        } as never;
      },
    });

    await daemon.start();

    const apiIdx = calls.indexOf('apiServer:ready');
    const shutdownIdx = calls.indexOf('setShutdownState:running');
    const startedAtIdx = calls.indexOf('setDaemonStartedAt');
    const startupIdx = calls.indexOf('activity:startup');

    expect(apiIdx).toBeGreaterThanOrEqual(0);
    expect(shutdownIdx).toBeGreaterThan(apiIdx);
    expect(startedAtIdx).toBeGreaterThan(apiIdx);
    expect(startupIdx).toBeGreaterThan(apiIdx);
  });
});
