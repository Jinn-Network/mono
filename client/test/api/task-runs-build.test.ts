import { describe, expect, it } from 'vitest';
import { gatherTaskRunsStatus, applyOutcomes, type TaskRunSummary } from '../../src/api/task-runs-build.js';
import { TaskRunPersistence } from '../../src/harnesses/engine/persistence.js';
import type { VerdictTallyResult } from '../../src/archive/types.js';
import { withTempStore } from '@test/store.js';

function makeSummary(overrides: Partial<TaskRunSummary>): TaskRunSummary {
  return {
    requestId: 'req',
    taskId: 'task-1',
    taskCid: 'bafy',
    solverType: 'swe-rebench-v2.v1',
    state: 'COMPLETE',
    taskRole: 'restoration',
    implName: null,
    windowStartTs: 1_000,
    windowEndTs: 2_000,
    runStartedAt: null,
    stateUpdatedAt: 3_000,
    manifestCid: null,
    deliveryTxHash: null,
    failureReason: null,
    outcome: null,
    ...overrides,
  };
}

describe('gatherTaskRunsStatus', () => {
  it('splits completed generic task runs into solution and verdict totals', async () => {
    await withTempStore(async (store) => {
      const persistence = new TaskRunPersistence(store.db);
      insertTask(persistence, {
        requestId: 'restoration-complete',
        taskId: 'task-1',
        taskRole: 'restoration',
      });
      insertTask(persistence, {
        requestId: 'evaluation-complete',
        taskId: 'task-2',
        taskRole: 'evaluation',
      });
      insertTask(persistence, {
        requestId: 'restoration-running',
        taskId: 'task-3',
        taskRole: 'restoration',
      });
      insertTask(persistence, {
        requestId: 'evaluation-failed',
        taskId: 'task-4',
        taskRole: 'evaluation',
      });

      store.db.prepare(`UPDATE task_runs SET state = 'COMPLETE', state_updated_at = ? WHERE request_id = ?`)
        .run(2_000, 'restoration-complete');
      store.db.prepare(`UPDATE task_runs SET state = 'COMPLETE', state_updated_at = ? WHERE request_id = ?`)
        .run(3_000, 'evaluation-complete');
      store.db.prepare(`UPDATE task_runs SET state = 'RUNNING', state_updated_at = ? WHERE request_id = ?`)
        .run(4_000, 'restoration-running');
      store.db.prepare(`UPDATE task_runs SET state = 'FAILED', state_updated_at = ?, failure_reason = ? WHERE request_id = ?`)
        .run(5_000, 'boom', 'evaluation-failed');

      const status = gatherTaskRunsStatus(store.taskRunReadModel());

      expect(status.totals).toEqual({
        observedTasks: 4,
        activeTaskRuns: 1,
        completed: 2,
        solutions: 1,
        verdicts: 1,
        failed: 1,
        settledFailed: 0,
        localErrors: 1,
        raceLost: 0,
      });
    });
  });

  it('counts RACE_LOST runs separately from FAILED (#896)', async () => {
    await withTempStore(async (store) => {
      const persistence = new TaskRunPersistence(store.db);
      insertTask(persistence, {
        requestId: 'pruned',
        taskId: 'task-pruned',
        taskRole: 'evaluation',
      });
      insertTask(persistence, {
        requestId: 'genuine-fail',
        taskId: 'task-fail',
        taskRole: 'evaluation',
      });

      store.db.prepare(`UPDATE task_runs SET state = 'RACE_LOST', state_updated_at = ?, failure_reason = ? WHERE request_id = ?`)
        .run(1_500, 'TCMaxVerdictsReached', 'pruned');
      store.db.prepare(`UPDATE task_runs SET state = 'FAILED', state_updated_at = ?, failure_reason = ? WHERE request_id = ?`)
        .run(1_600, 'runner crashed', 'genuine-fail');

      const status = gatherTaskRunsStatus(store.taskRunReadModel());

      expect(status.totals.failed).toBe(1);
      expect(status.totals.raceLost).toBe(1);
      // The pruned row is in recentTasks for operator audit.
      const requestIds = status.recentTasks.map((r) => r.requestId);
      expect(requestIds).toContain('pruned');
      expect(requestIds).toContain('genuine-fail');
    });
  });

  it('splits FAILED runs into on-chain settled failures and local engine errors', async () => {
    await withTempStore(async (store) => {
      const persistence = new TaskRunPersistence(store.db);
      // local error: failed before reaching the marketplace (no delivery tx).
      insertTask(persistence, {
        requestId: 'local-error',
        taskId: 'task-local',
        taskRole: 'restoration',
      });
      // settled failure: delivery tx landed on-chain but the run terminated FAILED.
      insertTask(persistence, {
        requestId: 'settled-fail',
        taskId: 'task-settled',
        taskRole: 'restoration',
      });
      // settled failure for an evaluation run — same split logic applies.
      insertTask(persistence, {
        requestId: 'settled-fail-eval',
        taskId: 'task-settled-eval',
        taskRole: 'evaluation',
      });

      store.db
        .prepare(
          `UPDATE task_runs
             SET state = 'FAILED', state_updated_at = ?, failure_reason = ?
             WHERE request_id = ?`,
        )
        .run(1_100, 'SkippableError', 'local-error');
      store.db
        .prepare(
          `UPDATE task_runs
             SET state = 'FAILED', state_updated_at = ?, failure_reason = ?, delivery_tx_hash = ?
             WHERE request_id = ?`,
        )
        .run(1_200, 'claimDelivery reverted', '0xdeadbeef', 'settled-fail');
      store.db
        .prepare(
          `UPDATE task_runs
             SET state = 'FAILED', state_updated_at = ?, failure_reason = ?, delivery_tx_hash = ?
             WHERE request_id = ?`,
        )
        .run(1_300, 'verdict rejected', '0xfeedface', 'settled-fail-eval');

      const status = gatherTaskRunsStatus(store.taskRunReadModel());

      expect(status.totals.failed).toBe(3);
      expect(status.totals.settledFailed).toBe(2);
      expect(status.totals.localErrors).toBe(1);
    });
  });

  it('includes runStartedAt in task run summaries distinct from windowStartTs', async () => {
    await withTempStore(async (store) => {
      const persistence = new TaskRunPersistence(store.db);
      insertTask(persistence, {
        requestId: 'fresh-claim',
        taskId: 'task-fresh',
        taskRole: 'restoration',
        runStartedAt: 10_000,
      });

      const status = gatherTaskRunsStatus(store.taskRunReadModel());

      expect(status.inFlight[0]).toMatchObject({
        requestId: 'fresh-claim',
        windowStartTs: 1_000,
        runStartedAt: 10_000,
      });
    });
  });

  it('seeds outcome to null in toSummary (base shape stays stable)', async () => {
    await withTempStore(async (store) => {
      const persistence = new TaskRunPersistence(store.db);
      insertTask(persistence, { requestId: 'r', taskId: 'task-r', taskRole: 'restoration' });
      const status = gatherTaskRunsStatus(store.taskRunReadModel());
      expect(status.inFlight[0]?.outcome).toBeNull();
    });
  });
});

