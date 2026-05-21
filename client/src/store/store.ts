import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  EnvelopeProjection,
  EnvelopeProjectionMetadataValue,
  EnvelopeProjectionQuery,
} from '../corpus/types.js';
import { TASK_RUNS_SCHEMA } from '../harnesses/engine/persistence.js';
import type { TxSubmissionKey, TxSubmissionLedgerEntry } from '../tx-retry.js';
import { normalizeEnvelopeRole, type Role } from '../types/envelope.js';

export interface ActivityEventInput {
  ts: string | null;
  kind: string;
  requestId?: string | null;
  serviceIndex?: number | null;
  txHash?: string | null;
  solverType?: string | null;
  outcome?: string | null;
  detail?: string | null;
  credentialId?: string | null;
  costUsdMicros?: number | null;
  model?: string | null;
}

export interface ActivityEventRow {
  id: number;
  ts: string | null;
  kind: string;
  requestId: string | null;
  serviceIndex: number | null;
  txHash: string | null;
  solverType: string | null;
  outcome: string | null;
  detail: string | null;
  credentialId: string | null;
  costUsdMicros: number | null;
  model: string | null;
}

export interface RewardClaimInput {
  ts: string;
  serviceIndex: number;
  serviceId?: number | null;
  stakingProxy: string;
  distributor: string;
  txHash: string;
  amountWei: string;
  asset?: string;
}

export interface BalanceCacheEntry {
  role: string;
  address: string;
  nativeWei?: string | null;
  bondWei?: string | null;
  assetExtraJson?: string | null;
  fetchedAt: string;
  error?: string | null;
}

export interface ServedArtifactInput {
  sha256: string;
  artifactType: string;
  requestId?: string | null;
  envelopeCid?: string | null;
  content: Buffer;
  priceUsdc: string;
  createdAt: string;
}

export interface ServedArtifactRow {
  sha256: string;
  artifactType: string;
  requestId: string | null;
  envelopeCid: string | null;
  content: Buffer;
  contentSize: number;
  priceUsdc: string;
  createdAt: string;
}

export interface ServedArtifactMetadataRow {
  sha256: string;
  artifactType: string;
  requestId: string | null;
  envelopeCid: string | null;
  contentSize: number;
  priceUsdc: string;
  createdAt: string;
}

export type ArtifactAccessOutcome =
  | 'free_served'
  | 'payment_required'
  | 'paid_served'
  | 'verification_failed'
  | 'settlement_failed'
  | 'payment_malformed'
  | 'not_found';

export interface ArtifactAccessEventInput {
  sha256: string;
  artifactType?: string | null;
  priceUsdc?: string | null;
  outcome: ArtifactAccessOutcome;
  httpStatus: number;
  payer?: string | null;
  settlementTx?: string | null;
  errorReason?: string | null;
  remoteAddr?: string | null;
  userAgent?: string | null;
  createdAt: string;
}

export interface ArtifactAccessEventRow {
  id: number;
  sha256: string;
  artifactType: string | null;
  priceUsdc: string | null;
  outcome: ArtifactAccessOutcome;
  httpStatus: number;
  payer: string | null;
  settlementTx: string | null;
  errorReason: string | null;
  remoteAddr: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface ArtifactAccessStats {
  accessCount: number;
  paidServeCount: number;
  freeServeCount: number;
  failedPaymentCount: number;
  paymentRequiredCount: number;
  revenueUsdc: string;
  lastAccessAt: string | null;
  lastPaidAt: string | null;
}

export type NetworkArtifactSource = 'origin' | 'route-resolver' | 'self-store-mirror';

export interface NetworkArtifactInput {
  sha256: string;
  artifactType: string;
  envelopeCid?: string | null;
  content: Buffer;
  source: NetworkArtifactSource;
  sourceOperator?: string | null;
  sourceEndpoint?: string | null;
  paidAmountUsdc: string;
  fetchedAt: string;
  /** When set, links this blob to a row from the HTTP catalog / peer sync `artifacts.id`. */
  peerCatalogId?: string | null;
}

export interface NetworkArtifactRow {
  sha256: string;
  artifactType: string;
  envelopeCid: string | null;
  content: Buffer;
  contentSize: number;
  source: NetworkArtifactSource;
  sourceOperator: string | null;
  sourceEndpoint: string | null;
  paidAmountUsdc: string;
  fetchedAt: string;
  lastUsedAt: string;
  peerCatalogId: string | null;
}

export interface NetworkArtifactMetadataRow {
  sha256: string;
  artifactType: string;
  envelopeCid: string | null;
  contentSize: number;
  source: NetworkArtifactSource;
  sourceOperator: string | null;
  sourceEndpoint: string | null;
  paidAmountUsdc: string;
  fetchedAt: string;
  lastUsedAt: string;
  peerCatalogId: string | null;
}

export type TaskPostingPolicyType = 'once_per_safe' | 'once_per_bucket' | 'interval';
type LauncherTaskProjectionState = 'open' | 'claims-in-flight' | 'fully-claimed' | 'settled' | 'failed';

export interface TaskPostRecord {
  creatorSafeAddress: string;
  sourceKey: string;
  policyType: TaskPostingPolicyType;
  scopeKey: string;
  taskId: string;
  protocolTaskId?: string | null;
  taskCid?: string | null;
  requestId: string;
  firstPostedAt: string;
  lastPostedAt: string;
  postCount: number;
}

interface LocalTaskRunProjectionRow {
  request_id: string;
  state: string;
  task_role: string | null;
  task_payload: string | null;
  delivery_tx_hash: string | null;
  state_updated_at: number;
}

function readClaimPolicyMaxClaims(taskPayload: string | null): number | undefined {
  if (!taskPayload) return undefined;
  try {
    const parsed = JSON.parse(taskPayload) as {
      claimPolicy?: { maxClaims?: unknown };
      signedTask?: { claimPolicy?: { maxClaims?: unknown } };
    };
    const value = parsed.claimPolicy?.maxClaims ?? parsed.signedTask?.claimPolicy?.maxClaims;
    return Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined;
  } catch {
    return undefined;
  }
}

function derivePostedTaskLocalState(args: {
  runs: LocalTaskRunProjectionRow[];
  localRestorationClaims: number;
  maxClaims?: number;
}): LauncherTaskProjectionState | undefined {
  if (args.runs.some((run) => run.state === 'FAILED')) return 'failed';
  if (args.runs.some((run) => run.state === 'COMPLETE' || run.delivery_tx_hash)) return 'settled';
  if (args.maxClaims !== undefined && args.localRestorationClaims >= args.maxClaims) {
    return 'fully-claimed';
  }
  if (args.localRestorationClaims > 0 || args.runs.length > 0) return 'claims-in-flight';
  return undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS own_activity (
  request_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('created', 'claimed', 'delivered', 'evaluated'))
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  protocol_task_id TEXT,
  task_cid TEXT,
  request_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE', 'UNKNOWN')),
  remote INTEGER NOT NULL DEFAULT 0,
  owner_address TEXT,
  endpoint TEXT,
  price TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_artifacts_outcome ON artifacts (outcome);
CREATE INDEX IF NOT EXISTS idx_artifacts_remote ON artifacts (remote);

CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  kind TEXT NOT NULL,
  request_id TEXT,
  service_index INTEGER,
  tx_hash TEXT,
  solver_type TEXT,
  outcome TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_events_ts ON activity_events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_req ON activity_events (request_id);
CREATE INDEX IF NOT EXISTS idx_activity_events_service_idx ON activity_events (service_index);

CREATE TABLE IF NOT EXISTS tx_submissions (
  chain_id INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  hash TEXT,
  logical_tx TEXT,
  submitted_at_ms INTEGER NOT NULL,
  max_fee_per_gas TEXT,
  max_priority_fee_per_gas TEXT,
  gas_price TEXT,
  to_address TEXT,
  value_wei TEXT,
  data TEXT,
  resolved_at_ms INTEGER,
  PRIMARY KEY (chain_id, from_address, nonce)
);
CREATE INDEX IF NOT EXISTS idx_tx_submissions_unresolved
  ON tx_submissions (chain_id, from_address, nonce)
  WHERE resolved_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS reward_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  service_index INTEGER NOT NULL,
  service_id INTEGER,
  staking_proxy TEXT NOT NULL,
  distributor TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  amount_wei TEXT NOT NULL,
  asset TEXT NOT NULL DEFAULT 'reward'
);
CREATE INDEX IF NOT EXISTS idx_reward_claims_svc ON reward_claims (service_index);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_claims_tx ON reward_claims (tx_hash);

CREATE TABLE IF NOT EXISTS balance_cache (
  role TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  native_wei TEXT,
  bond_wei TEXT,
  asset_extra_json TEXT,
  fetched_at TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS task_posts (
  creator_safe_address TEXT NOT NULL,
  source_key TEXT NOT NULL,
  policy_type TEXT NOT NULL CHECK (policy_type IN ('once_per_safe', 'once_per_bucket', 'interval')),
  scope_key TEXT NOT NULL DEFAULT '',
  task_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  first_posted_at TEXT NOT NULL,
  last_posted_at TEXT NOT NULL,
  post_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (creator_safe_address, source_key, policy_type, scope_key)
);

CREATE TABLE IF NOT EXISTS served_artifacts (
  sha256 TEXT PRIMARY KEY,
  artifact_type TEXT NOT NULL,
  request_id TEXT,
  envelope_cid TEXT,
  content BLOB NOT NULL,
  content_size INTEGER NOT NULL,
  price_usdc TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_served_artifacts_request ON served_artifacts (request_id);
CREATE INDEX IF NOT EXISTS idx_served_artifacts_envelope ON served_artifacts (envelope_cid);
CREATE INDEX IF NOT EXISTS idx_served_artifacts_artifact_type ON served_artifacts (artifact_type);

CREATE TABLE IF NOT EXISTS artifact_access_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256 TEXT NOT NULL,
  artifact_type TEXT,
  price_usdc TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'free_served',
    'payment_required',
    'paid_served',
    'verification_failed',
    'settlement_failed',
    'payment_malformed',
    'not_found'
  )),
  http_status INTEGER NOT NULL,
  payer TEXT,
  settlement_tx TEXT,
  error_reason TEXT,
  remote_addr TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_access_events_sha ON artifact_access_events (sha256);
CREATE INDEX IF NOT EXISTS idx_artifact_access_events_created ON artifact_access_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifact_access_events_outcome ON artifact_access_events (outcome);

CREATE TABLE IF NOT EXISTS network_artifacts (
  sha256 TEXT PRIMARY KEY,
  artifact_type TEXT NOT NULL,
  envelope_cid TEXT,
  content BLOB NOT NULL,
  content_size INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('origin', 'route-resolver', 'self-store-mirror')),
  source_operator TEXT,
  source_endpoint TEXT,
  paid_amount_usdc TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  peer_catalog_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_network_artifacts_envelope ON network_artifacts (envelope_cid);
CREATE INDEX IF NOT EXISTS idx_network_artifacts_artifact_type ON network_artifacts (artifact_type);
CREATE INDEX IF NOT EXISTS idx_network_artifacts_last_used ON network_artifacts (last_used_at DESC);

CREATE TABLE IF NOT EXISTS envelope_projections (
  envelope_id TEXT PRIMARY KEY,
  envelope_cid TEXT,
  envelope_sha256 TEXT,
  signature_hash TEXT NOT NULL,
  solver_type TEXT NOT NULL,
  role TEXT NOT NULL,
  task_cid TEXT,
  task_id TEXT,
  request_id TEXT,
  generated_at INTEGER NOT NULL,
  evidence_tier TEXT NOT NULL,
  participant_safe_address TEXT,
  participant_agent_eoa TEXT,
  executor_impl_name TEXT,
  executor_impl_version TEXT,
  executor_runtime_bundle_digest TEXT,
  executor_plugins_json TEXT NOT NULL DEFAULT '[]',
  solution_envelope_cid TEXT,
  solution_envelope_sha256 TEXT,
  solution_envelope_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_envelope_projections_solver_role ON envelope_projections (solver_type, role);
CREATE INDEX IF NOT EXISTS idx_envelope_projections_task_cid ON envelope_projections (task_cid);
CREATE INDEX IF NOT EXISTS idx_envelope_projections_request ON envelope_projections (request_id);
CREATE INDEX IF NOT EXISTS idx_envelope_projections_generated ON envelope_projections (generated_at DESC);

CREATE TABLE IF NOT EXISTS envelope_projection_metadata (
  envelope_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_text TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('string', 'number', 'boolean')),
  PRIMARY KEY (envelope_id, key),
  FOREIGN KEY (envelope_id) REFERENCES envelope_projections(envelope_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_envelope_projection_metadata_key_value
  ON envelope_projection_metadata (key, value_text);

CREATE TABLE IF NOT EXISTS task_post_locks (
  creator_safe_address TEXT NOT NULL,
  source_key TEXT NOT NULL,
  policy_type TEXT NOT NULL CHECK (policy_type IN ('once_per_safe', 'once_per_bucket', 'interval')),
  scope_key TEXT NOT NULL DEFAULT '',
  owner_token TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  PRIMARY KEY (creator_safe_address, source_key, policy_type, scope_key)
);

CREATE TABLE IF NOT EXISTS pending_captures (
  session_id TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  originating_tool_name TEXT NOT NULL,
  originating_tool_version TEXT,
  capture_path TEXT NOT NULL CHECK (capture_path IN ('A','B','C','D')),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','skipped')),
  span_count INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  redacted_span_count INTEGER NOT NULL,
  repo_remote_url TEXT,
  repo_commit_hash TEXT,
  envelope_cid TEXT,
  published_at TEXT,
  skipped_at TEXT
);
CREATE INDEX IF NOT EXISTS pending_captures_status_capturedat
  ON pending_captures (status, captured_at DESC);

CREATE TABLE IF NOT EXISTS capture_spans (
  session_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  start_time_unix_nano TEXT NOT NULL,
  end_time_unix_nano TEXT NOT NULL,
  attributes_json TEXT NOT NULL,
  redacted_keys_json TEXT NOT NULL,
  PRIMARY KEY (session_id, span_id)
);
CREATE INDEX IF NOT EXISTS capture_spans_session ON capture_spans (session_id);

`;

export class Store {
  /** Exposed for engine persistence layer — treat as package-internal. */
  readonly db: Database.Database;
  readonly path: string;

  /**
   * Legacy schemas predating Task-native IDs (#406) defined `desired_state_id`
   * as `TEXT NOT NULL` on `artifacts`. Newer code only writes `task_id`, which
   * makes inserts revert with "NOT NULL constraint failed: artifacts.desired_state_id"
   * on databases created before the migration. We can't ALTER COLUMN to drop
   * the constraint in SQLite without rebuilding the table, so we detect the
   * legacy column on startup and mirror `task_id` into it from `insertArtifact`.
   */
  private hasLegacyDesiredStateId = false;

  constructor(dbPath: string) {
    this.path = dbPath;
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.db.exec(TASK_RUNS_SCHEMA);
    this.ensureArtifactsTaskColumns();
    this.ensureRewardClaimsTxIndex();
    this.ensureNetworkArtifactsPeerCatalogId();
    this.ensureTaskPostsTaskCoordinatorColumns();
    this.ensureEnvelopeProjectionColumns();
    this.ensureActivityEventCostColumns();
    this.backfillActivityEvents();
    this.recordLegacyRestorationIntentsIgnored();
  }

  /** Older request-first DBs keyed artifacts by desired_state_id before Task-native IDs landed. */
  private ensureArtifactsTaskColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(artifacts)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    this.hasLegacyDesiredStateId = names.has('desired_state_id');
    if (!names.has('task_id')) {
      this.db.exec(`ALTER TABLE artifacts ADD COLUMN task_id TEXT`);
      if (this.hasLegacyDesiredStateId) {
        this.db.exec(`UPDATE artifacts SET task_id = desired_state_id WHERE task_id IS NULL`);
      }
    }
    if (!names.has('protocol_task_id')) {
      this.db.exec(`ALTER TABLE artifacts ADD COLUMN protocol_task_id TEXT`);
    }
    if (!names.has('task_cid')) {
      this.db.exec(`ALTER TABLE artifacts ADD COLUMN task_cid TEXT`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts (task_id)`);
  }

