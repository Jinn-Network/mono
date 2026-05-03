import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TASK_RUNS_SCHEMA } from '../harnesses/engine/persistence.js';

export interface ActivityEventInput {
  ts: string | null;
  kind: string;
  requestId?: string | null;
  serviceIndex?: number | null;
  txHash?: string | null;
  solverType?: string | null;
  outcome?: string | null;
  detail?: string | null;
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

export type TaskPostingPolicyType = 'once_per_safe' | 'once_per_bucket' | 'interval';

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

CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts (task_id);
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
CREATE INDEX IF NOT EXISTS idx_task_posts_task ON task_posts (task_id);

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

CREATE TABLE IF NOT EXISTS task_post_locks (
  creator_safe_address TEXT NOT NULL,
  source_key TEXT NOT NULL,
  policy_type TEXT NOT NULL CHECK (policy_type IN ('once_per_safe', 'once_per_bucket', 'interval')),
  scope_key TEXT NOT NULL DEFAULT '',
  owner_token TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  PRIMARY KEY (creator_safe_address, source_key, policy_type, scope_key)
);

`;

export class Store {
  /** Exposed for engine persistence layer — treat as package-internal. */
  readonly db: Database.Database;
  readonly path: string;

  constructor(dbPath: string) {
    this.path = dbPath;
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.db.exec(TASK_RUNS_SCHEMA);
    this.ensureRewardClaimsTxIndex();
    this.ensureNetworkArtifactsPeerCatalogId();
    this.ensureTaskPostsTaskCoordinatorColumns();
    this.backfillActivityEvents();
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
    if (!names.has('protocol_task_id')) {
      this.db.exec(`ALTER TABLE task_posts ADD COLUMN protocol_task_id TEXT`);
    }
    if (!names.has('task_cid')) {
      this.db.exec(`ALTER TABLE task_posts ADD COLUMN task_cid TEXT`);
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
      `INSERT INTO activity_events (ts, kind, request_id, service_index, tx_hash, solver_type, outcome, detail)
       VALUES (@ts, @kind, @requestId, @serviceIndex, @txHash, @solverType, @outcome, @detail)`,
    ).run({
      ts: event.ts ?? null,
      kind: event.kind,
      requestId: event.requestId ?? null,
      serviceIndex: event.serviceIndex ?? null,
      txHash: event.txHash ?? null,
      solverType: event.solverType ?? null,
      outcome: event.outcome ?? null,
      detail: event.detail ?? null,
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

  /** Newer events first, then ascending id for `jinn logs --follow` (oldest in batch printed first in caller). */
  getActivityEventsAfterId(afterId: number, limit: number): ActivityEventRow[] {
    const effectiveLimit = Math.max(0, Math.min(limit, 1000));
    const rows = this.db
      .prepare(
        `SELECT id, ts, kind, request_id, service_index, tx_hash, solver_type, outcome, detail
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
    this.db.prepare(`
      INSERT OR REPLACE INTO artifacts (id, task_id, request_id, title, content, tags, outcome)
      VALUES (@id, @taskId, @requestId, @title, @content, @tags, @outcome)
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

  touchNetworkArtifactUsage(sha256: string, ts: string): void {
    this.db.prepare(
      `UPDATE network_artifacts SET last_used_at = ? WHERE sha256 = ?`,
    ).run(ts, sha256);
  }

  /**
   * Local fast-path search across own (served) artifacts and cached (network)
   * artifacts. Used by the MCP `search_artifacts` tool to prepend local
   * matches to corpus query results.
   */
  searchOwnAndCached(filter: { artifactType?: string; limit: number }): Array<{
    sha256: string;
    artifactType: string;
    source: 'served' | 'network';
    envelopeCid: string | null;
    createdAt: string;
  }> {
    const limit = Math.min(Math.max(1, filter.limit), 500);
    const ownSql = filter.artifactType
      ? `SELECT sha256, artifact_type, envelope_cid, created_at FROM served_artifacts WHERE artifact_type = @type ORDER BY created_at DESC LIMIT @limit`
      : `SELECT sha256, artifact_type, envelope_cid, created_at FROM served_artifacts ORDER BY created_at DESC LIMIT @limit`;
    const cachedSql = filter.artifactType
      ? `SELECT sha256, artifact_type, envelope_cid, fetched_at FROM network_artifacts WHERE artifact_type = @type ORDER BY fetched_at DESC LIMIT @limit`
      : `SELECT sha256, artifact_type, envelope_cid, fetched_at FROM network_artifacts ORDER BY fetched_at DESC LIMIT @limit`;
    const params: Record<string, unknown> = { limit };
    if (filter.artifactType) params['type'] = filter.artifactType;

    const own = this.db.prepare(ownSql).all(params) as Array<{
      sha256: string;
      artifact_type: string;
      envelope_cid: string | null;
      created_at: string;
    }>;
    const cached = this.db.prepare(cachedSql).all(params) as Array<{
      sha256: string;
      artifact_type: string;
      envelope_cid: string | null;
      fetched_at: string;
    }>;

    return [
      ...own.map((r) => ({
        sha256: r.sha256,
        artifactType: r.artifact_type,
        source: 'served' as const,
        envelopeCid: r.envelope_cid,
        createdAt: r.created_at,
      })),
      ...cached.map((r) => ({
        sha256: r.sha256,
        artifactType: r.artifact_type,
        source: 'network' as const,
        envelopeCid: r.envelope_cid,
        createdAt: r.fetched_at,
      })),
    ];
  }

  close(): void {
    this.db.close();
  }
}
