import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Daemon, type DaemonConfig } from '../../src/daemon/daemon.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { SimpleRunner } from '../../src/runner/simple.js';
import { RestorerImplRegistry } from '../../src/restorer/engine/registry.js';

function minimalEngineConfig(): DaemonConfig['restorationEngine'] {
  const root = mkdtempSync(join(tmpdir(), 'jinn-daemon-test-'));
  const implRegistry = new RestorerImplRegistry({ default: 'legacy-claude' });
  return {
    implRegistry,
    paths: {
      workingDirRoot: join(root, 'work'),
      implStateDirRoot: join(root, 'impl-state'),
    },
  };
}

describe('Daemon', () => {
  it('initializes and stops cleanly', async () => {
    const config: DaemonConfig = {
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      intentSources: [],
      dbPath: ':memory:',
      restorationEngine: minimalEngineConfig(),
    };

    const daemon = new Daemon(config);
    await daemon.start();
    await daemon.stop();
  });

  it('tracks shutdown state in store', async () => {
    const config: DaemonConfig = {
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      intentSources: [],
      dbPath: ':memory:',
      restorationEngine: minimalEngineConfig(),
    };

    const daemon = new Daemon(config);
    await daemon.start();
    expect(daemon.getShutdownState()).toBe('running');
    await daemon.stop();
    expect(daemon.getShutdownState()).toBe('clean');
  });

  it('accepts legacy desiredStates when intentSources are omitted', async () => {
    const config: DaemonConfig = {
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      desiredStates: [{ id: 'legacy-static', description: 'legacy static intent' }],
      dbPath: ':memory:',
      restorationEngine: minimalEngineConfig(),
    };

    const daemon = new Daemon(config);
    await daemon.start();
    await daemon.stop();
    expect(daemon.getShutdownState()).toBe('clean');
  });
});
