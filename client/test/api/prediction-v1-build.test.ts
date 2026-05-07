import { describe, expect, it } from 'vitest';
import { withTempStore } from '@test/store.js';
import { gatherPredictionV1Status } from '../../src/api/prediction-v1-build.js';
import { TaskRunPersistence } from '../../src/harnesses/engine/persistence.js';
import type { Store } from '../../src/store/store.js';

function seedPredictionRun(
  store: Store,
  persistence: TaskRunPersistence,
  input: {
    requestId: string;
    taskId?: string;
    taskRole?: 'restoration' | 'evaluation';
    state?: 'DISCOVERED' | 'COMPLETE' | 'FAILED';
    stateUpdatedAt?: number;
    solverType?: string;
  },
): void {
  persistence.insertDiscovered({
    requestId: input.requestId,
    taskId: input.taskId ?? 'prediction-task-1',
    taskCid: `bafy-${input.requestId}`,
    onchainCreationTx: `0xtx-${input.requestId}`,
    onchainCreationBlock: 1,
    solverType: input.solverType ?? 'prediction.v1',
    taskRole: input.taskRole ?? 'restoration',
    windowStartTs: 1_000,
    windowEndTs: 2_000,
    task: {
      id: input.taskId ?? 'prediction-task-1',
      description: 'prediction test task',
      solverType: input.solverType ?? 'prediction.v1',
      role: input.taskRole ?? 'restoration',
    },
  });
  if (input.state && input.state !== 'DISCOVERED') {
    persistence.markFailed(input.requestId, 'temporary');
    if (input.state === 'COMPLETE') {
      store.db.prepare(
        `UPDATE task_runs
         SET state = 'COMPLETE',
             state_updated_at = ?,
             failure_reason = NULL,
             failure_at = NULL,
             manifest_cid = ?,
             delivery_tx_hash = ?
         WHERE request_id = ?`,
      ).run(input.stateUpdatedAt ?? Date.now(), `bafy-manifest-${input.requestId}`, `0xdelivery-${input.requestId}`, input.requestId);
    } else {
      store.db.prepare(
        `UPDATE task_runs
         SET state_updated_at = ?
         WHERE request_id = ?`,
      ).run(input.stateUpdatedAt ?? Date.now(), input.requestId);
    }
  } else if (input.stateUpdatedAt !== undefined) {
    store.db.prepare(
      `UPDATE task_runs SET state_updated_at = ? WHERE request_id = ?`,
    ).run(input.stateUpdatedAt, input.requestId);
  }
}

describe('gatherPredictionV1Status', () => {
  it('returns empty lifecycle rows when no prediction tasks exist', async () => {
    await withTempStore(async (store) => {
      const result = gatherPredictionV1Status(store);
      expect(result.operator).toBeNull();
      expect(result.totals).toEqual({
        observedTasks: 0,
        activeTaskRuns: 0,
        solutions: 0,
        verdicts: 0,
        failed: 0,
      });
      expect(result.recentTasks).toEqual([]);
    });
  });

  it('counts prediction Tasks, Solutions, Verdicts, and failures from task_runs', async () => {
    await withTempStore(async (store) => {
      const persistence = new TaskRunPersistence(store.db);
      seedPredictionRun(store, persistence, {
        requestId: 'solution-a',
        taskId: 'shared-task',
        state: 'COMPLETE',
        stateUpdatedAt: 10,
      });
      seedPredictionRun(store, persistence, {
        requestId: 'solution-b',
        taskId: 'shared-task',
        state: 'DISCOVERED',
        stateUpdatedAt: 20,
      });
      seedPredictionRun(store, persistence, {
        requestId: 'verdict-a',
        taskId: 'shared-task',
        taskRole: 'evaluation',
        state: 'COMPLETE',
        stateUpdatedAt: 30,
      });
      seedPredictionRun(store, persistence, {
        requestId: 'failed-a',
        taskId: 'other-task',
        state: 'FAILED',
        stateUpdatedAt: 40,
      });
      seedPredictionRun(store, persistence, {
        requestId: 'portfolio-a',
        taskId: 'portfolio-task',
        state: 'COMPLETE',
        stateUpdatedAt: 50,
        solverType: 'portfolio.v0',
      });

      const result = gatherPredictionV1Status(store, {
        operator: {
          kind: 'prediction.v1.operatorStatus',
          ok: true,
          configPath: '/tmp/config.json',
          solverNet: {
            name: 'prediction',
            enabled: true,
            solverType: 'prediction.v1',
            roles: ['solving'],
            harness: 'prediction-v1-baseline',
            taskGeneratorEnabled: true,
          },
          runtimePlugins: [],
          diagnostics: [],
          nextAction: { description: 'Run', cli: 'jinn run' },
        },
      });

      expect(result.operator?.ok).toBe(true);
      expect(result.totals).toEqual({
        observedTasks: 2,
        activeTaskRuns: 1,
        solutions: 1,
        verdicts: 1,
        failed: 1,
      });
      expect(result.latest).toEqual({
        taskAt: 40,
        solutionAt: 10,
        verdictAt: 30,
      });
      expect(result.recentTasks.map((task) => task.requestId)).toEqual([
        'failed-a',
        'verdict-a',
        'solution-b',
        'solution-a',
      ]);
      expect(result.recentSolutions[0]).toMatchObject({
        requestId: 'solution-a',
        taskRole: 'restoration',
        manifestCid: 'bafy-manifest-solution-a',
      });
      expect(result.recentVerdicts[0]).toMatchObject({
        requestId: 'verdict-a',
        taskRole: 'evaluation',
      });
    });
  });
});
