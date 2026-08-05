import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { maskUrlsInMessage } from '../rpc/transport.js';
import type {
  EnvelopeProjection,
  EnvelopeProjectionMetadataValue,
  EnvelopeProjectionQuery,
} from '../corpus/types.js';
import { ENGAGEMENT_LEDGER_SCHEMA } from '../daemon/engagement-ledger.js';
import { NATIVE_DISCOVERY_SCHEMA } from '../daemon/native-discovery.js';
import { NATIVE_OPERATOR_STATE_SCHEMA } from '../daemon/native-operator-state.js';
import {
  PROJECTOR_CANONICAL_JOURNAL_SCHEMA,
  PROJECTOR_CURSOR_SCHEMA,
  PROJECTOR_OBSERVATIONS_SCHEMA,
} from '../daemon/projector-cursor.js';
import { TASK_RUNS_SCHEMA, TaskRunPersistence } from './task-run-persistence.js';
import { PHASE_RUNS_SCHEMA, PhaseRunStore } from './phase-runs.js';
import type { TaskRunReadModel } from '../types/task-run-read-model.js';
import type { TxSubmissionKey, TxSubmissionLedgerEntry } from '../tx-retry.js';
import { normalizeEnvelopeRole, type Role } from '../types/envelope.js';
import { SEVEN_DAY_MS } from '../spend/ai-units.js';

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
  /** Projected AI units debited at claim time (issue #815). Estimates are the gate input; never recomputed. */
  aiUnits?: number | null;
  /** Lifecycle stamp on the per-request row: 'claimed' | 'claim_failed' | 'delivered'. */
  claimStatus?: string | null;
  /** USD estimate captured at claim time (micros). Distinct from `actualCostUsdMicros` filled on completion. */
  estimatedCostUsdMicros?: number | null;
  /** USD actually billed (micros) — filled by the completion path; null until then. */
  actualCostUsdMicros?: number | null;
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
  aiUnits: number | null;
  claimStatus: string | null;
  estimatedCostUsdMicros: number | null;
  actualCostUsdMicros: number | null;
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

export interface Erc8004AnchorInput {
  envelopeId: string;
  envelopeCid: string;
  contentKind: string;
  metadataKey: string;
  agentId: string;
  chainId: number;
  identityRegistryAddress: string;
  txHash: string;
  blockNumber: number | null;
  payloadHex: string;
  anchoredAt: number;
  gasUsed?: string | null;
  feeWei?: string | null;
}

export interface Erc8004AnchorRow extends Omit<Erc8004AnchorInput, 'gasUsed' | 'feeWei'> {
  id: number;
  gasUsed: string | null;
  feeWei: string | null;
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
  canonicalTaskJson?: string | null;
  requestJson?: string | null;
  creationTxHash?: `0x${string}` | null;
  creationBlockNumber?: number | null;
  broadcastIntentAt?: string | null;
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
  canonical_task_json TEXT,
  request_json TEXT,
  creation_tx_hash TEXT,
  creation_block_number INTEGER,
  broadcast_intent_at TEXT,
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

CREATE TABLE IF NOT EXISTS erc8004_anchors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id TEXT NOT NULL,
  envelope_cid TEXT NOT NULL,
  content_kind TEXT NOT NULL,
  metadata_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  identity_registry_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  block_number INTEGER,
  payload_hex TEXT NOT NULL,
  anchored_at INTEGER NOT NULL,
  gas_used TEXT,
  fee_wei TEXT
);
CREATE INDEX IF NOT EXISTS idx_erc8004_anchors_envelope_cid ON erc8004_anchors(envelope_cid);
CREATE INDEX IF NOT EXISTS idx_erc8004_anchors_envelope_id ON erc8004_anchors(envelope_id);

