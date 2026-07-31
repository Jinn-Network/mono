import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../../../src/store/store.js';
import { TaskEngine } from '../../../src/harnesses/engine/engine.js';
import type { PersistedTaskRun, PersistedTaskRunInput } from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import type { Harness, Solution, ReadyStatus } from '../../../src/harnesses/types.js';

function stubImpl(
  overrides: Partial<Harness> & {
    isReady?: (ctx?: { solverType: string; role?: 'restoration' | 'evaluation' }) => Promise<ReadyStatus>;
  } = {},
): Harness {
  return {
    name: 'stub-impl',
    version: '1.0.0',
    supports: () => true,
    run: async (): Promise<Solution> => ({ venueRef: { name: 'stub' }, gating: {} }),
    ...overrides,
  };
}

function makeInput(id = 'req-gate'): PersistedTaskRunInput {
  const now = Date.now();
  return {
    requestId: id,
    taskCid: 'bafy',
    onchainCreationTx: '0xtx' as `0x${string}`,
    onchainCreationBlock: 1,
    solverType: 'portfolio.v0',
    windowStartTs: now + 1000,
    windowEndTs: now + 60_000,
    task: { id, description: 'test' },
  };
}

class TestEngine extends TaskEngine {
  async callClaim(intent: PersistedTaskRun): Promise<void> {
    return this.claim(intent);
  }
  get db(): import('../../../src/harnesses/engine/persistence.js').TaskRunPersistence {
    return this.persistence;
  }
}

