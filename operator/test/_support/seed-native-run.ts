import { NATIVE_EVALUATOR_STATE_SCHEMA } from '../../src/daemon/native-evaluator-state.js';
import type { Store } from '../../src/store/store.js';
import type { Task } from '../../src/types/task.js';

const RUN_TO_ENGAGEMENT: Record<string, string> = {
  DISCOVERED: 'eligible',
  CLAIMED: 'claim-finalized',
  WAITING: 'paused',
  PRE_SNAPSHOT: 'executing',
  RUNNING: 'executing',
  POST_SNAPSHOT: 'executing',
  PACKAGING: 'solution-ready',
  DELIVERING: 'solution-published',
  AWAITING_ADOPTION: 'solution-published',
  CLAIMING_DELIVERY: 'solution-settlement-pending',
  COMPLETE: 'solution-settled',
  FAILED: 'failed',
  RACE_LOST: 'lost',
};

const RUN_TO_EVALUATION: Record<string, string> = {
  DISCOVERED: 'evaluation-pending',
  CLAIMED: 'evaluation-finalized',
  WAITING: 'paused',
  PRE_SNAPSHOT: 'evaluating',
  RUNNING: 'evaluating',
  POST_SNAPSHOT: 'evaluating',
  PACKAGING: 'verdict-ready',
  DELIVERING: 'verdict-published',
  AWAITING_ADOPTION: 'verdict-published',
  CLAIMING_DELIVERY: 'verdict-settlement-pending',
  COMPLETE: 'complete',
  FAILED: 'failed',
  RACE_LOST: 'lost',
};

export interface SeedNativeRunInput {
  requestId: string;
  taskId?: string;
  taskCid?: string;
  solverType?: string | null;
  taskRole?: 'restoration' | 'evaluation';
  windowStartTs?: number;
  windowEndTs?: number;
  runStartedAt?: number;
  state?: string;
  stateUpdatedAt?: number;
  deliveryTxHash?: string | null;
  failureReason?: string | null;
  manifestCid?: string | null;
  task?: Partial<Task> | null;
}

function toIsoFromUnixSeconds(ts: number | undefined, fallbackMs: number): string {
  if (ts === undefined) return new Date(fallbackMs).toISOString();
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toISOString();
}

function toIsoFromUnixMs(ts: number | undefined, fallbackMs: number): string {
  if (ts === undefined) return new Date(fallbackMs).toISOString();
  return new Date(ts).toISOString();
}

function digestFor(label: string): string {
  const hex = Buffer.from(label).toString('hex').padEnd(64, '0').slice(0, 64);
  return `sha256:${hex}`;
}

/**
 * Insert a native engagement or evaluation row that the status read model
 * surfaces as a PersistedTaskRun. Replaces TaskRunPersistence.insertDiscovered
 * in tests after the engine table retired.
 */
