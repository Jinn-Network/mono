/**
 * Harness engine — SQLite persistence helpers.
 *
 * §6.4 of spec/2026-04-17-portfolio-v0-design.md
 *
 * Wraps the Store's underlying Database instance via the Store class — the
 * Store itself holds the DB handle; we extend it with engine-specific queries.
 * To keep concerns clean, this module exports a standalone `TaskRunPersistence`
 * class that is constructed with a `Database` instance (passed from Store).
 */

import type Database from 'better-sqlite3';
import { assertValidTransition, TERMINAL_STATES, type TaskRunState } from './state.js';
import type { Task } from '../../types/task.js';

// ── Concurrency error ─────────────────────────────────────────────────────────

/**
 * Thrown by `transition()` and `markFailed()` when the DB row has already been
 * updated by a concurrent call before the UPDATE could land.
 *
 * Callers should treat this as a signal to retry from the fresh DB state or
 * abandon the operation (the concurrent call has already advanced the task).
 */
export class ConcurrentTransitionError extends Error {
  readonly requestId: string;
  readonly expectedState: TaskRunState;
  readonly attemptedNewState: string;

  constructor(requestId: string, expectedState: TaskRunState, attemptedNewState: string) {
    super(
      `ConcurrentTransitionError: ${requestId} expected state=${expectedState} but DB row has changed (attempted=${attemptedNewState})`,
    );
    this.name = 'ConcurrentTransitionError';
    this.requestId = requestId;
    this.expectedState = expectedState;
    this.attemptedNewState = attemptedNewState;
  }
}

// ── Schema ────────────────────────────────────────────────────────────────────

export const TASK_RUNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_runs (
  request_id              TEXT PRIMARY KEY,
  task_cid              TEXT NOT NULL,
  onchain_creation_tx     TEXT NOT NULL,
  onchain_creation_block  INTEGER NOT NULL,
  solver_type               TEXT,
  task_role             TEXT,     -- 'restoration' | 'evaluation' | NULL (legacy)
  impl_name               TEXT,

  state                   TEXT NOT NULL,
  state_updated_at        INTEGER NOT NULL,

  working_dir             TEXT,
  impl_state_dir          TEXT,

  window_start_ts         INTEGER NOT NULL,
  window_end_ts           INTEGER NOT NULL,

  pre_snapshot_captured_at  INTEGER,
  pre_snapshot_payload      TEXT,
  post_snapshot_captured_at INTEGER,
  post_snapshot_payload     TEXT,
  fills_payload             TEXT,
  gating_claim              TEXT,
  informational_claim       TEXT,

  artifact_cids           TEXT,
  manifest_cid            TEXT,
  delivery_tx_hash        TEXT,

  -- Additive columns (schema migration 2026-04-17):
  -- manifest_generated_at: persisted once at first PACKAGING entry; reused on
  --   retry to keep manifest CID deterministic (idempotent PACKAGING).
  -- evidence_hash: keccak256 of the signed manifest canonical JSON; dedicated
  --   column replaces the former _evidenceHash stash in informational_claim.
  manifest_generated_at   INTEGER,
  evidence_hash           TEXT,

  -- Additive column (schema migration 2026-04-17, full Task threading):
  -- task_payload: full Task JSON, captured at observe() time.
  -- NULL for pre-migration rows (legacy fallback in engine consumers).
  task_payload   TEXT,

  -- Additive column (added by WT-C for PACKAGING recovery fidelity):
  -- solution_outputs_json: serialised Solution persisted before the
  --   RUNNING → PACKAGING transition. Enables pack() to recover solution outputs
  --   after a crash without re-executing the impl. NULL once pack() succeeds.
  solution_outputs_json       TEXT,
  runtime_plugins_json        TEXT,

  failure_reason          TEXT,
  failure_at              INTEGER
);

CREATE INDEX IF NOT EXISTS idx_task_runs_state
  ON task_runs(state);

CREATE INDEX IF NOT EXISTS idx_task_runs_window_start_ts
  ON task_runs(window_start_ts);