describe('TaskEngine.claim — impl gate', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-claim-gate-'));
    store = new Store(join(dir, 'jinn.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to claim when no impl is registered for the intent\'s kind', async () => {
    const engine = new TestEngine({
      store,
      paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
      implRegistry: { findFor: () => undefined },
    });
    const input = makeInput();
    engine.db.insertDiscovered(input);

    const persisted = engine.db.getByRequestId(input.requestId)!;
    await expect(engine.callClaim(persisted)).rejects.toThrow(/no Harness registered or enabled/);
    const after = engine.db.getByRequestId(input.requestId)!;
    expect(after.state).toBe(TaskRunState.FAILED);
    expect(after.failureReason).toMatch(/jinn solver-nets set-harness <name> <harness>/);
  });

  it('refuses to claim when impl reports not-ready', async () => {
    const notReadyImpl = stubImpl({
      isReady: async (ctx) => {
        expect(ctx).toEqual({ solverType: 'portfolio.v0', role: 'restoration' });
        return {
          ready: false,
          reason: 'api-wallet not approved',
          nextStep: { description: 'do the thing', cli: 'jinn solver-nets enable portfolio --confirm-approved' },
        };
      },
    });
    const engine = new TestEngine({
      store,
      paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
      implRegistry: { findFor: () => notReadyImpl },
    });
    const input = makeInput();
    engine.db.insertDiscovered(input);

    const persisted = engine.db.getByRequestId(input.requestId)!;
    await expect(engine.callClaim(persisted)).rejects.toThrow(/not ready/);
    const after = engine.db.getByRequestId(input.requestId)!;
    expect(after.state).toBe(TaskRunState.FAILED);
    expect(after.failureReason).toMatch(/api-wallet not approved/);
    expect(after.failureReason).toMatch(/jinn solver-nets enable portfolio --confirm-approved/);
  });

  it('proceeds with claim when impl is registered and ready', async () => {
    const readyImpl = stubImpl({ isReady: async () => ({ ready: true }) });
    const engine = new TestEngine({
      store,
      paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
      implRegistry: { findFor: () => readyImpl },
    });
    const input = makeInput();
    engine.db.insertDiscovered(input);

    const persisted = engine.db.getByRequestId(input.requestId)!;
    await engine.callClaim(persisted);
    const after = engine.db.getByRequestId(input.requestId)!;
    expect(after.state).toBe(TaskRunState.CLAIMED);
  });

  // Cutover stage 1 (docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md Task 16):
  // canAcceptTask({ taskRole: 'restoration', ... }) is now always refused before this
  // in-flight gate runs (see test/daemon/solution-path-retired.test.ts). The gate itself is
  // unchanged and still reachable for taskRole: 'evaluation' — this probe moved there so the
  // single-flight branch of runnableFailureReason stays covered.
  it('refuses to accept another task for the same solver type and role while one is in flight', async () => {
    const readyImpl = stubImpl({ isReady: async () => ({ ready: true }) });
    const engine = new TestEngine({
      store,
      paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
      implRegistry: { findFor: () => readyImpl },
    });
    const active = makeInput('active-task');
    active.taskRole = 'evaluation';
    active.task = { ...active.task, role: 'evaluation' };
    engine.db.insertDiscovered(active);

    const accept = await engine.canAcceptTask({
      solverType: 'portfolio.v0',
      taskRole: 'evaluation',
      task: { id: 'next-task', description: 'test', solverType: 'portfolio.v0', role: 'evaluation' },
    });

    expect(accept).toEqual({
      ok: false,
      reason: 'another portfolio.v0/evaluation task is already in flight',
    });
  });

  it('allows claiming the current discovered row despite the single-flight gate', async () => {
    const readyImpl = stubImpl({ isReady: async () => ({ ready: true }) });
    const engine = new TestEngine({
      store,
      paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
      implRegistry: { findFor: () => readyImpl },
    });
    const input = makeInput('current-task');
    engine.db.insertDiscovered(input);

    await engine.callClaim(engine.db.getByRequestId(input.requestId)!);

    const after = engine.db.getByRequestId(input.requestId)!;
    expect(after.state).toBe(TaskRunState.CLAIMED);
  });

  it('refuses to claim a discovered row when another run for the same solver type and role is active', async () => {
    const readyImpl = stubImpl({ isReady: async () => ({ ready: true }) });
    const engine = new TestEngine({
      store,
      paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
      implRegistry: { findFor: () => readyImpl },
    });
    const active = makeInput('active-task');
    engine.db.insertDiscovered(active);
    await engine.callClaim(engine.db.getByRequestId(active.requestId)!);

    const next = makeInput('next-task');
    engine.db.insertDiscovered(next);

    await expect(engine.callClaim(engine.db.getByRequestId(next.requestId)!)).rejects.toThrow(
      /another portfolio\.v0\/restoration task is already in flight/,
    );
    expect(engine.db.getByRequestId(next.requestId)!.state).toBe(TaskRunState.FAILED);
  });

  it('does not gate when implRegistry is absent (legacy test-mode path)', async () => {
    const engine = new TestEngine({
      store,
      paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
      // No implRegistry — gate must no-op so raw claim path works.
    });
    const input = makeInput();
    engine.db.insertDiscovered(input);

    const persisted = engine.db.getByRequestId(input.requestId)!;
    await engine.callClaim(persisted);
    const after = engine.db.getByRequestId(input.requestId)!;
    expect(after.state).toBe(TaskRunState.CLAIMED);
  });

  // ── Issue #398: canAcceptTask must not run a per-task blocking probe ─────────
  //
  // canAcceptTask runs once per task announcement on the engine-watcher hot
  // path. impl.isReady() is the only blocking I/O it could hit (the Hermes
  // harness spawns child processes synchronously). The daemon already gates
  // claims O(1) against the cached HarnessReadinessRegistry immediately after
  // canAcceptTask returns, so canAcceptTask must NOT probe isReady() itself.
  //
  // Cutover stage 1 (docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md
  // Task 16): this suite uses taskRole: 'evaluation' — canAcceptTask({ taskRole:
  // 'restoration' }) is now always refused before the skipReadinessProbe branch runs (see
  // test/daemon/solution-path-retired.test.ts). skipReadinessProbe itself is unconditional
  // and unchanged for evaluation.
  describe('canAcceptTask — issue #398 readiness probe', () => {
    it('does NOT invoke impl.isReady() (cached registry gates this downstream)', async () => {
      const isReady = vi.fn(async () => ({ ready: true }) as ReadyStatus);
      const engine = new TestEngine({
        store,
        paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
        implRegistry: { findFor: () => stubImpl({ isReady }) },
      });

      const accept = await engine.canAcceptTask({
        solverType: 'portfolio.v0',
        taskRole: 'evaluation',
        task: { id: 'announced-task', description: 'test', solverType: 'portfolio.v0', role: 'evaluation' },
      });

      expect(accept).toEqual({ ok: true });
      // The expensive per-task readiness probe must never be reached.
      expect(isReady).not.toHaveBeenCalled();
    });

    it('still accepts a task even when the harness would report not-ready (gate is downstream)', async () => {
      // A harness whose isReady() reports not-ready must NOT make
      // canAcceptTask reject — the cached-registry gate in the daemon is the
      // authoritative readiness check on the watcher path.
      const isReady = vi.fn(async () => ({
        ready: false,
        reason: 'would block if probed',
      }) as ReadyStatus);
      const engine = new TestEngine({
        store,
        paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
        implRegistry: { findFor: () => stubImpl({ isReady }) },
      });

      const accept = await engine.canAcceptTask({
        solverType: 'portfolio.v0',
        taskRole: 'evaluation',
        task: { id: 'announced-task', description: 'test', solverType: 'portfolio.v0', role: 'evaluation' },
      });

      expect(accept).toEqual({ ok: true });
      expect(isReady).not.toHaveBeenCalled();
    });

    it('claim() still probes impl.isReady() — the per-claim authoritative gate is unchanged', async () => {
      // Contrast with canAcceptTask: claim() runs once per claimed task (not
      // per announcement) and has no downstream cached-registry gate, so it
      // must keep probing isReady().
      const isReady = vi.fn(async () => ({ ready: true }) as ReadyStatus);
      const engine = new TestEngine({
        store,
        paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
        implRegistry: { findFor: () => stubImpl({ isReady }) },
      });
      const input = makeInput();
      engine.db.insertDiscovered(input);

      await engine.callClaim(engine.db.getByRequestId(input.requestId)!);

      expect(isReady).toHaveBeenCalledTimes(1);
      expect(engine.db.getByRequestId(input.requestId)!.state).toBe(TaskRunState.CLAIMED);
    });
  });

  describe('claim() — onchainCreationTimestamp resolution (#1827)', () => {
    it('resolves and persists the block timestamp via blockTimestamp.getBlockTimestamp on successful claim', async () => {
      const getBlockTimestamp = vi.fn().mockResolvedValue(1752000000);
      const engine = new TestEngine({
        store,
        paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
        implRegistry: { findFor: () => stubImpl({ isReady: async () => ({ ready: true }) }) },
        blockTimestamp: { getBlockTimestamp },
      });
      const input = makeInput('req-createdat-claim-1');
      engine.db.insertDiscovered(input);

      await engine.callClaim(engine.db.getByRequestId(input.requestId)!);

      expect(getBlockTimestamp).toHaveBeenCalledWith(1); // matches makeInput's onchainCreationBlock: 1
      const row = engine.db.getByRequestId(input.requestId)!;
      expect(row.state).toBe(TaskRunState.CLAIMED);
      expect(row.onchainCreationTimestamp).toBe(1752000000);
    });

    it('retries a transient block lookup and persists task.createdAt before advancing', async () => {
      const getBlockTimestamp = vi.fn()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce(1752000001);
      const engine = new TestEngine({
        store,
        paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
        implRegistry: { findFor: () => stubImpl({ isReady: async () => ({ ready: true }) }) },
        blockTimestamp: { getBlockTimestamp },
      });
      const input = makeInput('req-createdat-claim-2');
      engine.db.insertDiscovered(input);

      await engine.callClaim(engine.db.getByRequestId(input.requestId)!);

      const row = engine.db.getByRequestId(input.requestId)!;
      expect(getBlockTimestamp).toHaveBeenCalledTimes(2);
      expect(row.state).toBe(TaskRunState.CLAIMED);
      expect(row.onchainCreationTimestamp).toBe(1752000001);
    });

    it('parks the discovered row when all bounded attempts hit a transient RPC failure', async () => {
      const getBlockTimestamp = vi.fn().mockRejectedValue(new Error('fetch failed'));
      const engine = new TestEngine({
        store,
        paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
        implRegistry: { findFor: () => stubImpl({ isReady: async () => ({ ready: true }) }) },
        blockTimestamp: { getBlockTimestamp },
      });
      const input = makeInput('req-createdat-transient-park');
      engine.db.insertDiscovered(input);

      await expect(engine.process(input.requestId)).rejects.toThrow(
        'authoritative task creation timestamp',
      );

      const row = engine.db.getByRequestId(input.requestId)!;
      expect(getBlockTimestamp).toHaveBeenCalledTimes(3);
      expect(row.state).toBe(TaskRunState.DISCOVERED);
      expect(row.onchainCreationTimestamp).toBeNull();
    });

    it('parks an invalid lookup result and re-resolves it successfully on the next process pass', async () => {
      const getBlockTimestamp = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(1752000002);
      const engine = new TestEngine({
        store,
        paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
        implRegistry: { findFor: () => stubImpl({ isReady: async () => ({ ready: true }) }) },
        blockTimestamp: { getBlockTimestamp },
      });
      const input = makeInput('req-createdat-invalid-park-retry');
      engine.db.insertDiscovered(input);

      await expect(engine.process(input.requestId)).rejects.toMatchObject({
        name: 'TaskCreationTimestampUnavailableError',
      });
      expect(engine.db.getByRequestId(input.requestId)).toMatchObject({
        state: TaskRunState.DISCOVERED,
        onchainCreationTimestamp: null,
      });

      await engine.process(input.requestId);

      expect(getBlockTimestamp).toHaveBeenCalledTimes(4);
      expect(engine.db.getByRequestId(input.requestId)).toMatchObject({
        state: TaskRunState.CLAIMED,
        onchainCreationTimestamp: 1752000002,
      });
    });

    it('redacts configured RPC URL and API-key material from lookup failure logs', async () => {
      const rpcSecret = 'super-secret-rpc-key-123456';
      const rpcUrl = `https://base.example.test/v2/${rpcSecret}`;
      const getBlockTimestamp = vi.fn().mockRejectedValue(
        new Error(`HTTP 401 from ${rpcUrl}; rejected api key ${rpcSecret}`),
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const engine = new TestEngine({
        store,
        paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
        implRegistry: { findFor: () => stubImpl({ isReady: async () => ({ ready: true }) }) },
        blockTimestamp: { getBlockTimestamp, configuredRpcUrls: [rpcUrl] },
      });
      const input = makeInput('req-createdat-redaction');
      engine.db.insertDiscovered(input);

      await expect(
        engine.callClaim(engine.db.getByRequestId(input.requestId)!),
      ).rejects.toThrow('authoritative task creation timestamp');

      const warning = warn.mock.calls.flat().join(' ');
      expect(getBlockTimestamp).toHaveBeenCalledTimes(3);
      expect(warning).not.toContain(rpcUrl);
      expect(warning).not.toContain(rpcSecret);
      expect(warning).toContain('<rpc-');
      warn.mockRestore();
    });

    it('refuses to advance when every bounded lookup returns no authoritative timestamp', async () => {
      const getBlockTimestamp = vi.fn().mockResolvedValue(undefined);
      const engine = new TestEngine({
        store,
        paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
        implRegistry: { findFor: () => stubImpl({ isReady: async () => ({ ready: true }) }) },
        blockTimestamp: { getBlockTimestamp },
      });
      const input = makeInput('req-createdat-claim-3');
      engine.db.insertDiscovered(input);

      await expect(
        engine.callClaim(engine.db.getByRequestId(input.requestId)!),
      ).rejects.toThrow('authoritative task creation timestamp');

      const row = engine.db.getByRequestId(input.requestId)!;
      expect(getBlockTimestamp).toHaveBeenCalledTimes(3);
      expect(row.state).toBe(TaskRunState.DISCOVERED);
      expect(row.onchainCreationTimestamp).toBeNull();
    });

    it('skips createdAt resolution entirely when blockTimestamp dependency is absent (back-compat)', async () => {
      const engine = new TestEngine({
        store,
        paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
        implRegistry: { findFor: () => stubImpl({ isReady: async () => ({ ready: true }) }) },
      });
      const input = makeInput('req-createdat-claim-4');
      engine.db.insertDiscovered(input);

      await engine.callClaim(engine.db.getByRequestId(input.requestId)!);

      const row = engine.db.getByRequestId(input.requestId)!;
      expect(row.state).toBe(TaskRunState.CLAIMED);
      expect(row.onchainCreationTimestamp).toBeNull();
    });
  });
});
