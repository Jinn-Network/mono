/**
 * #1977 — pin: windowEndTs abort terminalizes the row and frees the
 * single-flight slot for the same (routingKey, role, manifestCid).
 *
 * Cleanup under test is TaskEngine.runImpl abort + _runTransition /
 * markFailed (or pack/deliver → COMPLETE), NOT the #1043 loop watchdog.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafymock123'),
  cidToDigestHex: vi.fn().mockReturnValue(
    '0xdeadbeef00000000000000000000000000000000000000000000000000000000' as `0x${string}`,
  ),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

vi.mock('../../../src/adapters/mech/contracts.js', () => ({
  callDeliverToMarketplace: vi.fn().mockResolvedValue('0xdeliverytx' as `0x${string}`),
  claimDelivery: vi.fn().mockResolvedValue('0xclaimtx' as `0x${string}`),
  submitTask: vi.fn(),
  submitEvaluationJob: vi.fn(),
  claimJob: vi.fn(),
  getJobClaim: vi.fn(),
  getMechDeliveryRate: vi.fn(),
  getTimeoutBounds: vi.fn(),
  pollDeliverEvents: vi.fn(),
  decodeMarketplaceRequestLogs: vi.fn(),
  decodeDeliverLogs: vi.fn(),
  scanTasks: vi.fn(),
  scanEvaluationJobs: vi.fn(),
}));

import { getEventBuffer } from '../../../src/events/emitter.js';
import { Store } from '../../../src/store/store.js';
import { TaskEngine, type TaskEngineOptions } from '../../../src/harnesses/engine/engine.js';
import { TaskRunPersistence } from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import { getSolverNetContract } from '../../../src/solver-nets/contracts.js';
import { SolverNetRegistry } from '../../../src/solver-nets/registry.js';
import type { Task } from '../../../src/types/task.js';
import type { Harness, HarnessContext, ReadyStatus, Solution } from '../../../src/harnesses/types.js';

const ROUTING_KEY = 'swe-rebench-v2.v1';
const MANIFEST_CID = 'bafkrei-window-expiry-single-flight-pin';
const WINDOW_MS = 100;
const TERMINAL_WAIT_MS = 5_000;
const HARNESS_START_WAIT_MS = 2_000;

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Mirror adapter race: already-aborted OR next abort event. */
function awaitAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

async function awaitHarnessStarted(
  started: ReturnType<typeof deferred<'started'>>,
): Promise<void> {
  await expect(
    Promise.race([
      started.promise,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('harness never started')), HARNESS_START_WAIT_MS),
      ),
    ]),
  ).resolves.toBe('started');
}

function makeTask(requestId: string, windowStartTs: number, windowEndTs: number): Task {
  return {
    id: requestId,
    description: 'window-expiry single-flight pin',
    solverType: ROUTING_KEY,
    contractId: 'swe-rebench-v2',
    contractVersion: 'v1',
    solverNetManifestCid: MANIFEST_CID,
    role: 'restoration',
    window: { startTs: windowStartTs, endTs: windowEndTs },
    spec: {},
  } as unknown as Task;
}

function makeEmptyAbortHarness(started: ReturnType<typeof deferred<'started'>>): Harness {
  return {
    name: 'window-expiry-empty-stub',
    version: '0.0.1',
    supports: () => true,
    isReady: async (): Promise<ReadyStatus> => ({ ready: true }),
    async run(ctx: HarnessContext): Promise<Solution> {
      started.resolve('started');
      await awaitAbort(ctx.abort);
      // Models harvest-empty after adapters resolve on abort.
      throw new Error('no deliverable: empty harvest after window abort');
    },
  };
}

function makePartialAbortHarness(started: ReturnType<typeof deferred<'started'>>): Harness {
  return {
    name: 'window-expiry-partial-stub',
    version: '0.0.1',
    supports: () => true,
    isReady: async (): Promise<ReadyStatus> => ({ ready: true }),
    async run(ctx: HarnessContext): Promise<Solution> {
      started.resolve('started');
      await awaitAbort(ctx.abort);
      // Models adapter resolve-on-abort + harvest of a valid partial Solution.
      // solutionPayload is required so pack() validatePayload(swe-rebench-v2.v1)
      // succeeds hermetically (fixture wiring, not a production change).
      return {
        venueRef: { name: 'stub-partial' },
        gating: { ok: true, partialAfterAbort: true },
        informational: { status: 'partial' },
        artifacts: [],
        solutionPayload: {
          schemaVersion: 'swe-rebench-v2-solution.v1',
          patch: 'diff --git a/foo b/foo\n@@ -1 +1 @@\n-hello\n+world\n',
        },
      };
    },
  };
}