describe('applyOutcomes', () => {
  const tally = (pass: number, fail: number): VerdictTallyResult => ({ pass, fail });

  it('derives fail for a COMPLETE solve run with a majority-fail tally', () => {
    const runs = [makeSummary({ taskId: 'task-1', state: 'COMPLETE', taskRole: 'restoration' })];
    applyOutcomes(runs, new Map([['task-1', tally(0, 2)]]));
    expect(runs[0]!.outcome).toBe('fail');
  });

  it('derives pass for a COMPLETE solve run with a majority-pass tally', () => {
    const runs = [makeSummary({ taskId: 'task-1', state: 'COMPLETE', taskRole: 'restoration' })];
    applyOutcomes(runs, new Map([['task-1', tally(3, 0)]]));
    expect(runs[0]!.outcome).toBe('pass');
  });

  it('derives awaiting for a COMPLETE solve run with no matching tally', () => {
    const runs = [makeSummary({ taskId: 'task-1', state: 'COMPLETE', taskRole: 'restoration' })];
    applyOutcomes(runs, new Map());
    expect(runs[0]!.outcome).toBe('awaiting');
  });

  it('leaves outcome null for a non-COMPLETE (FAILED) run', () => {
    const runs = [makeSummary({ taskId: 'task-1', state: 'FAILED', taskRole: 'restoration' })];
    applyOutcomes(runs, new Map([['task-1', tally(0, 2)]]));
    expect(runs[0]!.outcome).toBeNull();
  });

  it('defers evaluation runs to awaiting (operator-verdict join is a follow-up)', () => {
    const runs = [makeSummary({ taskId: 'task-1', state: 'COMPLETE', taskRole: 'evaluation' })];
    applyOutcomes(runs, new Map([['task-1', tally(3, 0)]]));
    expect(runs[0]!.outcome).toBe('awaiting');
  });
});

function insertTask(
  persistence: TaskRunPersistence,
  input: {
    requestId: string;
    taskId: string;
    taskRole: 'restoration' | 'evaluation';
    runStartedAt?: number;
  },
): void {
  persistence.insertDiscovered({
    requestId: input.requestId,
    taskId: input.taskId,
    taskCid: `bafy-${input.requestId}`,
    onchainCreationTx: '0xabc',
    onchainCreationBlock: 1,
    solverType: 'swe-rebench-v2.v1',
    taskRole: input.taskRole,
    runStartedAt: input.runStartedAt,
    windowStartTs: 1_000,
    windowEndTs: 2_000,
    task: {
      id: input.taskId,
      description: input.taskId,
      solverType: 'swe-rebench-v2.v1',
      role: input.taskRole,
    },
  });
}
