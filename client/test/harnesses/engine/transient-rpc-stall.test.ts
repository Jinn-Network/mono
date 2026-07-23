import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Store } from '../../../src/store/store.js';
import {
  TaskEngine,
  TRANSIENT_TICK_ERROR_HEARTBEAT_MS,
  type TaskEngineOptions,
} from '../../../src/harnesses/engine/engine.js';
import {
  TaskRunPersistence,
  type PersistedTaskRun,
  type PersistedTaskRunInput,
} from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import { recoverInFlight } from '../../../src/harnesses/engine/recovery.js';
import { AllRpcsFailedError } from '../../../src/rpc/transport.js';
import { gatherTaskRunsStatus } from '../../../src/api/task-runs-build.js';

/**
 * Regression test for #912 / #934: a transient transport error
 * (AllRpcsFailedError — every provider in the L2 fallback chain failed at
 * once) was stamping the in-flight task FAILED, dropping it from
 * getInFlight() permanently so the next tick never re-drove it. L2 work went
 * silent until a manual restart.
 *
 * Expected behaviour after #912:
 *  - A transport-transient error on a task whose delivery window is still
 *    open leaves the row in its in-flight state (DELIVERING) so the next
 *    tick re-drives it; it does NOT land in FAILED.
 *  - A `tick_error` (outcome 'warn') event is emitted instead of inflating
 *    the FAILED counter.
 *  - After the RPCs recover, the SAME engine (no restart) drives the row to
 *    COMPLETE.
 *  - A genuine (non-transient) error still lands in FAILED (guard).
 *  - A transient error on a task whose window has already passed still
 *    terminalizes FAILED (guard against infinite churn).
 *
 * Expected behaviour after #934:
 *  - Transient `tick_error` warn emits for a given requestId are bounded to
 *    first occurrence + a 5-minute heartbeat (not one per failing tick).
 */

function makeOpts(store: Store): TaskEngineOptions {
  return {
    store,
    paths: { workingDirRoot: '/tmp/work', implStateDirRoot: '/tmp/impl' },
  };
}

function makeInput(
  id: string,
  overrides: Partial<PersistedTaskRunInput> = {},
): PersistedTaskRunInput {
  const now = Date.now();
  return {
    requestId: id,
    taskCid: `bafycid-${id}`,
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 100,
    windowStartTs: now - 10_000,
    windowEndTs: now + 86_400_000,
    task: {
      id,
      description: 'test',
      solverType: 'swe-rebench-v2.v1',
      role: 'evaluation',
    },
    ...overrides,
  };
}

function allRpcsFailed(): AllRpcsFailedError {
  return new AllRpcsFailedError(['rpc-a.example', 'rpc-b.example']);
}

function countTickErrors(store: Store, requestId: string): number {
  return store
    .getRecentActivityEvents(200)
    .filter((e) => e.kind === 'tick_error' && e.requestId === requestId)
    .length;
}

/**
 * Engine subclass that lets the test inject the error `deliver()` should throw,
 * and clear it to simulate RPC recovery. The DELIVERING row is pre-positioned
 * via the persistence transition sequence, so only the deliver path is touched.
 */
class FailingEngine extends TaskEngine {
  deliverError: Error | null = null;

  get testPersistence(): TaskRunPersistence {
    return this.persistence;
  }

  override async deliver(task: PersistedTaskRun): Promise<void> {
    if (this.deliverError) throw this.deliverError;
    // RPC recovered — drive the row to terminal COMPLETE as the real
    // deliver path would after a successful delivery.
    this.persistence.transition(task.requestId, TaskRunState.COMPLETE);
  }
}

function seedDelivering(
  p: TaskRunPersistence,
  id: string,
  overrides: Partial<PersistedTaskRunInput> = {},
): void {
  p.insertDiscovered(makeInput(id, overrides));
  p.transition(id, TaskRunState.CLAIMED);
  p.transition(id, TaskRunState.WAITING);
  p.transition(id, TaskRunState.PRE_SNAPSHOT);
  p.transition(id, TaskRunState.RUNNING);
  p.transition(id, TaskRunState.POST_SNAPSHOT);
  p.transition(id, TaskRunState.PACKAGING);
  p.transition(id, TaskRunState.DELIVERING);
}