`;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Input when first observing an task from an on-chain event. */
export interface PersistedTaskRunInput {
  requestId: string;
  taskCid: string;
  onchainCreationTx: string;
  onchainCreationBlock: number;
  solverType?: string;
  /** 'restoration' (default) or 'evaluation'. Captured from Task.type at observe() time. */
  taskRole?: 'restoration' | 'evaluation';
  windowStartTs: number;
  windowEndTs: number;
  /**
   * Full Task payload, captured at observe() time.
   * Required: production callers always thread it (daemon.ts); making this
   * required provides a type-level guarantee against silent regression to the
   * stub path. Tests that need to exercise the pre-migration NULL row path
   * must use a direct raw SQL INSERT.
   */
  task: Task;
}

/** Full persisted task row (all columns). */
export interface PersistedTaskRun {
  requestId: string;
  taskCid: string;
  onchainCreationTx: string;
  onchainCreationBlock: number;
  solverType: string | null;
  taskRole: 'restoration' | 'evaluation' | null;
  implName: string | null;

  state: TaskRunState;
  stateUpdatedAt: number;

  workingDir: string | null;
  implStateDir: string | null;

  windowStartTs: number;
  windowEndTs: number;

  preSnapshotCapturedAt: number | null;
  preSnapshotPayload: unknown | null;    // deserialized JSON
  postSnapshotCapturedAt: number | null;
  postSnapshotPayload: unknown | null;   // deserialized JSON
  fillsPayload: unknown[] | null;        // deserialized JSON
  gatingClaim: Record<string, unknown> | null;
  informationalClaim: Record<string, unknown> | null;

  artifactCids: Record<string, string> | null;  // { path: cid }
  manifestCid: string | null;
  deliveryTxHash: string | null;

  /** Persisted once at first PACKAGING entry; reused on retry for manifest CID determinism. */
  manifestGeneratedAt: number | null;
  /** keccak256 of signed manifest canonical JSON; used by deliver() as evidenceHash. */
  evidenceHash: string | null;

  /** Full Task payload as recorded at observe() time; null for pre-migration rows. */
  task: Task | null;

  /**
   * Serialised Solution from runImpl, persisted before the
   * RUNNING → PACKAGING transition. Used by pack() to recover solution outputs
   * after a crash so the manifest CID remains deterministic. Null for
   * pre-migration rows and tasks that have already been packed.
   * Added by WT-C for PACKAGING recovery fidelity.
   */
  solutionOutputsJson: string | null;
  runtimePluginsJson: string | null;

  failureReason: string | null;
  failureAt: number | null;
}

/**
 * Fields that can be patched during a transition.
 * Only lists fields that `transition()` actually writes — attempting to patch
 * other fields (e.g. `solverType`, window timestamps) gives a compile-time error
 * instead of silently dropping the value.
 */
export type TaskRunPatch = Partial<{
  implName: string | null;
  workingDir: string | null;
  implStateDir: string | null;
  preSnapshotCapturedAt: number | null;
  preSnapshotPayload: unknown;
  postSnapshotCapturedAt: number | null;
  postSnapshotPayload: unknown;
  fillsPayload: unknown;
  gatingClaim: unknown;
  informationalClaim: unknown;
  artifactCids: Record<string, string> | null;
  manifestCid: string | null;
  deliveryTxHash: string | null;
  /** Persisted once at first PACKAGING entry; reused on retry. */
  manifestGeneratedAt: number | null;
  /** keccak256 of signed manifest canonical JSON (evidenceHash for claimDelivery). */
  evidenceHash: string | null;
  /**
   * Serialised Solution JSON, persisted before RUNNING → PACKAGING.
   * Enables pack() to recover solution outputs after a crash without re-executing
   * the impl. Set by engine.runImpl(); cleared by engine after successful pack().
   * Added by WT-C for PACKAGING recovery fidelity.
   */
  solutionOutputsJson: string | null;
  runtimePluginsJson: string | null;
}>;

// ── Raw DB row (snake_case from SQLite) ───────────────────────────────────────

interface RawRow {
  request_id: string;
  task_cid: string;
  onchain_creation_tx: string;
  onchain_creation_block: number;
  solver_type: string | null;
  task_role: string | null;
  impl_name: string | null;
  state: string;
  state_updated_at: number;
  working_dir: string | null;
  impl_state_dir: string | null;
  window_start_ts: number;
  window_end_ts: number;
  pre_snapshot_captured_at: number | null;
  pre_snapshot_payload: string | null;
  post_snapshot_captured_at: number | null;
  post_snapshot_payload: string | null;
  fills_payload: string | null;
  gating_claim: string | null;
  informational_claim: string | null;
  artifact_cids: string | null;
  manifest_cid: string | null;
  delivery_tx_hash: string | null;
  manifest_generated_at: number | null;
  evidence_hash: string | null;
  task_payload: string | null;
  solution_outputs_json: string | null;
  runtime_plugins_json: string | null;
  failure_reason: string | null;
  failure_at: number | null;
}

// ── Migrations ────────────────────────────────────────────────────────────────

/**
 * Idempotent additive migrations for `task_runs`.
 *
 * better-sqlite3 throws on duplicate column from ALTER TABLE ADD COLUMN; we
 * swallow that specific error so this is safe to invoke on every startup.
 * For new DBs the column already exists via CREATE TABLE; the ALTER is a no-op.
 */
function runAdditiveMigrations(db: Database.Database): void {
  const additions: Array<{ column: string; ddl: string }> = [
    { column: 'task_payload', ddl: 'ALTER TABLE task_runs ADD COLUMN task_payload TEXT' },
    { column: 'manifest_generated_at', ddl: 'ALTER TABLE task_runs ADD COLUMN manifest_generated_at TEXT NULL' },
    { column: 'evidence_hash',         ddl: 'ALTER TABLE task_runs ADD COLUMN evidence_hash TEXT NULL' },
    // Persists solution outputs so pack() can recover a deterministic manifest CID
    // after a process restart (otherwise in-memory solutionOutputs is lost).
    { column: 'solution_outputs_json',     ddl: 'ALTER TABLE task_runs ADD COLUMN solution_outputs_json TEXT' },
    { column: 'runtime_plugins_json',      ddl: 'ALTER TABLE task_runs ADD COLUMN runtime_plugins_json TEXT' },
    { column: 'task_role',           ddl: 'ALTER TABLE task_runs ADD COLUMN task_role TEXT' },
  ];

  // Fetch existing column names once so each ALTER is a no-op if the column
  // already exists (avoids duplicate-column-name errors on newer DBs).
  const existingColumns = new Set(
    (db.pragma('table_info(task_runs)') as Array<{ name: string }>)
      .map(r => r.name),
  );

  for (const { column, ddl } of additions) {
    if (existingColumns.has(column)) continue;
    try {
      db.exec(ddl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(msg)) throw err;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  return JSON.parse(raw) as T;
}

function rowToTaskRun(row: RawRow): PersistedTaskRun {
  return {
    requestId: row.request_id,
    taskCid: row.task_cid,
    onchainCreationTx: row.onchain_creation_tx,
    onchainCreationBlock: row.onchain_creation_block,
    solverType: row.solver_type,
    taskRole: (row.task_role ?? null) as 'restoration' | 'evaluation' | null,
    implName: row.impl_name,
    state: row.state as TaskRunState,
    stateUpdatedAt: row.state_updated_at,
    workingDir: row.working_dir,
    implStateDir: row.impl_state_dir,
    windowStartTs: row.window_start_ts,
    windowEndTs: row.window_end_ts,
    preSnapshotCapturedAt: row.pre_snapshot_captured_at,
    preSnapshotPayload: parseJson(row.pre_snapshot_payload),
    postSnapshotCapturedAt: row.post_snapshot_captured_at,
    postSnapshotPayload: parseJson(row.post_snapshot_payload),
    fillsPayload: parseJson(row.fills_payload),
    gatingClaim: parseJson(row.gating_claim),
    informationalClaim: parseJson(row.informational_claim),
    artifactCids: parseJson(row.artifact_cids),
    manifestCid: row.manifest_cid,
    deliveryTxHash: row.delivery_tx_hash,
    manifestGeneratedAt: row.manifest_generated_at,
    evidenceHash: row.evidence_hash,
    task: parseJson<Task>(row.task_payload),
    solutionOutputsJson: row.solution_outputs_json,
    runtimePluginsJson: row.runtime_plugins_json,
    failureReason: row.failure_reason,
    failureAt: row.failure_at,
  };
}

// ── TaskRunPersistence ─────────────────────────────────────────────────────────

/**
 * Low-level CRUD helpers for `task_runs`.
 *
 * Constructed with the raw better-sqlite3 `Database` instance. The `Store`
 * class exposes it via `store.db` — callers that have a `Store` can pass
 * `store.db` here.
 */
export class TaskRunPersistence {
  constructor(private readonly db: Database.Database) {
    runAdditiveMigrations(db);
  }

  /**
   * Insert a DISCOVERED task row. Idempotent: if a row with the same
   * `requestId` already exists, this is a no-op (INSERT OR IGNORE).
   */
  insertDiscovered(input: PersistedTaskRunInput): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO task_runs (
        request_id, task_cid, onchain_creation_tx, onchain_creation_block,
        solver_type, task_role, state, state_updated_at, window_start_ts, window_end_ts,
        task_payload
      ) VALUES (
        @requestId, @taskCid, @onchainCreationTx, @onchainCreationBlock,
        @solverType, @taskRole, 'DISCOVERED', @now, @windowStartTs, @windowEndTs,
        @taskPayload
      )
    `).run({
      requestId: input.requestId,
      taskCid: input.taskCid,
      onchainCreationTx: input.onchainCreationTx,
      onchainCreationBlock: input.onchainCreationBlock,
      solverType: input.solverType ?? null,
      taskRole: input.taskRole ?? null,
      now: Date.now(),
      windowStartTs: input.windowStartTs,
      windowEndTs: input.windowEndTs,
      taskPayload: input.task ? JSON.stringify(input.task) : null,
    });
  }

  /**
   * Transition an task to a new state. Validates the transition and writes
   * the new state + optional patch fields atomically (persist-before-invoke).
   */
  transition(requestId: string, toState: TaskRunState, patch: TaskRunPatch = {}): void {
    const existing = this.getByRequestId(requestId);
    if (!existing) {
      throw new Error(`Task run not found: ${requestId}`);
    }
    assertValidTransition(existing.state, toState);

    const setClauses: string[] = ['state = @state', 'state_updated_at = @stateUpdatedAt'];
    const params: Record<string, unknown> = {
      requestId,
      state: toState,
      stateUpdatedAt: Date.now(),
    };

    if (patch.implName !== undefined) {
      setClauses.push('impl_name = @implName');
      params['implName'] = patch.implName;
    }
    if (patch.workingDir !== undefined) {
      setClauses.push('working_dir = @workingDir');
      params['workingDir'] = patch.workingDir;
    }
    if (patch.implStateDir !== undefined) {
      setClauses.push('impl_state_dir = @implStateDir');
      params['implStateDir'] = patch.implStateDir;
    }
    if (patch.preSnapshotCapturedAt !== undefined) {
      setClauses.push('pre_snapshot_captured_at = @preSnapshotCapturedAt');
      params['preSnapshotCapturedAt'] = patch.preSnapshotCapturedAt;
    }
    if (patch.preSnapshotPayload !== undefined) {
      setClauses.push('pre_snapshot_payload = @preSnapshotPayload');
      params['preSnapshotPayload'] = patch.preSnapshotPayload !== null
        ? JSON.stringify(patch.preSnapshotPayload) : null;
    }
    if (patch.postSnapshotCapturedAt !== undefined) {
      setClauses.push('post_snapshot_captured_at = @postSnapshotCapturedAt');
      params['postSnapshotCapturedAt'] = patch.postSnapshotCapturedAt;
    }
    if (patch.postSnapshotPayload !== undefined) {
      setClauses.push('post_snapshot_payload = @postSnapshotPayload');
      params['postSnapshotPayload'] = patch.postSnapshotPayload !== null
        ? JSON.stringify(patch.postSnapshotPayload) : null;
    }
    if (patch.fillsPayload !== undefined) {
      setClauses.push('fills_payload = @fillsPayload');
      params['fillsPayload'] = patch.fillsPayload !== null
        ? JSON.stringify(patch.fillsPayload) : null;
    }
    if (patch.gatingClaim !== undefined) {
      setClauses.push('gating_claim = @gatingClaim');
      params['gatingClaim'] = patch.gatingClaim !== null
        ? JSON.stringify(patch.gatingClaim) : null;
    }
    if (patch.informationalClaim !== undefined) {
      setClauses.push('informational_claim = @informationalClaim');
      params['informationalClaim'] = patch.informationalClaim !== null
        ? JSON.stringify(patch.informationalClaim) : null;
    }
    if (patch.artifactCids !== undefined) {
      setClauses.push('artifact_cids = @artifactCids');
      params['artifactCids'] = patch.artifactCids !== null
        ? JSON.stringify(patch.artifactCids) : null;
    }
    if (patch.manifestCid !== undefined) {
      setClauses.push('manifest_cid = @manifestCid');
      params['manifestCid'] = patch.manifestCid;
    }
    if (patch.deliveryTxHash !== undefined) {
      setClauses.push('delivery_tx_hash = @deliveryTxHash');
      params['deliveryTxHash'] = patch.deliveryTxHash;
    }
    if (patch.manifestGeneratedAt !== undefined) {
      setClauses.push('manifest_generated_at = @manifestGeneratedAt');
      params['manifestGeneratedAt'] = patch.manifestGeneratedAt;
    }
    if (patch.evidenceHash !== undefined) {
      setClauses.push('evidence_hash = @evidenceHash');
      params['evidenceHash'] = patch.evidenceHash;
    }
    if (patch.solutionOutputsJson !== undefined) {
      setClauses.push('solution_outputs_json = @solutionOutputsJson');
      params['solutionOutputsJson'] = patch.solutionOutputsJson;
    }
    if (patch.runtimePluginsJson !== undefined) {
      setClauses.push('runtime_plugins_json = @runtimePluginsJson');
      params['runtimePluginsJson'] = patch.runtimePluginsJson;
    }
    // Optimistic concurrency: include AND state = @expectedState in the WHERE
    // clause so a concurrent call that already advanced the row results in 0
    // changed rows rather than a silent double-write.
    params['expectedState'] = existing.state;
    const result = this.db.prepare(`
      UPDATE task_runs SET ${setClauses.join(', ')}
      WHERE request_id = @requestId AND state = @expectedState
    `).run(params);
    if (result.changes === 0) {
      throw new ConcurrentTransitionError(requestId, existing.state, toState);
    }
  }

  /** Fetch a single task by request ID. Returns null if not found. */
  getByRequestId(requestId: string): PersistedTaskRun | null {
    const row = this.db.prepare(
      'SELECT * FROM task_runs WHERE request_id = ?',
    ).get(requestId) as RawRow | undefined;
    if (!row) return null;
    return rowToTaskRun(row);
  }

  /**
   * Fetch a single task by request ID. Throws if not found.
   * Use this in code paths where the task is guaranteed to exist
   * (e.g. immediately after a successful `transition()` call).
   */
  getOrThrow(requestId: string): PersistedTaskRun {
    const row = this.getByRequestId(requestId);
    if (!row) {
      throw new Error(`No persisted task run for requestId ${requestId}`);
    }
    return row;
  }

  /** Fetch all tasks in a given state. */
  getByState(state: TaskRunState): PersistedTaskRun[] {
    const rows = this.db.prepare(
      'SELECT * FROM task_runs WHERE state = ? ORDER BY window_start_ts ASC',
    ).all(state) as RawRow[];
    return rows.map(rowToTaskRun);
  }

  /** Fetch all in-flight tasks (not in any terminal state). */
  getInFlight(): PersistedTaskRun[] {
    const terminalList = [...TERMINAL_STATES];
    const placeholders = terminalList.map(() => '?').join(', ');
    const sql = `SELECT * FROM task_runs WHERE state NOT IN (${placeholders}) ORDER BY window_start_ts ASC`;
    const rows = this.db.prepare(sql).all(...terminalList) as RawRow[];
    return rows.map(rowToTaskRun);
  }

  /**
   * Persist `deliveryTxHash` without triggering a state transition (state
   * remains DELIVERING). Called after deliverToMarketplace lands on-chain but
   * before claimDelivery runs, so that a crash between the two steps can be
   * recovered without re-submitting the deliver transaction.
   */
  setDeliveryTxHash(requestId: string, deliveryTxHash: string): void {
    this.db.prepare(
      'UPDATE task_runs SET delivery_tx_hash = ? WHERE request_id = ?',
    ).run(deliveryTxHash, requestId);
  }

  /**
   * Persist `manifestGeneratedAt` for the first time without triggering a
   * state transition. Used by pack() to lock in the generatedAt timestamp
   * before assembling the manifest, ensuring idempotent CID on retry.
   * No-op if already set.
   */
  setManifestGeneratedAt(requestId: string, generatedAt: number): void {
    this.db.prepare(
      'UPDATE task_runs SET manifest_generated_at = ? WHERE request_id = ? AND manifest_generated_at IS NULL',
    ).run(generatedAt, requestId);
  }

  /** Mark an task FAILED with a reason (valid from any non-terminal state). */
  markFailed(requestId: string, reason: string): void {
    const existing = this.getByRequestId(requestId);
    if (!existing) {
      throw new Error(`Task run not found: ${requestId}`);
    }
    if (existing.state === 'COMPLETE' || existing.state === 'FAILED') {
      // Already terminal — no-op (idempotent)
      return;
    }
    const now = Date.now();
    // Optimistic concurrency: guard on the expected source state so a
    // concurrent transition that has already advanced the row doesn't get
    // silently overwritten.
    const result = this.db.prepare(`
      UPDATE task_runs
      SET state = 'FAILED', state_updated_at = ?, failure_reason = ?, failure_at = ?
      WHERE request_id = ? AND state = ?
    `).run(now, reason, now, requestId, existing.state);
    if (result.changes === 0) {
      throw new ConcurrentTransitionError(requestId, existing.state, 'FAILED');
    }
  }
}
