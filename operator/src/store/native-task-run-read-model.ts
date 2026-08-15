/**
 * Native-backed {@link TaskRunReadModel} (one-swap R1, umbrella #2461,
 * DR-2026-08-05).
 *
 * The API read plane reaches persisted work ONLY through the neutral
 * {@link TaskRunReadModel} port, handed over by `Store.taskRunReadModel()`. This
 * read model sits on the native tables the solver / evaluator write —
 * `native_engagements` (M3) and `native_evaluations` (M4a) — mapping each native
 * aggregate row onto the `PersistedTaskRun` row shape the five status builders
 * already consume. The port interface and the builders are unchanged; only the
 * data source moves, so the SPA needs no change.
 *
 * This lives under `store/` (not `api/`) on purpose: `Store` is the neutral
 * seam that already imports the native daemon schemas, and the #1584 boundary
 * forbids `api/` from importing `daemon/` or the persistence internals. `api/`
 * still only ever sees the port returned by `Store.taskRunReadModel()`.
 */
import type { Database as DatabaseType } from 'better-sqlite3';
import type { PersistedTaskRun, TaskRunState } from '../types/task-run.js';
import type { Task } from '../types/task.js';
import type { TaskRunReadModel } from '../types/task-run-read-model.js';
import { TERMINAL_STATES } from '../harnesses/engine/state.js';
import type { NativeEngagementState } from '../daemon/native-operator-state.js';
import type { NativeEvaluationState } from '../daemon/native-evaluator-state.js';

/**
 * Native engagement (solver) lifecycle state → the neutral `TaskRunState` the
 * status builders classify on. Only the terminal partition (COMPLETE / FAILED /
 * RACE_LOST) and the terminal-vs-in-flight split are load-bearing for the
 * builders; the specific in-flight sub-state is cosmetic but mapped to the
 * nearest legacy engine phase for a faithful Activity-row `state` label.
 */
const ENGAGEMENT_STATE_TO_RUN_STATE: Record<NativeEngagementState, TaskRunState> = {
  eligible: 'DISCOVERED',
  'claim-pending': 'CLAIMED',
  'claim-finalized': 'CLAIMED',
  executing: 'RUNNING',
  'solution-ready': 'PACKAGING',
  'solution-published': 'DELIVERING',
  'solution-settlement-pending': 'CLAIMING_DELIVERY',
  'solution-settled': 'COMPLETE',
  paused: 'WAITING',
  lost: 'RACE_LOST',
  failed: 'FAILED',
};

/** Native evaluation lifecycle state → the neutral `TaskRunState`. */
const EVALUATION_STATE_TO_RUN_STATE: Record<NativeEvaluationState, TaskRunState> = {
  'evaluation-pending': 'DISCOVERED',
  'evaluation-claim-pending': 'CLAIMED',
  'evaluation-finalized': 'CLAIMED',
  evaluating: 'RUNNING',
  'verdict-ready': 'PACKAGING',
  'verdict-published': 'DELIVERING',
  'verdict-settlement-pending': 'CLAIMING_DELIVERY',
  complete: 'COMPLETE',
  paused: 'WAITING',
  // Retracted before any attempt — terminal, but the operator did no work, so
  // it belongs with RACE_LOST (excluded from the FAILED counter, #896) rather
  // than FAILED.
  withdrawn: 'RACE_LOST',
  lost: 'RACE_LOST',
  failed: 'FAILED',
};

interface CapabilityFields {
  solverType: string | null;
  failureReason: string | null;
  manifestCid: string | null;
  runStartedAt: number | null;
  task: Task | null;
}

interface RawEngagementReadRow {
  engagement_id: string;
  task_id: string;
  request_id: string | null;
  task_digest: string;
  attempt_index: number | null;
  state: NativeEngagementState;
  capability_json: string;
  created_at: string;
  updated_at: string;
  delivery_tx_hash: string | null;
}

interface RawEvaluationReadRow {
  evaluation_id: string;
  task_id: string;
  evaluation_request_id: string | null;
  solution_request_id: string;
  subject_task_digest: string;
  solution_attempt_index: number;
  state: NativeEvaluationState;
  sibling_capability_json: string | null;
  created_at: string;
  updated_at: string;
  delivery_tx_hash: string | null;
}

