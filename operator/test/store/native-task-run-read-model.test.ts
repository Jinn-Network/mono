import { describe, expect, it } from 'vitest';
import { withTempStore } from '@test/store.js';
import type { Store } from '@/store/store.js';
import { NativeTaskRunReadModel } from '@/store/native-task-run-read-model.js';
import { NATIVE_EVALUATOR_STATE_SCHEMA } from '@/daemon/native-evaluator-state.js';
import type { NativeEngagementState } from '@/daemon/native-operator-state.js';
import type { NativeEvaluationState } from '@/daemon/native-evaluator-state.js';

/**
 * One-swap R1 (umbrella #2461): the native-backed `TaskRunReadModel` maps
 * `native_engagements` / `native_evaluations` rows onto the same
 * `PersistedTaskRun` row shape the status builders consume. Rows are seeded by
 * direct SQL — the read model only reads, and the state→run-state mapping is
 * the surface under test.
 */

let engagementSeq = 0;
function seedEngagement(
  store: Store,
  input: {
    state: NativeEngagementState;
    requestId?: string | null;
    taskId?: string;
    createdAt?: string;
    updatedAt?: string;
    settlementTxHash?: string | null;
  },
): void {
  const id = `eng-${++engagementSeq}`;
  const createdAt = input.createdAt ?? `2026-08-01T00:00:0${engagementSeq}.000Z`;
  const updatedAt = input.updatedAt ?? createdAt;
  store.db
    .prepare(
      `INSERT INTO native_engagements
        (engagement_id, chain_id, coordinator, task_id, role, operator_agent, task_digest,
         submission_uri, submission_digest, state, attempt_index, attempt_uri, request_id,
         policy_json, capability_json, created_at, updated_at)
       VALUES (?, '84532', '0xcoord', ?, 'solver', '0xop', ?, ?, ?, ?, 0, NULL, ?, '{}', '{}', ?, ?)`,
    )
    .run(
      id,
      input.taskId ?? String(100 + engagementSeq),
      `sha256:${'a'.repeat(64)}`,
      `urn:uuid:00000000-0000-0000-0000-00000000000${engagementSeq}`,
      `sha256:${'b'.repeat(64)}`,
      input.state,
      input.requestId ?? null,
      createdAt,
      updatedAt,
    );
  if (input.settlementTxHash) {
    store.db
      .prepare(
        `INSERT INTO native_operations
          (operation_id, engagement_id, kind, status, tx_hash, detail_json, created_at, updated_at)
         VALUES (?, ?, 'solution-settlement', 'finalized', ?, '{}', ?, ?)`,
      )
      .run(`op-${id}`, id, input.settlementTxHash, createdAt, updatedAt);
  }
}

