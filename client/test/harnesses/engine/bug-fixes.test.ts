/**
 * Regression tests for harness-engine + claude-mcp-hyperliquid bug fixes:
 *   - jinn-mono-sae: recovery chain re-dispatches after takePreSnapshot
 *   - jinn-mono-egi: full Task threading through persistence
 *   - jinn-mono-eci: periodic engine tick
 *   - jinn-mono-u59: takePreSnapshot resolves impl.name via registry for implStateDir
 *   - jinn-mono-cmb: session-orchestrator ignores undefined config overrides
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Store } from '../../../src/store/store.js';
import {
  TaskEngine,
  type TaskEngineOptions,
} from '../../../src/harnesses/engine/engine.js';
import { TaskRunPersistence } from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState, MissingEvidenceHashError } from '../../../src/harnesses/engine/state.js';
import type { Task } from '../../../src/types/task.js';
import type { Harness, HarnessContext, Solution } from '../../../src/harnesses/types.js';
import {
  resolveOrchestratorConfig,
  DEFAULT_ORCHESTRATOR_CONFIG,
} from '../../../src/harnesses/impls/claude-mcp-hyperliquid/session-orchestrator.js';

// ── Test scaffolding ──────────────────────────────────────────────────────────

const engTestRoot = mkdtempSync(join(tmpdir(), 're-eng-'));

function makeOpts(store: Store, implRegistry?: TaskEngineOptions['implRegistry']): TaskEngineOptions {
  return {
    store,
    paths: { workingDirRoot: join(engTestRoot, 'work'), implStateDirRoot: join(engTestRoot, 'impl') },
    ...(implRegistry ? { implRegistry } : {}),
  };
}

/** Records the ctx.task that runImpl received for inspection. */
function makeRecordingImpl(opts: { name?: string; solverType: string; output?: Partial<Solution> } = { solverType: 'portfolio.v0' }): {
  impl: Harness;
  received: { ctx: HarnessContext | null };
} {
  const received: { ctx: HarnessContext | null } = { ctx: null };
  const impl: Harness = {
    name: opts.name ?? 'recording-impl',
    version: '0.0.1',
    supports: (s) => s.solverType === opts.solverType,
    async run(ctx) {
      received.ctx = ctx;
      const baseSnapshot = { capturedAt: Date.now(), hlTime: 0, payload: {} };
      const out: Solution = {
        venueRef: { name: 'test' },
        gating: { ok: true },
        preSnapshot: baseSnapshot,
        postSnapshot: baseSnapshot,
        fills: [],
        ...(opts.output ?? {}),
      };
      return out;
    },
  };
  return { impl, received };
}

function fullTask(id: string, windowStartTs: number, windowEndTs: number): Task {
  return {
    id,
    description: 'Recover BTC-PERP exposure to 50% of equity within window',
    solverType: 'portfolio.v0',
    spec: {
      account: { venue: 'hyperliquid', masterAddress: '0xabc0000000000000000000000000000000000001' },
      target: { instrument: 'BTC-PERP', exposure: 0.5 },
      constraint: { maxSlippageBps: 25 },
    },
    eligibility: { minEquityUsd: 100 },
    window: { startTs: windowStartTs, endTs: windowEndTs },
  };
}

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

function timeout<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function testSolution(): Solution {
  const baseSnapshot = { capturedAt: Date.now(), hlTime: 0, payload: {} };
  return {
    venueRef: { name: 'test' },
    gating: { ok: true },
    preSnapshot: baseSnapshot,
    postSnapshot: baseSnapshot,
    fills: [],
  };
}

// ── Bug 1: jinn-mono-sae ──────────────────────────────────────────────────────