/** Unix ms from an ISO timestamp; 0 when unparseable (never throws). */
function toMillis(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/** Unix seconds from an ISO timestamp; 0 when unparseable. */
function toSeconds(iso: string): number {
  const ms = toMillis(iso);
  return ms === 0 ? 0 : Math.floor(ms / 1000);
}

function parseCapability(json: string | null | undefined): CapabilityFields {
  const empty: CapabilityFields = {
    solverType: null,
    failureReason: null,
    manifestCid: null,
    runStartedAt: null,
    task: null,
  };
  if (!json) return empty;
  try {
    const cap = JSON.parse(json) as Record<string, unknown>;
    const solverType =
      typeof cap.solverType === 'string' ? cap.solverType
        : typeof cap.workKind === 'string' ? cap.workKind
          : null;
    const failureReason = typeof cap.failureReason === 'string' ? cap.failureReason : null;
    const manifestCid = typeof cap.manifestCid === 'string' ? cap.manifestCid : null;
    const runStartedAt = typeof cap.runStartedAt === 'number' ? cap.runStartedAt : null;
    const task = cap.task !== null && typeof cap.task === 'object' ? cap.task as Task : null;
    return { solverType, failureReason, manifestCid, runStartedAt, task };
  } catch {
    return empty;
  }
}

/**
 * Build a fully-populated `PersistedTaskRun` from the native-derived fields.
 * Every field the port's row shape declares is present; the ones native has no
 * analog for are `null` / `0`, exactly as a fresh legacy row seeds them. Only
 * the handful the five builders read carry native data.
 */
function baseRun(input: {
  requestId: string;
  taskId: string;
  taskCid: string;
  taskRole: 'restoration' | 'evaluation';
  attemptIndex: number | null;
  state: TaskRunState;
  createdAt: string;
  updatedAt: string;
  deliveryTxHash: string | null;
  capability: CapabilityFields;
}): PersistedTaskRun {
  const stateUpdatedAt = toMillis(input.updatedAt);
  const runStartedAt = input.capability.runStartedAt ?? toMillis(input.createdAt);
  return {
    requestId: input.requestId,
    taskId: input.taskId,
    attemptIndex: input.attemptIndex,
    taskCid: input.taskCid,
    onchainCreationTx: '',
    onchainCreationBlock: 0,
    onchainCreationTimestamp: null,
    solverType: input.capability.solverType,
    solverNetManifestCid: null,
    taskRole: input.taskRole,
    implName: null,
    state: input.state,
    stateUpdatedAt,
    workingDir: null,
    implStateDir: null,
    windowStartTs: toSeconds(input.createdAt),
    windowEndTs: toSeconds(input.updatedAt),
    runStartedAt,
    preSnapshotCapturedAt: null,
    preSnapshotPayload: null,
    postSnapshotCapturedAt: null,
    postSnapshotPayload: null,
    fillsPayload: null,
    gatingClaim: null,
    informationalClaim: null,
    artifactCids: null,
    manifestCid: input.capability.manifestCid,
    deliveryTxHash: input.deliveryTxHash,
    deliveryDigest: null,
    deliveryDiscoveryAnchorTxHash: null,
    deliveryDiscoveryAnchorBlockNumber: null,
    adoptionReceiptLocation: null,
    adoptionReceiptAuthors: null,
    adoptionWaitStartedAt: null,
    adoptionObservationAttempts: 0,
    adoptionNextObservationAt: null,
    adoptionLastObservation: null,
    adoptionAcceptedReceipt: null,
    adoptionLastError: null,
    manifestGeneratedAt: null,
    evidenceHash: null,
    task: input.capability.task,
    solutionOutputsJson: null,
    intermediateFailureDiffsJson: null,
    runtimePluginsJson: null,
    consumedRefsJson: null,
    executorMode: null,
    executorCodeDigest: null,
    failureReason: input.capability.failureReason,
    failureAt: null,
  };
}

/**
 * Reads the `TaskRunReadModel` port off the native aggregate tables so the API
 * status/build plane reflects native solver + evaluator work in native mode.
 * Never throws on a missing native-evaluator table (that table is created only
 * once the native evaluator repository is constructed; a solver-only boot has
 * `native_engagements` but not `native_evaluations`).
 */
export class NativeTaskRunReadModel implements TaskRunReadModel {
  constructor(private readonly db: DatabaseType) {}

  private tableExists(name: string): boolean {
    return (
      this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(name) !== undefined
    );
  }

  /** Every native aggregate mapped to a `PersistedTaskRun`, oldest-first. */
  private allRuns(): PersistedTaskRun[] {
    return [...this.engagementRuns(), ...this.evaluationRuns()].sort(
      (a, b) => a.windowStartTs - b.windowStartTs,
    );
  }

  private engagementRuns(): PersistedTaskRun[] {
    if (!this.tableExists('native_engagements')) return [];
    const rows = this.db
      .prepare(
        `SELECT e.engagement_id, e.task_id, e.request_id, e.task_digest, e.attempt_index,
                e.state, e.capability_json, e.created_at, e.updated_at,
                (SELECT o.tx_hash FROM native_operations o
                   WHERE o.engagement_id = e.engagement_id
                     AND o.kind = 'solution-settlement'
                     AND o.tx_hash IS NOT NULL
                   ORDER BY o.updated_at DESC LIMIT 1) AS delivery_tx_hash
           FROM native_engagements e
          ORDER BY e.created_at ASC, e.engagement_id ASC`,
      )
      .all() as RawEngagementReadRow[];
    return rows.map((row) =>
      baseRun({
        requestId: row.request_id ?? row.engagement_id,
        taskId: row.task_id,
        taskCid: row.task_digest,
        taskRole: 'restoration',
        attemptIndex: row.attempt_index,
        state: ENGAGEMENT_STATE_TO_RUN_STATE[row.state] ?? 'RUNNING',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deliveryTxHash: row.delivery_tx_hash,
        capability: parseCapability(row.capability_json),
      }),
    );
  }

  private evaluationRuns(): PersistedTaskRun[] {
    if (!this.tableExists('native_evaluations')) return [];
    const hasOps = this.tableExists('native_evaluation_operations');
    const deliverySelect = hasOps
      ? `(SELECT o.tx_hash FROM native_evaluation_operations o
            WHERE o.evaluation_id = v.evaluation_id
              AND o.kind = 'verdict-settlement'
              AND o.tx_hash IS NOT NULL
            ORDER BY o.updated_at DESC LIMIT 1)`
      : `NULL`;
    const rows = this.db
      .prepare(
        `SELECT v.evaluation_id, v.task_id, v.evaluation_request_id, v.solution_request_id,
                v.subject_task_digest, v.solution_attempt_index, v.state, v.created_at, v.updated_at,
                ${deliverySelect} AS delivery_tx_hash,
                (SELECT e.capability_json FROM native_engagements e
                   WHERE e.task_id = v.task_id LIMIT 1) AS sibling_capability_json
           FROM native_evaluations v
          ORDER BY v.created_at ASC, v.evaluation_id ASC`,
      )
      .all() as RawEvaluationReadRow[];
    return rows.map((row) =>
      baseRun({
        requestId: row.evaluation_request_id ?? row.evaluation_id,
        taskId: row.task_id,
        taskCid: row.subject_task_digest,
        taskRole: 'evaluation',
        attemptIndex: row.solution_attempt_index,
        state: EVALUATION_STATE_TO_RUN_STATE[row.state] ?? 'RUNNING',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deliveryTxHash: row.delivery_tx_hash,
        capability: (() => {
          const sibling = parseCapability(row.sibling_capability_json);
          return {
            solverType: sibling.solverType,
            task: sibling.task,
            failureReason: null,
            manifestCid: null,
            runStartedAt: null,
          };
        })(),
      }),
    );
  }

  getInFlight(): PersistedTaskRun[] {
    return this.allRuns().filter((run) => !TERMINAL_STATES.has(run.state));
  }

  getByState(state: TaskRunState): PersistedTaskRun[] {
    return this.allRuns().filter((run) => run.state === state);
  }

  getGatingRows(): Array<{ phasesJson: string | null; deliveredTxHash: string | null }> {
    // Native execution carries no engine `gating.phasesCompleted` array — the
    // self-improvement phase loop is a legacy-engine concept. The loop-
    // completion rollup's `delivered` count stays honest off the settlement tx;
    // its phase counters are legitimately zero in native mode.
    return this.allRuns().map((run) => ({
      phasesJson: null,
      deliveredTxHash: run.deliveryTxHash,
    }));
  }
}