  /** Older on-disk DBs predate `peer_catalog_id` on network_artifacts. */
  private ensureNetworkArtifactsPeerCatalogId(): void {
    const cols = this.db.prepare(`PRAGMA table_info(network_artifacts)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'peer_catalog_id')) {
      this.db.exec(`ALTER TABLE network_artifacts ADD COLUMN peer_catalog_id TEXT`);
    }
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_network_artifacts_peer_catalog ON network_artifacts (peer_catalog_id)`,
    );
  }

  /** Fresh v1 state is Task-first; older local DBs get additive columns only. */
  private ensureTaskPostsTaskCoordinatorColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(task_posts)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('task_id')) {
      this.db.exec(`ALTER TABLE task_posts ADD COLUMN task_id TEXT`);
    }
    if (!names.has('protocol_task_id')) {
      this.db.exec(`ALTER TABLE task_posts ADD COLUMN protocol_task_id TEXT`);
    }
    if (!names.has('task_cid')) {
      this.db.exec(`ALTER TABLE task_posts ADD COLUMN task_cid TEXT`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_task_posts_task ON task_posts (task_id)`);
  }

  /** Older local DBs may have the projection table from before Task grouping fields landed. */
  private ensureEnvelopeProjectionColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(envelope_projections)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    const addColumn = (name: string, ddl: string) => {
      if (!names.has(name)) this.db.exec(`ALTER TABLE envelope_projections ADD COLUMN ${ddl}`);
    };

    addColumn('task_id', 'task_id TEXT');
    addColumn('executor_runtime_bundle_digest', 'executor_runtime_bundle_digest TEXT');
    addColumn('executor_plugins_json', `executor_plugins_json TEXT NOT NULL DEFAULT '[]'`);
    addColumn('solution_envelope_cid', 'solution_envelope_cid TEXT');
    addColumn('solution_envelope_sha256', 'solution_envelope_sha256 TEXT');
    addColumn('solution_envelope_ref', 'solution_envelope_ref TEXT');
    addColumn('metadata_json', `metadata_json TEXT NOT NULL DEFAULT '{}'`);

    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_envelope_projections_task_id ON envelope_projections (task_id)`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_envelope_projections_solution_ref ON envelope_projections (solution_envelope_ref)`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_envelope_projections_generated ON envelope_projections (generated_at DESC)`,
    );
  }

  /** Older local DBs predate the per-credential spend-ledger columns on activity_events. */
  private ensureActivityEventCostColumns(): void {
    const activityCols = new Set(
      (this.db.prepare(`PRAGMA table_info(activity_events)`).all() as Array<{ name: string }>)
        .map(c => c.name),
    );
    const addActivityColumn = (name: string, ddl: string) => {
      if (!activityCols.has(name)) this.db.exec(`ALTER TABLE activity_events ADD COLUMN ${ddl}`);
    };
    addActivityColumn('credential_id', 'credential_id TEXT');
    addActivityColumn('cost_usd_micros', 'cost_usd_micros INTEGER');
    addActivityColumn('model', 'model TEXT');
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_activity_events_credential ON activity_events (credential_id, ts)`,
    );
  }

  /**
   * Task-native startup ignores the retired request-first `restoration_intents`
   * table. Keep a one-time local marker when old in-flight rows are present so
   * operators can see why they were not resumed without blocking Store startup.
   */
  private recordLegacyRestorationIntentsIgnored(): void {
    const table = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'restoration_intents'`,
    ).get() as { name: string } | undefined;
    if (!table) return;

    const cols = this.db.prepare(`PRAGMA table_info(restoration_intents)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('state')) return;

    try {
      const row = this.db.prepare(
        `SELECT COUNT(*) AS count
         FROM restoration_intents
         WHERE state NOT IN ('COMPLETE', 'FAILED')`,
      ).get() as { count: number } | undefined;
      const count = row?.count ?? 0;
      if (count <= 0) return;

      const detail =
        `Ignored ${count} legacy request-first restoration_intents row${count === 1 ? '' : 's'}; ` +
        'Task-native recovery does not resume ClaimRegistry/request-first jobs.';
      const ts = new Date().toISOString();
      const marker = {
        schemaVersion: 1,
        ignoredAt: ts,
        table: 'restoration_intents',
        inFlightRows: count,
        reason: 'legacy_request_first_task_native_update',
      };

      const tx = this.db.transaction(() => {
        this.db.prepare(
          `INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`,
        ).run('legacy_restoration_intents_ignored_v1', JSON.stringify(marker));
        this.db.prepare(
          `INSERT INTO activity_events (ts, kind, outcome, detail)
           SELECT @ts, 'legacy_ignored', 'ignored', @detail
           WHERE NOT EXISTS (
             SELECT 1 FROM activity_events
             WHERE kind = 'legacy_ignored' AND detail = @detail
           )`,
        ).run({ ts, detail });
      });
      tx();
    } catch {
      // Legacy schemas varied. Never let stale request-first state block Store startup.
    }
  }

  /** Idempotent: older DBs before idx_reward_claims_tx may lack the unique index. */
  private ensureRewardClaimsTxIndex(): void {
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_claims_tx ON reward_claims (tx_hash)`,
    );
  }

  recordOwnActivity(requestId: string, role: 'created' | 'claimed' | 'delivered' | 'evaluated'): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO own_activity (request_id, role) VALUES (?, ?)`
    ).run(requestId, role);
    const ts = new Date().toISOString();
    this.recordActivityEvent({ ts, kind: role, requestId });
  }

  isOwnActivity(requestId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM own_activity WHERE request_id = ?').get(requestId);
    return row !== undefined;
  }

  setShutdownState(state: 'clean' | 'running'): void {
    this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('shutdown_state', state);
  }

  getShutdownState(): string | null {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get('shutdown_state') as { value: string } | undefined;
    return row?.value ?? null;
  }

  setDaemonStartedAt(value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('daemon_started_at', value);
  }

  getDaemonStartedAt(): string | null {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get('daemon_started_at') as { value: string } | undefined;
    return row?.value ?? null;
  }

  recordTxSubmission(entry: TxSubmissionLedgerEntry): void {
    this.db.prepare(
      `INSERT INTO tx_submissions
         (chain_id, from_address, nonce, hash, logical_tx, submitted_at_ms,
          max_fee_per_gas, max_priority_fee_per_gas, gas_price, to_address, value_wei, data, resolved_at_ms)
       VALUES
         (@chainId, @fromAddress, @nonce, @hash, @logicalTx, @submittedAtMs,
          @maxFeePerGas, @maxPriorityFeePerGas, @gasPrice, @toAddress, @valueWei, @data, @resolvedAtMs)
       ON CONFLICT(chain_id, from_address, nonce) DO UPDATE SET
         hash = excluded.hash,
         logical_tx = excluded.logical_tx,
         submitted_at_ms = excluded.submitted_at_ms,
         max_fee_per_gas = excluded.max_fee_per_gas,
         max_priority_fee_per_gas = excluded.max_priority_fee_per_gas,
         gas_price = excluded.gas_price,
         to_address = excluded.to_address,
         value_wei = excluded.value_wei,
         data = excluded.data,
         resolved_at_ms = excluded.resolved_at_ms`,
    ).run({
      chainId: entry.chainId,
      fromAddress: entry.from.toLowerCase(),
      nonce: entry.nonce,
      hash: entry.hash ?? null,
      logicalTx: entry.logicalTx ?? null,
      submittedAtMs: entry.submittedAtMs,
      maxFeePerGas: entry.fees.maxFeePerGas?.toString() ?? null,
      maxPriorityFeePerGas: entry.fees.maxPriorityFeePerGas?.toString() ?? null,
      gasPrice: entry.fees.gasPrice?.toString() ?? null,
      toAddress: entry.to?.toLowerCase() ?? null,
      valueWei: entry.value?.toString() ?? null,
      data: entry.data ?? null,
      resolvedAtMs: entry.resolvedAtMs ?? null,
    });
  }

  getTxSubmission(key: TxSubmissionKey): TxSubmissionLedgerEntry | null {
    const row = this.db.prepare(
      `SELECT chain_id, from_address, nonce, hash, logical_tx, submitted_at_ms,
              max_fee_per_gas, max_priority_fee_per_gas, gas_price,
              to_address, value_wei, data, resolved_at_ms
       FROM tx_submissions
       WHERE chain_id = @chainId
         AND from_address = @fromAddress
         AND nonce = @nonce`,
    ).get({
      chainId: key.chainId,
      fromAddress: key.from.toLowerCase(),
      nonce: key.nonce,
    }) as {
      chain_id: number;
      from_address: string;
      nonce: number;
      hash: string | null;
      logical_tx: string | null;
      submitted_at_ms: number;
      max_fee_per_gas: string | null;
      max_priority_fee_per_gas: string | null;
      gas_price: string | null;
      to_address: string | null;
      value_wei: string | null;
      data: string | null;
      resolved_at_ms: number | null;
    } | undefined;
    if (!row) return null;
    return {
      chainId: row.chain_id,
      from: row.from_address as TxSubmissionLedgerEntry['from'],
      nonce: row.nonce,
      hash: row.hash as TxSubmissionLedgerEntry['hash'],
      logicalTx: row.logical_tx ?? undefined,
      submittedAtMs: row.submitted_at_ms,
      fees: {
        ...(row.max_fee_per_gas !== null ? { maxFeePerGas: BigInt(row.max_fee_per_gas) } : {}),
        ...(row.max_priority_fee_per_gas !== null
          ? { maxPriorityFeePerGas: BigInt(row.max_priority_fee_per_gas) }
          : {}),
        ...(row.gas_price !== null ? { gasPrice: BigInt(row.gas_price) } : {}),
      },
      to: row.to_address as TxSubmissionLedgerEntry['to'],
      value: row.value_wei === null ? undefined : BigInt(row.value_wei),
      data: row.data as TxSubmissionLedgerEntry['data'],
      resolvedAtMs: row.resolved_at_ms,
    };
  }

  markTxSubmissionResolved(key: TxSubmissionKey & { resolvedAtMs: number }): void {
    this.db.prepare(
      `UPDATE tx_submissions
       SET resolved_at_ms = @resolvedAtMs
       WHERE chain_id = @chainId
         AND from_address = @fromAddress
         AND nonce = @nonce`,
    ).run({
      chainId: key.chainId,
      fromAddress: key.from.toLowerCase(),
      nonce: key.nonce,
      resolvedAtMs: key.resolvedAtMs,
    });
  }

  /** Generic config row (e.g. last_reward_claim_tick_at). */
  getConfigValue(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setConfigValue(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
  }

  getTaskPostRecord(args: {
    creatorSafeAddress: string;
    sourceKey: string;
    policyType: TaskPostingPolicyType;
    scopeKey: string;
  }): TaskPostRecord | null {
    const row = this.db.prepare(
      `SELECT creator_safe_address, source_key, policy_type, scope_key, task_id,
              protocol_task_id, task_cid, request_id,
              first_posted_at, last_posted_at, post_count
       FROM task_posts
       WHERE creator_safe_address = @creatorSafeAddress
         AND source_key = @sourceKey
         AND policy_type = @policyType
         AND scope_key = @scopeKey`,
    ).get(args) as {
      creator_safe_address: string;
      source_key: string;
      policy_type: TaskPostingPolicyType;
      scope_key: string;
      task_id: string;
      protocol_task_id: string | null;
      task_cid: string | null;
      request_id: string;
      first_posted_at: string;
      last_posted_at: string;
      post_count: number;
    } | undefined;
    if (!row) return null;
    return {
      creatorSafeAddress: row.creator_safe_address,
      sourceKey: row.source_key,
      policyType: row.policy_type,
      scopeKey: row.scope_key,
      taskId: row.task_id,
      protocolTaskId: row.protocol_task_id,
      taskCid: row.task_cid,
      requestId: row.request_id,
      firstPostedAt: row.first_posted_at,
      lastPostedAt: row.last_posted_at,
      postCount: row.post_count,
    };
  }

  /**
   * Posted Tasks for the launcher mode (`GET /v1/launcher/tasks`,
   * spec/2026-05-05-launcher-role-and-mode.md §5.3). Returns rows from
   * `task_posts` filtered by creator Safe address, sorted by `last_posted_at
   * DESC` (most recent first). The `solverType` is denormalised in by joining
   * `activity_events` on `request_id` for the `task_posted` kind — that's
   * where `posting-service.ts` writes the SolverType when the post lands.
   *
   * `before` filters to rows with `last_posted_at < before` (ISO-8601). When
   * `before` is undefined, returns the most recent `limit` rows.
   *
   * Caller-side: `gatherLauncherTasks` (`api/launcher-tasks.ts`) maps the
   * solver_type back to the operator's SolverNet name via config lookup.
   */
  listPostedTasksByCreator(args: {
    creatorSafeAddress: string;
    limit: number;
    before?: string;
  }): Array<{
    taskId: string;
    taskCid: string;
    solverType: string | null;
    requestId: string;
    postedAt: string;
    state?: LauncherTaskProjectionState;
    claims?: { current?: number; max?: number };
  }> {
    const limit = Math.max(0, Math.min(args.limit, 1000));
    if (limit === 0) return [];
    const params: Record<string, unknown> = {
      creator: args.creatorSafeAddress,
      limit,
    };
    let beforeClause = '';
    if (args.before) {
      beforeClause = ' AND tp.last_posted_at < @before';
      params['before'] = args.before;
    }
    // LEFT JOIN: a stale `task_posts` row from before activity_events backfill
    // (or one whose event was lost to `recordActivityEvent` failure) still
    // surfaces with a NULL solver_type — the gather function falls back to
    // `solverNet: 'unknown'` rather than dropping the row, because the
    // operator should still see the Task they posted.
    const rows = this.db.prepare(
      `SELECT
         tp.task_id,
         tp.task_cid,
         tp.protocol_task_id,
         tp.request_id,
         tp.last_posted_at,
         (
           SELECT ae.solver_type
           FROM activity_events ae
           WHERE ae.request_id = tp.request_id
             AND ae.kind = 'task_posted'
             AND ae.solver_type IS NOT NULL
           ORDER BY ae.id DESC
           LIMIT 1
         ) AS solver_type
       FROM task_posts tp
       WHERE tp.creator_safe_address = @creator${beforeClause}
       ORDER BY tp.last_posted_at DESC
       LIMIT @limit`,
    ).all(params) as Array<{
      task_id: string | null;
      task_cid: string | null;
      protocol_task_id: string | null;
      request_id: string;
      last_posted_at: string;
      solver_type: string | null;
    }>;
    const localRunsForPost = this.db.prepare(
      `SELECT request_id, state, task_role, task_payload, delivery_tx_hash, state_updated_at
       FROM task_runs
       WHERE request_id = @requestId
          OR (@taskId != '' AND task_id = @taskId)
          OR (@protocolTaskId != '' AND task_id = @protocolTaskId)
          OR (@taskCid != '' AND task_cid = @taskCid)
       ORDER BY state_updated_at DESC`,
    );
    return rows.map((r) => {
      // task_id was added by an additive migration; the column exists on every
      // post-migration insert (posting-service.ts always writes it). Older
      // rows fall back to protocol_task_id (chain Task ID) and finally
      // request_id so the response shape's `taskId` is always populated.
      const taskId = r.task_id ?? r.protocol_task_id ?? r.request_id;
      const protocolTaskId = r.protocol_task_id ?? '';
      const taskCid = r.task_cid ?? '';
      const runs = localRunsForPost.all({
        requestId: r.request_id,
        taskId,
        protocolTaskId,
        taskCid,
      }) as LocalTaskRunProjectionRow[];
      const maxClaims = runs
        .map((run) => readClaimPolicyMaxClaims(run.task_payload))
        .find((value): value is number => value !== undefined);
      const localRestorationClaims = new Set(
        runs
          .filter((run) => run.task_role !== 'evaluation')
          .map((run) => run.request_id),
      ).size;
      const state = derivePostedTaskLocalState({
        runs,
        localRestorationClaims,
        maxClaims,
      });
      return {
        taskId,
        taskCid,
        solverType: r.solver_type,
        requestId: r.request_id,
        postedAt: r.last_posted_at,
        ...(state ? { state } : {}),
        ...(runs.length > 0 || maxClaims !== undefined
          ? {
              claims: {
                current: localRestorationClaims,
                ...(maxClaims !== undefined ? { max: maxClaims } : {}),
              },
            }
          : {}),
      };
    });
  }

  /** Count of posted Tasks for this creator with the given solver_type. v1
   *  treats every posted Task as in-flight (state derivation lands with
   *  router-watcher hardening, jinn-mono-l2zl.12). */
  countPostedTasksByCreatorAndSolverType(args: {
    creatorSafeAddress: string;
    solverType: string;
  }): number {
    const row = this.db.prepare(
      `SELECT COUNT(DISTINCT tp.task_id) AS c
       FROM task_posts tp
       INNER JOIN activity_events ae
         ON ae.request_id = tp.request_id
         AND ae.kind = 'task_posted'
       WHERE tp.creator_safe_address = @creator
         AND ae.solver_type = @solverType`,
    ).get({
      creator: args.creatorSafeAddress,
      solverType: args.solverType,
    }) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  upsertTaskPostRecord(record: TaskPostRecord): void {
    const params = {
      ...record,
      protocolTaskId: record.protocolTaskId ?? null,
      taskCid: record.taskCid ?? null,
    };
    this.db.prepare(
      `INSERT INTO task_posts
         (creator_safe_address, source_key, policy_type, scope_key, task_id, protocol_task_id, task_cid, request_id,
          first_posted_at, last_posted_at, post_count)
       VALUES
         (@creatorSafeAddress, @sourceKey, @policyType, @scopeKey, @taskId, @protocolTaskId, @taskCid, @requestId,
          @firstPostedAt, @lastPostedAt, @postCount)
       ON CONFLICT(creator_safe_address, source_key, policy_type, scope_key) DO UPDATE SET
         task_id = excluded.task_id,
         protocol_task_id = excluded.protocol_task_id,
         task_cid = excluded.task_cid,
         request_id = excluded.request_id,
         first_posted_at = excluded.first_posted_at,
         last_posted_at = excluded.last_posted_at,
         post_count = excluded.post_count`,
    ).run(params);
  }

  acquireTaskPostLock(args: {
    creatorSafeAddress: string;
    sourceKey: string;
    policyType: TaskPostingPolicyType;
    scopeKey: string;
    ownerToken: string;
    lockedAt: string;
    staleAfterMs: number;
  }): boolean {
    const tx = this.db.transaction((params: typeof args) => {
      const existing = this.db.prepare(
        `SELECT owner_token, locked_at
         FROM task_post_locks
         WHERE creator_safe_address = @creatorSafeAddress
           AND source_key = @sourceKey
           AND policy_type = @policyType
           AND scope_key = @scopeKey`,
      ).get(params) as { owner_token: string; locked_at: string } | undefined;

      if (!existing) {
        this.db.prepare(
          `INSERT INTO task_post_locks
             (creator_safe_address, source_key, policy_type, scope_key, owner_token, locked_at)
           VALUES
             (@creatorSafeAddress, @sourceKey, @policyType, @scopeKey, @ownerToken, @lockedAt)`,
        ).run(params);
        return true;
      }

      const lockedAtMs = Date.parse(existing.locked_at);
      const nowMs = Date.parse(params.lockedAt);
      const isStale = Number.isFinite(lockedAtMs)
        && Number.isFinite(nowMs)
        && (nowMs - lockedAtMs) >= params.staleAfterMs;
      if (!isStale) {
        return false;
      }

      this.db.prepare(
        `UPDATE task_post_locks
         SET owner_token = @ownerToken, locked_at = @lockedAt
         WHERE creator_safe_address = @creatorSafeAddress
           AND source_key = @sourceKey
           AND policy_type = @policyType
           AND scope_key = @scopeKey`,
      ).run(params);
      return true;
    });

    return tx(args);
  }

  releaseTaskPostLock(args: {
    creatorSafeAddress: string;
    sourceKey: string;
    policyType: TaskPostingPolicyType;
    scopeKey: string;
    ownerToken: string;
  }): void {
    this.db.prepare(
      `DELETE FROM task_post_locks
       WHERE creator_safe_address = @creatorSafeAddress
         AND source_key = @sourceKey
         AND policy_type = @policyType
         AND scope_key = @scopeKey
         AND owner_token = @ownerToken`,
    ).run(args);
  }

  /** Counts of protocol roles recorded for this node (best-effort activity hints). */
  getOwnActivityCounts(): Record<string, number> {
    const counts = this.getActivityCountsByKind();
    if (Object.keys(counts).length > 0) return counts;
    const rows = this.db.prepare(
      `SELECT role, COUNT(*) as c FROM own_activity GROUP BY role`,
    ).all() as Array<{ role: string; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.role] = r.c;
    return out;
  }

  /** Latest own_activity rows by insertion order (approximate). */
  getRecentOwnActivity(limit: number): Array<{ requestId: string; role: string }> {
    const rows = this.getRecentActivityEvents(limit);
    if (rows.length > 0) return rows.map((r) => ({ requestId: r.requestId ?? '', role: r.kind }));
    const legacyRows = this.db.prepare(
      `SELECT request_id, role FROM own_activity ORDER BY rowid DESC LIMIT ?`,
    ).all(Math.max(0, Math.min(limit, 1000))) as Array<{ request_id: string; role: string }>;
    return legacyRows.map(r => ({ requestId: r.request_id, role: r.role }));
  }

  recordActivityEvent(event: ActivityEventInput): void {
    this.db.prepare(
      `INSERT INTO activity_events
         (ts, kind, request_id, service_index, tx_hash, solver_type, outcome, detail,
          credential_id, cost_usd_micros, model)
       VALUES
         (@ts, @kind, @requestId, @serviceIndex, @txHash, @solverType, @outcome, @detail,
          @credentialId, @costUsdMicros, @model)`,
    ).run({
      ts: event.ts ?? null,
      kind: event.kind,
      requestId: event.requestId ?? null,
      serviceIndex: event.serviceIndex ?? null,
      txHash: event.txHash ?? null,
      solverType: event.solverType ?? null,
      outcome: event.outcome ?? null,
      detail: event.detail ?? null,
      credentialId: event.credentialId ?? null,
      costUsdMicros: event.costUsdMicros ?? null,
      model: event.model ?? null,
    });
  }

  getRecentActivityEvents(
    limit: number,
    opts: { since?: string; cursor?: string } = {},
  ): ActivityEventRow[] {
    const effectiveLimit = Math.max(0, Math.min(limit, 1000));
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: effectiveLimit };
    if (opts.since) {
      clauses.push('ts IS NOT NULL AND ts >= @since');
      params['since'] = opts.since;
    }
    if (opts.cursor) {
      clauses.push('ts IS NOT NULL AND ts < @cursor');
      params['cursor'] = opts.cursor;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT id, ts, kind, request_id, service_index, tx_hash, solver_type, outcome, detail,
              credential_id, cost_usd_micros, model
       FROM activity_events
       ${where}
       ORDER BY id DESC
       LIMIT @limit`,
    ).all(params) as Array<{
      id: number;
      ts: string | null;
      kind: string;
      request_id: string | null;
      service_index: number | null;
      tx_hash: string | null;
      solver_type: string | null;
      outcome: string | null;
      detail: string | null;
      credential_id: string | null;
      cost_usd_micros: number | null;
      model: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      requestId: r.request_id,
      serviceIndex: r.service_index,
      txHash: r.tx_hash,
      solverType: r.solver_type,
      outcome: r.outcome,
      detail: r.detail,
      credentialId: r.credential_id,
      costUsdMicros: r.cost_usd_micros,
      model: r.model,
    }));
  }

  /**
   * Total cost in micro-dollars recorded against a credential since the most
   * recent UTC midnight. Backs the daily spend cap.
   */
  spentTodayMicros(credentialId: string, now: Date = new Date()): number {
    const midnight = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    ).toISOString();
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(cost_usd_micros), 0) AS total
       FROM activity_events
       WHERE credential_id = @cid AND ts IS NOT NULL AND ts >= @midnight`,
    ).get({ cid: credentialId, midnight }) as { total: number };
    return row.total;
  }

  /** Newer events first, then ascending id for `jinn logs --follow` (oldest in batch printed first in caller). */
  getActivityEventsAfterId(afterId: number, limit: number): ActivityEventRow[] {
    const effectiveLimit = Math.max(0, Math.min(limit, 1000));
    const rows = this.db
      .prepare(
        `SELECT id, ts, kind, request_id, service_index, tx_hash, solver_type, outcome, detail,
                credential_id, cost_usd_micros, model
         FROM activity_events
         WHERE id > @afterId
         ORDER BY id ASC
         LIMIT @limit`,
      )
      .all({ afterId, limit: effectiveLimit }) as Array<{
        id: number;
        ts: string | null;
        kind: string;
        request_id: string | null;
        service_index: number | null;
        tx_hash: string | null;
        solver_type: string | null;
        outcome: string | null;
        detail: string | null;
        credential_id: string | null;
        cost_usd_micros: number | null;
        model: string | null;
      }>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      requestId: r.request_id,
      serviceIndex: r.service_index,
      txHash: r.tx_hash,
      solverType: r.solver_type,
      outcome: r.outcome,
      detail: r.detail,
      credentialId: r.credential_id,
      costUsdMicros: r.cost_usd_micros,
      model: r.model,
    }));
  }

  /**
   * Filtered, id-cursored page of activity events for the dedicated Events
   * page. Newest-first.
   *
   * Cursors on `id` rather than `ts` so startup/shutdown rows with null
   * timestamps remain reachable.
   */
  getActivityEventsPage(opts: {
    kinds?: string[];
    outcome?: string;
    requestId?: string;
    beforeId?: number;
    limit?: number;
  } = {}): ActivityEventRow[] {
    const effectiveLimit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: effectiveLimit };
    if (opts.kinds && opts.kinds.length > 0) {
      const placeholders = opts.kinds.map((_, i) => `@kind${i}`);
      clauses.push(`kind IN (${placeholders.join(', ')})`);
      opts.kinds.forEach((k, i) => {
        params[`kind${i}`] = k;
      });
    }
    if (opts.outcome) {
      clauses.push('outcome = @outcome');
      params['outcome'] = opts.outcome;
    }
    if (opts.requestId) {
      clauses.push('request_id = @requestId');
      params['requestId'] = opts.requestId;
    }
    if (opts.beforeId !== undefined) {
      clauses.push('id < @beforeId');
      params['beforeId'] = opts.beforeId;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT id, ts, kind, request_id, service_index, tx_hash, solver_type, outcome, detail
       FROM activity_events
       ${where}
       ORDER BY id DESC
       LIMIT @limit`,
    ).all(params) as Array<{
      id: number;
      ts: string | null;
      kind: string;
      request_id: string | null;
      service_index: number | null;
      tx_hash: string | null;
      solver_type: string | null;
      outcome: string | null;
      detail: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      requestId: r.request_id,
      serviceIndex: r.service_index,
      txHash: r.tx_hash,
      solverType: r.solver_type,
      outcome: r.outcome,
      detail: r.detail,
    }));
  }

  getActivityEventById(id: number): ActivityEventRow | null {
    const r = this.db.prepare(
      `SELECT id, ts, kind, request_id, service_index, tx_hash, solver_type, outcome, detail
       FROM activity_events
       WHERE id = ?`,
    ).get(id) as {
      id: number;
      ts: string | null;
      kind: string;
      request_id: string | null;
      service_index: number | null;
      tx_hash: string | null;
      solver_type: string | null;
      outcome: string | null;
      detail: string | null;
    } | undefined;
    if (!r) return null;
    return {
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      requestId: r.request_id,
      serviceIndex: r.service_index,
      txHash: r.tx_hash,
      solverType: r.solver_type,
      outcome: r.outcome,
      detail: r.detail,
    };
  }

  getActivityCountsByKind(): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT kind, COUNT(*) as c FROM activity_events GROUP BY kind`,
    ).all() as Array<{ kind: string; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.kind] = r.c;
    return out;
  }

  getLastEventAtForService(serviceIndex: number): string | null {
    const row = this.db.prepare(
      `SELECT ts FROM activity_events WHERE service_index = ? AND ts IS NOT NULL ORDER BY id DESC LIMIT 1`,
    ).get(serviceIndex) as { ts: string | null } | undefined;
    return row?.ts ?? null;
  }

  getActivityCountsForService(serviceIndex: number): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT kind, COUNT(*) as c FROM activity_events WHERE service_index = ? GROUP BY kind`,
    ).all(serviceIndex) as Array<{ kind: string; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.kind] = r.c;
    return out;
  }

  recordRewardClaim(claim: RewardClaimInput): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO reward_claims
         (ts, service_index, service_id, staking_proxy, distributor, tx_hash, amount_wei, asset)
         VALUES (@ts, @serviceIndex, @serviceId, @stakingProxy, @distributor, @txHash, @amountWei, @asset)`,
      )
      .run({
        ts: claim.ts,
        serviceIndex: claim.serviceIndex,
        serviceId: claim.serviceId ?? null,
        stakingProxy: claim.stakingProxy,
        distributor: claim.distributor,
        txHash: claim.txHash,
        amountWei: claim.amountWei,
        asset: claim.asset ?? 'reward',
      });
  }

  getClaimedRewardsByService(): Record<number, { total: string; lastAt: string; lastTxHash: string }> {
    const rows = this.db.prepare(
      `SELECT id, service_index, amount_wei, ts, tx_hash FROM reward_claims ORDER BY id ASC`,
    ).all() as Array<{
      id: number;
      service_index: number;
      amount_wei: string;
      ts: string;
      tx_hash: string;
    }>;
    const out: Record<number, { total: string; lastAt: string; lastTxHash: string }> = {};
    const lastId: Record<number, number> = {};
    for (const r of rows) {
      const current = out[r.service_index];
      const nextTotal = (current ? BigInt(current.total) : 0n) + BigInt(r.amount_wei);
      const isNewer = !current || r.id > (lastId[r.service_index] ?? 0);
      if (isNewer) {
        lastId[r.service_index] = r.id;
      }
      out[r.service_index] = {
        total: nextTotal.toString(),
        lastAt: isNewer || !current ? r.ts : current.lastAt,
        lastTxHash: isNewer || !current ? r.tx_hash : current.lastTxHash,
      };
    }
    return out;
  }

  upsertBalanceCache(entry: BalanceCacheEntry): void {
    this.db.prepare(
      `INSERT INTO balance_cache (role, address, native_wei, bond_wei, asset_extra_json, fetched_at, error)
       VALUES (@role, @address, @nativeWei, @bondWei, @assetExtraJson, @fetchedAt, @error)
       ON CONFLICT(role) DO UPDATE SET
         address=excluded.address,
         native_wei=excluded.native_wei,
         bond_wei=excluded.bond_wei,
         asset_extra_json=excluded.asset_extra_json,
         fetched_at=excluded.fetched_at,
         error=excluded.error`,
    ).run({
      role: entry.role,
      address: entry.address,
      nativeWei: entry.nativeWei ?? null,
      bondWei: entry.bondWei ?? null,
      assetExtraJson: entry.assetExtraJson ?? null,
      fetchedAt: entry.fetchedAt,
      error: entry.error ?? null,
    });
  }

  getBalanceCache(): BalanceCacheEntry[] {
    const rows = this.db.prepare(
      `SELECT role, address, native_wei, bond_wei, asset_extra_json, fetched_at, error
       FROM balance_cache`,
    ).all() as Array<{
      role: string;
      address: string;
      native_wei: string | null;
      bond_wei: string | null;
      asset_extra_json: string | null;
      fetched_at: string;
      error: string | null;
    }>;
    return rows.map((r) => ({
      role: r.role,
      address: r.address,
      nativeWei: r.native_wei,
      bondWei: r.bond_wei,
      assetExtraJson: r.asset_extra_json,
      fetchedAt: r.fetched_at,
      error: r.error,
    }));
  }

  private backfillActivityEvents(): void {
    const migrationKey = 'activity_events_migrated_v1';
    const insert = this.db.prepare(
      `INSERT INTO activity_events (ts, kind, request_id)
       SELECT NULL, o.role, o.request_id
       FROM own_activity o
       WHERE NOT EXISTS (
         SELECT 1 FROM activity_events a
         WHERE a.request_id = o.request_id AND a.kind = o.role
       )`,
    );
    const tx = this.db.transaction(() => {
      if (this.getConfigValue(migrationKey) === 'true') return;
      insert.run();
      this.setConfigValue(migrationKey, 'true');
    });
    tx();
  }

  getTaskEvidenceHash(requestId: string): string | null {
    const row = this.db.prepare(
      'SELECT evidence_hash FROM task_runs WHERE request_id = ?',
    ).get(requestId) as { evidence_hash: string | null } | undefined;
    return row?.evidence_hash ?? null;
  }

  getLastProcessedBlock(): bigint | null {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get('last_processed_block') as { value: string } | undefined;
    return row?.value ? BigInt(row.value) : null;
  }

  setLastProcessedBlock(block: bigint): void {
    this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('last_processed_block', block.toString());
  }

  insertArtifact(artifact: {
    id: string;
    taskId: string;
    requestId: string;
    title: string;
    content: string;
    tags: string[];
    outcome: 'SUCCESS' | 'FAILURE' | 'UNKNOWN';
  }): void {
    const columns = ['id', 'task_id', 'request_id', 'title', 'content', 'tags', 'outcome'];
    const values = ['@id', '@taskId', '@requestId', '@title', '@content', '@tags', '@outcome'];
    if (this.hasLegacyDesiredStateId) {
      columns.push('desired_state_id');
      values.push('@taskId');
    }
    this.db.prepare(`
      INSERT OR REPLACE INTO artifacts (${columns.join(', ')})
      VALUES (${values.join(', ')})
    `).run({
      ...artifact,
      tags: JSON.stringify(artifact.tags),
    });
  }

  searchArtifacts(query: {
    tags?: string[];
    outcome?: string;
    requestId?: string;
    taskId?: string;
    after?: string;   // ISO timestamp — only return artifacts created after this time
    before?: string;  // ISO timestamp — only return artifacts created before this time
    limit?: number;
  }): Array<{ id: string; title: string; content: string; tags: string[]; outcome: string; request_id: string; task_id: string; created_at: string }> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.outcome) {
      conditions.push('outcome = @outcome');
      params['outcome'] = query.outcome;
    }

    if (query.requestId) {
      conditions.push('request_id = @requestId');
      params['requestId'] = query.requestId;
    }

    if (query.taskId) {
      conditions.push('task_id = @taskId');
      params['taskId'] = query.taskId;
    }

    if (query.after) {
      conditions.push('created_at >= @after');
      params['after'] = query.after;
    }

    if (query.before) {
      conditions.push('created_at <= @before');
      params['before'] = query.before;
    }

    if (query.tags && query.tags.length > 0) {
      for (let i = 0; i < query.tags.length; i++) {
        conditions.push(`tags LIKE @tag${i}`);
        params[`tag${i}`] = `%${query.tags[i]}%`;
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = query.limit ?? 50;

    const rows = this.db.prepare(
      `SELECT id, title, content, tags, outcome, request_id, task_id, created_at FROM artifacts ${where} ORDER BY created_at DESC LIMIT ${limit}`
    ).all(params) as Array<{ id: string; title: string; content: string; tags: string; outcome: string; request_id: string; task_id: string; created_at: string }>;

    return rows.map(row => ({
      ...row,
      tags: JSON.parse(row.tags) as string[],
    }));
  }

  insertRemoteArtifact(artifact: {
    id: string;
    taskId: string;
    requestId: string;
    title: string;
    tags: string[];
    outcome: 'SUCCESS' | 'FAILURE' | 'UNKNOWN';
    ownerAddress: string;
    endpoint: string;
    price?: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO artifacts (id, task_id, request_id, title, tags, outcome, remote, owner_address, endpoint, price)
      VALUES (@id, @taskId, @requestId, @title, @tags, @outcome, 1, @ownerAddress, @endpoint, @price)
    `).run({
      ...artifact,
      tags: JSON.stringify(artifact.tags),
      price: artifact.price ?? null,
    });
  }

  /**
   * Text body for a catalog artifact id: local `artifacts.content`, else a peer-cached
   * blob in `network_artifacts` (via `peer_catalog_id`).
   */
  resolveCatalogArtifactContent(id: string): string | null {
    const local = this.db.prepare('SELECT content FROM artifacts WHERE id = ?').get(id) as
      | { content: string | null }
      | undefined;
    if (local?.content != null) return local.content;

    const net = this.db.prepare(
      `SELECT content FROM network_artifacts WHERE peer_catalog_id = ? ORDER BY fetched_at DESC LIMIT 1`,
    ).get(id) as { content: Buffer } | undefined;
    if (!net) return null;
    return net.content.toString('utf-8');
  }

  /** Endpoint / owner for a remote (peer-synced) catalog row in `artifacts`. */
  getRemoteDiscoveryMetadata(id: string): { endpoint: string; ownerAddress: string; price?: string } | null {
    const row = this.db.prepare(
      'SELECT endpoint, owner_address, price FROM artifacts WHERE id = ? AND remote = 1',
    ).get(id) as { endpoint: string; owner_address: string; price: string | null } | undefined;
    if (!row) return null;
    return {
      endpoint: row.endpoint,
      ownerAddress: row.owner_address,
      price: row.price ?? undefined,
    };
  }

  getArtifactByRequestId(requestId: string, tag: string): { id: string; title: string; content: string; tags: string[]; outcome: string } | null {
    const row = this.db.prepare(
      `SELECT id, title, content, tags, outcome FROM artifacts WHERE request_id = ? AND tags LIKE ? ORDER BY created_at DESC LIMIT 1`
    ).get(requestId, `%${tag}%`) as { id: string; title: string; content: string; tags: string; outcome: string } | undefined;
    if (!row) return null;
    return { ...row, tags: JSON.parse(row.tags) as string[] };
  }

  saveServedArtifact(input: ServedArtifactInput): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO served_artifacts
         (sha256, artifact_type, request_id, envelope_cid, content, content_size, price_usdc, created_at)
       VALUES
         (@sha256, @artifactType, @requestId, @envelopeCid, @content, @contentSize, @priceUsdc, @createdAt)`,
    ).run({
      sha256: input.sha256,
      artifactType: input.artifactType,
      requestId: input.requestId ?? null,
      envelopeCid: input.envelopeCid ?? null,
      content: input.content,
      contentSize: input.content.length,
      priceUsdc: input.priceUsdc,
      createdAt: input.createdAt,
    });
  }

  getServedArtifact(sha256: string): ServedArtifactRow | null {
    const row = this.db.prepare(
      `SELECT sha256, artifact_type, request_id, envelope_cid, content, content_size, price_usdc, created_at
       FROM served_artifacts WHERE sha256 = ?`,
    ).get(sha256) as {
      sha256: string;
      artifact_type: string;
      request_id: string | null;
      envelope_cid: string | null;
      content: Buffer;
      content_size: number;
      price_usdc: string;
      created_at: string;
    } | undefined;
    if (!row) return null;
    return {
      sha256: row.sha256,
      artifactType: row.artifact_type,
      requestId: row.request_id,
      envelopeCid: row.envelope_cid,
      content: row.content,
      contentSize: row.content_size,
      priceUsdc: row.price_usdc,
      createdAt: row.created_at,
    };
  }

  getServedArtifactMetadata(sha256: string): ServedArtifactMetadataRow | null {
    const row = this.db.prepare(
      `SELECT sha256, artifact_type, request_id, envelope_cid, content_size, price_usdc, created_at
       FROM served_artifacts WHERE sha256 = ?`,
    ).get(sha256) as {
      sha256: string;
      artifact_type: string;
      request_id: string | null;
      envelope_cid: string | null;
      content_size: number;
      price_usdc: string;
      created_at: string;
    } | undefined;
    if (!row) return null;
    return {
      sha256: row.sha256,
      artifactType: row.artifact_type,
      requestId: row.request_id,
      envelopeCid: row.envelope_cid,
      contentSize: row.content_size,
      priceUsdc: row.price_usdc,
      createdAt: row.created_at,
    };
  }

  listServedArtifactMetadata(filter: { artifactType?: string; limit?: number } = {}): ServedArtifactMetadataRow[] {
    const limit = Math.min(Math.max(1, filter.limit ?? 100), 500);
    const sql = filter.artifactType
      ? `SELECT sha256, artifact_type, request_id, envelope_cid, content_size, price_usdc, created_at
         FROM served_artifacts
         WHERE artifact_type = @artifactType
         ORDER BY created_at DESC
         LIMIT @limit`
      : `SELECT sha256, artifact_type, request_id, envelope_cid, content_size, price_usdc, created_at
         FROM served_artifacts
         ORDER BY created_at DESC
         LIMIT @limit`;
    const rows = this.db.prepare(sql).all({
      limit,
      ...(filter.artifactType ? { artifactType: filter.artifactType } : {}),
    }) as Array<{
      sha256: string;
      artifact_type: string;
      request_id: string | null;
      envelope_cid: string | null;
      content_size: number;
      price_usdc: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      sha256: row.sha256,
      artifactType: row.artifact_type,
      requestId: row.request_id,
      envelopeCid: row.envelope_cid,
      contentSize: row.content_size,
      priceUsdc: row.price_usdc,
      createdAt: row.created_at,
    }));
  }

  recordArtifactAccessEvent(input: ArtifactAccessEventInput): void {
    this.db.prepare(
      `INSERT INTO artifact_access_events
         (sha256, artifact_type, price_usdc, outcome, http_status, payer,
          settlement_tx, error_reason, remote_addr, user_agent, created_at)
       VALUES
         (@sha256, @artifactType, @priceUsdc, @outcome, @httpStatus, @payer,
          @settlementTx, @errorReason, @remoteAddr, @userAgent, @createdAt)`,
    ).run({
      sha256: input.sha256,
      artifactType: input.artifactType ?? null,
      priceUsdc: input.priceUsdc ?? null,
      outcome: input.outcome,
      httpStatus: input.httpStatus,
      payer: input.payer ?? null,
      settlementTx: input.settlementTx ?? null,
      errorReason: input.errorReason ?? null,
      remoteAddr: input.remoteAddr ?? null,
      userAgent: input.userAgent ?? null,
      createdAt: input.createdAt,
    });
  }

  listArtifactAccessEvents(filter: { sha256?: string; limit?: number } = {}): ArtifactAccessEventRow[] {
    const limit = Math.min(Math.max(1, filter.limit ?? 50), 500);
    const sql = filter.sha256
      ? `SELECT id, sha256, artifact_type, price_usdc, outcome, http_status,
                payer, settlement_tx, error_reason, remote_addr, user_agent, created_at
         FROM artifact_access_events
         WHERE sha256 = @sha256
         ORDER BY created_at DESC, id DESC
         LIMIT @limit`
      : `SELECT id, sha256, artifact_type, price_usdc, outcome, http_status,
                payer, settlement_tx, error_reason, remote_addr, user_agent, created_at
         FROM artifact_access_events
         ORDER BY created_at DESC, id DESC
         LIMIT @limit`;
    const rows = this.db.prepare(sql).all({
      limit,
      ...(filter.sha256 ? { sha256: filter.sha256 } : {}),
    }) as Array<{
      id: number;
      sha256: string;
      artifact_type: string | null;
      price_usdc: string | null;
      outcome: ArtifactAccessOutcome;
      http_status: number;
      payer: string | null;
      settlement_tx: string | null;
      error_reason: string | null;
      remote_addr: string | null;
      user_agent: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sha256: row.sha256,
      artifactType: row.artifact_type,
      priceUsdc: row.price_usdc,
      outcome: row.outcome,
      httpStatus: row.http_status,
      payer: row.payer,
      settlementTx: row.settlement_tx,
      errorReason: row.error_reason,
      remoteAddr: row.remote_addr,
      userAgent: row.user_agent,
      createdAt: row.created_at,
    }));
  }

  getArtifactAccessSummary(): ArtifactAccessStats {
    const row = this.db.prepare(
      `SELECT
         COUNT(*) AS access_count,
         COALESCE(SUM(CASE WHEN outcome = 'paid_served' THEN 1 ELSE 0 END), 0) AS paid_serve_count,
         COALESCE(SUM(CASE WHEN outcome = 'free_served' THEN 1 ELSE 0 END), 0) AS free_serve_count,
         COALESCE(SUM(CASE WHEN outcome IN ('verification_failed', 'settlement_failed', 'payment_malformed') THEN 1 ELSE 0 END), 0) AS failed_payment_count,
         COALESCE(SUM(CASE WHEN outcome = 'payment_required' THEN 1 ELSE 0 END), 0) AS payment_required_count,
         COALESCE(SUM(CASE WHEN outcome = 'paid_served' THEN CAST(price_usdc AS REAL) ELSE 0 END), 0) AS revenue_usdc,
         MAX(created_at) AS last_access_at,
         MAX(CASE WHEN outcome = 'paid_served' THEN created_at ELSE NULL END) AS last_paid_at
       FROM artifact_access_events`,
    ).get() as {
      access_count: number;
      paid_serve_count: number;
      free_serve_count: number;
      failed_payment_count: number;
      payment_required_count: number;
      revenue_usdc: number;
      last_access_at: string | null;
      last_paid_at: string | null;
    };
    return {
      accessCount: row.access_count,
      paidServeCount: row.paid_serve_count,
      freeServeCount: row.free_serve_count,
      failedPaymentCount: row.failed_payment_count,
      paymentRequiredCount: row.payment_required_count,
      revenueUsdc: String(row.revenue_usdc),
      lastAccessAt: row.last_access_at,
      lastPaidAt: row.last_paid_at,
    };
  }

  getArtifactAccessStatsBySha(sha256s: string[]): Record<string, ArtifactAccessStats> {
    const unique = Array.from(new Set(sha256s)).filter((sha256) => sha256.length > 0);
    if (unique.length === 0) return {};
    const placeholders = unique.map((_, idx) => `@sha${idx}`).join(', ');
    const params = Object.fromEntries(unique.map((sha256, idx) => [`sha${idx}`, sha256]));
    const rows = this.db.prepare(
      `SELECT
         sha256,
         COUNT(*) AS access_count,
         COALESCE(SUM(CASE WHEN outcome = 'paid_served' THEN 1 ELSE 0 END), 0) AS paid_serve_count,
         COALESCE(SUM(CASE WHEN outcome = 'free_served' THEN 1 ELSE 0 END), 0) AS free_serve_count,
         COALESCE(SUM(CASE WHEN outcome IN ('verification_failed', 'settlement_failed', 'payment_malformed') THEN 1 ELSE 0 END), 0) AS failed_payment_count,
         COALESCE(SUM(CASE WHEN outcome = 'payment_required' THEN 1 ELSE 0 END), 0) AS payment_required_count,
         COALESCE(SUM(CASE WHEN outcome = 'paid_served' THEN CAST(price_usdc AS REAL) ELSE 0 END), 0) AS revenue_usdc,
         MAX(created_at) AS last_access_at,
         MAX(CASE WHEN outcome = 'paid_served' THEN created_at ELSE NULL END) AS last_paid_at
       FROM artifact_access_events
       WHERE sha256 IN (${placeholders})
       GROUP BY sha256`,
    ).all(params) as Array<{
      sha256: string;
      access_count: number;
      paid_serve_count: number;
      free_serve_count: number;
      failed_payment_count: number;
      payment_required_count: number;
      revenue_usdc: number;
      last_access_at: string | null;
      last_paid_at: string | null;
    }>;
    return Object.fromEntries(rows.map((row) => [
      row.sha256,
      {
        accessCount: row.access_count,
        paidServeCount: row.paid_serve_count,
        freeServeCount: row.free_serve_count,
        failedPaymentCount: row.failed_payment_count,
        paymentRequiredCount: row.payment_required_count,
        revenueUsdc: String(row.revenue_usdc),
        lastAccessAt: row.last_access_at,
        lastPaidAt: row.last_paid_at,
      },
    ]));
  }

  setServedArtifactEnvelopeCid(sha256: string, envelopeCid: string): void {
    this.db.prepare(
      `UPDATE served_artifacts SET envelope_cid = ? WHERE sha256 = ?`,
    ).run(envelopeCid, sha256);
  }

  getServedArtifactsByRequestId(requestId: string): ServedArtifactRow[] {
    const rows = this.db.prepare(
      `SELECT sha256, artifact_type, request_id, envelope_cid, content, content_size, price_usdc, created_at
       FROM served_artifacts WHERE request_id = ? ORDER BY created_at ASC`,
    ).all(requestId) as Array<{
      sha256: string;
      artifact_type: string;
      request_id: string | null;
      envelope_cid: string | null;
      content: Buffer;
      content_size: number;
      price_usdc: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      sha256: row.sha256,
      artifactType: row.artifact_type,
      requestId: row.request_id,
      envelopeCid: row.envelope_cid,
      content: row.content,
      contentSize: row.content_size,
      priceUsdc: row.price_usdc,
      createdAt: row.created_at,
    }));
  }

  saveNetworkArtifact(input: NetworkArtifactInput): void {
    if (input.peerCatalogId) {
      this.db.prepare(`DELETE FROM network_artifacts WHERE peer_catalog_id = ?`).run(input.peerCatalogId);
    }
    this.db.prepare(
      `INSERT OR REPLACE INTO network_artifacts
         (sha256, artifact_type, envelope_cid, content, content_size, source,
          source_operator, source_endpoint, paid_amount_usdc, fetched_at, last_used_at, peer_catalog_id)
       VALUES
         (@sha256, @artifactType, @envelopeCid, @content, @contentSize, @source,
          @sourceOperator, @sourceEndpoint, @paidAmountUsdc, @fetchedAt, @fetchedAt, @peerCatalogId)`,
    ).run({
      sha256: input.sha256,
      artifactType: input.artifactType,
      envelopeCid: input.envelopeCid ?? null,
      content: input.content,
      contentSize: input.content.length,
      source: input.source,
      sourceOperator: input.sourceOperator ?? null,
      sourceEndpoint: input.sourceEndpoint ?? null,
      paidAmountUsdc: input.paidAmountUsdc,
      fetchedAt: input.fetchedAt,
      peerCatalogId: input.peerCatalogId ?? null,
    });
  }

  getNetworkArtifact(sha256: string): NetworkArtifactRow | null {
    const row = this.db.prepare(
      `SELECT sha256, artifact_type, envelope_cid, content, content_size, source,
              source_operator, source_endpoint, paid_amount_usdc, fetched_at, last_used_at,
              peer_catalog_id
       FROM network_artifacts WHERE sha256 = ?`,
    ).get(sha256) as {
      sha256: string;
      artifact_type: string;
      envelope_cid: string | null;
      content: Buffer;
      content_size: number;
      source: NetworkArtifactSource;
      source_operator: string | null;
      source_endpoint: string | null;
      paid_amount_usdc: string;
      fetched_at: string;
      last_used_at: string;
      peer_catalog_id: string | null;
    } | undefined;
    if (!row) return null;
    return {
      sha256: row.sha256,
      artifactType: row.artifact_type,
      envelopeCid: row.envelope_cid,
      content: row.content,
      contentSize: row.content_size,
      source: row.source,
      sourceOperator: row.source_operator,
      sourceEndpoint: row.source_endpoint,
      paidAmountUsdc: row.paid_amount_usdc,
      fetchedAt: row.fetched_at,
      lastUsedAt: row.last_used_at,
      peerCatalogId: row.peer_catalog_id,
    };
  }

  getNetworkArtifactMetadata(sha256: string): NetworkArtifactMetadataRow | null {
    const row = this.db.prepare(
      `SELECT sha256, artifact_type, envelope_cid, content_size, source,
              source_operator, source_endpoint, paid_amount_usdc, fetched_at, last_used_at,
              peer_catalog_id
       FROM network_artifacts WHERE sha256 = ?`,
    ).get(sha256) as {
      sha256: string;
      artifact_type: string;
      envelope_cid: string | null;
      content_size: number;
      source: NetworkArtifactSource;
      source_operator: string | null;
      source_endpoint: string | null;
      paid_amount_usdc: string;
      fetched_at: string;
      last_used_at: string;
      peer_catalog_id: string | null;
    } | undefined;
    if (!row) return null;
    return {
      sha256: row.sha256,
      artifactType: row.artifact_type,
      envelopeCid: row.envelope_cid,
      contentSize: row.content_size,
      source: row.source,
      sourceOperator: row.source_operator,
      sourceEndpoint: row.source_endpoint,
      paidAmountUsdc: row.paid_amount_usdc,
      fetchedAt: row.fetched_at,
      lastUsedAt: row.last_used_at,
      peerCatalogId: row.peer_catalog_id,
    };
  }

  listNetworkArtifactMetadata(filter: { artifactType?: string; limit?: number } = {}): NetworkArtifactMetadataRow[] {
    const limit = Math.min(Math.max(1, filter.limit ?? 100), 500);
    const sql = filter.artifactType
      ? `SELECT sha256, artifact_type, envelope_cid, content_size, source,
                source_operator, source_endpoint, paid_amount_usdc, fetched_at,
                last_used_at, peer_catalog_id
         FROM network_artifacts
         WHERE artifact_type = @artifactType
         ORDER BY fetched_at DESC
         LIMIT @limit`
      : `SELECT sha256, artifact_type, envelope_cid, content_size, source,
                source_operator, source_endpoint, paid_amount_usdc, fetched_at,
                last_used_at, peer_catalog_id
         FROM network_artifacts
         ORDER BY fetched_at DESC
         LIMIT @limit`;
    const rows = this.db.prepare(sql).all({
      limit,
      ...(filter.artifactType ? { artifactType: filter.artifactType } : {}),
    }) as Array<{
      sha256: string;
      artifact_type: string;
      envelope_cid: string | null;
      content_size: number;
      source: NetworkArtifactSource;
      source_operator: string | null;
      source_endpoint: string | null;
      paid_amount_usdc: string;
      fetched_at: string;
      last_used_at: string;
      peer_catalog_id: string | null;
    }>;
    return rows.map((row) => ({
      sha256: row.sha256,
      artifactType: row.artifact_type,
      envelopeCid: row.envelope_cid,
      contentSize: row.content_size,
      source: row.source,
      sourceOperator: row.source_operator,
      sourceEndpoint: row.source_endpoint,
      paidAmountUsdc: row.paid_amount_usdc,
      fetchedAt: row.fetched_at,
      lastUsedAt: row.last_used_at,
      peerCatalogId: row.peer_catalog_id,
    }));
  }

  touchNetworkArtifactUsage(sha256: string, ts: string): void {
    this.db.prepare(
      `UPDATE network_artifacts SET last_used_at = ? WHERE sha256 = ?`,
    ).run(ts, sha256);
  }

  /**
   * Local fast-path search across own (served) artifacts and cached (network)
   * artifacts. Used by MCP record search to prepend locally held matches to
   * corpus query results without loading artifact bytes.
   */
  searchOwnAndCached(filter: { artifactType?: string; limit: number }): Array<{
    sha256: string;
    artifactType: string;
    source: 'served' | 'network';
    envelopeCid: string | null;
    createdAt: string;
    contentSize: number;
    priceUsdc?: string;
    sourceEndpoint?: string | null;
    sourceOperator?: string | null;
    paidAmountUsdc?: string;
  }> {
    const limit = Math.min(Math.max(1, filter.limit), 500);
    const ownSql = filter.artifactType
      ? `SELECT sha256, artifact_type, envelope_cid, content_size, price_usdc, created_at FROM served_artifacts WHERE artifact_type = @type ORDER BY created_at DESC LIMIT @limit`
      : `SELECT sha256, artifact_type, envelope_cid, content_size, price_usdc, created_at FROM served_artifacts ORDER BY created_at DESC LIMIT @limit`;
    const cachedSql = filter.artifactType
      ? `SELECT sha256, artifact_type, envelope_cid, content_size, source_operator, source_endpoint, paid_amount_usdc, fetched_at FROM network_artifacts WHERE artifact_type = @type ORDER BY fetched_at DESC LIMIT @limit`
      : `SELECT sha256, artifact_type, envelope_cid, content_size, source_operator, source_endpoint, paid_amount_usdc, fetched_at FROM network_artifacts ORDER BY fetched_at DESC LIMIT @limit`;
    const params: Record<string, unknown> = { limit };
    if (filter.artifactType) params['type'] = filter.artifactType;

    const own = this.db.prepare(ownSql).all(params) as Array<{
      sha256: string;
      artifact_type: string;
      envelope_cid: string | null;
      content_size: number;
      price_usdc: string;
      created_at: string;
    }>;
    const cached = this.db.prepare(cachedSql).all(params) as Array<{
      sha256: string;
      artifact_type: string;
      envelope_cid: string | null;
      content_size: number;
      source_operator: string | null;
      source_endpoint: string | null;
      paid_amount_usdc: string;
      fetched_at: string;
    }>;

    return [
      ...own.map((r) => ({
        sha256: r.sha256,
        artifactType: r.artifact_type,
        source: 'served' as const,
        envelopeCid: r.envelope_cid,
        createdAt: r.created_at,
        contentSize: r.content_size,
        priceUsdc: r.price_usdc,
      })),
      ...cached.map((r) => ({
        sha256: r.sha256,
        artifactType: r.artifact_type,
        source: 'network' as const,
        envelopeCid: r.envelope_cid,
        createdAt: r.fetched_at,
        contentSize: r.content_size,
        sourceEndpoint: r.source_endpoint,
        sourceOperator: r.source_operator,
        paidAmountUsdc: r.paid_amount_usdc,
      })),
    ];
  }

  saveEnvelopeProjection(projection: EnvelopeProjection): void {
    const tx = this.db.transaction((p: EnvelopeProjection) => {
      this.db.prepare(
        `INSERT INTO envelope_projections
           (envelope_id, envelope_cid, envelope_sha256, signature_hash, solver_type, role,
            task_cid, task_id, request_id, generated_at, evidence_tier,
            participant_safe_address, participant_agent_eoa,
            executor_impl_name, executor_impl_version, executor_runtime_bundle_digest,
            executor_plugins_json, solution_envelope_cid, solution_envelope_sha256,
            solution_envelope_ref, metadata_json)
         VALUES
           (@envelopeId, @envelopeCid, @envelopeSha256, @signatureHash, @solverType, @role,
            @taskCid, @taskId, @requestId, @generatedAt, @evidenceTier,
            @participantSafeAddress, @participantAgentEoa,
            @executorImplName, @executorImplVersion, @executorRuntimeBundleDigest,
            @executorPluginsJson, @solutionEnvelopeCid, @solutionEnvelopeSha256,
            @solutionEnvelopeRef, @metadataJson)
         ON CONFLICT(envelope_id) DO UPDATE SET
           envelope_cid = excluded.envelope_cid,
           envelope_sha256 = excluded.envelope_sha256,
           signature_hash = excluded.signature_hash,
           solver_type = excluded.solver_type,
           role = excluded.role,
           task_cid = excluded.task_cid,
           task_id = excluded.task_id,
           request_id = excluded.request_id,
           generated_at = excluded.generated_at,
           evidence_tier = excluded.evidence_tier,
           participant_safe_address = excluded.participant_safe_address,
           participant_agent_eoa = excluded.participant_agent_eoa,
           executor_impl_name = excluded.executor_impl_name,
           executor_impl_version = excluded.executor_impl_version,
           executor_runtime_bundle_digest = excluded.executor_runtime_bundle_digest,
           executor_plugins_json = excluded.executor_plugins_json,
           solution_envelope_cid = excluded.solution_envelope_cid,
           solution_envelope_sha256 = excluded.solution_envelope_sha256,
           solution_envelope_ref = excluded.solution_envelope_ref,
           metadata_json = excluded.metadata_json`,
      ).run({
        envelopeId: p.envelopeId,
        envelopeCid: p.envelopeCid,
        envelopeSha256: p.envelopeSha256,
        signatureHash: p.signatureHash,
        solverType: p.solverType,
        role: normalizeEnvelopeRole(p.role),
        taskCid: p.taskCid,
        taskId: p.taskId,
        requestId: p.requestId,
        generatedAt: p.generatedAt,
        evidenceTier: p.evidenceTier,
        participantSafeAddress: p.participantSafeAddress,
        participantAgentEoa: p.participantAgentEoa,
        executorImplName: p.executorImplName,
        executorImplVersion: p.executorImplVersion,
        executorRuntimeBundleDigest: p.executorRuntimeBundleDigest,
        executorPluginsJson: JSON.stringify(p.executorPlugins),
        solutionEnvelopeCid: p.solutionEnvelopeCid,
        solutionEnvelopeSha256: p.solutionEnvelopeSha256,
        solutionEnvelopeRef: p.solutionEnvelopeRef,
        metadataJson: JSON.stringify(p.metadata),
      });

      this.db.prepare(`DELETE FROM envelope_projection_metadata WHERE envelope_id = ?`).run(p.envelopeId);
      const insertMetadata = this.db.prepare(
        `INSERT INTO envelope_projection_metadata (envelope_id, key, value_text, value_type)
         VALUES (@envelopeId, @key, @valueText, @valueType)`,
      );
      for (const [key, value] of Object.entries(p.metadata)) {
        insertMetadata.run({
          envelopeId: p.envelopeId,
          key,
          valueText: metadataValueText(value),
          valueType: typeof value,
        });
      }
    });
    tx(projection);
  }

  queryEnvelopeProjections(query: EnvelopeProjectionQuery = {}): EnvelopeProjection[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.envelopeRefs && query.envelopeRefs.length > 0) {
      const placeholders = query.envelopeRefs.map((ref, index) => {
        const key = `envelopeRef${index}`;
        params[key] = ref;
        return `@${key}`;
      }).join(', ');
      conditions.push(
        `(envelope_id IN (${placeholders})
          OR envelope_cid IN (${placeholders})
          OR envelope_sha256 IN (${placeholders})
          OR signature_hash IN (${placeholders}))`,
      );
    }
    if (query.solverType) {
      conditions.push('solver_type = @solverType');
      params['solverType'] = query.solverType;
    }
    if (query.role) {
      const role = normalizeEnvelopeRole(query.role) as Role;
      if (role === 'solution') {
        conditions.push('(role = @role OR role = @legacyRole)');
        params['legacyRole'] = 'restoration';
      } else {
        conditions.push('role = @role');
      }
      params['role'] = role;
    }
    if (query.taskCid) {
      conditions.push('task_cid = @taskCid');
      params['taskCid'] = query.taskCid;
    }
    if (query.taskId) {
      conditions.push('task_id = @taskId');
      params['taskId'] = query.taskId;
    }
    if (query.requestId) {
      conditions.push('request_id = @requestId');
      params['requestId'] = query.requestId;
    }
    if (query.participant?.safeAddress) {
      conditions.push('participant_safe_address = @participantSafeAddress');
      params['participantSafeAddress'] = query.participant.safeAddress;
    }
    if (query.participant?.agentEoa) {
      conditions.push('participant_agent_eoa = @participantAgentEoa');
      params['participantAgentEoa'] = query.participant.agentEoa;
    }
    if (query.solutionEnvelopeRef) {
      conditions.push('solution_envelope_ref = @solutionEnvelopeRef');
      params['solutionEnvelopeRef'] = query.solutionEnvelopeRef;
    }
    if (query.generatedAfter !== undefined) {
      conditions.push('generated_at >= @generatedAfter');
      params['generatedAfter'] = query.generatedAfter;
    }
    if (query.generatedBefore !== undefined) {
      conditions.push('generated_at <= @generatedBefore');
      params['generatedBefore'] = query.generatedBefore;
    }

    let metadataIndex = 0;
    for (const [key, value] of Object.entries(query.metadata ?? {})) {
      const keyParam = `metadataKey${metadataIndex}`;
      const valueParam = `metadataValue${metadataIndex}`;
      conditions.push(
        `EXISTS (
          SELECT 1 FROM envelope_projection_metadata m${metadataIndex}
          WHERE m${metadataIndex}.envelope_id = envelope_projections.envelope_id
            AND m${metadataIndex}.key = @${keyParam}
            AND m${metadataIndex}.value_text = @${valueParam}
        )`,
      );
      params[keyParam] = key;
      params[valueParam] = metadataValueText(value);
      metadataIndex += 1;
    }

    const limit = Math.max(0, Math.min(query.limit ?? 100, 1000));
    params['limit'] = limit;
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT envelope_id, envelope_cid, envelope_sha256, signature_hash, solver_type, role,
              task_cid, task_id, request_id, generated_at, evidence_tier,
              participant_safe_address, participant_agent_eoa,
              executor_impl_name, executor_impl_version, executor_runtime_bundle_digest,
              executor_plugins_json, solution_envelope_cid, solution_envelope_sha256,
              solution_envelope_ref, metadata_json
       FROM envelope_projections
       ${where}
       ORDER BY generated_at DESC, envelope_id ASC
       LIMIT @limit`,
    ).all(params) as EnvelopeProjectionRow[];

    return rows.map(rowToEnvelopeProjection);
  }

  close(): void {
    this.db.close();
  }
}

