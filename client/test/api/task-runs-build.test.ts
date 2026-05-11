import { describe, expect, it } from 'vitest';
import { gatherTaskRunsStatus } from '../../src/api/task-runs-build.js';
import { TaskRunPersistence } from '../../src/harnesses/engine/persistence.js';
import { withTempStore } from '@test/store.js';

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

      const status = gatherTaskRunsStatus(store);

      expect(status.totals).toEqual({
        observedTasks: 4,
        activeTaskRuns: 1,
        completed: 2,
        solutions: 1,
        verdicts: 1,
        failed: 1,
      });
    });
  });
});

function insertTask(
  persistence: TaskRunPersistence,
  input: {
    requestId: string;
    taskId: string;
    taskRole: 'restoration' | 'evaluation';
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
