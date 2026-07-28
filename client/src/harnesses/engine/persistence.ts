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
import type {
  AdoptionObservation,
  AdoptionReceiptLocation,
  PersistedTaskRun,
} from '../../types/task-run.js';
import type {
  AutopilotAdoptionReceipt,
} from '@jinn-network/sdk/solvernets/jinn-repo';

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
  task_id                 TEXT,
  attempt_index           INTEGER,
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
  run_started_at          INTEGER,

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
  delivery_digest         TEXT,
  delivery_discovery_anchor_tx_hash TEXT,
  delivery_discovery_anchor_block_number INTEGER,
  adoption_receipt_location TEXT,
  adoption_receipt_authors  TEXT,
  adoption_wait_started_at  INTEGER,
  adoption_observation_attempts INTEGER NOT NULL DEFAULT 0,
  adoption_next_observation_at INTEGER,
  adoption_last_observation TEXT,
  adoption_accepted_receipt TEXT,
  adoption_last_error       TEXT,

  -- Additive columns (schema migration 2026-04-17):
  -- manifest_generated_at: persisted once at first PACKAGING entry; reused on
  --   retry to keep manifest CID deterministic (idempotent PACKAGING).
  -- evidence_hash: keccak256 of the signed manifest canonical JSON; dedicated
  --   column replaces the former _evidenceHash stash in informational_claim.
  manifest_generated_at   INTEGER,
  evidence_hash           TEXT,

  -- Additive column (schema migration 2026-05-23, in-flight gate fix):
  -- solver_net_manifest_cid: the SolverNet manifest CID this task was
  -- posted under (Task.solverNetManifestCid). Distinct from the artifact
  -- manifest_cid above, which is the PACKAGING output CID. Used by
  -- hasInFlightFor so distinct SolverNets that share the same routing key
  -- (e.g. two SWE-rebench-v2 launches at different manifestCids) each hold
  -- their own in-flight slot.
  solver_net_manifest_cid TEXT,

  -- Additive column (schema migration 2026-04-17, full Task threading):
  -- task_payload: full Task JSON, captured at observe() time.
  -- NULL for pre-migration rows (legacy fallback in engine consumers).
  task_payload   TEXT,

  -- Additive column (added by WT-C for PACKAGING recovery fidelity):
  -- solution_outputs_json: serialised Solution persisted before the
  --   RUNNING → PACKAGING transition. Enables pack() to recover solution outputs
  --   after a crash without re-executing the impl. NULL once pack() succeeds.
  solution_outputs_json       TEXT,
  -- Additive column (#1643, intermediateFailureDiffs / spec §10 field 4):
  -- intermediate_failure_diffs_json: JSON string[] of harness-emitted
  --   failed working-tree diffs from in-session attempt boundaries,
  --   written once at RUNNING → POST_SNAPSHOT. NULL when empty / absent.
  intermediate_failure_diffs_json TEXT,
  runtime_plugins_json        TEXT,

  -- Additive column (#1393, corpus knowledge autoload):
  -- consumed_refs_json: JSON array of corpus knowledge record refs injected
  --   into task.context.corpusKnowledge for this run (envelopeCid + artifact
  --   sha256s). NULL when no knowledge was injected. Read by the #1397
  --   consumed-refs hook and the daemon-harness e2e.
  consumed_refs_json          TEXT,

  -- Additive columns for ERC-8004 payload v2 (jinn-mono-9fe5):
  --   executor_mode: 'train' | 'frozen', captured by pack() from the freeze-fence
  --     and reused by deliver() to emit a payload v2 setMetadata.
  --   executor_code_digest: sha256:<hex> form, same source.
  -- NULL for pre-migration rows; deliver() falls back to the v1 encoder.
  executor_mode               TEXT,
  executor_code_digest        TEXT,

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
  taskId?: string;
  attemptIndex?: number;
  taskCid: string;
  onchainCreationTx: string;
  onchainCreationBlock: number;
  solverType?: string;
  /** 'restoration' (default) or 'evaluation'. Captured from Task.type at observe() time. */
  taskRole?: 'restoration' | 'evaluation';
  windowStartTs: number;
  windowEndTs: number;
  /** Unix ms timestamp captured when this operator successfully claimed the run. */
  runStartedAt?: number;
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
// The canonical `PersistedTaskRun` shape now lives in the neutral `types/`
// layer so the API can type-import it without depending on this engine
// module (#1584). Re-exported here (imported at the top) for back-compat with
// existing importers.
export type { PersistedTaskRun };

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
  deliveryDigest: string | null;
  deliveryDiscoveryAnchorTxHash: string | null;
  deliveryDiscoveryAnchorBlockNumber: number | null;
  adoptionReceiptLocation: AdoptionReceiptLocation | null;
  adoptionReceiptAuthors: string[] | null;
  adoptionWaitStartedAt: number | null;
  adoptionObservationAttempts: number;
  adoptionNextObservationAt: number | null;
  adoptionLastObservation: AdoptionObservation | null;
  adoptionAcceptedReceipt: AutopilotAdoptionReceipt | null;
  adoptionLastError: string | null;
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
  /**
   * JSON string[] of harness-emitted intermediate failure diffs (#1643).
   * Null clears / leaves empty (prefer null when no evidence).
   */
  intermediateFailureDiffsJson: string | null;
  runtimePluginsJson: string | null;
  /** Corpus knowledge refs consumed by this run (#1393). */
  consumedRefsJson: string | null;
  /** Executor mode captured from freeze-fence. Reused by deliver() for v2 setMetadata. */
  executorMode: 'train' | 'frozen' | null;
  /** Executor codeDigest captured from freeze-fence. Reused by deliver() for v2 setMetadata. */
  executorCodeDigest: string | null;
}>;

// ── Raw DB row (snake_case from SQLite) ───────────────────────────────────────

interface RawRow {
  request_id: string;
  task_id: string | null;
  attempt_index: number | null;
  task_cid: string;
  onchain_creation_tx: string;
  onchain_creation_block: number;
  onchain_creation_timestamp: number | null;
  solver_type: string | null;
  solver_net_manifest_cid: string | null;
  task_role: string | null;
  impl_name: string | null;
  state: string;
  state_updated_at: number;
  working_dir: string | null;
  impl_state_dir: string | null;
  window_start_ts: number;
  window_end_ts: number;
  run_started_at: number | null;
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
  delivery_digest: string | null;
  delivery_discovery_anchor_tx_hash: string | null;
  delivery_discovery_anchor_block_number: number | null;
  adoption_receipt_location: string | null;
  adoption_receipt_authors: string | null;
  adoption_wait_started_at: number | null;
  adoption_observation_attempts: number;
  adoption_next_observation_at: number | null;
  adoption_last_observation: string | null;
  adoption_accepted_receipt: string | null;
  adoption_last_error: string | null;
  manifest_generated_at: number | null;
  evidence_hash: string | null;
  task_payload: string | null;
  solution_outputs_json: string | null;
  intermediate_failure_diffs_json: string | null;
  runtime_plugins_json: string | null;
  consumed_refs_json: string | null;
  executor_mode: string | null;
  executor_code_digest: string | null;
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
    { column: 'intermediate_failure_diffs_json', ddl: 'ALTER TABLE task_runs ADD COLUMN intermediate_failure_diffs_json TEXT' },
    { column: 'runtime_plugins_json',      ddl: 'ALTER TABLE task_runs ADD COLUMN runtime_plugins_json TEXT' },
    { column: 'consumed_refs_json',      ddl: 'ALTER TABLE task_runs ADD COLUMN consumed_refs_json TEXT' },
    { column: 'task_role',           ddl: 'ALTER TABLE task_runs ADD COLUMN task_role TEXT' },
    { column: 'task_id',             ddl: 'ALTER TABLE task_runs ADD COLUMN task_id TEXT' },
    { column: 'attempt_index',       ddl: 'ALTER TABLE task_runs ADD COLUMN attempt_index INTEGER' },
    { column: 'run_started_at',      ddl: 'ALTER TABLE task_runs ADD COLUMN run_started_at INTEGER' },
    // ERC-8004 payload v2 (jinn-mono-9fe5): persists executor mode + codeDigest
    // from pack() so deliver() can emit a v2 setMetadata payload after the
    // transient maps are cleared.
    { column: 'executor_mode',         ddl: 'ALTER TABLE task_runs ADD COLUMN executor_mode TEXT' },
    { column: 'executor_code_digest',  ddl: 'ALTER TABLE task_runs ADD COLUMN executor_code_digest TEXT' },
    // Per-SolverNet in-flight gate (2026-05-23): distinct SolverNets that
    // share the same `contract.id.version` routing key must each hold their
    // own in-flight slot, otherwise a task in SolverNet B is silently
    // rejected while SolverNet A is busy. See `hasInFlightFor`.
    { column: 'solver_net_manifest_cid', ddl: 'ALTER TABLE task_runs ADD COLUMN solver_net_manifest_cid TEXT' },
    // On-chain creation-block timestamp (#1827), resolved once at claim()
    // time via publicClient.getBlock and threaded to pack() for
    // envelope.task.createdAt. NULL when the RPC lookup failed or hasn't
    // run yet — never backfilled with a guess.
    { column: 'onchain_creation_timestamp', ddl: 'ALTER TABLE task_runs ADD COLUMN onchain_creation_timestamp INTEGER' },
    { column: 'delivery_digest', ddl: 'ALTER TABLE task_runs ADD COLUMN delivery_digest TEXT' },
    { column: 'delivery_discovery_anchor_tx_hash', ddl: 'ALTER TABLE task_runs ADD COLUMN delivery_discovery_anchor_tx_hash TEXT' },
    { column: 'delivery_discovery_anchor_block_number', ddl: 'ALTER TABLE task_runs ADD COLUMN delivery_discovery_anchor_block_number INTEGER' },
    { column: 'adoption_receipt_location', ddl: 'ALTER TABLE task_runs ADD COLUMN adoption_receipt_location TEXT' },
    { column: 'adoption_receipt_authors', ddl: 'ALTER TABLE task_runs ADD COLUMN adoption_receipt_authors TEXT' },
    { column: 'adoption_wait_started_at', ddl: 'ALTER TABLE task_runs ADD COLUMN adoption_wait_started_at INTEGER' },
    { column: 'adoption_observation_attempts', ddl: 'ALTER TABLE task_runs ADD COLUMN adoption_observation_attempts INTEGER NOT NULL DEFAULT 0' },
    { column: 'adoption_next_observation_at', ddl: 'ALTER TABLE task_runs ADD COLUMN adoption_next_observation_at INTEGER' },
    { column: 'adoption_last_observation', ddl: 'ALTER TABLE task_runs ADD COLUMN adoption_last_observation TEXT' },
    { column: 'adoption_accepted_receipt', ddl: 'ALTER TABLE task_runs ADD COLUMN adoption_accepted_receipt TEXT' },
    { column: 'adoption_last_error', ddl: 'ALTER TABLE task_runs ADD COLUMN adoption_last_error TEXT' },
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

  // Backfill `solver_net_manifest_cid` from the persisted Task JSON for rows
  // inserted before this column existed. Idempotent: only touches rows where
  // the column is NULL and the JSON path resolves to a string. better-sqlite3
  // ships with the JSON1 extension, so `json_extract` is always available.
  // Failures (e.g. malformed JSON) are non-fatal — the row keeps NULL and
  // legacy behaviour (no per-SolverNet slot) applies for that row.
  try {
    db.exec(`
      UPDATE task_runs
      SET solver_net_manifest_cid = json_extract(task_payload, '$.solverNetManifestCid')
      WHERE solver_net_manifest_cid IS NULL
        AND task_payload IS NOT NULL
        AND json_valid(task_payload) = 1
        AND json_extract(task_payload, '$.solverNetManifestCid') IS NOT NULL
    `);
  } catch {
    // Best-effort backfill: a database without JSON1 (very unlikely with
    // better-sqlite3's bundled SQLite) just keeps NULL and reverts to legacy
    // behaviour for those rows. The forward-going `insertDiscovered` path
    // populates the column directly.
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  return JSON.parse(raw) as T;
}

/**
 * Sanitize harness-emitted failed diffs for §10 field 4 (#1643).
 * Keeps non-empty strings only; first-seen order; drops duplicates.
 */
export function normalizeIntermediateFailureDiffs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.length > 0) seen.add(entry);
  }
  return [...seen];
}

