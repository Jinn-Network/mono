import { describe, it, expect, vi } from 'vitest';
import { Daemon, type DaemonConfig } from '../../src/daemon/daemon.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { SimpleRunner } from '../../src/runner/simple.js';
import type { OperatorComposition } from '../../src/daemon/composition-root.js';
import { Store } from '../../src/store/store.js';
import { LOOP_HEARTBEAT_PREFIX } from '../../src/daemon/loop-heartbeat.js';

describe('Daemon', () => {
  it('initializes and stops cleanly', async () => {
    const config: DaemonConfig = {
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      taskSources: [],
      dbPath: ':memory:',
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
});
