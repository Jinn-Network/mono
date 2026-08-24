import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EnvelopeProjection, EnvelopeProjectionQuery } from '../corpus/types.js';
import { ENGAGEMENT_LEDGER_SCHEMA } from '../daemon/engagement-ledger.js';
import { NATIVE_DISCOVERY_SCHEMA } from '../daemon/native-discovery.js';
import { NATIVE_OPERATOR_STATE_SCHEMA } from '../daemon/native-operator-state.js';
import {
  PROJECTOR_CANONICAL_JOURNAL_SCHEMA,
  PROJECTOR_CURSOR_SCHEMA,
  PROJECTOR_OBSERVATIONS_SCHEMA,
} from '../daemon/projector-cursor.js';
import { NativeTaskRunReadModel } from './native-task-run-read-model.js';
import { NativeVerdictTallyReadModel } from './native-verdict-tally-read-model.js';
import { PHASE_RUNS_SCHEMA, PhaseRunStore } from './phase-runs.js';
import { ActivityEventsStore } from './activity-events.js';
import { ArtifactsStore } from './artifacts.js';
import { BalanceCacheStore } from './balance-cache.js';
import { EnvelopeProjectionsStore } from './envelope-projections.js';
import { Erc8004AnchorsStore, type Erc8004AnchorInput, type Erc8004AnchorRow } from './erc8004-anchors.js';
import {
  EvalResultsStore,
  type EvalAggregate,
  type EvalResultRecord,
  type EvalResultRow,
} from './eval-results.js';
import { NetworkArtifactsStore } from './network-artifacts.js';
import { OperatorConfigStore } from './operator-config.js';
import { OwnActivityStore } from './own-activity.js';
import { RewardClaimsStore } from './reward-claims.js';
import { ServedArtifactsStore } from './served-artifacts.js';
import {
  TaskPostsStore,
  type TaskPostRecord,
  type TaskPostingPolicyType,
} from './task-posts.js';
import { TxSubmissionsStore } from './tx-submissions.js';
import type { TaskRunReadModel } from '../types/task-run-read-model.js';
import type { VerdictTallyReadModel } from '../types/verdict-tally-read-model.js';
import type { TxSubmissionKey, TxSubmissionLedgerEntry } from '../tx-retry.js';

