/**
 * Restorer engine — SQLite persistence helpers.
 *
 * §6.4 of spec/2026-04-17-portfolio-v0-design.md
 *
 * Wraps the Store's underlying Database instance via the Store class — the
 * Store itself holds the DB handle; we extend it with engine-specific queries.
 * To keep concerns clean, this module exports a standalone `IntentPersistence`
 * class that is constructed with a `Database` instance (passed from Store).
 */

import type Database from 'better-sqlite3';
import { assertValidTransition, TERMINAL_STATES, type IntentState } from './state.js';
import type { RestorationJob } from '../../types/desired-state.js';

// ── Concurrency error ─────────────────────────────────────────────────────────

/**
 * Thrown by `transition()` and `markFailed()` when the DB row has already been
 * updated by a concurrent call before the UPDATE could land.
 *
 * Callers should treat this as a signal to retry from the fresh DB state or
 * abandon the operation (the concurrent call has already advanced the intent).
 */
export class ConcurrentTransitionError extends Error {
  readonly requestId: string;
  readonly expectedState: IntentState;
  readonly attemptedNewState: string;

  constructor(requestId: string, expectedState: IntentState, attemptedNewState: string) {
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

export const RESTORATION_INTENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS restoration_intents (
  request_id              TEXT PRIMARY KEY,
  intent_cid              TEXT NOT NULL,
  onchain_creation_tx     TEXT NOT NULL,
  onchain_creation_block  INTEGER NOT NULL,
  spec_kind               TEXT,
  intent_type             TEXT,     -- 'restoration' | 'evaluation' | NULL (legacy)
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

  -- Additive column (schema migration 2026-04-17, full RestorationJob threading):
  -- desired_state_payload: full RestorationJob JSON, captured at observe() time.
  -- NULL for pre-migration rows (legacy fallback in engine consumers).
  desired_state_payload   TEXT,

  -- Additive column (added by WT-C for PACKAGING recovery fidelity):
  -- impl_outputs_json: serialised RestorationOutput persisted before the
  --   RUNNING → PACKAGING transition. Enables pack() to recover impl outputs
  --   after a crash without re-executing the impl. NULL once pack() succeeds.
  impl_outputs_json       TEXT,

  failure_reason          TEXT,
  failure_at              INTEGER
);

CREATE INDEX IF NOT EXISTS idx_restoration_intents_state
  ON restoration_intents(state);

CREATE INDEX IF NOT EXISTS idx_restoration_intents_window_start_ts
  ON restoration_intents(window_start_ts);
`;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Input when first observing an intent from an on-chain event. */
export interface PersistedIntentInput {
  requestId: string;
  intentCid: string;
  onchainCreationTx: string;
  onchainCreationBlock: number;
  specKind?: string;
  /** 'restoration' (default) or 'evaluation'. Captured from RestorationJob.type at observe() time. */
  intentType?: 'restoration' | 'evaluation';
  windowStartTs: number;
  windowEndTs: number;
  /**
   * Full RestorationJob payload, captured at observe() time.
   * Required: production callers always thread it (daemon.ts); making this
   * required provides a type-level guarantee against silent regression to the
   * stub path. Tests that need to exercise the pre-migration NULL row path
   * must use a direct raw SQL INSERT.
   */
  restorationJob: RestorationJob;
}

/** Full persisted intent row (all columns). */
export interface PersistedIntent {
  requestId: string;
  intentCid: string;
  onchainCreationTx: string;
  onchainCreationBlock: number;
  specKind: string | null;
  intentType: 'restoration' | 'evaluation' | null;
  implName: string | null;

  state: IntentState;
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

  /** Full RestorationJob payload as recorded at observe() time; null for pre-migration rows. */
  restorationJob: RestorationJob | null;

  /**
   * Serialised RestorationOutput from runImpl, persisted before the
   * RUNNING → PACKAGING transition. Used by pack() to recover impl outputs
   * after a crash so the manifest CID remains deterministic. Null for
   * pre-migration rows and intents that have already been packed.
   * Added by WT-C for PACKAGING recovery fidelity.
   */
  implOutputsJson: string | null;

  failureReason: string | null;
  failureAt: number | null;
}

/**
 * Fields that can be patched during a transition.
 * Only lists fields that `transition()` actually writes — attempting to patch
 * other fields (e.g. `specKind`, window timestamps) gives a compile-time error
 * instead of silently dropping the value.
 */
export type IntentPatch = Partial<{
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
   * Serialised RestorationOutput JSON, persisted before RUNNING → PACKAGING.
   * Enables pack() to recover impl outputs after a crash without re-executing
   * the impl. Set by engine.runImpl(); cleared by engine after successful pack().
   * Added by WT-C for PACKAGING recovery fidelity.
   */
  implOutputsJson: string | null;
}>;

// ── Raw DB row (snake_case from SQLite) ───────────────────────────────────────

interface RawRow {
  request_id: string;
  intent_cid: string;
  onchain_creation_tx: string;
  onchain_creation_block: number;
  spec_kind: string | null;
  intent_type: string | null;
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
  desired_state_payload: string | null;
  impl_outputs_json: string | null;
  failure_reason: string | null;
  failure_at: number | null;
}

// ── Migrations ────────────────────────────────────────────────────────────────

/**
 * Idempotent additive migrations for `restoration_intents`.
 *
 * better-sqlite3 throws on duplicate column from ALTER TABLE ADD COLUMN; we
 * swallow that specific error so this is safe to invoke on every startup.
 * For new DBs the column already exists via CREATE TABLE; the ALTER is a no-op.
 */
function runAdditiveMigrations(db: Database.Database): void {
  const additions: Array<{ column: string; ddl: string }> = [
    { column: 'desired_state_payload', ddl: 'ALTER TABLE restoration_intents ADD COLUMN desired_state_payload TEXT' },
    { column: 'manifest_generated_at', ddl: 'ALTER TABLE restoration_intents ADD COLUMN manifest_generated_at TEXT NULL' },
    { column: 'evidence_hash',         ddl: 'ALTER TABLE restoration_intents ADD COLUMN evidence_hash TEXT NULL' },
    // Persists impl outputs so pack() can recover a deterministic manifest CID
    // after a process restart (otherwise in-memory implOutputs is lost).
    { column: 'impl_outputs_json',     ddl: 'ALTER TABLE restoration_intents ADD COLUMN impl_outputs_json TEXT' },
    { column: 'intent_type',           ddl: 'ALTER TABLE restoration_intents ADD COLUMN intent_type TEXT' },
  ];

  // Fetch existing column names once so each ALTER is a no-op if the column
  // already exists (avoids duplicate-column-name errors on newer DBs).
  const existingColumns = new Set(
    (db.pragma('table_info(restoration_intents)') as Array<{ name: string }>)
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

function rowToIntent(row: RawRow): PersistedIntent {
  return {
    requestId: row.request_id,
    intentCid: row.intent_cid,
    onchainCreationTx: row.onchain_creation_tx,
    onchainCreationBlock: row.onchain_creation_block,
    specKind: row.spec_kind,
    intentType: (row.intent_type ?? null) as 'restoration' | 'evaluation' | null,
    implName: row.impl_name,
    state: row.state as IntentState,
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
    restorationJob: parseJson<RestorationJob>(row.desired_state_payload),
    implOutputsJson: row.impl_outputs_json,
    failureReason: row.failure_reason,
    failureAt: row.failure_at,
  };
}

// ── IntentPersistence ─────────────────────────────────────────────────────────

/**
 * Low-level CRUD helpers for `restoration_intents`.
 *
 * Constructed with the raw better-sqlite3 `Database` instance. The `Store`
 * class exposes it via `store.db` — callers that have a `Store` can pass
 * `store.db` here.
 */
export class IntentPersistence {
  constructor(private readonly db: Database.Database) {
    runAdditiveMigrations(db);
  }

  /**
   * Insert a DISCOVERED intent row. Idempotent: if a row with the same
   * `requestId` already exists, this is a no-op (INSERT OR IGNORE).
   */
  insertDiscovered(input: PersistedIntentInput): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO restoration_intents (
        request_id, intent_cid, onchain_creation_tx, onchain_creation_block,
        spec_kind, intent_type, state, state_updated_at, window_start_ts, window_end_ts,
        desired_state_payload
      ) VALUES (
        @requestId, @intentCid, @onchainCreationTx, @onchainCreationBlock,
        @specKind, @intentType, 'DISCOVERED', @now, @windowStartTs, @windowEndTs,
        @desiredStatePayload
      )
    `).run({
      requestId: input.requestId,
      intentCid: input.intentCid,
      onchainCreationTx: input.onchainCreationTx,
      onchainCreationBlock: input.onchainCreationBlock,
      specKind: input.specKind ?? null,
      intentType: input.intentType ?? null,
      now: Date.now(),
      windowStartTs: input.windowStartTs,
      windowEndTs: input.windowEndTs,
      desiredStatePayload: input.restorationJob ? JSON.stringify(input.restorationJob) : null,
    });
  }

  /**
   * Transition an intent to a new state. Validates the transition and writes
   * the new state + optional patch fields atomically (persist-before-invoke).
   */
  transition(requestId: string, toState: IntentState, patch: IntentPatch = {}): void {
    const existing = this.getByRequestId(requestId);
    if (!existing) {
      throw new Error(`Intent not found: ${requestId}`);
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
    if (patch.implOutputsJson !== undefined) {
      setClauses.push('impl_outputs_json = @implOutputsJson');
      params['implOutputsJson'] = patch.implOutputsJson;
    }
    // Optimistic concurrency: include AND state = @expectedState in the WHERE
    // clause so a concurrent call that already advanced the row results in 0
    // changed rows rather than a silent double-write.
    params['expectedState'] = existing.state;
    const result = this.db.prepare(`
      UPDATE restoration_intents SET ${setClauses.join(', ')}
      WHERE request_id = @requestId AND state = @expectedState
    `).run(params);
    if (result.changes === 0) {
      throw new ConcurrentTransitionError(requestId, existing.state, toState);
    }
  }

  /** Fetch a single intent by request ID. Returns null if not found. */
  getByRequestId(requestId: string): PersistedIntent | null {
    const row = this.db.prepare(
      'SELECT * FROM restoration_intents WHERE request_id = ?',
    ).get(requestId) as RawRow | undefined;
    if (!row) return null;
    return rowToIntent(row);
  }

  /**
   * Fetch a single intent by request ID. Throws if not found.
   * Use this in code paths where the intent is guaranteed to exist
   * (e.g. immediately after a successful `transition()` call).
   */
  getOrThrow(requestId: string): PersistedIntent {
    const row = this.getByRequestId(requestId);
    if (!row) {
      throw new Error(`No persisted intent for requestId ${requestId}`);
    }
    return row;
  }

  /** Fetch all intents in a given state. */
  getByState(state: IntentState): PersistedIntent[] {
    const rows = this.db.prepare(
      'SELECT * FROM restoration_intents WHERE state = ? ORDER BY window_start_ts ASC',
    ).all(state) as RawRow[];
    return rows.map(rowToIntent);
  }

  /** Fetch all in-flight intents (not in any terminal state). */
  getInFlight(): PersistedIntent[] {
    const terminalList = [...TERMINAL_STATES];
    const placeholders = terminalList.map(() => '?').join(', ');
    const sql = `SELECT * FROM restoration_intents WHERE state NOT IN (${placeholders}) ORDER BY window_start_ts ASC`;
    const rows = this.db.prepare(sql).all(...terminalList) as RawRow[];
    return rows.map(rowToIntent);
  }

  /**
   * Persist `deliveryTxHash` without triggering a state transition (state
   * remains DELIVERING). Called after deliverToMarketplace lands on-chain but
   * before claimDelivery runs, so that a crash between the two steps can be
   * recovered without re-submitting the deliver transaction.
   */
  setDeliveryTxHash(requestId: string, deliveryTxHash: string): void {
    this.db.prepare(
      'UPDATE restoration_intents SET delivery_tx_hash = ? WHERE request_id = ?',
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
      'UPDATE restoration_intents SET manifest_generated_at = ? WHERE request_id = ? AND manifest_generated_at IS NULL',
    ).run(generatedAt, requestId);
  }

  /** Mark an intent FAILED with a reason (valid from any non-terminal state). */
  markFailed(requestId: string, reason: string): void {
    const existing = this.getByRequestId(requestId);
    if (!existing) {
      throw new Error(`Intent not found: ${requestId}`);
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
      UPDATE restoration_intents
      SET state = 'FAILED', state_updated_at = ?, failure_reason = ?, failure_at = ?
      WHERE request_id = ? AND state = ?
    `).run(now, reason, now, requestId, existing.state);
    if (result.changes === 0) {
      throw new ConcurrentTransitionError(requestId, existing.state, 'FAILED');
    }
  }
}