interface EnvelopeProjectionRow {
  envelope_id: string;
  envelope_cid: string | null;
  envelope_sha256: string | null;
  signature_hash: string;
  solver_type: string;
  role: string;
  task_cid: string | null;
  task_id: string | null;
  request_id: string | null;
  generated_at: number;
  evidence_tier: 'self-signed' | 'committed' | 'attested';
  participant_safe_address: string | null;
  participant_agent_eoa: string | null;
  executor_impl_name: string | null;
  executor_impl_version: string | null;
  executor_runtime_bundle_digest: string | null;
  executor_plugins_json: string;
  solution_envelope_cid: string | null;
  solution_envelope_sha256: string | null;
  solution_envelope_ref: string | null;
  metadata_json: string;
}

function rowToEnvelopeProjection(row: EnvelopeProjectionRow): EnvelopeProjection {
  return {
    envelopeId: row.envelope_id,
    envelopeCid: row.envelope_cid,
    envelopeSha256: row.envelope_sha256,
    signatureHash: row.signature_hash,
    solverType: row.solver_type,
    role: normalizeEnvelopeRole(row.role) as Role,
    taskCid: row.task_cid,
    taskId: row.task_id,
    requestId: row.request_id,
    generatedAt: row.generated_at,
    evidenceTier: row.evidence_tier,
    participantSafeAddress: row.participant_safe_address,
    participantAgentEoa: row.participant_agent_eoa,
    executorImplName: row.executor_impl_name,
    executorImplVersion: row.executor_impl_version,
    executorRuntimeBundleDigest: row.executor_runtime_bundle_digest,
    executorPlugins: parseStringArray(row.executor_plugins_json),
    solutionEnvelopeCid: row.solution_envelope_cid,
    solutionEnvelopeSha256: row.solution_envelope_sha256,
    solutionEnvelopeRef: row.solution_envelope_ref,
    metadata: parseMetadata(row.metadata_json),
  };
}

function metadataValueText(value: EnvelopeProjectionMetadataValue): string {
  return String(value);
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function parseMetadata(json: string): Record<string, EnvelopeProjectionMetadataValue> {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, EnvelopeProjectionMetadataValue> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}