let evaluationSeq = 0;
function seedEvaluation(
  store: Store,
  input: {
    state: NativeEvaluationState;
    requestId?: string | null;
    taskId?: string;
    createdAt?: string;
    updatedAt?: string;
    settlementTxHash?: string | null;
  },
): void {
  store.db.exec(NATIVE_EVALUATOR_STATE_SCHEMA);
  const id = `eval-${++evaluationSeq}`;
  const createdAt = input.createdAt ?? `2026-08-02T00:00:0${evaluationSeq}.000Z`;
  const updatedAt = input.updatedAt ?? createdAt;
  store.db
    .prepare(
      `INSERT INTO native_evaluations
        (evaluation_id, chain_id, coordinator, task_id, solution_attempt_index, solution_request_id,
         solution_operator, evaluator_agent, source, source_sequence, source_entry_digest,
         canonical_event_identity, block_hash, block_number, transaction_hash, log_index,
         subject_task_digest, advertised_delivery_digest, subject_graph_digest, state,
         evaluation_attempt_uri, evaluation_request_id, verdict_code, created_at, updated_at)
       VALUES (?, '84532', '0xcoord', ?, 0, '0xsol', '0xsolop', '0xevalop', 'src', ?, ?, ?,
               '0x${'0'.repeat(64)}', '10', '0x${'1'.repeat(64)}', 0, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
    )
    .run(
      id,
      input.taskId ?? '200',
      `${evaluationSeq}`,
      `sha256:${'c'.repeat(64)}`,
      `identity-${id}`,
      `sha256:${'d'.repeat(64)}`,
      `sha256:${'e'.repeat(64)}`,
      `sha256:${'f'.repeat(64)}`,
      input.state,
      input.requestId ?? null,
      createdAt,
      updatedAt,
    );
  if (input.settlementTxHash) {
    store.db
      .prepare(
        `INSERT INTO native_evaluation_operations
          (operation_id, evaluation_id, kind, status, tx_hash, detail_json, created_at, updated_at)
         VALUES (?, ?, 'verdict-settlement', 'finalized', ?, '{}', ?, ?)`,
      )
      .run(`op-${id}`, id, input.settlementTxHash, createdAt, updatedAt);
  }
}

describe('NativeTaskRunReadModel (one-swap R1)', () => {
  it('maps engagement lifecycle states to the neutral TaskRunState partition', async () => {
    await withTempStore(async (store) => {
      seedEngagement(store, { state: 'eligible' });
      seedEngagement(store, { state: 'executing' });
      seedEngagement(store, { state: 'solution-settled' });
      seedEngagement(store, { state: 'failed' });
      seedEngagement(store, { state: 'lost' });

      const model = new NativeTaskRunReadModel(store.db);
      expect(model.getInFlight().map((r) => r.state).sort()).toEqual(['DISCOVERED', 'RUNNING']);
      expect(model.getByState('COMPLETE')).toHaveLength(1);
      expect(model.getByState('FAILED')).toHaveLength(1);
      expect(model.getByState('RACE_LOST')).toHaveLength(1);
      expect(model.getByState('COMPLETE')[0]!.taskRole).toBe('restoration');
    });
  });

  it('maps evaluation lifecycle states and marks the evaluation role', async () => {
    await withTempStore(async (store) => {
      seedEvaluation(store, { state: 'evaluation-pending' });
      seedEvaluation(store, { state: 'evaluating' });
      seedEvaluation(store, { state: 'complete' });
      seedEvaluation(store, { state: 'withdrawn' });
      seedEvaluation(store, { state: 'failed' });

      const model = new NativeTaskRunReadModel(store.db);
      expect(model.getInFlight().map((r) => r.state).sort()).toEqual(['DISCOVERED', 'RUNNING']);
      expect(model.getByState('COMPLETE')).toHaveLength(1);
      expect(model.getByState('COMPLETE')[0]!.taskRole).toBe('evaluation');
      // withdrawn folds into RACE_LOST (excluded from FAILED, #896).
      expect(model.getByState('RACE_LOST')).toHaveLength(1);
      expect(model.getByState('FAILED')).toHaveLength(1);
    });
  });

  it('surfaces the settlement tx as deliveryTxHash and derives requestId', async () => {
    await withTempStore(async (store) => {
      seedEngagement(store, { state: 'solution-settled', requestId: '0xreq', settlementTxHash: '0xsettle' });
      seedEngagement(store, { state: 'failed', requestId: null, settlementTxHash: null });

      const model = new NativeTaskRunReadModel(store.db);
      const complete = model.getByState('COMPLETE')[0]!;
      expect(complete.requestId).toBe('0xreq');
      expect(complete.deliveryTxHash).toBe('0xsettle');

      const failed = model.getByState('FAILED')[0]!;
      // No marketplace request id → falls back to the engagement id (non-null).
      expect(failed.requestId).toMatch(/^eng-/);
      expect(failed.deliveryTxHash).toBeNull();
    });
  });

  it('getGatingRows reports the delivery tx with no engine phases (native has none)', async () => {
    await withTempStore(async (store) => {
      seedEngagement(store, { state: 'solution-settled', settlementTxHash: '0xsettle' });
      seedEngagement(store, { state: 'executing' });

      const rows = new NativeTaskRunReadModel(store.db).getGatingRows();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.phasesJson === null)).toBe(true);
      expect(rows.filter((r) => r.deliveredTxHash !== null)).toHaveLength(1);
    });
  });

  it('never throws when the native evaluator table has not been created', async () => {
    await withTempStore(async (store) => {
      // Solver-only boot: native_engagements exists (Store ctor), native_evaluations does not.
      seedEngagement(store, { state: 'executing' });
      const model = new NativeTaskRunReadModel(store.db);
      expect(() => model.getInFlight()).not.toThrow();
      expect(model.getInFlight()).toHaveLength(1);
    });
  });

  it('is empty on a store with no native rows', async () => {
    await withTempStore(async (store) => {
      const model = new NativeTaskRunReadModel(store.db);
      expect(model.getInFlight()).toEqual([]);
      expect(model.getByState('COMPLETE')).toEqual([]);
      expect(model.getGatingRows()).toEqual([]);
    });
  });
});
