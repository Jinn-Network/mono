import { describe, expect, it } from 'vitest';
import { withTempStore } from '@test/store.js';
import { gatherPredictionV1Status } from '../../src/api/prediction-v1-build.js';
import type { Store } from '../../src/store/store.js';
import { patchNativeRun, seedNativeRun } from '@test/seed-native-run.js';

function seedPredictionRun(
  store: Store,
  input: {
    requestId: string;
    taskId?: string;
    taskRole?: 'restoration' | 'evaluation';
    state?: 'DISCOVERED' | 'COMPLETE' | 'FAILED';
    stateUpdatedAt?: number;
    solverType?: string;
    runStartedAt?: number;
  },
): void {
  const solverType = input.solverType ?? 'prediction.v1';
  seedNativeRun(store, {
    requestId: input.requestId,
    taskId: input.taskId ?? 'prediction-task-1',
    taskCid: `bafy-${input.requestId}`,
    solverType,
    taskRole: input.taskRole ?? 'restoration',
    runStartedAt: input.runStartedAt,
    windowStartTs: 1_000,
    windowEndTs: 2_000,
    state: input.state ?? 'DISCOVERED',
    stateUpdatedAt: input.stateUpdatedAt,
    manifestCid: input.state === 'COMPLETE' ? `bafy-manifest-${input.requestId}` : undefined,
    deliveryTxHash: input.state === 'COMPLETE' ? `0xdelivery-${input.requestId}` : undefined,
    failureReason: input.state === 'FAILED' ? 'temporary' : undefined,
    task: {
      id: input.taskId ?? 'prediction-task-1',
      description: 'prediction test task',
      solverType,
      role: input.taskRole ?? 'restoration',
    },
  });
}

describe('gatherPredictionV1Status', () => {
  it('returns empty lifecycle rows when no prediction tasks exist', async () => {
    await withTempStore(async (store) => {
      const result = gatherPredictionV1Status(store.taskRunReadModel());
      expect(result.operator).toBeNull();
      expect(result.totals).toEqual({
        observedTasks: 0,
        activeTaskRuns: 0,
        solutions: 0,
        verdicts: 0,
        failed: 0,
        settledFailed: 0,
        localErrors: 0,
        raceLost: 0,
      });
      expect(result.recentTasks).toEqual([]);
    });
  });

  it('counts prediction Tasks, Solutions, Verdicts, and failures from the native read model', async () => {
    await withTempStore(async (store) => {
      seedPredictionRun(store, {
        requestId: 'solution-a',
        taskId: 'shared-task',
        state: 'COMPLETE',
        stateUpdatedAt: 10,
      });
      seedPredictionRun(store, {
        requestId: 'solution-b',
        taskId: 'shared-task',
        state: 'DISCOVERED',
        stateUpdatedAt: 20,
      });
      seedPredictionRun(store, {
        requestId: 'verdict-a',
        taskId: 'shared-task',
        taskRole: 'evaluation',
        state: 'COMPLETE',
        stateUpdatedAt: 30,
      });
      seedPredictionRun(store, {
        requestId: 'failed-a',
        taskId: 'other-task',
        state: 'FAILED',
        stateUpdatedAt: 40,
      });
      seedPredictionRun(store, {
        requestId: 'portfolio-a',
        taskId: 'portfolio-task',
        state: 'COMPLETE',
        stateUpdatedAt: 50,
        solverType: 'portfolio.v0',
      });

      const result = gatherPredictionV1Status(store.taskRunReadModel(), {
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
        settledFailed: 0,
        localErrors: 1,
        raceLost: 0,
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

  it('splits FAILED prediction runs into settled fails and local errors via delivery_tx_hash', async () => {
    await withTempStore(async (store) => {
      // Local engine error: no delivery tx ever landed.
      seedPredictionRun(store, {
        requestId: 'local-error',
        taskId: 'task-local',
        state: 'FAILED',
        stateUpdatedAt: 100,
      });
      // Settled failure: delivery tx landed on-chain before the run failed.
      seedPredictionRun(store, {
        requestId: 'settled-fail',
        taskId: 'task-settled',
        state: 'FAILED',
        stateUpdatedAt: 200,
      });
      patchNativeRun(store, 'settled-fail', { deliveryTxHash: '0xdeadbeef' });

      const result = gatherPredictionV1Status(store.taskRunReadModel());

      expect(result.totals.failed).toBe(2);
      expect(result.totals.settledFailed).toBe(1);
      expect(result.totals.localErrors).toBe(1);
    });
  });

  it('keeps prediction rows when solver_type is missing but task_payload still identifies the net', async () => {
    await withTempStore(async (store) => {
      seedPredictionRun(store, {
        requestId: 'canonical-prediction',
        taskId: 'prediction-canonical-task',
      });
      patchNativeRun(store, 'canonical-prediction', {
        solverType: null,
        task: {
          id: 'prediction-canonical-task',
          description: 'prediction test task',
          contractId: 'prediction',
          contractVersion: 'v1',
          role: 'restoration',
        },
      });

      seedPredictionRun(store, {
        requestId: 'legacy-prediction',
        taskId: 'prediction-legacy-task',
        state: 'FAILED',
        stateUpdatedAt: 25,
      });
      patchNativeRun(store, 'legacy-prediction', {
        solverType: null,
        task: {
          id: 'prediction-legacy-task',
          description: 'prediction test task',
          solverType: 'prediction.v1',
          role: 'restoration',
        },
      });

      const result = gatherPredictionV1Status(store.taskRunReadModel());

      expect(result.totals.observedTasks).toBe(2);
      expect(result.totals.activeTaskRuns).toBe(1);
      expect(result.totals.failed).toBe(1);
      expect(result.recentTasks.map((task) => task.requestId)).toEqual(
        expect.arrayContaining(['canonical-prediction', 'legacy-prediction']),
      );
    });
  });

  it('includes runStartedAt in prediction task summaries', async () => {
    await withTempStore(async (store) => {
      seedPredictionRun(store, {
        requestId: 'recent-prediction-claim',
        taskId: 'prediction-recent-task',
        runStartedAt: 50_000,
        stateUpdatedAt: 60_000,
      });

      const result = gatherPredictionV1Status(store.taskRunReadModel());

      expect(result.recentTasks[0]).toMatchObject({
        requestId: 'recent-prediction-claim',
        windowStartTs: 1_000,
        runStartedAt: 50_000,
      });
    });
  });
});