export type { ActivityEventInput, ActivityEventRow } from './activity-events.js';
export type { BalanceCacheEntry } from './balance-cache.js';
export type { Erc8004AnchorInput, Erc8004AnchorRow } from './erc8004-anchors.js';
export type { EvalAggregate, EvalResultRecord, EvalResultRow } from './eval-results.js';
export type {
  ArtifactAccessEventInput,
  ArtifactAccessEventRow,
  ArtifactAccessOutcome,
  ArtifactAccessStats,
  ServedArtifactInput,
  ServedArtifactMetadataRow,
  ServedArtifactRow,
} from './served-artifacts.js';
export type {
  NetworkArtifactInput,
  NetworkArtifactMetadataRow,
  NetworkArtifactRow,
  NetworkArtifactSource,
} from './network-artifacts.js';
export type { RewardClaimInput } from './reward-claims.js';
export type { TaskPostRecord, TaskPostingPolicyType } from './task-posts.js';

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
  /** Exposed for native persistence and tests — treat as package-internal. */
  readonly db: Database.Database;
  readonly path: string;

  private readonly operatorConfig: OperatorConfigStore;
  private readonly txSubmissions: TxSubmissionsStore;
  private readonly rewardClaims: RewardClaimsStore;
  private readonly balanceCache: BalanceCacheStore;
  private readonly ownActivity: OwnActivityStore;
  private readonly taskPosts: TaskPostsStore;
  private readonly activityEvents: ActivityEventsStore;
  private readonly artifacts: ArtifactsStore;
  private readonly servedArtifacts: ServedArtifactsStore;
  private readonly networkArtifacts: NetworkArtifactsStore;
  private readonly envelopeProjections: EnvelopeProjectionsStore;
  private readonly erc8004Anchors: Erc8004AnchorsStore;
  private readonly evalResults: EvalResultsStore;

  constructor(dbPath: string) {
    this.path = dbPath;
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.operatorConfig = new OperatorConfigStore(this.db);
    this.txSubmissions = new TxSubmissionsStore(this.db);
    this.rewardClaims = new RewardClaimsStore(this.db);
    this.balanceCache = new BalanceCacheStore(this.db);
    this.ownActivity = new OwnActivityStore(this.db);
    this.taskPosts = new TaskPostsStore(this.db);
    this.activityEvents = new ActivityEventsStore(this.db);
    this.artifacts = new ArtifactsStore(this.db);
    this.servedArtifacts = new ServedArtifactsStore(this.db);
    this.networkArtifacts = new NetworkArtifactsStore(this.db);
    this.envelopeProjections = new EnvelopeProjectionsStore(this.db);
    this.erc8004Anchors = new Erc8004AnchorsStore(this.db);
    this.evalResults = new EvalResultsStore(this.db);
    this.db.exec(SCHEMA);
    this.db.exec(PHASE_RUNS_SCHEMA);
    this.db.exec(ENGAGEMENT_LEDGER_SCHEMA);
    this.db.exec(NATIVE_DISCOVERY_SCHEMA);
    this.db.exec(NATIVE_OPERATOR_STATE_SCHEMA);
    this.db.exec(PROJECTOR_CURSOR_SCHEMA);
    this.db.exec(PROJECTOR_OBSERVATIONS_SCHEMA);
    this.db.exec(PROJECTOR_CANONICAL_JOURNAL_SCHEMA);
    this.artifacts.runMigrations();
    this.ensureEngagementLedgerRequestIdColumn();
    this.ensureEngagementLedgerDispatchContextColumns();
    this.rewardClaims.runMigrations();
    this.networkArtifacts.runMigrations();
    this.erc8004Anchors.runMigrations();
    this.taskPosts.runMigrations();
    this.envelopeProjections.runMigrations();
    this.activityEvents.runMigrations();
    this.backfillActivityEvents();
    this.recordLegacyRestorationIntentsIgnored();
    this.balanceCache.clearLegacyErrors();
  }

  /**
   * Read-only task-run view for the status/build endpoints (#1584). Always the
   * native aggregate tables (`native_engagements` / `native_evaluations`).
   * The optional argument is accepted for call-site compatibility and ignored.
   */
  taskRunReadModel(_compositionMode?: 'legacy' | 'native'): TaskRunReadModel {
    return new NativeTaskRunReadModel(this.db);
  }

  /**
   * Whether this request belongs to a jinn-repo Autopilot session this operator
   * claimed. Durable lookup for the mech adapter's settlement-ownership gate
   * after a restart (in-memory Task maps are empty).
   */
  engagementIsAutopilotSession(requestId: string): boolean {
    const ledger = this.db.prepare(
      `SELECT work_kind FROM engagement_ledger WHERE request_id = ? LIMIT 1`,
    ).get(requestId) as { work_kind: string } | undefined;
    if (ledger?.work_kind === 'jinn-repo.v1') return true;
    const native = this.db.prepare(
      `SELECT capability_json FROM native_engagements WHERE request_id = ? LIMIT 1`,
    ).get(requestId) as { capability_json: string } | undefined;
    if (native === undefined) return false;
    try {
      const cap = JSON.parse(native.capability_json) as { workKind?: unknown; solverType?: unknown };
      return cap.workKind === 'jinn-repo.v1' || cap.solverType === 'jinn-repo.v1';
    } catch {
      return false;
    }
  }

  /**
   * Native verdict-tally read model for the status-plane outcome enrichment
   * (one-swap R2, umbrella #2461, DR-2026-08-05).
   */
  verdictTallyReadModel(): VerdictTallyReadModel {
    return new NativeVerdictTallyReadModel(this.db);
  }

  /** Opaque generator phase-run persistence (#2042). */
  phaseRuns(): PhaseRunStore {
    return new PhaseRunStore(this.db);
  }

  private ensureEngagementLedgerRequestIdColumn(): void {
    const cols = this.db.prepare(`PRAGMA table_info(engagement_ledger)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'request_id')) {
      this.db.exec(`ALTER TABLE engagement_ledger ADD COLUMN request_id TEXT`);
    }
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_engagement_ledger_request_id ON engagement_ledger (request_id)`,
    );
  }

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
        this.operatorConfig.setConfigValue('legacy_restoration_intents_ignored_v1', JSON.stringify(marker));
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

  recordOwnActivity(requestId: string, role: 'created' | 'claimed' | 'delivered' | 'evaluated'): void {
    this.ownActivity.record(requestId, role);
    const ts = new Date().toISOString();
    this.activityEvents.recordActivityEvent({ ts, kind: role, requestId });
  }

  isOwnActivity(requestId: string): boolean {
    return this.ownActivity.isOwnActivity(requestId);
  }

  setShutdownState(state: 'clean' | 'running'): void { this.operatorConfig.setShutdownState(state); }
  getShutdownState(): string | null { return this.operatorConfig.getShutdownState(); }
  setDaemonStartedAt(value: string): void { this.operatorConfig.setDaemonStartedAt(value); }
  getDaemonStartedAt(): string | null { return this.operatorConfig.getDaemonStartedAt(); }

  recordTxSubmission(entry: TxSubmissionLedgerEntry): void { this.txSubmissions.recordTxSubmission(entry); }
  getTxSubmission(key: TxSubmissionKey): TxSubmissionLedgerEntry | null { return this.txSubmissions.getTxSubmission(key); }
  markTxSubmissionResolved(key: TxSubmissionKey & { resolvedAtMs: number }): void { this.txSubmissions.markTxSubmissionResolved(key); }

  getConfigValue(key: string): string | null { return this.operatorConfig.getConfigValue(key); }
  setConfigValue(key: string, value: string): void { this.operatorConfig.setConfigValue(key, value); }

  getTaskPostRecord(args: {
    creatorSafeAddress: string;
    sourceKey: string;
    policyType: TaskPostingPolicyType;
    scopeKey: string;
  }): TaskPostRecord | null { return this.taskPosts.getTaskPostRecord(args); }

  listPostedTasksByCreator(args: {
    creatorSafeAddress: string;
    limit: number;
    before?: string;
  }) { return this.taskPosts.listPostedTasksByCreator(args); }

  countPostedTasksByCreatorAndSolverType(args: { creatorSafeAddress: string; solverType: string }): number {
    return this.taskPosts.countPostedTasksByCreatorAndSolverType(args);
  }

  upsertTaskPostRecord(record: TaskPostRecord): void { this.taskPosts.upsertTaskPostRecord(record); }
  acquireTaskPostLock(args: Parameters<TaskPostsStore['acquireTaskPostLock']>[0]): boolean { return this.taskPosts.acquireTaskPostLock(args); }
  releaseTaskPostLock(args: Parameters<TaskPostsStore['releaseTaskPostLock']>[0]): void { this.taskPosts.releaseTaskPostLock(args); }
  renewTaskPostLock(args: Parameters<TaskPostsStore['renewTaskPostLock']>[0]): boolean { return this.taskPosts.renewTaskPostLock(args); }
  markTaskPostBroadcastIntent(args: Parameters<TaskPostsStore['markTaskPostBroadcastIntent']>[0]): boolean {
    return this.taskPosts.markTaskPostBroadcastIntent(args);
  }

  /** Counts of protocol roles recorded for this node (best-effort activity hints). */
  getOwnActivityCounts(): Record<string, number> {
    const counts = this.activityEvents.getActivityCountsByKind();
    if (Object.keys(counts).length > 0) return counts;
    return this.ownActivity.getCounts();
  }

  /** Latest own_activity rows by insertion order (approximate). */
  getRecentOwnActivity(limit: number): Array<{ requestId: string; role: string }> {
    const rows = this.activityEvents.getRecentActivityEvents(limit);
    if (rows.length > 0) return rows.map((r) => ({ requestId: r.requestId ?? '', role: r.kind }));
    const legacyRows = this.db.prepare(
      `SELECT request_id, role FROM own_activity ORDER BY rowid DESC LIMIT ?`,
    ).all(Math.max(0, Math.min(limit, 1000))) as Array<{ request_id: string; role: string }>;
    return legacyRows.map(r => ({ requestId: r.request_id, role: r.role }));
  }

  recordActivityEvent(event: Parameters<ActivityEventsStore['recordActivityEvent']>[0]): number {
    return this.activityEvents.recordActivityEvent(event);
  }

  getRecentActivityEvents(limit: number, opts: Parameters<ActivityEventsStore['getRecentActivityEvents']>[1] = {}) {
    return this.activityEvents.getRecentActivityEvents(limit, opts);
  }

  spentTodayMicros(credentialId: string, now?: Date): number { return this.activityEvents.spentTodayMicros(credentialId, now); }
  aiUnitsThisBlock(credentialId: string, now?: Date): number { return this.activityEvents.aiUnitsThisBlock(credentialId, now); }
  aiUnitsThisWeek(credentialId: string, now?: Date): number { return this.activityEvents.aiUnitsThisWeek(credentialId, now); }
  usdMicrosThisBlock(credentialId: string, now?: Date) { return this.activityEvents.usdMicrosThisBlock(credentialId, now); }
  usdMicrosThisWeek(credentialId: string, now?: Date) { return this.activityEvents.usdMicrosThisWeek(credentialId, now); }
  weekWindowResumeAt(credentialId: string, capUsdMicros: number, now?: Date, projectedUsdMicros?: number) {
    return this.activityEvents.weekWindowResumeAt(credentialId, capUsdMicros, now, projectedUsdMicros);
  }
  hasAiUnitsCapReachedFor(credentialId: string, window: 'block' | 'week', blockId: string): boolean {
    return this.activityEvents.hasAiUnitsCapReachedFor(credentialId, window, blockId);
  }
  finalizeClaimDelivered(requestId: string, actualCostUsdMicros: number, actualCostEstimated: boolean): void {
    this.activityEvents.finalizeClaimDelivered(requestId, actualCostUsdMicros, actualCostEstimated);
  }
  getActivityEventsAfterId(afterId: number, limit: number) { return this.activityEvents.getActivityEventsAfterId(afterId, limit); }
  getActivityEventsPage(opts: Parameters<ActivityEventsStore['getActivityEventsPage']>[0] = {}) {
    return this.activityEvents.getActivityEventsPage(opts);
  }
  getActivityEventById(id: number) { return this.activityEvents.getActivityEventById(id); }
  getActivityCountsByKind(): Record<string, number> { return this.activityEvents.getActivityCountsByKind(); }
  getLastEventAtForService(serviceIndex: number): string | null { return this.activityEvents.getLastEventAtForService(serviceIndex); }
  getActivityCountsForService(serviceIndex: number): Record<string, number> { return this.activityEvents.getActivityCountsForService(serviceIndex); }

  recordRewardClaim(claim: Parameters<RewardClaimsStore['recordRewardClaim']>[0]): void { this.rewardClaims.recordRewardClaim(claim); }
  getClaimedRewardsLast24hWei(): string { return this.rewardClaims.getClaimedRewardsLast24hWei(); }
  getClaimedRewardsByService() { return this.rewardClaims.getClaimedRewardsByService(); }

  upsertBalanceCache(entry: Parameters<BalanceCacheStore['upsertBalanceCache']>[0]): void { this.balanceCache.upsertBalanceCache(entry); }
  getBalanceCache() { return this.balanceCache.getBalanceCache(); }

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
      if (this.operatorConfig.getConfigValue(migrationKey) === 'true') return;
      insert.run();
      this.operatorConfig.setConfigValue(migrationKey, 'true');
    });
    tx();
  }

  getLastProcessedBlock(): bigint | null { return this.operatorConfig.getLastProcessedBlock(); }
  setLastProcessedBlock(block: bigint): void { this.operatorConfig.setLastProcessedBlock(block); }

  insertArtifact(artifact: Parameters<ArtifactsStore['insertArtifact']>[0]): void { this.artifacts.insertArtifact(artifact); }
  searchArtifacts(query: Parameters<ArtifactsStore['searchArtifacts']>[0]) { return this.artifacts.searchArtifacts(query); }
  resolveCatalogArtifactContent(id: string): string | null { return this.artifacts.resolveCatalogArtifactContent(id); }
  getArtifactByRequestId(requestId: string, tag: string) { return this.artifacts.getArtifactByRequestId(requestId, tag); }

  saveServedArtifact(input: Parameters<ServedArtifactsStore['saveServedArtifact']>[0]): void { this.servedArtifacts.saveServedArtifact(input); }
  getServedArtifact(sha256: string) { return this.servedArtifacts.getServedArtifact(sha256); }
  getServedArtifactMetadata(sha256: string) { return this.servedArtifacts.getServedArtifactMetadata(sha256); }
  listServedArtifactMetadata(filter: Parameters<ServedArtifactsStore['listServedArtifactMetadata']>[0] = {}) {
    return this.servedArtifacts.listServedArtifactMetadata(filter);
  }
  recordArtifactAccessEvent(input: Parameters<ServedArtifactsStore['recordArtifactAccessEvent']>[0]): void {
    this.servedArtifacts.recordArtifactAccessEvent(input);
  }
  listArtifactAccessEvents(filter: Parameters<ServedArtifactsStore['listArtifactAccessEvents']>[0] = {}) {
    return this.servedArtifacts.listArtifactAccessEvents(filter);
  }
  getArtifactAccessSummary() { return this.servedArtifacts.getArtifactAccessSummary(); }
  getArtifactAccessStatsBySha(sha256s: string[]) { return this.servedArtifacts.getArtifactAccessStatsBySha(sha256s); }
  setServedArtifactEnvelopeCid(sha256: string, envelopeCid: string): void { this.servedArtifacts.setServedArtifactEnvelopeCid(sha256, envelopeCid); }
  getServedArtifactsByRequestId(requestId: string) { return this.servedArtifacts.getServedArtifactsByRequestId(requestId); }

  saveNetworkArtifact(input: Parameters<NetworkArtifactsStore['saveNetworkArtifact']>[0]): void { this.networkArtifacts.saveNetworkArtifact(input); }
  getNetworkArtifact(sha256: string) { return this.networkArtifacts.getNetworkArtifact(sha256); }
  getNetworkArtifactMetadata(sha256: string) { return this.networkArtifacts.getNetworkArtifactMetadata(sha256); }
  listNetworkArtifactMetadata(filter: Parameters<NetworkArtifactsStore['listNetworkArtifactMetadata']>[0] = {}) {
    return this.networkArtifacts.listNetworkArtifactMetadata(filter);
  }
  touchNetworkArtifactUsage(sha256: string, ts: string): void { this.networkArtifacts.touchNetworkArtifactUsage(sha256, ts); }

  /**
   * Local fast-path search across own (served) artifacts and cached (network)
   * artifacts. Used by MCP record search to prepend locally held matches to
   * corpus query results without loading artifact bytes.
   */
  searchOwnAndCached(filter: { artifactType?: string; limit: number }) {
    const own = this.servedArtifacts.searchRecent(filter);
    const cached = this.networkArtifacts.searchRecent(filter);
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
  getArtifactsByEnvelopeCids(envelopeCids: readonly string[]) {
    const own = this.servedArtifacts.getByEnvelopeCids(envelopeCids);
    const cached = this.networkArtifacts.getByEnvelopeCids(envelopeCids);
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

  saveEnvelopeProjection(projection: EnvelopeProjection): void { this.envelopeProjections.saveEnvelopeProjection(projection); }
  upgradeEnvelopeProjectionEvidenceTier(envelopeId: string, tier: EnvelopeProjection['evidenceTier']): void {
    this.envelopeProjections.upgradeEnvelopeProjectionEvidenceTier(envelopeId, tier);
  }
  queryEnvelopeProjections(query: EnvelopeProjectionQuery = {}) { return this.envelopeProjections.queryEnvelopeProjections(query); }

  saveErc8004Anchor(input: Erc8004AnchorInput): void { this.erc8004Anchors.saveErc8004Anchor(input); }
  loadManifestBatchJournal(batchKey: string): string | null { return this.erc8004Anchors.loadManifestBatchJournal(batchKey); }
  saveManifestBatchJournal(batchKey: string, stateJson: string): void { this.erc8004Anchors.saveManifestBatchJournal(batchKey, stateJson); }
  compareAndSwapManifestBatchJournal(batchKey: string, expectedStateJson: string | null, nextStateJson: string): boolean {
    return this.erc8004Anchors.compareAndSwapManifestBatchJournal(batchKey, expectedStateJson, nextStateJson);
  }
  listErc8004AnchorsByEnvelopeCids(envelopeCids: readonly string[]): Erc8004AnchorRow[] {
    return this.erc8004Anchors.listErc8004AnchorsByEnvelopeCids(envelopeCids);
  }

  recordEvalResult(args: EvalResultRecord): void { this.evalResults.recordEvalResult(args); }
  getEvalAggregate(checkpoint_cid: string, slate_version: string): EvalAggregate {
    return this.evalResults.getEvalAggregate(checkpoint_cid, slate_version);
  }
  getEvalSlateHashes(checkpoint_cid: string, slate_version: string): string[] {
    return this.evalResults.getEvalSlateHashes(checkpoint_cid, slate_version);
  }
  getEvalResults(checkpoint_cid: string, slate_version: string): EvalResultRow[] {
    return this.evalResults.getEvalResults(checkpoint_cid, slate_version);
  }

  close(): void { this.db.close(); }
}