describe('transient RPC stall (#912)', () => {
  let store: Store;
  let engine: FailingEngine;
  let p: TaskRunPersistence;

  beforeEach(() => {
    store = new Store(':memory:');
    engine = new FailingEngine(makeOpts(store));
    p = engine.testPersistence;
  });

  afterEach(() => {
    store.close();
  });

  it('does not terminalize on AllRpcsFailedError and resumes after recovery (no restart)', async () => {
    seedDelivering(p, 'r-transient');
    engine.deliverError = allRpcsFailed();

    // Three consecutive ticks during the outage. process() still re-throws the
    // original error (documented contract), but the row must stay DELIVERING,
    // remain in getInFlight(), and never inflate the FAILED counter.
    for (let i = 0; i < 3; i++) {
      await expect(engine.process('r-transient')).rejects.toThrow(
        /All RPC providers in the fallback chain failed/,
      );

      const row = p.getByRequestId('r-transient')!;
      expect(row.state).toBe(TaskRunState.DELIVERING);

      const inFlight = p.getInFlight().map((t) => t.requestId);
      expect(inFlight).toContain('r-transient');

      const status = gatherTaskRunsStatus(store.taskRunReadModel());
      expect(status.totals.failed).toBe(0);
      expect(status.totals.raceLost).toBe(0);
    }

    // #934: three same-clock-window transient ticks → exactly one tick_error
    expect(countTickErrors(store, 'r-transient')).toBe(1);
    const firstWarn = store
      .getRecentActivityEvents(50)
      .find((e) => e.kind === 'tick_error' && e.requestId === 'r-transient');
    expect(firstWarn?.outcome).toBe('warn');

    // RPCs recover — the SAME engine instance drives the row to COMPLETE
    // without any restart.
    engine.deliverError = null;
    await engine.process('r-transient');

    const row = p.getByRequestId('r-transient')!;
    expect(row.state).toBe(TaskRunState.COMPLETE);

    const status = gatherTaskRunsStatus(store.taskRunReadModel());
    expect(status.totals.failed).toBe(0);
    expect(status.totals.completed).toBe(1);
  });

  it('recovery path also leaves a transient-failing row in-flight (not FAILED)', async () => {
    seedDelivering(p, 'r-recover-transient');
    engine.deliverError = allRpcsFailed();

    await recoverInFlight(engine);

    const row = p.getByRequestId('r-recover-transient')!;
    expect(row.state).toBe(TaskRunState.DELIVERING);

    const status = gatherTaskRunsStatus(store.taskRunReadModel());
    expect(status.totals.failed).toBe(0);
    expect(status.totals.raceLost).toBe(0);
  });

  it('a genuine (non-transient) error still lands in FAILED', async () => {
    seedDelivering(p, 'r-genuine');
    engine.deliverError = new Error('runner crashed mid-deliver');

    await expect(engine.process('r-genuine')).rejects.toThrow(
      /runner crashed mid-deliver/,
    );

    const row = p.getByRequestId('r-genuine')!;
    expect(row.state).toBe(TaskRunState.FAILED);

    const status = gatherTaskRunsStatus(store.taskRunReadModel());
    expect(status.totals.failed).toBe(1);
  });

  it('a transient error on a task whose window has passed still terminalizes', async () => {
    const now = Date.now();
    seedDelivering(p, 'r-past-window', {
      windowStartTs: now - 200_000,
      windowEndTs: now - 100_000,
    });
    engine.deliverError = allRpcsFailed();

    await expect(engine.process('r-past-window')).rejects.toThrow(
      /All RPC providers in the fallback chain failed/,
    );

    const row = p.getByRequestId('r-past-window')!;
    expect(row.state).toBe(TaskRunState.FAILED);

    const status = gatherTaskRunsStatus(store.taskRunReadModel());
    expect(status.totals.failed).toBe(1);
  });

  it('emits at most one tick_error across N consecutive transient ticks for the same requestId (#934)', async () => {
    const id = 'r-bound-n';
    seedDelivering(p, id);
    engine.deliverError = allRpcsFailed();

    const N = 10;
    for (let i = 0; i < N; i++) {
      await expect(engine.process(id)).rejects.toThrow(
        /All RPC providers in the fallback chain failed/,
      );
      expect(p.getByRequestId(id)!.state).toBe(TaskRunState.DELIVERING);
    }

    expect(countTickErrors(store, id)).toBe(1);

    const status = gatherTaskRunsStatus(store.taskRunReadModel());
    expect(status.totals.failed).toBe(0);
  });

  it('after a successful process, a new transient on the same requestId emits immediately again (#934)', async () => {
    const id = 'r-clear-same';
    seedDelivering(p, id);
    engine.deliverError = allRpcsFailed();

    await expect(engine.process(id)).rejects.toThrow(/All RPC providers/);
    await expect(engine.process(id)).rejects.toThrow(/All RPC providers/);
    expect(countTickErrors(store, id)).toBe(1);

    engine.deliverError = null;
    await engine.process(id);
    expect(p.getByRequestId(id)!.state).toBe(TaskRunState.COMPLETE);

    // Test-only: drop terminal row so we can re-seed the same requestId.
    store.db.prepare('DELETE FROM task_runs WHERE request_id = ?').run(id);
    seedDelivering(p, id);
    engine.deliverError = allRpcsFailed();
    await expect(engine.process(id)).rejects.toThrow(/All RPC providers/);

    // Without clear-on-success the Map still holds `id` → count stays 1.
    // With clear → second outage's first emit makes count 2.
    expect(countTickErrors(store, id)).toBe(2);
  });

  it('emits a second tick_error after the heartbeat window elapses (#934)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-23T12:00:00.000Z'));

    try {
      const id = 'r-heartbeat';
      seedDelivering(p, id);
      engine.deliverError = allRpcsFailed();

      await expect(engine.process(id)).rejects.toThrow(/All RPC providers/);
      expect(countTickErrors(store, id)).toBe(1);

      await expect(engine.process(id)).rejects.toThrow(/All RPC providers/);
      expect(countTickErrors(store, id)).toBe(1);

      vi.advanceTimersByTime(TRANSIENT_TICK_ERROR_HEARTBEAT_MS);

      await expect(engine.process(id)).rejects.toThrow(/All RPC providers/);
      expect(countTickErrors(store, id)).toBe(2);

      expect(p.getByRequestId(id)!.state).toBe(TaskRunState.DELIVERING);
      expect(gatherTaskRunsStatus(store.taskRunReadModel()).totals.failed).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
