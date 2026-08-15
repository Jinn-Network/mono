import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Daemon, type DaemonConfig } from '../../src/daemon/daemon.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { SimpleRunner } from '../../src/runner/simple.js';
import type { OperatorComposition } from '../../src/daemon/composition-root.js';
import { Store } from '../../src/store/store.js';
import { LOOP_HEARTBEAT_PREFIX } from '../../src/daemon/loop-heartbeat.js';

describe('Daemon', () => {
  it('starts native-v1 without constructing or starting the legacy TaskEngine/watcher estate', async () => {
    const adapter = new LocalAdapter();
    const watch = vi.spyOn(adapter, 'watchForTasks');
    const nativeHost = { start: vi.fn(async () => undefined), health: vi.fn(), close: vi.fn(async () => undefined) };
    const daemon = new Daemon({
      verticalMode: 'native-v1',
      nativeHost,
      adapter,
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      taskSources: [],
      dbPath: ':memory:',
      apiPort: 0, // OS picks an ephemeral port
    });

    await daemon.start();
    expect(nativeHost.start).toHaveBeenCalledOnce();
    expect(watch).not.toHaveBeenCalled();
    await daemon.stop();
    expect(nativeHost.close).toHaveBeenCalledOnce();
  });

  // Wave-4 D1 (DR-2026-08-05) retired the TaskEngine, so an explicit legacy
  // daemon no longer requires — or accepts — a restoration engine. It must
  // still construct and start cleanly.
  it('keeps explicit legacy mode startable with no restoration engine', () => {
    expect(() => new Daemon({
      verticalMode: 'legacy',
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      taskSources: [],
      dbPath: ':memory:',
      apiPort: 0, // OS picks an ephemeral port
    })).not.toThrow();
  });

  it('initializes and stops cleanly', async () => {
    const config: DaemonConfig = {
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      taskSources: [],
      dbPath: ':memory:',
      apiPort: 0, // OS picks an ephemeral port
    };

    const daemon = new Daemon(config);
    await daemon.start();
    await daemon.stop();
  });

  it('tracks shutdown state in store', async () => {
    const config: DaemonConfig = {
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      taskSources: [],
      dbPath: ':memory:',
      apiPort: 0, // OS picks an ephemeral port
    };

    const daemon = new Daemon(config);
    await daemon.start();
    expect(daemon.getShutdownState()).toBe('running');
    await daemon.stop();
    expect(daemon.getShutdownState()).toBe('clean');
  });

  it('accepts static configured Tasks when taskSources are omitted', async () => {
    const config: DaemonConfig = {
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      tasks: [{ id: 'legacy-static', description: 'legacy static task' }],
      dbPath: ':memory:',
      apiPort: 0, // OS picks an ephemeral port
    };

    const daemon = new Daemon(config);
    await daemon.start();
    await daemon.stop();
    expect(daemon.getShutdownState()).toBe('clean');
  });

});

/**
 * C8 close-out: `daemon.start()` must start all THREE composition-driven loops (projector, work,
 * evidence-driver) and register them with the watchdog — Task 13 started only `work`. The
 * `composition` fixture here is a hand-built fake (not `buildOperatorComposition`, which is
 * already exercised end to end by `composition-root.test.ts`) so this suite tests only the
 * daemon's own orchestration: which loops get `.run()`/`.stop()` called on them, and which get
 * seeded into the watchdog's heartbeat table.
 */