/** JSON column value for POST_SNAPSHOT — null when no evidence after normalize. */
export function serializeIntermediateFailureDiffsJson(raw: unknown): string | null {
  const diffs = normalizeIntermediateFailureDiffs(raw);
  return diffs.length > 0 ? JSON.stringify(diffs) : null;
}

function rowToTaskRun(row: RawRow): PersistedTaskRun {
  return {
    requestId: row.request_id,
    taskId: row.task_id,
    attemptIndex: row.attempt_index,
    taskCid: row.task_cid,
    onchainCreationTx: row.onchain_creation_tx,
    onchainCreationBlock: row.onchain_creation_block,
    onchainCreationTimestamp: row.onchain_creation_timestamp ?? null,
    solverType: row.solver_type,
    solverNetManifestCid: row.solver_net_manifest_cid,
    taskRole: (row.task_role ?? null) as 'restoration' | 'evaluation' | null,
    implName: row.impl_name,
    state: row.state as TaskRunState,
    stateUpdatedAt: row.state_updated_at,
    workingDir: row.working_dir,
    implStateDir: row.impl_state_dir,
    windowStartTs: row.window_start_ts,
    windowEndTs: row.window_end_ts,
    runStartedAt: row.run_started_at,
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
    deliveryDigest: row.delivery_digest,
    deliveryDiscoveryAnchorTxHash: row.delivery_discovery_anchor_tx_hash,
    deliveryDiscoveryAnchorBlockNumber: row.delivery_discovery_anchor_block_number,
    adoptionReceiptLocation: parseJson<AdoptionReceiptLocation>(row.adoption_receipt_location),
    adoptionReceiptAuthors: parseJson<string[]>(row.adoption_receipt_authors),
    adoptionWaitStartedAt: row.adoption_wait_started_at,
    adoptionObservationAttempts: row.adoption_observation_attempts ?? 0,
    adoptionNextObservationAt: row.adoption_next_observation_at,
    adoptionLastObservation: parseJson<AdoptionObservation>(row.adoption_last_observation),
    adoptionAcceptedReceipt: parseJson<AutopilotAdoptionReceipt>(row.adoption_accepted_receipt),
    adoptionLastError: row.adoption_last_error,
    manifestGeneratedAt: row.manifest_generated_at,
    evidenceHash: row.evidence_hash,
    task: parseJson<Task>(row.task_payload),
    solutionOutputsJson: row.solution_outputs_json,
    intermediateFailureDiffsJson: row.intermediate_failure_diffs_json,
    runtimePluginsJson: row.runtime_plugins_json,
    consumedRefsJson: row.consumed_refs_json,
    executorMode: (row.executor_mode === 'train' || row.executor_mode === 'frozen')
      ? row.executor_mode
      : null,
    executorCodeDigest: row.executor_code_digest,
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
  constructor(
    private readonly db: Database.Database,
    options: { migrate?: boolean } = {},
  ) {
    if (options.migrate !== false) {
      runAdditiveMigrations(db);
    }
  }

  /**
   * Insert a DISCOVERED task row. Idempotent: if a row with the same
   * `requestId` already exists, this is a no-op (INSERT OR IGNORE).
   */
  insertDiscovered(input: PersistedTaskRunInput): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT OR IGNORE INTO task_runs (
        request_id, task_id, attempt_index, task_cid, onchain_creation_tx, onchain_creation_block,
        solver_type, task_role, state, state_updated_at, window_start_ts, window_end_ts, run_started_at,
        task_payload, solver_net_manifest_cid
      ) VALUES (
        @requestId, @taskId, @attemptIndex, @taskCid, @onchainCreationTx, @onchainCreationBlock,
        @solverType, @taskRole, 'DISCOVERED', @now, @windowStartTs, @windowEndTs, @runStartedAt,
        @taskPayload, @solverNetManifestCid
      )
    `).run({
      requestId: input.requestId,
      taskId: input.taskId ?? null,
      attemptIndex: input.attemptIndex ?? null,
      taskCid: input.taskCid,
      onchainCreationTx: input.onchainCreationTx,
      onchainCreationBlock: input.onchainCreationBlock,
      solverType: input.solverType ?? null,
      taskRole: input.taskRole ?? null,
      now,
      windowStartTs: input.windowStartTs,
      windowEndTs: input.windowEndTs,
      runStartedAt: input.runStartedAt ?? now,
      taskPayload: input.task ? JSON.stringify(input.task) : null,
      solverNetManifestCid: input.task?.solverNetManifestCid ?? null,
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
    if (patch.deliveryDigest !== undefined) {
      setClauses.push('delivery_digest = @deliveryDigest');
      params['deliveryDigest'] = patch.deliveryDigest;
    }
    if (patch.deliveryDiscoveryAnchorTxHash !== undefined) {
      setClauses.push('delivery_discovery_anchor_tx_hash = @deliveryDiscoveryAnchorTxHash');
      params['deliveryDiscoveryAnchorTxHash'] = patch.deliveryDiscoveryAnchorTxHash;
    }
    if (patch.deliveryDiscoveryAnchorBlockNumber !== undefined) {
      setClauses.push('delivery_discovery_anchor_block_number = @deliveryDiscoveryAnchorBlockNumber');
      params['deliveryDiscoveryAnchorBlockNumber'] = patch.deliveryDiscoveryAnchorBlockNumber;
    }
    if (patch.adoptionReceiptLocation !== undefined) {
      setClauses.push('adoption_receipt_location = @adoptionReceiptLocation');
      params['adoptionReceiptLocation'] = patch.adoptionReceiptLocation === null
        ? null
        : JSON.stringify(patch.adoptionReceiptLocation);
    }
    if (patch.adoptionReceiptAuthors !== undefined) {
      setClauses.push('adoption_receipt_authors = @adoptionReceiptAuthors');
      params['adoptionReceiptAuthors'] = patch.adoptionReceiptAuthors === null
        ? null
        : JSON.stringify(patch.adoptionReceiptAuthors);
    }
    if (patch.adoptionWaitStartedAt !== undefined) {
      setClauses.push('adoption_wait_started_at = @adoptionWaitStartedAt');
      params['adoptionWaitStartedAt'] = patch.adoptionWaitStartedAt;
    }
    if (patch.adoptionObservationAttempts !== undefined) {
      setClauses.push(
        'adoption_observation_attempts = @adoptionObservationAttempts',
      );
      params['adoptionObservationAttempts'] =
        patch.adoptionObservationAttempts;
    }
    if (patch.adoptionNextObservationAt !== undefined) {
      setClauses.push(
        'adoption_next_observation_at = @adoptionNextObservationAt',
      );
      params['adoptionNextObservationAt'] =
        patch.adoptionNextObservationAt;
    }
    if (patch.adoptionLastObservation !== undefined) {
      setClauses.push('adoption_last_observation = @adoptionLastObservation');
      params['adoptionLastObservation'] = patch.adoptionLastObservation === null
        ? null
        : JSON.stringify(patch.adoptionLastObservation);
    }
    if (patch.adoptionAcceptedReceipt !== undefined) {
      setClauses.push('adoption_accepted_receipt = @adoptionAcceptedReceipt');
      params['adoptionAcceptedReceipt'] = patch.adoptionAcceptedReceipt === null
        ? null
        : JSON.stringify(patch.adoptionAcceptedReceipt);
    }
    if (patch.adoptionLastError !== undefined) {
      setClauses.push('adoption_last_error = @adoptionLastError');
      params['adoptionLastError'] = patch.adoptionLastError;
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
    if (patch.intermediateFailureDiffsJson !== undefined) {
      setClauses.push('intermediate_failure_diffs_json = @intermediateFailureDiffsJson');
      params['intermediateFailureDiffsJson'] = patch.intermediateFailureDiffsJson;
    }
    if (patch.runtimePluginsJson !== undefined) {
      setClauses.push('runtime_plugins_json = @runtimePluginsJson');
      params['runtimePluginsJson'] = patch.runtimePluginsJson;
    }
    if (patch.consumedRefsJson !== undefined) {
      setClauses.push('consumed_refs_json = @consumedRefsJson');
      params['consumedRefsJson'] = patch.consumedRefsJson;
    }
    if (patch.executorMode !== undefined) {
      setClauses.push('executor_mode = @executorMode');
      params['executorMode'] = patch.executorMode;
    }
    if (patch.executorCodeDigest !== undefined) {
      setClauses.push('executor_code_digest = @executorCodeDigest');
      params['executorCodeDigest'] = patch.executorCodeDigest;
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
   * Fetch all terminal tasks (every state in `TERMINAL_STATES`: COMPLETE,
   * FAILED, RACE_LOST). Used by the working-dir reaper (issue #320) to
   * decide which on-disk scratch directories are safe to delete.
   */
  getTerminal(): PersistedTaskRun[] {
    const terminalList = [...TERMINAL_STATES];
    const placeholders = terminalList.map(() => '?').join(', ');
    const sql = `SELECT * FROM task_runs WHERE state IN (${placeholders}) ORDER BY state_updated_at ASC`;
    const rows = this.db.prepare(sql).all(...terminalList) as RawRow[];
    return rows.map(rowToTaskRun);
  }

  /**
   * Atomic snapshot for the working-dir reaper (issue #320): every task run's
   * request ID partitioned into terminal (every state in `TERMINAL_STATES`)
   * vs in-flight.
   *
   * The reaper must NOT read in-flight and terminal sets as two separate
   * queries — a task transitioning DELIVERING → COMPLETE between the two reads
   * could be seen by neither (or, worse, classified terminal) and have its
   * working directory deleted while `deliver()` still references files in it.
   * A single `SELECT` is a single statement, so the snapshot is internally
   * consistent: every row is observed at exactly one state.
   */
  getReaperPartition(): { terminal: Set<string>; inFlight: Set<string> } {
    const rows = this.db
      .prepare('SELECT request_id, state FROM task_runs')
      .all() as Array<{ request_id: string; state: string }>;
    const terminal = new Set<string>();
    const inFlight = new Set<string>();
    for (const r of rows) {
      if (TERMINAL_STATES.has(r.state as TaskRunState)) {
        terminal.add(r.request_id);
      } else {
        inFlight.add(r.request_id);
      }
    }
    return { terminal, inFlight };
  }

  /**
   * Read-only projection for the /v1/status loop-completion rollup (#959):
   * for every task_run, the engine's `gating.phasesCompleted` array extracted
   * in SQL via `json_extract` (so the fat `solution_outputs_json` blob never
   * leaves SQLite — this endpoint is hard-polled ~1.5s by the SPA) plus its
   * `delivery_tx_hash`. `phasesJson` is the JSON text of the array, or NULL
   * when the row's `solution_outputs_json` is NULL, malformed, or lacks the
   * gating path. The `json_valid` guard is load-bearing: `json_extract` throws
   * `SQLITE_ERROR: malformed JSON` on invalid text, which would abort the whole
   * query — guarding to NULL keeps the per-row never-throw semantics (NULL ⇒
   * `[]` in the caller). Across all rows regardless of state. SQLite ships with
   * the JSON1 extension, so `json_extract`/`json_valid` are always available.
   */
  getGatingRows(): Array<{ phasesJson: string | null; deliveredTxHash: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT CASE
                  WHEN json_valid(solution_outputs_json)
                  THEN json_extract(solution_outputs_json, '$.gating.phasesCompleted')
                  ELSE NULL
                END AS phases_json,
                delivery_tx_hash
         FROM task_runs`,
      )
      .all() as Array<{ phases_json: string | null; delivery_tx_hash: string | null }>;
    return rows.map((r) => ({
      phasesJson: r.phases_json,
      deliveredTxHash: r.delivery_tx_hash,
    }));
  }

  /**
   * Single-flight gate: is there a non-terminal task_run for the given
   * routing key + role, in the same SolverNet?
   *
   * `manifestCid` scopes the gate to one SolverNet:
   *   - When a string is supplied, only rows whose `solver_net_manifest_cid`
   *     equals it count. Two distinct SolverNets that happen to share the
   *     same `contract.id.version` routing key (e.g. mainline SWE-rebench-v2
   *     and an isolated SWE-rebench-v2 launched at a separate manifestCid)
   *     each hold their own in-flight slot.
   *   - When `null` is supplied, only rows with NULL `solver_net_manifest_cid`
   *     count (legacy / health-check tasks form their own bucket).
   *   - When omitted (`undefined`), the manifest filter is dropped — the
   *     historical routing-key-only behaviour. Production callers always
   *     pass an explicit value; this path exists for legacy tests.
   *
   * The bug this fix closes: an operator joined to multiple SolverNets that
   * share the same routing key had ONE in-flight slot across all of them, so
   * a task in SolverNet B was silently rejected with
   * `another <routingKey>/<role> task is already in flight` whenever the
   * operator was busy on SolverNet A.
   */
  hasInFlightFor(args: {
    solverType: string;
    taskRole: 'restoration' | 'evaluation';
    excludeRequestId?: string;
    manifestCid?: string | null;
  }): boolean {
    const terminalList = [...TERMINAL_STATES];
    const placeholders = terminalList.map((_, i) => `@terminal${i}`).join(', ');
    const params: Record<string, string> = {
      solverType: args.solverType,
      taskRole: args.taskRole,
      excludeRequestId: args.excludeRequestId ?? '',
    };
    terminalList.forEach((state, i) => {
      params[`terminal${i}`] = state;
    });
    let manifestClause = '';
    if (args.manifestCid === null) {
      manifestClause = 'AND solver_net_manifest_cid IS NULL';
    } else if (typeof args.manifestCid === 'string') {
      manifestClause = 'AND solver_net_manifest_cid = @manifestCid';
      params['manifestCid'] = args.manifestCid;
    }
    const row = this.db.prepare(`
      SELECT 1
      FROM task_runs
      WHERE solver_type = @solverType
        AND COALESCE(task_role, 'restoration') = @taskRole
        AND state NOT IN (${placeholders})
        AND request_id != @excludeRequestId
        ${manifestClause}
      LIMIT 1
    `).get(params) as { 1: number } | undefined;
    return row !== undefined;
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

  /** Journal and confirm the correctness-critical pre-adoption metadata anchor. */
  setDeliveryDiscoveryAnchor(
    requestId: string,
    txHash: string | null,
    blockNumber: number | null,
  ): void {
    this.db.prepare(`
      UPDATE task_runs
      SET delivery_discovery_anchor_tx_hash = ?,
          delivery_discovery_anchor_block_number = ?
      WHERE request_id = ? AND state = 'DELIVERING'
    `).run(txHash, blockNumber, requestId);
  }

  /** Persist a receipt observation while the run remains AWAITING_ADOPTION. */
  setAdoptionObservation(
    requestId: string,
    observation: AdoptionObservation,
    nextObservationAt: number,
  ): void {
    this.db.prepare(`
      UPDATE task_runs
      SET adoption_last_observation = ?, adoption_last_error = NULL,
          adoption_observation_attempts = adoption_observation_attempts + 1,
          adoption_next_observation_at = ?,
          state_updated_at = ?
      WHERE request_id = ? AND state = 'AWAITING_ADOPTION'
    `).run(
      JSON.stringify(observation),
      nextObservationAt,
      Date.now(),
      requestId,
    );
  }

  /** Persist a retryable observer error without failing or advancing the run. */
  setAdoptionError(
    requestId: string,
    error: string,
    nextObservationAt: number,
  ): void {
    this.db.prepare(`
      UPDATE task_runs
      SET adoption_last_error = ?,
          adoption_observation_attempts = adoption_observation_attempts + 1,
          adoption_next_observation_at = ?,
          state_updated_at = ?
      WHERE request_id = ? AND state = 'AWAITING_ADOPTION'
    `).run(error, nextObservationAt, Date.now(), requestId);
  }

  /** Refresh the adoption observation at the final Router-claim boundary. */
  setClaimingAdoptionObservation(
    requestId: string,
    observation: AdoptionObservation,
    nextObservationAt: number | null,
  ): void {
    this.db.prepare(`
      UPDATE task_runs
      SET adoption_last_observation = ?, adoption_last_error = NULL,
          adoption_observation_attempts = adoption_observation_attempts + 1,
          adoption_next_observation_at = ?,
          state_updated_at = ?
      WHERE request_id = ? AND state = 'CLAIMING_DELIVERY'
    `).run(
      JSON.stringify(observation),
      nextObservationAt,
      Date.now(),
      requestId,
    );
  }

  /** Keep a claim retryable when the claim-boundary observer is unavailable. */
  setClaimingAdoptionError(
    requestId: string,
    error: string,
    nextObservationAt: number,
  ): void {
    this.db.prepare(`
      UPDATE task_runs
      SET adoption_last_error = ?,
          adoption_observation_attempts = adoption_observation_attempts + 1,
          adoption_next_observation_at = ?,
          state_updated_at = ?
      WHERE request_id = ? AND state = 'CLAIMING_DELIVERY'
    `).run(error, nextObservationAt, Date.now(), requestId);
  }

  /**
   * Persist `consumedRefsJson` without triggering a state transition (state
   * remains RUNNING). Called by runImpl right after the corpus-knowledge
   * lookup resolves — BEFORE harness spawn — so that a crash between the
   * lookup and the RUNNING → POST_SNAPSHOT transition still leaves the
   * result durably recorded (#1393 review finding 1). Without this, a
   * restarted process (empty in-memory cache, DB column still null) would
   * re-query the corpus and re-emit a duplicate `corpus_knowledge` event.
   */
  setConsumedRefsJson(requestId: string, consumedRefsJson: string | null): void {
    this.db.prepare(
      'UPDATE task_runs SET consumed_refs_json = ? WHERE request_id = ?',
    ).run(consumedRefsJson, requestId);
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

  /**
   * Persist the on-chain creation-block timestamp for a task (#1827).
   * Called once per claimed task from `claim()`. Idempotent — safe to call
   * repeatedly with the same value (e.g. on retry after a crash between
   * the RPC call and the CLAIMED transition).
   */
  setOnchainCreationTimestamp(requestId: string, timestampSec: number): void {
    this.db.prepare(
      'UPDATE task_runs SET onchain_creation_timestamp = ? WHERE request_id = ?',
    ).run(timestampSec, requestId);
  }

  /** Mark an task FAILED with a reason (valid from any non-terminal state). */
  markFailed(requestId: string, reason: string): void {
    const existing = this.getByRequestId(requestId);
    if (!existing) {
      throw new Error(`Task run not found: ${requestId}`);
    }
    if (TERMINAL_STATES.has(existing.state)) {
      // Already terminal — no-op (idempotent). Includes COMPLETE / FAILED /
      // RACE_LOST so a late markFailed after a race-loss classification
      // doesn't downgrade a benign prune to an operator failure.
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

  /**
   * Administrative recovery for one already-validated false adoption
   * contradiction. This is deliberately not a state-machine transition:
   * FAILED remains terminal during ordinary execution.
   *
   * Every recovery-critical value from the validated snapshot participates in
   * the WHERE clause. A changed row returns false instead of partially
   * applying stale authority. Delivery and execution evidence are never
   * rewritten; only the adoption scheduler is made live again.
   */
  requeueFailedAdoptionObservation(
    expected: PersistedTaskRun,
    recoveredAt: number,
  ): boolean {
    if (expected.state !== 'FAILED') return false;
    const json = (value: unknown): string | null =>
      value === null ? null : JSON.stringify(value);
    const result = this.db.prepare(`
      UPDATE task_runs
      SET state = 'AWAITING_ADOPTION',
          state_updated_at = @recoveredAt,
          failure_reason = NULL,
          failure_at = NULL,
          adoption_last_error = NULL,
          adoption_next_observation_at = @recoveredAt
      WHERE request_id = @requestId
        AND state = 'FAILED'
        AND state_updated_at = @stateUpdatedAt
        AND failure_reason IS @failureReason
        AND failure_at IS @failureAt
        AND task_id IS @taskId
        AND attempt_index IS @attemptIndex
        AND task_cid = @taskCid
        AND onchain_creation_tx = @onchainCreationTx
        AND onchain_creation_block = @onchainCreationBlock
        AND onchain_creation_timestamp IS @onchainCreationTimestamp
        AND solver_type IS @solverType
        AND solver_net_manifest_cid IS @solverNetManifestCid
        AND task_role IS @taskRole
        AND impl_name IS @implName
        AND task_payload IS @taskPayload
        AND working_dir IS @workingDir
        AND impl_state_dir IS @implStateDir
        AND window_start_ts = @windowStartTs
        AND window_end_ts = @windowEndTs
        AND run_started_at IS @runStartedAt
        AND pre_snapshot_captured_at IS @preSnapshotCapturedAt
        AND pre_snapshot_payload IS @preSnapshotPayload
        AND post_snapshot_captured_at IS @postSnapshotCapturedAt
        AND post_snapshot_payload IS @postSnapshotPayload
        AND fills_payload IS @fillsPayload
        AND gating_claim IS @gatingClaim
        AND informational_claim IS @informationalClaim
        AND artifact_cids IS @artifactCids
        AND manifest_generated_at IS @manifestGeneratedAt
        AND manifest_cid IS @manifestCid
        AND delivery_tx_hash IS @deliveryTxHash
        AND delivery_digest IS @deliveryDigest
        AND delivery_discovery_anchor_tx_hash IS @deliveryAnchorTxHash
        AND delivery_discovery_anchor_block_number IS @deliveryAnchorBlock
        AND evidence_hash IS @evidenceHash
        AND solution_outputs_json IS @solutionOutputsJson
        AND intermediate_failure_diffs_json IS @intermediateFailureDiffsJson
        AND runtime_plugins_json IS @runtimePluginsJson
        AND consumed_refs_json IS @consumedRefsJson
        AND executor_mode IS @executorMode
        AND executor_code_digest IS @executorCodeDigest
        AND adoption_receipt_location IS @adoptionReceiptLocation
        AND adoption_receipt_authors IS @adoptionReceiptAuthors
        AND adoption_wait_started_at IS @adoptionWaitStartedAt
        AND adoption_observation_attempts = @adoptionObservationAttempts
        AND adoption_next_observation_at IS @adoptionNextObservationAt
        AND adoption_last_observation IS @adoptionLastObservation
        AND adoption_accepted_receipt IS @adoptionAcceptedReceipt
        AND adoption_last_error IS @adoptionLastError
    `).run({
      recoveredAt,
      requestId: expected.requestId,
      stateUpdatedAt: expected.stateUpdatedAt,
      failureReason: expected.failureReason,
      failureAt: expected.failureAt,
      taskId: expected.taskId,
      attemptIndex: expected.attemptIndex,
      taskCid: expected.taskCid,
      onchainCreationTx: expected.onchainCreationTx,
      onchainCreationBlock: expected.onchainCreationBlock,
      onchainCreationTimestamp: expected.onchainCreationTimestamp,
      solverType: expected.solverType,
      solverNetManifestCid: expected.solverNetManifestCid,
      taskRole: expected.taskRole,
      implName: expected.implName,
      taskPayload: json(expected.task),
      workingDir: expected.workingDir,
      implStateDir: expected.implStateDir,
      windowStartTs: expected.windowStartTs,
      windowEndTs: expected.windowEndTs,
      runStartedAt: expected.runStartedAt,
      preSnapshotCapturedAt: expected.preSnapshotCapturedAt,
      preSnapshotPayload: json(expected.preSnapshotPayload),
      postSnapshotCapturedAt: expected.postSnapshotCapturedAt,
      postSnapshotPayload: json(expected.postSnapshotPayload),
      fillsPayload: json(expected.fillsPayload),
      gatingClaim: json(expected.gatingClaim),
      informationalClaim: json(expected.informationalClaim),
      artifactCids: json(expected.artifactCids),
      manifestGeneratedAt: expected.manifestGeneratedAt,
      manifestCid: expected.manifestCid,
      deliveryTxHash: expected.deliveryTxHash,
      deliveryDigest: expected.deliveryDigest,
      deliveryAnchorTxHash: expected.deliveryDiscoveryAnchorTxHash,
      deliveryAnchorBlock: expected.deliveryDiscoveryAnchorBlockNumber,
      evidenceHash: expected.evidenceHash,
      solutionOutputsJson: expected.solutionOutputsJson,
      intermediateFailureDiffsJson: expected.intermediateFailureDiffsJson,
      runtimePluginsJson: expected.runtimePluginsJson,
      consumedRefsJson: expected.consumedRefsJson,
      executorMode: expected.executorMode,
      executorCodeDigest: expected.executorCodeDigest,
      adoptionReceiptLocation: json(expected.adoptionReceiptLocation),
      adoptionReceiptAuthors: json(expected.adoptionReceiptAuthors),
      adoptionWaitStartedAt: expected.adoptionWaitStartedAt,
      adoptionObservationAttempts: expected.adoptionObservationAttempts,
      adoptionNextObservationAt: expected.adoptionNextObservationAt,
      adoptionLastObservation: json(expected.adoptionLastObservation),
      adoptionAcceptedReceipt: json(expected.adoptionAcceptedReceipt),
      adoptionLastError: expected.adoptionLastError,
    });
    return result.changes === 1;
  }

  /**
   * Administrative backfill (#506): reclassify a FAILED row as COMPLETE when
   * its on-chain delivery actually landed — the run failed only because a
   * downstream persistence step (e.g. the legacy `desired_state_id` NOT NULL
   * insertArtifact throw, fixed in #511) threw after the delivery tx was
   * already broadcast and confirmed.
   *
   * Deliberately bypasses `assertValidTransition` — there is no FAILED →
   * COMPLETE edge in the state machine, and there shouldn't be one; this is
   * an out-of-band operator-invoked correction driven by on-chain evidence
   * (a successful transaction receipt), not a transition the engine itself
   * would ever perform. Idempotent: returns `false` and makes no change if
   * the row is missing or not currently FAILED.
   */
  reclassifyFailedAsComplete(requestId: string): boolean {
    const existing = this.getByRequestId(requestId);
    if (!existing || existing.state !== 'FAILED') return false;
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE task_runs
      SET state = 'COMPLETE', state_updated_at = ?, failure_reason = NULL, failure_at = NULL
      WHERE request_id = ? AND state = 'FAILED'
    `).run(now, requestId);
    return result.changes > 0;
  }

  /**
   * Mark a task RACE_LOST with a reason (valid from any non-terminal state).
   * Peer to `markFailed`, semantically distinct: the run never produced
   * operator-attributable work — another operator pruned the on-chain slot
   * (TCMaxVerdictsReached, TCAttemptAlreadyFinalized, …) before we got
   * anywhere. Dashboards must NOT count these as failures (#896).
   *
   * Reuses the existing `failure_reason` / `failure_at` columns to avoid a
   * schema migration: the engine-level classifier is the source of truth
   * for "is this a failure vs a race-loss", not the column name.
   *
   * Idempotent on any terminal state (COMPLETE / FAILED / RACE_LOST): a
   * late race-loss classification after a successful run or an operator
   * failure must not rewrite the row.
   */
  markRaceLost(requestId: string, reason: string): void {
    const existing = this.getByRequestId(requestId);
    if (!existing) {
      throw new Error(`Task run not found: ${requestId}`);
    }
    if (TERMINAL_STATES.has(existing.state)) {
      // Already terminal — no-op (idempotent).
      return;
    }
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE task_runs
      SET state = 'RACE_LOST', state_updated_at = ?, failure_reason = ?, failure_at = ?
      WHERE request_id = ? AND state = ?
    `).run(now, reason, now, requestId, existing.state);
    if (result.changes === 0) {
      throw new ConcurrentTransitionError(requestId, existing.state, 'RACE_LOST');
    }
  }
}
