import { describe, expect, it } from 'vitest';
import { withTempStore } from '@test/store.js';
import type { Store } from '@/store/store.js';
import { NativeTaskRunReadModel } from '@/store/native-task-run-read-model.js';
import { NATIVE_EVALUATOR_STATE_SCHEMA } from '@/daemon/native-evaluator-state.js';
import { gatherTaskRunsStatus } from '@/api/task-runs-build.js';
import { gatherLoopCompletion } from '@/api/loop-completion-build.js';

/**
 * One-swap R1 (umbrella #2461) — DUAL-READ equivalence. The SAME logical
 * activity (a delivered solve, a settled-failed solve, an in-flight solve, a
 * completed evaluation) seeded into EITHER source — legacy `task_runs` OR the
 * native aggregate tables — produces equivalent wire output from the status
 * builders. This is the property that lets the deploy flip `compositionMode`
 * without the dashboard changing shape.
 *
 * The two sources carry source-specific identity (legacy CIDs vs. native
 * digests), so equivalence is asserted on the source-independent wire facts the
 * builders compute: the totals rollup, and the per-run (state, role, delivered)
 * multiset keyed by the shared requestId.
 */

// ── Legacy seed: direct SQL into task_runs at the exact state wanted. ──────────
let legacySeq = 0;
function seedLegacy(
  store: Store,
  input: {
    requestId: string;
    state: string;
    taskRole: 'restoration' | 'evaluation';
    deliveryTxHash?: string | null;
    stateUpdatedAt: number;
  },
): void {
  legacySeq += 1;
  store.db
    .prepare(
      `INSERT INTO task_runs
        (request_id, task_id, task_cid, onchain_creation_tx, onchain_creation_block,
         task_role, state, state_updated_at, window_start_ts, window_end_ts, run_started_at,
         delivery_tx_hash)
       VALUES (?, ?, ?, '0xtx', 1, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.requestId,
      `task-${legacySeq}`,
      `cid-${legacySeq}`,
      input.taskRole,
      input.state,
      input.stateUpdatedAt,
      1000 + legacySeq,
      2000 + legacySeq,
      input.stateUpdatedAt,
      input.deliveryTxHash ?? null,
    );
}

// ── Native seed: direct SQL into native aggregate tables. ──────────────────────
let engSeq = 0;
function seedNativeEngagement(
  store: Store,
  input: { requestId: string; state: string; settlementTxHash?: string | null; createdAt: string },
): void {
  engSeq += 1;
  const id = `eng-${engSeq}`;
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
      String(300 + engSeq),
      `sha256:${'a'.repeat(64)}`,
      `urn:uuid:00000000-0000-0000-0000-0000000003${engSeq}0`,
      `sha256:${'b'.repeat(64)}`,
      input.state,
      input.requestId,
      input.createdAt,
      input.createdAt,
    );
  if (input.settlementTxHash) {
    store.db
      .prepare(
        `INSERT INTO native_operations
          (operation_id, engagement_id, kind, status, tx_hash, detail_json, created_at, updated_at)
         VALUES (?, ?, 'solution-settlement', 'finalized', ?, '{}', ?, ?)`,
      )
      .run(`op-${id}`, id, input.settlementTxHash, input.createdAt, input.createdAt);
  }
}

let evSeq = 0;
function seedNativeEvaluation(
  store: Store,
  input: { requestId: string; state: string; createdAt: string; settlementTxHash?: string | null },
): void {
  store.db.exec(NATIVE_EVALUATOR_STATE_SCHEMA);
  evSeq += 1;
  const id = `eval-${evSeq}`;
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
      String(400 + evSeq),
      `${evSeq}`,
      `sha256:${'c'.repeat(64)}`,
      `identity-${id}`,
      `sha256:${'d'.repeat(64)}`,
      `sha256:${'e'.repeat(64)}`,
      `sha256:${'f'.repeat(64)}`,
      input.state,
      input.requestId,
      input.createdAt,
      input.createdAt,
    );
  if (input.settlementTxHash) {
    store.db
      .prepare(
        `INSERT INTO native_evaluation_operations
          (operation_id, evaluation_id, kind, status, tx_hash, detail_json, created_at, updated_at)
         VALUES (?, ?, 'verdict-settlement', 'finalized', ?, '{}', ?, ?)`,
      )
      .run(`op-${id}`, id, input.settlementTxHash, input.createdAt, input.createdAt);
  }
}

/** Reduce a TaskRunsStatus to the source-independent facts. */
function wireFacts(status: ReturnType<typeof gatherTaskRunsStatus>) {
  return {
    totals: status.totals,
    recent: [...status.recentTasks]
      .map((r) => ({
        requestId: r.requestId,
        state: r.state,
        taskRole: r.taskRole,
        delivered: r.deliveryTxHash !== null,
      }))
      .sort((a, b) => a.requestId.localeCompare(b.requestId)),
  };
}

describe('dual-read equivalence (one-swap R1)', () => {
  it('legacy task_runs and native tables yield equivalent gatherTaskRunsStatus output', async () => {
    const legacyFacts = await withTempStore(async (store) => {
      seedLegacy(store, { requestId: 'r-solved', state: 'COMPLETE', taskRole: 'restoration', deliveryTxHash: '0xdel', stateUpdatedAt: 40 });
      seedLegacy(store, { requestId: 'r-settledfail', state: 'FAILED', taskRole: 'restoration', deliveryTxHash: '0xfaildel', stateUpdatedAt: 30 });
      seedLegacy(store, { requestId: 'r-inflight', state: 'RUNNING', taskRole: 'restoration', stateUpdatedAt: 20 });
      seedLegacy(store, { requestId: 'r-verdict', state: 'COMPLETE', taskRole: 'evaluation', deliveryTxHash: '0xvdel', stateUpdatedAt: 10 });
      return wireFacts(gatherTaskRunsStatus(store.taskRunReadModel('legacy')));
    });

    const nativeFacts = await withTempStore(async (store) => {
      seedNativeEngagement(store, { requestId: 'r-solved', state: 'solution-settled', settlementTxHash: '0xdel', createdAt: '2026-08-01T00:00:04.000Z' });
      seedNativeEngagement(store, { requestId: 'r-settledfail', state: 'failed', settlementTxHash: '0xfaildel', createdAt: '2026-08-01T00:00:03.000Z' });
      seedNativeEngagement(store, { requestId: 'r-inflight', state: 'executing', createdAt: '2026-08-01T00:00:02.000Z' });
      seedNativeEvaluation(store, { requestId: 'r-verdict', state: 'complete', settlementTxHash: '0xvdel', createdAt: '2026-08-01T00:00:01.000Z' });
      return wireFacts(gatherTaskRunsStatus(store.taskRunReadModel('native')));
    });

    // The totals rollup is identical fact-for-fact across the two sources.
    expect(nativeFacts.totals).toEqual(legacyFacts.totals);
    // And the per-run (state, role, delivered) multiset keyed by requestId matches.
    expect(nativeFacts.recent).toEqual(legacyFacts.recent);
  });

  it('loop-completion delivered count is equivalent across sources', async () => {
    const legacyDelivered = await withTempStore(async (store) => {
      seedLegacy(store, { requestId: 'r1', state: 'COMPLETE', taskRole: 'restoration', deliveryTxHash: '0xa', stateUpdatedAt: 2 });
      seedLegacy(store, { requestId: 'r2', state: 'FAILED', taskRole: 'restoration', deliveryTxHash: null, stateUpdatedAt: 1 });
      return gatherLoopCompletion(store.taskRunReadModel('legacy')).delivered;
    });
    const nativeDelivered = await withTempStore(async (store) => {
      seedNativeEngagement(store, { requestId: 'r1', state: 'solution-settled', settlementTxHash: '0xa', createdAt: '2026-08-01T00:00:02.000Z' });
      seedNativeEngagement(store, { requestId: 'r2', state: 'failed', settlementTxHash: null, createdAt: '2026-08-01T00:00:01.000Z' });
      return gatherLoopCompletion(store.taskRunReadModel('native')).delivered;
    });
    expect(nativeDelivered).toBe(legacyDelivered);
    expect(nativeDelivered).toBe(1);
  });
});
