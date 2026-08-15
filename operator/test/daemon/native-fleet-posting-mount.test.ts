/**
 * One-swap M5d (#2461): the posting loop's host-wire into the fleet daemon.
 *
 * Proves the two properties the mount must have:
 *  - MOUNTED when native mode carries a non-empty `posting[]`: the daemon seeds and registers the
 *    `posting` heartbeat with the watchdog (same `posting` LOOP_REGISTRY row M5b added — no
 *    re-registration, no double-count).
 *  - BOOT-INERT otherwise: a legacy composition, or an empty `posting[]`, constructs no loop, so the
 *    `posting` heartbeat is never seeded — a default boot is byte-identical.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Daemon, type DaemonConfig } from '@/daemon/daemon.js';
import { LocalAdapter } from '@/adapters/local/adapter.js';
import { SimpleRunner } from '@/runner/simple.js';
import { HarnessRegistry } from '@/harnesses/engine/registry.js';
import { Store } from '@/store/store.js';
import { getLoopTick, LOOP_REGISTRY } from '@/daemon/loop-heartbeat.js';
import type { PostingLoopPorts } from '@/daemon/posting-loop.js';

function minimalEngineConfig(root: string): DaemonConfig['restorationEngine'] {
  return {
    implRegistry: new HarnessRegistry({ default: 'legacy-claude' }),
    paths: { workingDirRoot: join(root, 'work'), implStateDirRoot: join(root, 'impl-state') },
  };
}

/** Inert ports — the mount is what is under test, not the port behaviour (covered elsewhere). */
function stubPorts(): PostingLoopPorts {
  return {
    reconcile: async () => {},
    listTargets: async () => [],
    probeFunds: async () => ({
      safeBalanceWei: 0n, agentBalanceWei: 0n, solutionMaxDeliveryRateWei: 0n,
      verdictMaxDeliveryRateWei: 0n, maxClaims: 1, agentGasReserveWei: 0n,
    }),
    probeFreshness: async () => ({ claimWindowEndMs: 0, submissionDeadlineMs: 0, sessionDeadlineMs: 0 }),
    post: async () => ({}),
  };
}

function makeDaemon(store: Store, tmp: string, posting: DaemonConfig['posting']): Daemon {
  return new Daemon({
    adapter: new LocalAdapter(),
    runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
    store,
    dbPath: ':memory:',
    apiPort: 0,
    pollIntervalMs: 60_000,
    taskSources: [],
    restorationEngine: minimalEngineConfig(tmp),
    watchdog: { autoRestart: false },
    posting,
  });
}

describe('M5d posting loop host-wire', () => {
  let tmp: string;
  let store: Store;
  let daemon: Daemon | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jinn-m5d-posting-'));
    store = new Store(':memory:');
  });

  afterEach(async () => {
    await daemon?.stop().catch(() => undefined);
    store.close();
  });

  it('the posting row already exists exactly once in LOOP_REGISTRY (mount, do not re-register)', () => {
    expect(LOOP_REGISTRY.filter((r) => r.name === 'posting')).toHaveLength(1);
  });

  it('mounts and heartbeats posting for native mode with a non-empty posting[]', async () => {
    daemon = makeDaemon(store, tmp, {
      compositionMode: 'native',
      postingEntryCount: 1,
      ports: stubPorts(),
    });
    await daemon.start();
    expect(getLoopTick(store, 'posting')).not.toBeNull();
    await daemon.stop();
    daemon = undefined;
  });

  it('is boot-inert for a legacy composition (default boot)', async () => {
    daemon = makeDaemon(store, tmp, {
      compositionMode: 'legacy',
      postingEntryCount: 3,
      ports: stubPorts(),
    });
    await daemon.start();
    expect(getLoopTick(store, 'posting')).toBeNull();
    await daemon.stop();
    daemon = undefined;
  });

  it('is boot-inert for native mode with an empty posting[]', async () => {
    daemon = makeDaemon(store, tmp, {
      compositionMode: 'native',
      postingEntryCount: 0,
      ports: stubPorts(),
    });
    await daemon.start();
    expect(getLoopTick(store, 'posting')).toBeNull();
    await daemon.stop();
    daemon = undefined;
  });

  it('starts nothing posting-related when the posting config is omitted', async () => {
    daemon = makeDaemon(store, tmp, undefined);
    await daemon.start();
    expect(getLoopTick(store, 'posting')).toBeNull();
    await daemon.stop();
    daemon = undefined;
  });
});