CREATE TABLE IF NOT EXISTS manifest_batch_journal (
  batch_key TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

-- Held-out checkpoint eval results (issue #818). One row per
-- (checkpoint, slate version, instance). Scores are only comparable WITHIN a
-- slate version; slate_hash is stored so a version-bump / hash-drift is
-- detectable. passed is nullable: an unscorable row (Docker down, disk
-- floor) carries passed = NULL and is EXCLUDED from the denominator -- never
-- coerced to a fail.
CREATE TABLE IF NOT EXISTS eval_results (
  checkpoint_cid TEXT NOT NULL,
  slate_hash TEXT NOT NULL,
  slate_version TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  passed INTEGER,
  unscorable INTEGER NOT NULL DEFAULT 0,
  code_digest TEXT NOT NULL,
  run_at_ms INTEGER NOT NULL,
  test_log_excerpt TEXT,
  PRIMARY KEY (checkpoint_cid, slate_version, instance_id)
);

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
    this.db.exec(PHASE_RUNS_SCHEMA);
    this.db.exec(ENGAGEMENT_LEDGER_SCHEMA);
    this.db.exec(NATIVE_DISCOVERY_SCHEMA);
    this.db.exec(NATIVE_OPERATOR_STATE_SCHEMA);
    this.db.exec(PROJECTOR_CURSOR_SCHEMA);
    this.db.exec(PROJECTOR_OBSERVATIONS_SCHEMA);
    this.db.exec(PROJECTOR_CANONICAL_JOURNAL_SCHEMA);
    this.ensureArtifactsTaskColumns();
    this.ensureEngagementLedgerRequestIdColumn();
    this.ensureEngagementLedgerDispatchContextColumns();
    this.ensureRewardClaimsTxIndex();
    this.ensureNetworkArtifactsPeerCatalogId();
    this.ensureErc8004AnchorGasColumns();
    this.ensureErc8004AnchorFinalizationIndex();
    this.ensureTaskPostsTaskCoordinatorColumns();
    this.ensureEnvelopeProjectionColumns();
    this.ensureActivityEventCostColumns();
    this.backfillActivityEvents();
    this.recordLegacyRestorationIntentsIgnored();
    this.clearLegacyBalanceCacheErrors();
  }

  /**
   * One-time migration (issue #2402, spec §14.2 item 2): a `balance_cache`
   * row written before this fix can carry a raw, key-in-path RPC URL in its
   * `error` column. `getBalanceCache()` re-masks on every read (see there),
   * which covers every row a client still fetches — but a service/role that
   * later drops out of the fleet (re-indexed display slot, removed service)
   * leaves its row un-read forever, so re-mask-on-read never reaches it.
   * Clearing the column outright at schema-init closes that orphan-row case;
   * `error` is re-populated on the role's next fetch/failure regardless.
   */
  private clearLegacyBalanceCacheErrors(): void {
    this.db.exec(`UPDATE balance_cache SET error = NULL WHERE error LIKE '%http%'`);
  }

  /**
   * Read-only task-run view for the status/build endpoints (#1584). Returns a
   * `TaskRunReadModel` backed by the engine persistence layer, keeping the
   * concrete `TaskRunPersistence` construction out of `api/`.
   */
  taskRunReadModel(): TaskRunReadModel {
    return new TaskRunPersistence(this.db);
  }

  /** Opaque generator phase-run persistence (#2042). */
  phaseRuns(): PhaseRunStore {
    return new PhaseRunStore(this.db);
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

  /**
   * Older on-disk DBs predate `request_id` on `engagement_ledger` (cutover stage 1 close-out C1
   * / finding E24 gap 2 -- see `../daemon/engagement-ledger.ts`'s schema doc comment).
   */
  private ensureEngagementLedgerRequestIdColumn(): void {
    const cols = this.db.prepare(`PRAGMA table_info(engagement_ledger)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'request_id')) {
      this.db.exec(`ALTER TABLE engagement_ledger ADD COLUMN request_id TEXT`);
    }
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_engagement_ledger_request_id ON engagement_ledger (request_id)`,
    );
  }

  /**
   * Older on-disk DBs predate `dispatch_context_digest`/`dispatch_context_bytes` on
   * `engagement_ledger` (finding E35, ruled -- see `../daemon/engagement-ledger.ts`'s schema doc
   * comment: the work loop seals the dispatch-context document once, at claim time, into this
   * row).
   */
  private ensureEngagementLedgerDispatchContextColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(engagement_ledger)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('dispatch_context_digest')) {
      this.db.exec(`ALTER TABLE engagement_ledger ADD COLUMN dispatch_context_digest TEXT`);
    }
    if (!names.has('dispatch_context_bytes')) {
      this.db.exec(`ALTER TABLE engagement_ledger ADD COLUMN dispatch_context_bytes TEXT`);
    }
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

  /** Databases created before manifest batching do not have receipt cost telemetry. */
  private ensureErc8004AnchorGasColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(erc8004_anchors)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('gas_used')) {
      this.db.exec(`ALTER TABLE erc8004_anchors ADD COLUMN gas_used TEXT`);
    }
    if (!names.has('fee_wei')) {
      this.db.exec(`ALTER TABLE erc8004_anchors ADD COLUMN fee_wei TEXT`);
    }
  }

  /**
   * Exact anchor finalization is idempotent across process crashes. Older
   * databases may contain duplicates from the pre-journal path, so retain the
   * first local receipt before adding the durable key.
   */
  private ensureErc8004AnchorFinalizationIndex(): void {
    this.db.exec(`
      DELETE FROM erc8004_anchors
       WHERE id NOT IN (
         SELECT MIN(id)
           FROM erc8004_anchors
          GROUP BY chain_id, identity_registry_address, metadata_key, tx_hash
       );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_erc8004_anchors_finalization
        ON erc8004_anchors (
          chain_id,
          identity_registry_address,
          metadata_key,
          tx_hash
        );
    `);
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
    if (!names.has('canonical_task_json')) {
      this.db.exec(`ALTER TABLE task_posts ADD COLUMN canonical_task_json TEXT`);
    }
    if (!names.has('request_json')) {
      this.db.exec(`ALTER TABLE task_posts ADD COLUMN request_json TEXT`);
    }
    if (!names.has('creation_tx_hash')) {
      this.db.exec(`ALTER TABLE task_posts ADD COLUMN creation_tx_hash TEXT`);
    }
    if (!names.has('creation_block_number')) {
      this.db.exec(`ALTER TABLE task_posts ADD COLUMN creation_block_number INTEGER`);
    }
    if (!names.has('broadcast_intent_at')) {
      this.db.exec(`ALTER TABLE task_posts ADD COLUMN broadcast_intent_at TEXT`);
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
    // Issue #815 — AI-units ceiling. ai_units is the gate-input projection
    // captured at claim time; claim_status tracks the per-request lifecycle
    // (claimed / claim_failed / delivered); the cost pair splits the
    // estimated-at-claim-time vs actual-at-completion telemetry.
    addActivityColumn('ai_units', 'ai_units REAL');
    addActivityColumn('claim_status', 'claim_status TEXT');
    addActivityColumn('estimated_cost_usd_micros', 'estimated_cost_usd_micros INTEGER');
    addActivityColumn('actual_cost_usd_micros', 'actual_cost_usd_micros INTEGER');
    // Issue #1004 (AC4): whether actual_cost_usd_micros is estimate-backed
    // (1) or harvested telemetry (0/null). A telemetry-less harness such as
    // Hermes still writes a NON-null actual cost via finalizeClaimDelivered,
    // so the column distinguishes a heuristic figure from a metered one. The
    // gate's estimated flag reads this so a heuristic is not shown as metered.
    addActivityColumn('actual_cost_estimated', 'actual_cost_estimated INTEGER');
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_activity_events_credential ON activity_events (credential_id, ts)`,
    );
    // Per-request lookup for the completion-time update path that fills
    // actualCostUsdMicros / sets claim_status='delivered'.
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_activity_events_req_claim ON activity_events (request_id, claim_status)`,
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

  /**
   * Membership-only variant of `recordOwnActivity`: writes the
   * `own_activity` row but does NOT emit a generic `activity_events`
   * row. Used by paths that emit their own enriched activity event
   * (e.g. issue #815's claim path attaches credentialId / aiUnits /
   * estimatedCostUsdMicros / claimStatus to the row).
   */
  markOwnActivity(requestId: string, role: 'created' | 'claimed' | 'delivered' | 'evaluated'): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO own_activity (request_id, role) VALUES (?, ?)`
    ).run(requestId, role);
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
              first_posted_at, last_posted_at, post_count, canonical_task_json, request_json,
              creation_tx_hash, creation_block_number, broadcast_intent_at
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
      canonical_task_json: string | null;
      request_json: string | null;
      creation_tx_hash: `0x${string}` | null;
      creation_block_number: number | null;
      broadcast_intent_at: string | null;
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
      canonicalTaskJson: row.canonical_task_json,
      requestJson: row.request_json,
      creationTxHash: row.creation_tx_hash,
      creationBlockNumber: row.creation_block_number,
      broadcastIntentAt: row.broadcast_intent_at,
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
    /**
     * On-chain decimal taskId (#579), decoded from the `TaskCreated` event.
     * DISTINCT from `taskId`, which is the off-chain task-document id. The
     * launcher's on-chain status chip keys its indexer lookup on this. Empty
     * string when no on-chain id was recorded (pre-migration / lost event).
     */
    protocolTaskId: string;
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
        protocolTaskId,
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
      canonicalTaskJson: record.canonicalTaskJson ?? null,
      requestJson: record.requestJson ?? null,
      creationTxHash: record.creationTxHash ?? null,
      creationBlockNumber: record.creationBlockNumber ?? null,
      broadcastIntentAt: record.broadcastIntentAt ?? null,
    };
    this.db.prepare(
      `INSERT INTO task_posts
         (creator_safe_address, source_key, policy_type, scope_key, task_id, protocol_task_id, task_cid, request_id,
          first_posted_at, last_posted_at, post_count, canonical_task_json, request_json,
          creation_tx_hash, creation_block_number, broadcast_intent_at)
       VALUES
         (@creatorSafeAddress, @sourceKey, @policyType, @scopeKey, @taskId, @protocolTaskId, @taskCid, @requestId,
          @firstPostedAt, @lastPostedAt, @postCount, @canonicalTaskJson, @requestJson,
          @creationTxHash, @creationBlockNumber, @broadcastIntentAt)
       ON CONFLICT(creator_safe_address, source_key, policy_type, scope_key) DO UPDATE SET
         task_id = excluded.task_id,
         protocol_task_id = excluded.protocol_task_id,
         task_cid = excluded.task_cid,
         request_id = excluded.request_id,
         first_posted_at = excluded.first_posted_at,
         last_posted_at = excluded.last_posted_at,
         post_count = excluded.post_count,
         canonical_task_json = excluded.canonical_task_json,
         request_json = excluded.request_json,
         creation_tx_hash = COALESCE(excluded.creation_tx_hash, task_posts.creation_tx_hash),
         creation_block_number = COALESCE(excluded.creation_block_number, task_posts.creation_block_number),
         broadcast_intent_at = COALESCE(excluded.broadcast_intent_at, task_posts.broadcast_intent_at)`,
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

  renewTaskPostLock(args: {
    creatorSafeAddress: string;
    sourceKey: string;
    policyType: TaskPostingPolicyType;
    scopeKey: string;
    ownerToken: string;
    lockedAt: string;
  }): boolean {
    const result = this.db.prepare(
      `UPDATE task_post_locks
       SET locked_at = @lockedAt
       WHERE creator_safe_address = @creatorSafeAddress
         AND source_key = @sourceKey
         AND policy_type = @policyType
         AND scope_key = @scopeKey
         AND owner_token = @ownerToken`,
    ).run(args);
    return result.changes === 1;
  }

  markTaskPostBroadcastIntent(args: {
    creatorSafeAddress: string;
    sourceKey: string;
    policyType: TaskPostingPolicyType;
    scopeKey: string;
    ownerToken: string;
    lockedAt: string;
    broadcastIntentAt: string;
  }): boolean {
    const tx = this.db.transaction((params: typeof args) => {
      const renewed = this.db.prepare(
        `UPDATE task_post_locks
         SET locked_at = @lockedAt
         WHERE creator_safe_address = @creatorSafeAddress
           AND source_key = @sourceKey
           AND policy_type = @policyType
           AND scope_key = @scopeKey
           AND owner_token = @ownerToken`,
      ).run(params);
      if (renewed.changes !== 1) return false;

      const marked = this.db.prepare(
        `UPDATE task_posts
         SET broadcast_intent_at = @broadcastIntentAt
         WHERE creator_safe_address = @creatorSafeAddress
           AND source_key = @sourceKey
           AND policy_type = @policyType
           AND scope_key = @scopeKey`,
      ).run(params);
      if (marked.changes !== 1) {
        throw new Error(
          `Task post record disappeared while marking broadcast intent for ${params.sourceKey}`,
        );
      }
      return true;
    });

    return tx(args);
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
          credential_id, cost_usd_micros, model,
          ai_units, claim_status, estimated_cost_usd_micros, actual_cost_usd_micros)
       VALUES
         (@ts, @kind, @requestId, @serviceIndex, @txHash, @solverType, @outcome, @detail,
          @credentialId, @costUsdMicros, @model,
          @aiUnits, @claimStatus, @estimatedCostUsdMicros, @actualCostUsdMicros)`,
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
      aiUnits: event.aiUnits ?? null,
      claimStatus: event.claimStatus ?? null,
      estimatedCostUsdMicros: event.estimatedCostUsdMicros ?? null,
      actualCostUsdMicros: event.actualCostUsdMicros ?? null,
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
              credential_id, cost_usd_micros, model,
              ai_units, claim_status, estimated_cost_usd_micros, actual_cost_usd_micros
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
      ai_units: number | null;
      claim_status: string | null;
      estimated_cost_usd_micros: number | null;
      actual_cost_usd_micros: number | null;
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
      aiUnits: r.ai_units,
      claimStatus: r.claim_status,
      estimatedCostUsdMicros: r.estimated_cost_usd_micros,
      actualCostUsdMicros: r.actual_cost_usd_micros,
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

  /**
   * Sum of `ai_units` for a credential within the current 6h UTC-aligned
   * block (00:00 / 06:00 / 12:00 / 18:00 boundaries). Reads only rows whose
   * `claim_status = 'claimed'` or `'delivered'` so failed-claim rows
   * (`ai_units = 0`, `claim_status = 'claim_failed'`) don't muddy the sum
   * even though their contribution is already zero.
   *
   * Issue #815. Backs the per-block AI-units ceiling gate.
   */
  aiUnitsThisBlock(credentialId: string, now: Date = new Date()): number {
    const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const sinceDayStart = now.getTime() - startOfDay;
    const sixHoursMs = 6 * 60 * 60 * 1_000;
    // Cap at 3 — there are 4 blocks per day (indices 0..3). Edge cases
    // where sinceDayStart ≈ 24h (millisecond rounding) would otherwise
    // overshoot into a non-existent 5th block in the *next* day.
    const blocksIn = Math.min(Math.floor(sinceDayStart / sixHoursMs), 3);
    const blockStart = new Date(startOfDay + blocksIn * sixHoursMs).toISOString();
    const blockEnd = new Date(startOfDay + (blocksIn + 1) * sixHoursMs).toISOString();
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(ai_units), 0) AS total
       FROM activity_events
       WHERE credential_id = @cid
         AND ts IS NOT NULL AND ts >= @blockStart AND ts < @blockEnd
         AND claim_status IN ('claimed', 'delivered')`,
    ).get({ cid: credentialId, blockStart, blockEnd }) as { total: number };
    return row.total ?? 0;
  }

  /**
   * Sum of `ai_units` for a credential within the trailing 7-day rolling
   * window from `now`. Backs the per-week AI-units safety-net ceiling.
   * Issue #815.
   */
  aiUnitsThisWeek(credentialId: string, now: Date = new Date()): number {
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString();
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(ai_units), 0) AS total
       FROM activity_events
       WHERE credential_id = @cid
         AND ts IS NOT NULL AND ts >= @weekStart
         AND claim_status IN ('claimed', 'delivered')`,
    ).get({ cid: credentialId, weekStart }) as { total: number };
    return row.total ?? 0;
  }

  /**
   * Actual-spend accumulator for the current 6h UTC block (issue #1004).
   *
   * Sums `COALESCE(actual_cost_usd_micros, estimated_cost_usd_micros, 0)`
   * over rows whose `claim_status` is `'claimed'` or `'delivered'`:
   *   - delivered rows contribute the real harvested cost (`actual_*`),
   *   - in-flight claimed rows contribute their estimate so a burst of
   *     concurrent claims cannot slip the cap before any of them deliver,
   *   - failed claims (status `'claim_failed'`) are excluded.
   *
   * `estimated` is true iff the summed figure includes any estimate-backed
   * cost: an in-flight `claimed` row with no `actual_cost_usd_micros` yet,
   * OR a `delivered` row whose actual cost is itself a heuristic
   * (`actual_cost_estimated = 1` — a telemetry-less harness such as Hermes).
   * It is false only when every contributing row is harvested actual
   * telemetry. The gate surfaces this so an estimate-backed figure is not
   * presented as metered. Block boundaries mirror `aiUnitsThisBlock`.
   */
  usdMicrosThisBlock(
    credentialId: string,
    now: Date = new Date(),
  ): { usdMicros: number; estimated: boolean } {
    const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const sinceDayStart = now.getTime() - startOfDay;
    const sixHoursMs = 6 * 60 * 60 * 1_000;
    const blocksIn = Math.min(Math.floor(sinceDayStart / sixHoursMs), 3);
    const blockStart = new Date(startOfDay + blocksIn * sixHoursMs).toISOString();
    const blockEnd = new Date(startOfDay + (blocksIn + 1) * sixHoursMs).toISOString();
    return this.sumUsdMicros(credentialId, blockStart, blockEnd);
  }

  /**
   * Actual-spend accumulator for the trailing 7-day rolling window from
   * `now` (issue #1004). Same COALESCE + claim_status filter + `estimated`
   * semantics as {@link usdMicrosThisBlock}.
   */
  usdMicrosThisWeek(
    credentialId: string,
    now: Date = new Date(),
  ): { usdMicros: number; estimated: boolean } {
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString();
    return this.sumUsdMicros(credentialId, weekStart, undefined);
  }

  /**
   * The true "claims resume at" instant for the rolling 7-day window
   * (issue #830, item 1). `weekResetsAtUtc(now)` (`now + 7d`) is a fixed
   * instant that overstates the wait — a rolling window sheds its oldest
   * rows continuously, not all at once. This walks the in-window rows
   * oldest-to-newest, subtracting each from the running total, and returns
   * the instant `remaining + projectedUsdMicros` first falls to or below
   * `capUsdMicros` (that row's `ts + 7d`). The `<=` boundary exactly mirrors
   * the gate, which blocks only on `current + projected > cap`. Returns
   * `null` when the prospective claim is already allowed or when the
   * projection alone exceeds the cap, so no in-window row expiry can make
   * the claim eligible.
   */
  weekWindowResumeAt(
    credentialId: string,
    capUsdMicros: number,
    now: Date = new Date(),
    projectedUsdMicros = 0,
  ): string | null {
    if (projectedUsdMicros > capUsdMicros) return null;

    const weekStart = new Date(now.getTime() - SEVEN_DAY_MS).toISOString();
    const rows = this.db
      .prepare(
        `SELECT ts, COALESCE(actual_cost_usd_micros, estimated_cost_usd_micros, 0) AS usdMicros
         FROM activity_events
         WHERE credential_id = @cid
           AND ts IS NOT NULL AND ts >= @weekStart AND ts < @now
           AND claim_status IN ('claimed', 'delivered')
         ORDER BY ts ASC`,
      )
      .all({ cid: credentialId, weekStart, now: now.toISOString() }) as {
      ts: string;
      usdMicros: number;
    }[];

    let remaining = rows.reduce((sum, r) => sum + r.usdMicros, 0);
    if (remaining + projectedUsdMicros <= capUsdMicros) return null;

    // Guaranteed to return inside this loop for a non-negative projection no
    // larger than the cap: after the last row, remaining is zero and the
    // prospective debit is within the cap.
    for (const row of rows) {
      remaining -= row.usdMicros;
      if (remaining + projectedUsdMicros <= capUsdMicros) {
        return new Date(new Date(row.ts).getTime() + SEVEN_DAY_MS).toISOString();
      }
    }
    return null;
  }

  /** Shared COALESCE-sum + estimate-flag query for the USD accumulators. */
  private sumUsdMicros(
    credentialId: string,
    fromIso: string,
    toIso: string | undefined,
  ): { usdMicros: number; estimated: boolean } {
    const upper = toIso ? 'AND ts < @to' : '';
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(COALESCE(actual_cost_usd_micros, estimated_cost_usd_micros, 0)), 0) AS total,
           COALESCE(SUM(CASE WHEN actual_cost_usd_micros IS NULL OR actual_cost_estimated = 1 THEN 1 ELSE 0 END), 0) AS estimatedRows
         FROM activity_events
         WHERE credential_id = @cid
           AND ts IS NOT NULL AND ts >= @from ${upper}
           AND claim_status IN ('claimed', 'delivered')`,
      )
      .get({ cid: credentialId, from: fromIso, to: toIso }) as {
        total: number;
        estimatedRows: number;
      };
    return { usdMicros: row.total ?? 0, estimated: (row.estimatedRows ?? 0) > 0 };
  }

  /**
   * True iff an `ai_units_cap_reached` row exists for the given
   * (credentialId, window, blockId). Used by the daemon to hydrate the
   * AI-units gate's in-memory pause memo across restarts so the
   * "exactly one event per (credential, window, block-id)" guarantee
   * holds across process boundaries (issue #815, finding 1).
   *
   * Lookup is by `credential_id` + `kind` + the `[block=...][window=...]`
   * markers that `daemon.ts` embeds in the row's `detail` string.
   */
  hasAiUnitsCapReachedFor(
    credentialId: string,
    window: 'block' | 'week',
    blockId: string,
  ): boolean {
    const marker = `[block=${blockId}][window=${window}]`;
    const row = this.db.prepare(
      `SELECT 1 AS hit
       FROM activity_events
       WHERE kind = 'ai_units_cap_reached'
         AND credential_id = @cid
         AND detail LIKE @marker
       LIMIT 1`,
    ).get({ cid: credentialId, marker: `${marker}%` }) as { hit: number } | undefined;
    return row !== undefined;
  }

  /**
   * Mark the per-request `claimed` row as `delivered` and record
   * `actual_cost_usd_micros` (issue #1004 — the gate's accumulator now
   * reads this column via COALESCE, so a delivered row's real harvested
   * cost replaces its claim-time estimate in the running total). The
   * `ai_units` projection captured at claim time is intentionally NOT
   * recomputed — it remains the per-task estimate for the legacy unit
   * surfaces. For subscription credentials the resulting USD figure is a
   * *proxy* budget, not an exact bound on the provider's plan quota.
   *
   * `actualCostEstimated` (issue #1004, AC4) records whether the actual
   * cost is itself a heuristic — true for a telemetry-less harness such as
   * Hermes whose `harvestHarnessUsage` falls back to an a-priori estimate,
   * false when the figure is harvested telemetry. The gate reads it so a
   * delivered-but-heuristic row reports `estimated: true` rather than being
   * presented as metered. Idempotent: a no-op when no `claimed` row exists.
   */
  finalizeClaimDelivered(
    requestId: string,
    actualCostUsdMicros: number,
    actualCostEstimated: boolean,
  ): void {
    this.db.prepare(
      `UPDATE activity_events
         SET claim_status = 'delivered',
             actual_cost_usd_micros = @actual,
             actual_cost_estimated = @estimated
       WHERE request_id = @req AND claim_status = 'claimed'`,
    ).run({
      req: requestId,
      actual: actualCostUsdMicros,
      estimated: actualCostEstimated ? 1 : 0,
    });
  }

  /** Newer events first, then ascending id for `jinn logs --follow` (oldest in batch printed first in caller). */
  getActivityEventsAfterId(afterId: number, limit: number): ActivityEventRow[] {
    const effectiveLimit = Math.max(0, Math.min(limit, 1000));
    const rows = this.db
      .prepare(
        `SELECT id, ts, kind, request_id, service_index, tx_hash, solver_type, outcome, detail,
                credential_id, cost_usd_micros, model,
                ai_units, claim_status, estimated_cost_usd_micros, actual_cost_usd_micros
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
        ai_units: number | null;
        claim_status: string | null;
        estimated_cost_usd_micros: number | null;
        actual_cost_usd_micros: number | null;
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
      aiUnits: r.ai_units,
      claimStatus: r.claim_status,
      estimatedCostUsdMicros: r.estimated_cost_usd_micros,
      actualCostUsdMicros: r.actual_cost_usd_micros,
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
      `SELECT id, ts, kind, request_id, service_index, tx_hash, solver_type, outcome, detail,
              credential_id, cost_usd_micros, model,
              ai_units, claim_status, estimated_cost_usd_micros, actual_cost_usd_micros
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
      ai_units: number | null;
      claim_status: string | null;
      estimated_cost_usd_micros: number | null;
      actual_cost_usd_micros: number | null;
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
      aiUnits: r.ai_units,
      claimStatus: r.claim_status,
      estimatedCostUsdMicros: r.estimated_cost_usd_micros,
      actualCostUsdMicros: r.actual_cost_usd_micros,
    }));
  }

  getActivityEventById(id: number): ActivityEventRow | null {
    const r = this.db.prepare(
      `SELECT id, ts, kind, request_id, service_index, tx_hash, solver_type, outcome, detail,
              credential_id, cost_usd_micros, model,
              ai_units, claim_status, estimated_cost_usd_micros, actual_cost_usd_micros
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
      credential_id: string | null;
      cost_usd_micros: number | null;
      model: string | null;
      ai_units: number | null;
      claim_status: string | null;
      estimated_cost_usd_micros: number | null;
      actual_cost_usd_micros: number | null;
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
      credentialId: r.credential_id,
      costUsdMicros: r.cost_usd_micros,
      model: r.model,
      aiUnits: r.ai_units,
      claimStatus: r.claim_status,
      estimatedCostUsdMicros: r.estimated_cost_usd_micros,
      actualCostUsdMicros: r.actual_cost_usd_micros,
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

  getClaimedRewardsLast24hWei(): string {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(
      `SELECT amount_wei FROM reward_claims WHERE ts >= ?`,
    ).all(cutoff) as Array<{ amount_wei: string }>;
    let total = 0n;
    for (const row of rows) {
      try {
        total += BigInt(row.amount_wei);
      } catch {
        /* ignore malformed legacy rows */
      }
    }
    return total.toString();
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
      // Re-mask on read (issue #2402, spec §14.2 item 2) — NOT a one-shot
      // scrub, this runs on every call. A row written before gather-status.ts's
      // `errorMessage` choke point started masking RPC URLs can carry a raw
      // key-in-path error string; masking again here is idempotent
      // (already-masked errors have no `http(s)://` substring left to match)
      // and guarantees such a row stops leaking on its very next read. The
      // actual one-shot scrub is `clearLegacyBalanceCacheErrors()` at
      // schema-init, which also covers rows for a role that's since dropped
      // out of the fleet and would otherwise never be read again.
      error: r.error === null ? null : maskUrlsInMessage(r.error),
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

  /**
   * Deterministic per-envelopeCid artifact lookup — no recency window, unlike
   * searchOwnAndCached. Used by corpus-knowledge autoload (#1393 review
   * finding 2) to backfill artifact refs for a small, already-ranked set of
   * envelope CIDs regardless of how many other artifact rows exist locally.
   */
  getArtifactsByEnvelopeCids(envelopeCids: readonly string[]): Array<{
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
    if (envelopeCids.length === 0) return [];
    const params: Record<string, unknown> = {};
    const placeholders = envelopeCids.map((cid, index) => {
      const key = `cid${index}`;
      params[key] = cid;
      return `@${key}`;
    }).join(', ');

    const own = this.db.prepare(
      `SELECT sha256, artifact_type, envelope_cid, content_size, price_usdc, created_at
       FROM served_artifacts WHERE envelope_cid IN (${placeholders})`,
    ).all(params) as Array<{
      sha256: string;
      artifact_type: string;
      envelope_cid: string | null;
      content_size: number;
      price_usdc: string;
      created_at: string;
    }>;
    const cached = this.db.prepare(
      `SELECT sha256, artifact_type, envelope_cid, content_size, source_operator, source_endpoint, paid_amount_usdc, fetched_at
       FROM network_artifacts WHERE envelope_cid IN (${placeholders})`,
    ).all(params) as Array<{
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

  /**
   * Upgrade a previously-saved projection's evidence_tier in place (#1393
   * review finding 1). pack() saves projections as 'self-signed' regardless
   * of the envelope's own (aspirational) tier — a race-lost or failed
   * delivery must never leave a 'committed' projection outranking genuinely
   * delivered self-signed work. deliver() calls this to upgrade the tier
   * only once on-chain evidence actually exists (claimDelivery succeeded).
   * No-op if the envelope_id isn't found (defensive; never fatal to deliver()).
   */
  upgradeEnvelopeProjectionEvidenceTier(envelopeId: string, tier: EnvelopeProjection['evidenceTier']): void {
    this.db.prepare(
      `UPDATE envelope_projections SET evidence_tier = @tier WHERE envelope_id = @envelopeId`,
    ).run({ envelopeId, tier });
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

  saveErc8004Anchor(input: Erc8004AnchorInput): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO erc8004_anchors
         (envelope_id, envelope_cid, content_kind, metadata_key, agent_id,
          chain_id, identity_registry_address, tx_hash, block_number,
          payload_hex, anchored_at, gas_used, fee_wei)
       VALUES
         (@envelopeId, @envelopeCid, @contentKind, @metadataKey, @agentId,
          @chainId, @identityRegistryAddress, @txHash, @blockNumber,
          @payloadHex, @anchoredAt, @gasUsed, @feeWei)`,
    ).run({
      envelopeId: input.envelopeId,
      envelopeCid: input.envelopeCid,
      contentKind: input.contentKind,
      metadataKey: input.metadataKey,
      agentId: input.agentId,
      chainId: input.chainId,
      identityRegistryAddress: input.identityRegistryAddress,
      txHash: input.txHash,
      blockNumber: input.blockNumber,
      payloadHex: input.payloadHex,
      anchoredAt: input.anchoredAt,
      gasUsed: input.gasUsed ?? null,
      feeWei: input.feeWei ?? null,
    });
  }

  loadManifestBatchJournal(batchKey: string): string | null {
    const row = this.db.prepare(
      `SELECT state_json
         FROM manifest_batch_journal
        WHERE batch_key = ?`,
    ).get(batchKey) as { state_json: string } | undefined;
    return row?.state_json ?? null;
  }

  saveManifestBatchJournal(batchKey: string, stateJson: string): void {
    this.db.prepare(
      `INSERT INTO manifest_batch_journal (batch_key, state_json, updated_at)
       VALUES (@batchKey, @stateJson, datetime('now'))
       ON CONFLICT(batch_key) DO UPDATE SET
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
    ).run({ batchKey, stateJson });
  }

  compareAndSwapManifestBatchJournal(
    batchKey: string,
    expectedStateJson: string | null,
    nextStateJson: string,
  ): boolean {
    if (expectedStateJson === null) {
      const result = this.db.prepare(
        `INSERT INTO manifest_batch_journal (batch_key, state_json, updated_at)
         VALUES (@batchKey, @nextStateJson, datetime('now'))
         ON CONFLICT(batch_key) DO NOTHING`,
      ).run({ batchKey, nextStateJson });
      return result.changes === 1;
    }
    const result = this.db.prepare(
      `UPDATE manifest_batch_journal
          SET state_json = @nextStateJson,
              updated_at = datetime('now')
        WHERE batch_key = @batchKey
          AND state_json = @expectedStateJson`,
    ).run({ batchKey, expectedStateJson, nextStateJson });
    return result.changes === 1;
  }

  listErc8004AnchorsByEnvelopeCids(envelopeCids: readonly string[]): Erc8004AnchorRow[] {
    if (envelopeCids.length === 0) return [];
    const placeholders = envelopeCids.map((_, i) => `@cid${i}`).join(', ');
    const params: Record<string, string> = {};
    envelopeCids.forEach((cid, i) => { params[`cid${i}`] = cid; });
    const rows = this.db.prepare(
      `SELECT id, envelope_id, envelope_cid, content_kind, metadata_key, agent_id,
              chain_id, identity_registry_address, tx_hash, block_number,
              payload_hex, anchored_at, gas_used, fee_wei
         FROM erc8004_anchors
         WHERE envelope_cid IN (${placeholders})
         ORDER BY anchored_at ASC, id ASC`,
    ).all(params) as Array<{
      id: number;
      envelope_id: string;
      envelope_cid: string;
      content_kind: string;
      metadata_key: string;
      agent_id: string;
      chain_id: number;
      identity_registry_address: string;
      tx_hash: string;
      block_number: number | null;
      payload_hex: string;
      anchored_at: number;
      gas_used: string | null;
      fee_wei: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      envelopeId: r.envelope_id,
      envelopeCid: r.envelope_cid,
      contentKind: r.content_kind,
      metadataKey: r.metadata_key,
      agentId: r.agent_id,
      chainId: r.chain_id,
      identityRegistryAddress: r.identity_registry_address,
      txHash: r.tx_hash,
      blockNumber: r.block_number,
      payloadHex: r.payload_hex,
      anchoredAt: r.anchored_at,
      gasUsed: r.gas_used,
      feeWei: r.fee_wei,
    }));
  }

  /**
   * Upsert one held-out eval result (issue #818). PK is
   * `(checkpoint_cid, slate_version, instance_id)` so a re-run overwrites.
   * `passed` is null for `unscorable` rows.
   */
  recordEvalResult(args: EvalResultRecord): void {
    this.db
      .prepare(
        `INSERT INTO eval_results
           (checkpoint_cid, slate_hash, slate_version, instance_id, passed, unscorable, code_digest, run_at_ms, test_log_excerpt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(checkpoint_cid, slate_version, instance_id) DO UPDATE SET
           slate_hash = excluded.slate_hash,
           passed = excluded.passed,
           unscorable = excluded.unscorable,
           code_digest = excluded.code_digest,
           run_at_ms = excluded.run_at_ms,
           test_log_excerpt = excluded.test_log_excerpt`,
      )
      .run(
        args.checkpoint_cid,
        args.slate_hash,
        args.slate_version,
        args.instance_id,
        args.unscorable ? null : args.passed ? 1 : 0,
        args.unscorable ? 1 : 0,
        args.code_digest,
        args.run_at_ms,
        args.test_log_excerpt ?? null,
      );
  }

  /**
   * Aggregate the eval results for a (checkpoint, slate version):
   * `scorable` = rows with `unscorable = 0`; `passed` = scorable rows with
   * `passed = 1`. Unscorable rows are counted separately and never enter the
   * denominator. A checkpoint with no rows yields all-zero (the orchestrator
   * reads this to detect a not-yet-evaluated parent).
   */
  getEvalAggregate(checkpoint_cid: string, slate_version: string): EvalAggregate {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN unscorable = 0 AND passed = 1 THEN 1 ELSE 0 END), 0) AS passed,
           COALESCE(SUM(CASE WHEN unscorable = 0 THEN 1 ELSE 0 END), 0) AS scorable,
           COALESCE(SUM(CASE WHEN unscorable = 1 THEN 1 ELSE 0 END), 0) AS unscorable
         FROM eval_results
         WHERE checkpoint_cid = ? AND slate_version = ?`,
      )
      .get(checkpoint_cid, slate_version) as { passed: number; scorable: number; unscorable: number };
    return { passed: row.passed, scorable: row.scorable, unscorable: row.unscorable };
  }

  /**
   * Distinct `slate_hash` values recorded for a (checkpoint, slate version).
   * The eval orchestrator reads this to detect slate-content drift under a
   * stable version label — the held-out exam is only an honest before/after
   * when the parent and child were scored on the SAME slate content (defeating
   * confounder #1, task-selection). Empty when the checkpoint has no rows.
   */
  getEvalSlateHashes(checkpoint_cid: string, slate_version: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT slate_hash
         FROM eval_results
         WHERE checkpoint_cid = ? AND slate_version = ?
         ORDER BY slate_hash`,
      )
      .all(checkpoint_cid, slate_version) as { slate_hash: string }[];
    return rows.map((r) => r.slate_hash);
  }

  /** Per-task eval results for a (checkpoint, slate version), ordered by instance_id. */
  getEvalResults(checkpoint_cid: string, slate_version: string): EvalResultRow[] {
    const rows = this.db
      .prepare(
        `SELECT checkpoint_cid, slate_hash, slate_version, instance_id, passed, unscorable, code_digest, run_at_ms, test_log_excerpt
         FROM eval_results
         WHERE checkpoint_cid = ? AND slate_version = ?
         ORDER BY instance_id`,
      )
      .all(checkpoint_cid, slate_version) as RawEvalResultRow[];
    return rows.map((r) => ({
      checkpoint_cid: r.checkpoint_cid,
      slate_hash: r.slate_hash,
      slate_version: r.slate_version,
      instance_id: r.instance_id,
      passed: r.passed === null ? null : r.passed === 1,
      unscorable: r.unscorable === 1,
      code_digest: r.code_digest,
      run_at_ms: r.run_at_ms,
      test_log_excerpt: r.test_log_excerpt,
    }));
  }

  close(): void {
    this.db.close();
  }
}

export interface EvalResultRecord {
  checkpoint_cid: string;
  slate_hash: string;
  slate_version: string;
  instance_id: string;
  /** Pass/fail; ignored (stored NULL) when `unscorable` is true. */
  passed: boolean | null;
  unscorable: boolean;
  code_digest: string;
  run_at_ms: number;
  test_log_excerpt?: string | null;
}

/** A persisted eval result read back from the store (same shape as the record written). */
export type EvalResultRow = EvalResultRecord;

export interface EvalAggregate {
  passed: number;
  scorable: number;
  unscorable: number;
}

interface RawEvalResultRow {
  checkpoint_cid: string;
  slate_hash: string;
  slate_version: string;
  instance_id: string;
  passed: number | null;
  unscorable: number;
  code_digest: string;
  run_at_ms: number;
  test_log_excerpt: string | null;
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