describe('Daemon — C8 loop startup', () => {
  function fakeComposition(): {
    readonly composition: OperatorComposition;
    readonly projectorRun: ReturnType<typeof vi.fn>;
    readonly projectorStop: ReturnType<typeof vi.fn>;
    readonly evidenceSync: ReturnType<typeof vi.fn>;
  } {
    // Never resolves — mirrors a real loop's `run()`, which only returns once `stopSignal()`
    // trips on its NEXT tick (loop-heartbeat.ts's `runLoop` has no early-exit on `.stop()`).
    const projectorRun = vi.fn(() => new Promise<void>(() => undefined));
    const projectorStop = vi.fn();
    const evidenceSync = vi.fn(async () => ({ indexed: 0, failed: 0 }));
    const evidence = {
      runtime: {
        sync: evidenceSync,
        getStatus: vi.fn(async () => ({ pendingAnnouncements: 0 })),
        listIndexingFailures: vi.fn(async () => ({ items: [] })),
        close: vi.fn(async () => undefined),
      },
      ports: { repository: {}, catalog: {}, awaitIndexed: vi.fn() },
      close: vi.fn(async () => undefined),
    };
    const composition = {
      backend: {} as never,
      pipelineConfig: {} as never,
      pipelinePorts: {} as never,
      venue: {} as never,
      evidence: evidence as unknown as OperatorComposition['evidence'],
      chain: {} as never,
      safeAddress: '0x0000000000000000000000000000000000000000',
      mechAddress: '0x0000000000000000000000000000000000000000',
      broadcaster: {} as never,
      noteAttemptWorkKind: () => undefined,
      projector: {
        run: projectorRun,
        stop: projectorStop,
        hasCaughtUp: vi.fn(async () => true),
      } as unknown as OperatorComposition['projector'],
      claimGate: { isOpen: () => true, waitUntilOpen: async () => undefined },
      engagementLedger: {} as never,
      readSealedDocuments: async () => ({ taskBytes: new Uint8Array(), submissionBytes: new Uint8Array() }),
      close: vi.fn(async () => undefined),
    } as OperatorComposition;
    return { composition, projectorRun, projectorStop, evidenceSync };
  }

  it('starts the projector and evidence-driver loops, and stops them on shutdown', async () => {
    const { composition, projectorRun, projectorStop, evidenceSync } = fakeComposition();
    const daemon = new Daemon({
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      taskSources: [],
      dbPath: ':memory:',
      apiPort: 0, // OS picks an ephemeral port
      composition,
      evidenceDriverIntervalMs: 20,
      shutdownTimeoutMs: 200,
    });

    await daemon.start();
    expect(projectorRun).toHaveBeenCalledTimes(1);
    // `runLoop` ticks immediately on entry (no upfront delay) — the evidence-driver loop's first
    // tick calls `runtime.sync()` synchronously with start().
    await vi.waitFor(() => expect(evidenceSync).toHaveBeenCalled());

    await daemon.stop();
    expect(projectorStop).toHaveBeenCalledTimes(1);
  });

  it('registers the projector and evidence-driver loops with the watchdog heartbeat table', async () => {
    const { composition } = fakeComposition();
    const store = new Store(':memory:');
    const daemon = new Daemon({
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      taskSources: [],
      dbPath: ':memory:',
      store,
      apiPort: 0, // OS picks an ephemeral port
      composition,
      evidenceDriverIntervalMs: 20,
      shutdownTimeoutMs: 200,
      watchdog: { autoRestart: false },
    });

    await daemon.start();
    expect(store.getConfigValue(`${LOOP_HEARTBEAT_PREFIX}projector`)).not.toBeNull();
    expect(store.getConfigValue(`${LOOP_HEARTBEAT_PREFIX}evidence-driver`)).not.toBeNull();

    await daemon.stop();
    store.close();
  });

  it('threads the evidence driver into the status config so /v1/status can carry evidenceIndexing (M6)', () => {
    // Regression guard: the consumer paths (gather-status, notifications-build) existed, but
    // nothing set `status.evidenceDriver`, so the block was always absent. The daemon must wire it.
    const { composition } = fakeComposition();
    const status: import('../../src/api/gather-status.js').StatusGatherConfig = {};
    // eslint-disable-next-line no-new
    new Daemon({
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      taskSources: [],
      dbPath: ':memory:',
      apiPort: 0,
      composition,
      status,
      evidenceDriverIntervalMs: 20,
      shutdownTimeoutMs: 200,
    });
    expect(status.evidenceDriver).toBeTypeOf('function');
    const source = status.evidenceDriver!();
    expect(source).not.toBeNull();
    expect(source!.pending).toBeTypeOf('function');
    expect(source!.failures).toBeTypeOf('function');
  });

  it('starts the work loop alongside the projector and evidence-driver loops when `work` is supplied', async () => {
    const { composition } = fakeComposition();
    const archiveSince = vi.fn(async () => []);
    const store = new Store(':memory:');
    const daemon = new Daemon({
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      taskSources: [],
      dbPath: ':memory:',
      store,
      apiPort: 0, // OS picks an ephemeral port
      composition,
      work: {
        archive: { since: archiveSince },
        // `WorkLoopConfig.ledger` is only read on a non-empty archive batch (never reached here,
        // since `archiveSince` always resolves `[]`) — this fixture proves the work loop itself
        // starts ticking, not its claim-gate/ledger behavior (already covered by
        // `work-loop.test.ts`).
        ledger: {} as never,
        claimGate: composition.claimGate,
        estimateAiUnits: () => 0,
        readSealedDocuments: composition.readSealedDocuments,
        pollIntervalMs: 20,
        acceptLegacyCards: true,
      },
      evidenceDriverIntervalMs: 20,
      shutdownTimeoutMs: 200,
      watchdog: { autoRestart: false },
    });

    await daemon.start();
    await vi.waitFor(() => expect(archiveSince).toHaveBeenCalled());
    expect(store.getConfigValue(`${LOOP_HEARTBEAT_PREFIX}work`)).not.toBeNull();

    await daemon.stop();
    store.close();
  });

  it('never records running/startup-ok when native lease initialization fails after API bind', async () => {
    const { composition: legacyShape } = fakeComposition();
    const composition = { ...legacyShape, mode: 'native' as const };
    const store = new Store(':memory:');
    const sync = vi.fn();
    const daemon = new Daemon({
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      taskSources: [],
      dbPath: ':memory:',
      store,
      apiPort: 0,
      composition,
      work: {
        nativeDiscovery: {
          sync,
          takePending: () => [],
          takePendingWithdrawals: () => [],
          acknowledge: vi.fn(),
          acknowledgeWithdrawal: vi.fn(),
          checkpoint: () => undefined,
          resumeSse: () => ({ close: () => undefined }),
        },
        nativeClaimCoordinator: {
          startWorker: () => { throw new Error('lease already owned'); },
          renewWorker: vi.fn(),
          reconcileStartup: vi.fn(async () => ({ reconciled: 0, finalized: 0 })),
          process: vi.fn(),
        },
        nativeSolutionCoordinator: {
          reconcileStartup: vi.fn(async () => []),
          reconcileEngagement: vi.fn(),
        },
        nativeSolutionCorrections: { reconcile: vi.fn(async () => undefined) },
        ledger: {} as never,
        claimGate: composition.claimGate,
        estimateAiUnits: () => 0,
        readSealedDocuments: composition.readSealedDocuments,
        pollIntervalMs: 20,
        acceptLegacyCards: false,
      },
      shutdownTimeoutMs: 50,
    });

    await expect(daemon.start()).rejects.toThrow('lease already owned');
    expect(daemon.getShutdownState()).toBeNull();
    expect(store.getShutdownState()).toBeNull();
    expect(store.db.prepare(`SELECT COUNT(*) AS count FROM activity_events WHERE kind = 'startup'`).get())
      .toEqual({ count: 0 });
    expect(sync).not.toHaveBeenCalled();

    await daemon.stop();
    store.close();
  });
});