// Cutover stage 1 (docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md
// Task 16): canAcceptTask({ taskRole: 'restoration', ... }) is now always refused
// before the single-flight in-flight gate runs (see
// test/daemon/solution-path-retired.test.ts). The gate itself
// (TaskRunPersistence.hasInFlightFor, consulted from runnableFailureReason) is
// unchanged, and restoration still reaches it through the surviving claim()
// entry point (DISCOVERED -> CLAIMED). The seeded RUNNING row under test keeps
// taskRole: 'restoration' (unrelated to canAcceptTask — it drives the real
// runImpl/pack/deliver lifecycle), and this probe checks the SAME
// {solverType, taskRole, manifestCid} gate bucket via claim() instead.
class TestEngine extends TaskEngine {
  async callClaim(intent: import('../../../src/harnesses/engine/persistence.js').PersistedTaskRun): Promise<void> {
    return this.claim(intent);
  }
}

async function probeSingleFlight(
  engine: TestEngine,
  store: Store,
  probeRequestId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const persistence = new TaskRunPersistence(store.db);
  const now = Date.now();
  persistence.insertDiscovered({
    requestId: probeRequestId,
    taskCid: `bafy-${probeRequestId}`,
    onchainCreationTx: '0xdeadbeefprobe000000000000000000000000',
    onchainCreationBlock: 1,
    solverType: ROUTING_KEY,
    taskRole: 'restoration',
    windowStartTs: now,
    windowEndTs: now + 60_000,
    task: makeTask(probeRequestId, now, now + 60_000),
  });
  try {
    await engine.callClaim(persistence.getByRequestId(probeRequestId)!);
    return { ok: true };
  } catch (err) {
    const row = persistence.getByRequestId(probeRequestId)!;
    return {
      ok: false,
      reason: row.failureReason ?? (err instanceof Error ? err.message : String(err)),
    };
  }
}

// issue #2039 fixture: a wired SolverNetRegistry so the engine exercises the
// production-realistic registry-resolved dispatch path (harnessNameForFind
// pin semantics) rather than the no-registry legacy fallback.
function fixtureSolverNetRegistry(harness: string): SolverNetRegistry {
  const contract = getSolverNetContract({ id: 'swe-rebench-v2', version: 'v1' });
  if (!contract) throw new Error('fixture SolverNet contract missing');
  const registry = new SolverNetRegistry();
  registry.register({
    name: MANIFEST_CID,
    manifestCid: MANIFEST_CID,
    enabled: true,
    solverType: ROUTING_KEY,
    roles: ['solving'],
    contract,
    harness,
    runtimePlugins: [],
    taskGenerator: { enabled: false },
  });
  return registry;
}

function packagingOpts(store: Store, dir: string, impl: Harness): TaskEngineOptions {
  return {
    store,
    paths: {
      workingDirRoot: join(dir, 'work'),
      implStateDirRoot: join(dir, 'impl-state'),
    },
    implRegistry: { findFor: () => impl },
    solverNetRegistry: fixtureSolverNetRegistry(impl.name),
    packagingDeps: {
      store,
      operatorEndpoint: 'https://op.test',
      defaultPriceUsdc: '0',
      perArtifactTypePrice: {},
    },
    envelopeDeps: {
      ipfsRegistryUrl: 'http://ipfs.test',
      agentEoaPrivateKey: TEST_PRIVATE_KEY,
      safeAddress: '0xsafe' as `0x${string}`,
    },
    deliveryDeps: {
      publicClient: {} as import('viem').PublicClient,
      walletClient: {} as import('viem').WalletClient,
      safeAddress: '0xsafe' as `0x${string}`,
      mechContractAddress: '0xmech' as `0x${string}`,
      routerAddress: '0xrouter' as `0x${string}`,
      claimDeliveryVariant: 'v2',
    },
  };
}

/**
 * AC4: watchdog stale signals go to the structured-event ring
 * (`errorCode: loop_watchdog_stale`), not `activity_events`. Also scan
 * activity rows for accidental watchdog naming. Primary proof remains:
 * this file never constructs Daemon / WatchdogLoop.
 */