describe('jinn-mono-sae: recovery re-dispatches runImpl after takePreSnapshot', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => { store.close(); });

  it('CLAIMED intent with open window recovers all the way through runImpl', async () => {
    const now = Date.now();
    const { impl, received } = makeRecordingImpl({ solverType: 'portfolio.v0' });
    const opts: TaskEngineOptions = {
      ...makeOpts(store),
      implRegistry: { findFor: (s) => (impl.supports(s) ? impl : undefined) },
    };
    const engine = new TaskEngine(opts);
    const persistence = new TaskRunPersistence(store.db);

    const ds = fullTask('rec-1', now - 1000, now + 86_400_000);
    persistence.insertDiscovered({
      requestId: 'rec-1',
      taskCid: 'cid-rec-1',
      onchainCreationTx: '0xabc',
      onchainCreationBlock: 1,
      solverType: 'portfolio.v0',
      windowStartTs: ds.window!.startTs,
      windowEndTs: ds.window!.endTs,
      task: ds,
    });
    persistence.transition('rec-1', TaskRunState.CLAIMED);

    await engine.recoverInFlight();

    expect(received.ctx).not.toBeNull();
    const after = persistence.getByRequestId('rec-1')!;
    // runImpl ran and captured its post-snapshot
    expect(after.state).toBe(TaskRunState.POST_SNAPSHOT);
  });
});

// ── Bug 2: jinn-mono-egi ──────────────────────────────────────────────────────

