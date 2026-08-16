import { describe, expect, it } from 'vitest';
import { withTempStore } from '@test/store.js';
import type { Store } from '@/store/store.js';
import { NativeTaskRunReadModel } from '@/store/native-task-run-read-model.js';
import { NATIVE_EVALUATOR_STATE_SCHEMA } from '@/daemon/native-evaluator-state.js';
import { gatherTaskRunsStatus, type TaskRunsStatus } from '@/api/task-runs-build.js';

/**
 * One-swap R1 (umbrella #2461) — GOLDEN WIRE-SHAPE proof.
 *
 * A fixed native seed produces an exact `TaskRunsStatus` wire object (the
 * shape the SPA's `status.taskRuns` reads). Pinned so a future mapping change
 * that would move the wire shape fails loudly. Stage 5 deleted the dual-read:
 * `taskRunReadModel()` is always the native read model.
 */

function seedNative(store: Store): void {
  store.db.exec(NATIVE_EVALUATOR_STATE_SCHEMA);
  store.db
    .prepare(
      `INSERT INTO native_engagements
        (engagement_id, chain_id, coordinator, task_id, role, operator_agent, task_digest,
         submission_uri, submission_digest, state, attempt_index, attempt_uri, request_id,
         policy_json, capability_json, created_at, updated_at)
       VALUES ('eng-1', '84532', '0xcoord', '301', 'solver', '0xop', 'sha256:${'a'.repeat(64)}',
               'urn:uuid:00000000-0000-0000-0000-000000000001', 'sha256:${'b'.repeat(64)}',
               'solution-settled', 0, NULL, '0xreq1', '{}', '{}',
               '2026-08-01T00:00:02.000Z', '2026-08-01T00:00:05.000Z')`,
    )
    .run();
  store.db
    .prepare(
      `INSERT INTO native_operations
        (operation_id, engagement_id, kind, status, tx_hash, detail_json, created_at, updated_at)
       VALUES ('op-1', 'eng-1', 'solution-settlement', 'finalized', '0xsettle1', '{}',
               '2026-08-01T00:00:05.000Z', '2026-08-01T00:00:05.000Z')`,
    )
    .run();
  store.db
    .prepare(
      `INSERT INTO native_evaluations
        (evaluation_id, chain_id, coordinator, task_id, solution_attempt_index, solution_request_id,
         solution_operator, evaluator_agent, source, source_sequence, source_entry_digest,
         canonical_event_identity, block_hash, block_number, transaction_hash, log_index,
         subject_task_digest, advertised_delivery_digest, subject_graph_digest, state,
         evaluation_attempt_uri, evaluation_request_id, verdict_code, created_at, updated_at)
       VALUES ('eval-1', '84532', '0xcoord', '401', 0, '0xsol', '0xsolop', '0xevalop', 'src', '1',
               'sha256:${'c'.repeat(64)}', 'identity-eval-1', '0x${'0'.repeat(64)}', '10',
               '0x${'1'.repeat(64)}', 0, 'sha256:${'d'.repeat(64)}', 'sha256:${'e'.repeat(64)}',
               'sha256:${'f'.repeat(64)}', 'evaluating', NULL, '0xevalreq1', NULL,
               '2026-08-01T00:00:03.000Z', '2026-08-01T00:00:04.000Z')`,
    )
    .run();
}

describe('native read-plane golden wire shape (one-swap R1)', () => {
  it('produces the pinned TaskRunsStatus wire object from a fixed native seed', async () => {
    await withTempStore(async (store) => {
      seedNative(store);
      const status = gatherTaskRunsStatus(store.taskRunReadModel('native'));

      const expected: TaskRunsStatus = {
        totals: {
          observedTasks: 2,
          activeTaskRuns: 1,
          completed: 1,
          solutions: 1,
          verdicts: 0,
          failed: 0,
          settledFailed: 0,
          localErrors: 0,
          raceLost: 0,
        },
        inFlight: [
          {
            requestId: '0xevalreq1',
            taskId: '401',
            taskCid: `sha256:${'d'.repeat(64)}`,
            solverType: null,
            state: 'RUNNING',
            taskRole: 'evaluation',
            implName: null,
            windowStartTs: 1785542403,
            windowEndTs: 1785542404,
            runStartedAt: 1785542403000,
            stateUpdatedAt: 1785542404000,
            manifestCid: null,
            deliveryTxHash: null,
            failureReason: null,
            outcome: null,
          },
        ],
        recentTasks: [
          {
            requestId: '0xreq1',
            taskId: '301',
            taskCid: `sha256:${'a'.repeat(64)}`,
            solverType: null,
            state: 'COMPLETE',
            taskRole: 'restoration',
            implName: null,
            windowStartTs: 1785542402,
            windowEndTs: 1785542405,
            runStartedAt: 1785542402000,
            stateUpdatedAt: 1785542405000,
            manifestCid: null,
            deliveryTxHash: '0xsettle1',
            failureReason: null,
            outcome: null,
          },
          {
            requestId: '0xevalreq1',
            taskId: '401',
            taskCid: `sha256:${'d'.repeat(64)}`,
            solverType: null,
            state: 'RUNNING',
            taskRole: 'evaluation',
            implName: null,
            windowStartTs: 1785542403,
            windowEndTs: 1785542404,
            runStartedAt: 1785542403000,
            stateUpdatedAt: 1785542404000,
            manifestCid: null,
            deliveryTxHash: null,
            failureReason: null,
            outcome: null,
          },
        ],
      };

      expect(status).toEqual(expected);
    });
  });
});

describe('taskRunReadModel is native-only', () => {
  it('returns NativeTaskRunReadModel for every composition argument', async () => {
    await withTempStore(async (store) => {
      expect(store.taskRunReadModel()).toBeInstanceOf(NativeTaskRunReadModel);
      expect(store.taskRunReadModel('legacy')).toBeInstanceOf(NativeTaskRunReadModel);
      expect(store.taskRunReadModel('native')).toBeInstanceOf(NativeTaskRunReadModel);
    });
  });
});