function assertNoWatchdogEvents(store: Store): void {
  const stale = getEventBuffer()
    .snapshot()
    .filter((e) => e.errorCode === 'loop_watchdog_stale');
  expect(stale).toEqual([]);

  const rows = store.db
    .prepare(
      `SELECT kind, detail FROM activity_events
       WHERE kind LIKE '%watchdog%'
          OR detail LIKE '%loop_watchdog_stale%'
          OR detail LIKE '%watchdog%'`,
    )
    .all() as Array<{ kind: string; detail: string | null }>;
  expect(rows).toEqual([]);
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms`);
}

describe('TaskEngine — windowEndTs abort terminalizes and releases single-flight', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    getEventBuffer().clear();
    dir = mkdtempSync(join(tmpdir(), 'jinn-window-expiry-sf-'));
    store = new Store(join(dir, 'jinn.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedRunning(
    persistence: TaskRunPersistence,
    requestId: string,
    implName: string,
    windowEndTs: number,
  ): void {
    const now = Date.now();
    const windowStartTs = now - 1_000;
    const workingDir = join(dir, 'work', requestId);
    const implStateDir = join(dir, 'impl-state', implName, 'swe_rebench_v2_v1');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(implStateDir, { recursive: true });

    persistence.insertDiscovered({
      requestId,
      taskCid: `bafy-${requestId}`,
      onchainCreationTx: '0xdeadbeef',
      onchainCreationBlock: 1,
      solverType: ROUTING_KEY,
      taskRole: 'restoration',
      windowStartTs,
      windowEndTs,
      task: makeTask(requestId, windowStartTs, windowEndTs),
    });
    persistence.transition(requestId, TaskRunState.CLAIMED);
    persistence.transition(requestId, TaskRunState.WAITING);
    persistence.transition(requestId, TaskRunState.PRE_SNAPSHOT);
    persistence.transition(requestId, TaskRunState.RUNNING, {
      workingDir,
      implStateDir,
      preSnapshotCapturedAt: now,
      preSnapshotPayload: { provisioned: true },
    });
  }

  it('empty harvest after window abort → FAILED and frees the SolverNet slot (not watchdog)', async () => {
    // AC1–AC4: short real window; leave RUNNING; FAILED terminal; slot free; no watchdog.
    const started = deferred<'started'>();
    const impl = makeEmptyAbortHarness(started);
    const engine = new TestEngine({
      store,
      paths: {
        workingDirRoot: join(dir, 'work'),
        implStateDirRoot: join(dir, 'impl-state'),
      },
      implRegistry: { findFor: () => impl },
      solverNetRegistry: fixtureSolverNetRegistry(impl.name),
    });
    const persistence = new TaskRunPersistence(store.db);
    const requestId = 'win-exp-empty-1';
    const windowEndTs = Date.now() + WINDOW_MS;

    seedRunning(persistence, requestId, impl.name, windowEndTs);

    // Slot occupied while RUNNING.
    const blocked = await probeSingleFlight(engine, store, 'win-exp-empty-probe-1');
    expect(blocked.ok).toBe(false);

    const processPromise = engine.process(requestId).then(
      () => ({ outcome: 'resolved' as const }),
      (err: unknown) => ({
        outcome: 'rejected' as const,
        message: err instanceof Error ? err.message : String(err),
      }),
    );

    await awaitHarnessStarted(started);

    await waitUntil(
      () => persistence.getByRequestId(requestId)?.state === TaskRunState.FAILED,
      TERMINAL_WAIT_MS,
      'FAILED after window abort',
    );

    const result = await processPromise;
    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.message).toMatch(/no deliverable|empty/i);
    }

    const row = persistence.getByRequestId(requestId)!;
    expect(row.state).toBe(TaskRunState.FAILED);
    expect(row.state).not.toBe(TaskRunState.RUNNING);
    expect(row.failureReason ?? '').toMatch(/no deliverable|empty/i);

    const accept = await probeSingleFlight(engine, store, 'win-exp-empty-probe-2');
    expect(accept).toEqual({ ok: true });

    assertNoWatchdogEvents(store);
  });

  it('valid partial Solution after window abort → COMPLETE and frees the SolverNet slot', async () => {
    const started = deferred<'started'>();
    const impl = makePartialAbortHarness(started);
    const engine = new TestEngine(packagingOpts(store, dir, impl));
    const persistence = new TaskRunPersistence(store.db);
    const requestId = 'win-exp-partial-1';
    const windowEndTs = Date.now() + WINDOW_MS;

    seedRunning(persistence, requestId, impl.name, windowEndTs);

    // Slot occupied while RUNNING (same gate keys as AC3 accept below).
    const blocked = await probeSingleFlight(engine, store, 'win-exp-partial-probe-1');
    expect(blocked.ok).toBe(false);

    // Drive RUNNING → POST_SNAPSHOT via abort, then pack/deliver via ticks.
    // runTickLoop keeps advancing until COMPLETE (process alone stops at POST_SNAPSHOT).
    const loop = engine.runTickLoop(10);
    try {
      await awaitHarnessStarted(started);

      await waitUntil(
        () => {
          const s = persistence.getByRequestId(requestId)?.state;
          return s === TaskRunState.COMPLETE || s === TaskRunState.FAILED;
        },
        TERMINAL_WAIT_MS,
        'COMPLETE (or FAILED) after partial abort',
      );

      const row = persistence.getByRequestId(requestId)!;
      expect(row.state).toBe(TaskRunState.COMPLETE);
      expect(row.state).not.toBe(TaskRunState.RUNNING);
      // Must not assert release from POST_SNAPSHOT/PACKAGING/DELIVERING.
      expect([
        TaskRunState.POST_SNAPSHOT,
        TaskRunState.PACKAGING,
        TaskRunState.DELIVERING,
        TaskRunState.RUNNING,
      ]).not.toContain(row.state);

      const accept = await probeSingleFlight(engine, store, 'win-exp-partial-probe-2');
      expect(accept).toEqual({ ok: true });

      assertNoWatchdogEvents(store);
    } finally {
      // Always stop so afterEach does not close the Store under a live tick loop.
      engine.stop();
      await Promise.race([loop, new Promise((r) => setTimeout(r, 500))]);
    }
  });
});