export function seedNativeRun(store: Store, input: SeedNativeRunInput): void {
  const taskId = input.taskId ?? input.requestId;
  const taskCid = input.taskCid ?? `bafy-${input.requestId}`;
  const state = input.state ?? 'DISCOVERED';
  const createdAt = toIsoFromUnixSeconds(input.windowStartTs, 1_000_000);
  const updatedAt = input.stateUpdatedAt !== undefined
    ? toIsoFromUnixMs(input.stateUpdatedAt, Date.parse(createdAt))
    : toIsoFromUnixSeconds(input.windowEndTs, Date.parse(createdAt));
  const capability = JSON.stringify({
    ...(input.solverType ? { solverType: input.solverType } : {}),
    ...(input.failureReason ? { failureReason: input.failureReason } : {}),
    ...(input.manifestCid ? { manifestCid: input.manifestCid } : {}),
    ...(input.runStartedAt !== undefined ? { runStartedAt: input.runStartedAt } : {}),
    ...(input.task ? { task: input.task } : {}),
  });

  if (input.taskRole === 'evaluation') {
    store.db.exec(NATIVE_EVALUATOR_STATE_SCHEMA);
    store.db.prepare(
      `INSERT INTO native_evaluations
        (evaluation_id, chain_id, coordinator, task_id, solution_attempt_index, solution_request_id,
         solution_operator, evaluator_agent, source, source_sequence, source_entry_digest,
         canonical_event_identity, block_hash, block_number, transaction_hash, log_index,
         subject_task_digest, advertised_delivery_digest, subject_graph_digest, state,
         evaluation_attempt_uri, evaluation_request_id, verdict_code, created_at, updated_at)
       VALUES (?, '84532', '0xcoord', ?, 0, ?, '0xsolop', ?, ?, '1', ?,
               ?, '0x${'0'.repeat(64)}', '10', '0x${'1'.repeat(64)}', 0,
               ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
    ).run(
      input.requestId,
      taskId,
      `0xsol-${input.requestId}`,
      input.requestId,
      input.requestId,
      digestFor(input.requestId),
      input.requestId,
      taskCid,
      digestFor(`adv-${input.requestId}`),
      digestFor(`graph-${input.requestId}`),
      RUN_TO_EVALUATION[state] ?? 'evaluation-pending',
      input.requestId,
      createdAt,
      updatedAt,
    );
    if (input.deliveryTxHash) {
      store.db.prepare(
        `INSERT INTO native_evaluation_operations
          (operation_id, evaluation_id, kind, status, tx_hash, detail_json, created_at, updated_at)
         VALUES (?, ?, 'verdict-settlement', 'finalized', ?, '{}', ?, ?)`,
      ).run(`op-${input.requestId}`, input.requestId, input.deliveryTxHash, updatedAt, updatedAt);
    }
    return;
  }

  store.db.prepare(
    `INSERT INTO native_engagements
      (engagement_id, chain_id, coordinator, task_id, role, operator_agent, task_digest,
       submission_uri, submission_digest, state, attempt_index, attempt_uri, request_id,
       policy_json, capability_json, created_at, updated_at)
     VALUES (?, '84532', '0xcoord', ?, 'solver', ?, ?,
             'urn:uuid:00000000-0000-0000-0000-000000000001', ?, ?, 0, NULL, ?,
             '{}', ?, ?, ?)`,
  ).run(
    input.requestId,
    taskId,
    input.requestId,
    taskCid,
    digestFor(`sub-${input.requestId}`),
    RUN_TO_ENGAGEMENT[state] ?? 'eligible',
    input.requestId,
    capability,
    createdAt,
    updatedAt,
  );
  if (input.deliveryTxHash) {
    store.db.prepare(
      `INSERT INTO native_operations
        (operation_id, engagement_id, kind, status, tx_hash, detail_json, created_at, updated_at)
       VALUES (?, ?, 'solution-settlement', 'finalized', ?, '{}', ?, ?)`,
    ).run(`op-${input.requestId}`, input.requestId, input.deliveryTxHash, updatedAt, updatedAt);
  }
}

export function markNativeFailed(store: Store, requestId: string, reason: string): void {
  patchNativeRun(store, requestId, { state: 'FAILED', failureReason: reason });
}

export function patchNativeRun(
  store: Store,
  requestId: string,
  patch: {
    state?: string;
    failureReason?: string | null;
    deliveryTxHash?: string | null;
    solverType?: string | null;
    task?: unknown;
    manifestCid?: string | null;
    stateUpdatedAt?: number;
  },
): void {
  const engagement = store.db.prepare(
    `SELECT capability_json, created_at FROM native_engagements WHERE request_id = ? OR engagement_id = ?`,
  ).get(requestId, requestId) as { capability_json: string; created_at: string } | undefined;
  if (engagement) {
    const cap = JSON.parse(engagement.capability_json || '{}') as Record<string, unknown>;
    if (patch.failureReason !== undefined) {
      if (patch.failureReason === null) delete cap.failureReason;
      else cap.failureReason = patch.failureReason;
    }
    if (patch.solverType !== undefined) {
      if (patch.solverType === null) delete cap.solverType;
      else cap.solverType = patch.solverType;
    }
    if (patch.task !== undefined) cap.task = patch.task;
    if (patch.manifestCid !== undefined) {
      if (patch.manifestCid === null) delete cap.manifestCid;
      else cap.manifestCid = patch.manifestCid;
    }
    const updatedAt = patch.stateUpdatedAt !== undefined
      ? new Date(patch.stateUpdatedAt).toISOString()
      : new Date().toISOString();
    const nativeState = patch.state ? (RUN_TO_ENGAGEMENT[patch.state] ?? patch.state) : undefined;
    store.db.prepare(
      `UPDATE native_engagements
          SET capability_json = ?,
              updated_at = ?,
              state = COALESCE(?, state)
        WHERE request_id = ? OR engagement_id = ?`,
    ).run(JSON.stringify(cap), updatedAt, nativeState ?? null, requestId, requestId);
    if (patch.deliveryTxHash) {
      store.db.prepare(
        `INSERT INTO native_operations
          (operation_id, engagement_id, kind, status, tx_hash, detail_json, created_at, updated_at)
         VALUES (?, ?, 'solution-settlement', 'finalized', ?, '{}', ?, ?)
         ON CONFLICT (engagement_id, kind) DO UPDATE SET tx_hash = excluded.tx_hash, updated_at = excluded.updated_at`,
      ).run(`op-${requestId}`, requestId, patch.deliveryTxHash, updatedAt, updatedAt);
    }
    return;
  }

  const evaluation = store.db.prepare(
    `SELECT evaluation_id FROM native_evaluations WHERE evaluation_request_id = ? OR evaluation_id = ?`,
  ).get(requestId, requestId) as { evaluation_id: string } | undefined;
  if (!evaluation) {
    throw new Error(`no native run for ${requestId}`);
  }
  const updatedAt = patch.stateUpdatedAt !== undefined
    ? new Date(patch.stateUpdatedAt).toISOString()
    : new Date().toISOString();
  const nativeState = patch.state ? (RUN_TO_EVALUATION[patch.state] ?? patch.state) : undefined;
  store.db.prepare(
    `UPDATE native_evaluations
        SET updated_at = ?,
            state = COALESCE(?, state)
      WHERE evaluation_id = ?`,
  ).run(updatedAt, nativeState ?? null, evaluation.evaluation_id);
  if (patch.deliveryTxHash) {
    store.db.prepare(
      `INSERT INTO native_evaluation_operations
        (operation_id, evaluation_id, kind, status, tx_hash, detail_json, created_at, updated_at)
       VALUES (?, ?, 'verdict-settlement', 'finalized', ?, '{}', ?, ?)
       ON CONFLICT (evaluation_id, kind) DO UPDATE SET tx_hash = excluded.tx_hash, updated_at = excluded.updated_at`,
    ).run(`op-${requestId}`, evaluation.evaluation_id, patch.deliveryTxHash, updatedAt, updatedAt);
  }
}