describe('jinn-mono-egi: full Task round-trip', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => { store.close(); });

  it('persists and re-emits a complete portfolio.v0 Task into ctx.task', async () => {
    const now = Date.now();
    const ds = fullTask('egi-1', now - 1000, now + 86_400_000);
    const { impl, received } = makeRecordingImpl({ solverType: 'portfolio.v0' });
    const opts: TaskEngineOptions = {
      ...makeOpts(store),
      implRegistry: { findFor: (s) => (impl.supports(s) ? impl : undefined) },
    };
    const engine = new TaskEngine(opts);
    const persistence = new TaskRunPersistence(store.db);

    await engine.observe({
      requestId: 'egi-1',
      taskId: '7',
      attemptIndex: 2,
      taskCid: 'cid-egi-1',
      onchainCreationTx: '0xdef',
      onchainCreationBlock: 2,
      solverType: 'portfolio.v0',
      windowStartTs: ds.window!.startTs,
      windowEndTs: ds.window!.endTs,
      task: ds,
    });

    // Drive to RUNNING via process() (shortcut by direct transitions, then process()).
    persistence.transition('egi-1', TaskRunState.CLAIMED);
    persistence.transition('egi-1', TaskRunState.WAITING);
    await engine.process('egi-1'); // advances WAITING → PRE_SNAPSHOT → RUNNING (re-dispatched)

    expect(received.ctx).not.toBeNull();
    expect(received.ctx!.task).toEqual(ds);
    expect(received.ctx).toMatchObject({
      taskId: '7',
      attemptIndex: 2,
      requestId: 'egi-1',
    });
  });

  it('falls back to stub when task_payload is NULL (legacy row)', async () => {
    const now = Date.now();
    const persistence = new TaskRunPersistence(store.db);
    // Direct INSERT with NULL task_payload (simulates pre-migration row).
    store.db.prepare(`
      INSERT INTO task_runs (
        request_id, task_cid, onchain_creation_tx, onchain_creation_block,
        solver_type, state, state_updated_at, window_start_ts, window_end_ts,
        task_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      'legacy-1', 'cid-legacy', '0x000', 0, null, 'CLAIMED', Date.now(),
      now - 1000, now + 86_400_000,
    );

    // Engine with no impl registered — recovery should still process the row
    // without throwing on the missing payload. The legacy stub Task is
    // synthesised from intent.solverType/window for both takePreSnapshot and
    // runImpl. Recovery advances CLAIMED → WAITING → PRE_SNAPSHOT → RUNNING.
    const engine = new TaskEngine(makeOpts(store));
    await engine.recoverInFlight();
    const after = persistence.getByRequestId('legacy-1')!;
    // The intent advanced past CLAIMED (recovery did not throw on NULL payload).
    // Recovery walks CLAIMED → WAITING → PRE_SNAPSHOT → RUNNING via takePreSnapshot
    // (using the synthesised stub Task), then runImpl throws
    // NotImplementedError. That throw propagates out of _recoverOne without
    // marking FAILED because current.state (RUNNING) no longer matches the
    // original intent.state (CLAIMED) — so the row is left in RUNNING.
    expect(after.state).toBe(TaskRunState.RUNNING);
    expect(after.task).toBeNull();
  });
});

// ── Bug 4: jinn-mono-u59 — implStateDir path matches impl.name ───────────────

describe('jinn-mono-u59: takePreSnapshot uses impl.name for implStateDir', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => { store.close(); });

  it('resolves implStateDir to <root>/<impl.name>, not <root>/<solverType>', async () => {
    const now = Date.now();
    const ds = fullTask('u59-1', now - 1000, now + 86_400_000);
    const { impl, received } = makeRecordingImpl({ name: 'claude-mcp-hyperliquid', solverType: 'portfolio.v0' });
    const opts: TaskEngineOptions = {
      ...makeOpts(store),
      implRegistry: { findFor: (s) => (impl.supports(s) ? impl : undefined) },
    };
    const engine = new TaskEngine(opts);
    const persistence = new TaskRunPersistence(store.db);

    await engine.observe({
      requestId: 'u59-1',
      taskCid: 'cid-u59',
      onchainCreationTx: '0xfff',
      onchainCreationBlock: 7,
      solverType: 'portfolio.v0',
      windowStartTs: ds.window!.startTs,
      windowEndTs: ds.window!.endTs,
      task: ds,
    });
    persistence.transition('u59-1', TaskRunState.CLAIMED);
    persistence.transition('u59-1', TaskRunState.WAITING);
    await engine.process('u59-1');

    expect(received.ctx).not.toBeNull();
    // Path is <root>/<impl.name>/<kind-sanitized>. impl.name segment must
    // appear (operators pre-place credentials at <root>/<impl.name>),
    // and the per-kind partition (. → _) must be the leaf so cross-kind
    // state cannot contaminate.
    expect(received.ctx!.implStateDir).toContain('/claude-mcp-hyperliquid/');
    expect(received.ctx!.implStateDir.endsWith('/portfolio_v0')).toBe(true);
  });
});

// ── Bug 5: jinn-mono-cmb — session-orchestrator config merge ─────────────────

describe('jinn-mono-cmb: resolveOrchestratorConfig discards undefined overrides', () => {
  it('falls back to defaults when caller passes explicit undefined values', () => {
    const merged = resolveOrchestratorConfig({
      cadenceMs: undefined,
      sessionMaxMs: undefined,
      trackedCoins: ['BTC'],
    } as unknown as Partial<Parameters<typeof resolveOrchestratorConfig>[0]>);
    expect(merged.cadenceMs).toBe(DEFAULT_ORCHESTRATOR_CONFIG.cadenceMs);
    expect(merged.sessionMaxMs).toBe(DEFAULT_ORCHESTRATOR_CONFIG.sessionMaxMs);
    expect(merged.trackedCoins).toEqual(['BTC']);
  });

  it('honours real overrides', () => {
    const merged = resolveOrchestratorConfig({ cadenceMs: 1234, sessionMaxMs: 5678 });
    expect(merged.cadenceMs).toBe(1234);
    expect(merged.sessionMaxMs).toBe(5678);
    expect(merged.marketMoveTriggerFraction).toBe(DEFAULT_ORCHESTRATOR_CONFIG.marketMoveTriggerFraction);
  });

  it('uses defaults when overrides is undefined', () => {
    expect(resolveOrchestratorConfig(undefined)).toEqual(DEFAULT_ORCHESTRATOR_CONFIG);
  });
});

// ── Finding #3: MissingEvidenceHashError for v2 claimDelivery ─────────────────

describe('finding-3: deliver() throws MissingEvidenceHashError when evidenceHash missing for v2', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => { store.close(); });

  function makeDeliveryDeps(variant: 'v1' | 'v2' = 'v2'): TaskEngineOptions['deliveryDeps'] {
    return {
      publicClient: {} as import('viem').PublicClient,
      walletClient: {} as import('viem').WalletClient,
      safeAddress: '0xsafe' as `0x${string}`,
      mechContractAddress: '0xmech' as `0x${string}`,
      routerAddress: '0xrouter' as `0x${string}`,
      claimDeliveryVariant: variant,
    };
  }

  it('throws MissingEvidenceHashError when evidenceHash is null and variant is v2', async () => {
    const persistence = new TaskRunPersistence(store.db);
    const now = Date.now();

    persistence.insertDiscovered({
      requestId: 'mis-1',
      taskCid: 'cid-mis-1',
      onchainCreationTx: '0xmis',
      onchainCreationBlock: 1,
      windowStartTs: now - 1000,
      windowEndTs: now + 86_400_000,
      task: { id: 'mis-1', description: 'test', role: 'restoration' },
    });

    // Advance to DELIVERING with no evidenceHash (null)
    persistence.transition('mis-1', TaskRunState.CLAIMED);
    persistence.transition('mis-1', TaskRunState.WAITING);
    persistence.transition('mis-1', TaskRunState.PRE_SNAPSHOT);
    persistence.transition('mis-1', TaskRunState.RUNNING);
    persistence.transition('mis-1', TaskRunState.POST_SNAPSHOT);
    persistence.transition('mis-1', TaskRunState.PACKAGING);
    persistence.transition('mis-1', TaskRunState.DELIVERING, {
      manifestCid: 'bafymanifest',
      // evidenceHash intentionally omitted → null
    });

    const engine = new TaskEngine({
      ...makeOpts(store),
      deliveryDeps: makeDeliveryDeps('v2'),
    });

    // tick() catches and logs errors per intent; process() re-throws
    await expect(engine.process('mis-1')).rejects.toThrow(MissingEvidenceHashError);
  });

  it('does NOT throw MissingEvidenceHashError for v1 (evidenceHash optional)', async () => {
    // v1 does not require evidenceHash — it should fail for a different reason
    // (callDeliverToMarketplace network call) not MissingEvidenceHashError.
    // We just assert the error is not MissingEvidenceHashError.
    const persistence = new TaskRunPersistence(store.db);
    const now = Date.now();

    persistence.insertDiscovered({
      requestId: 'v1-1',
      taskCid: 'cid-v1-1',
      onchainCreationTx: '0xv1',
      onchainCreationBlock: 1,
      windowStartTs: now - 1000,
      windowEndTs: now + 86_400_000,
      task: { id: 'v1-1', description: 'test', role: 'restoration' },
    });
    persistence.transition('v1-1', TaskRunState.CLAIMED);
    persistence.transition('v1-1', TaskRunState.WAITING);
    persistence.transition('v1-1', TaskRunState.PRE_SNAPSHOT);
    persistence.transition('v1-1', TaskRunState.RUNNING);
    persistence.transition('v1-1', TaskRunState.POST_SNAPSHOT);
    persistence.transition('v1-1', TaskRunState.PACKAGING);
    persistence.transition('v1-1', TaskRunState.DELIVERING, {
      manifestCid: 'bafymanifest',
      // evidenceHash intentionally omitted → null
    });

    const engine = new TaskEngine({
      ...makeOpts(store),
      deliveryDeps: makeDeliveryDeps('v1'),
    });

    try {
      await engine.process('v1-1');
      // If no error, that's unexpected but not a MissingEvidenceHashError — pass
    } catch (err) {
      expect(err).not.toBeInstanceOf(MissingEvidenceHashError);
    }
  });
});

// ── Bug 3: jinn-mono-eci ──────────────────────────────────────────────────────

describe('jinn-mono-eci: tick advances WAITING intents past windowStartTs', () => {
  let store: Store;
  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store(':memory:');
  });
  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  it('advances an intent past WAITING when tick is invoked after windowStartTs', async () => {
    const baseNow = Date.now();
    vi.setSystemTime(baseNow);

    const persistence = new TaskRunPersistence(store.db);
    persistence.insertDiscovered({
      requestId: 'eci-1',
      taskCid: 'cid-eci-1',
      onchainCreationTx: '0xeee',
      onchainCreationBlock: 9,
      windowStartTs: baseNow + 1_000,        // 1s in the future
      windowEndTs: baseNow + 86_400_000,
      task: { id: 'eci-1', description: 'test', role: 'restoration' },
    });
    persistence.transition('eci-1', TaskRunState.CLAIMED);
    persistence.transition('eci-1', TaskRunState.WAITING);

    const engine = new TaskEngine(makeOpts(store));

    // First tick: window not yet open → stays WAITING
    await engine.tick();
    expect(persistence.getByRequestId('eci-1')!.state).toBe(TaskRunState.WAITING);

    // Advance the clock past windowStartTs and tick again
    vi.setSystemTime(baseNow + 5_000);
    await engine.tick();

    const after = persistence.getByRequestId('eci-1')!;
    // WAITING → PRE_SNAPSHOT (then takePreSnapshot → RUNNING then re-dispatched
    // to runImpl which throws NotImplementedError → FAILED — but in any case
    // the intent has advanced past WAITING).
    expect(after.state).not.toBe(TaskRunState.WAITING);
  });
});

// ── Canary blocker: one long run must not starve later in-flight tasks ───────

describe('runTickLoop schedules other in-flight tasks while a harness is still running', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => { store.close(); });

  it('does not wait for a long RUNNING task before processing a later WAITING task', async () => {
    const now = Date.now();
    const longRelease = deferred<Solution>();
    const longStarted = deferred<'long-started'>();
    const laterStarted = deferred<'later-started'>();
    const impl: Harness = {
      name: 'nonblocking-test-impl',
      version: '0.0.1',
      supports: () => true,
      async run(ctx) {
        if (ctx.requestId === 'long-running') {
          longStarted.resolve('long-started');
          return longRelease.promise;
        }
        laterStarted.resolve('later-started');
        return testSolution();
      },
    };

    const opts: TaskEngineOptions = {
      ...makeOpts(store, { findFor: () => impl }),
    };
    const engine = new TaskEngine(opts);
    const persistence = new TaskRunPersistence(store.db);

    const longWorkingDir = join(engTestRoot, 'work', 'long-running');
    const longImplStateDir = join(engTestRoot, 'impl', 'nonblocking-test-impl', 'portfolio_v0');
    mkdirSync(longWorkingDir, { recursive: true });
    mkdirSync(longImplStateDir, { recursive: true });

    persistence.insertDiscovered({
      requestId: 'long-running',
      taskCid: 'cid-long-running',
      onchainCreationTx: '0xlong',
      onchainCreationBlock: 10,
      solverType: 'portfolio.v0',
      windowStartTs: now - 1_000,
      windowEndTs: now + 86_400_000,
      task: fullTask('long-running', now - 1_000, now + 86_400_000),
    });
    persistence.transition('long-running', TaskRunState.CLAIMED);
    persistence.transition('long-running', TaskRunState.WAITING);
    persistence.transition('long-running', TaskRunState.PRE_SNAPSHOT);
    persistence.transition('long-running', TaskRunState.RUNNING, {
      workingDir: longWorkingDir,
      implStateDir: longImplStateDir,
      preSnapshotCapturedAt: now,
      preSnapshotPayload: { provisioned: true },
    });

    const loop = engine.runTickLoop(5);
    await expect(Promise.race([longStarted.promise, timeout(300, 'timeout' as const)]))
      .resolves.toBe('long-started');

    persistence.insertDiscovered({
      requestId: 'later-waiting',
      taskCid: 'cid-later-waiting',
      onchainCreationTx: '0xlater',
      onchainCreationBlock: 11,
      solverType: 'portfolio.v0',
      windowStartTs: now - 1_000,
      windowEndTs: now + 86_400_000,
      task: fullTask('later-waiting', now - 1_000, now + 86_400_000),
    });
    persistence.transition('later-waiting', TaskRunState.CLAIMED);
    persistence.transition('later-waiting', TaskRunState.WAITING);

    await expect(Promise.race([laterStarted.promise, timeout(500, 'timeout' as const)]))
      .resolves.toBe('later-started');

    engine.stop();
    longRelease.resolve(testSolution());
    await Promise.race([loop, timeout(500, undefined)]);
  });
});
