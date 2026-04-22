import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RESTORATION_INTENTS_SCHEMA } from '../restorer/engine/persistence.js';

export interface ActivityEventInput {
  ts: string | null;
  kind: string;
  requestId?: string | null;
  serviceIndex?: number | null;
  txHash?: string | null;
  specKind?: string | null;
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
  specKind: string | null;
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
  desired_state_id TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_artifacts_desired_state ON artifacts (desired_state_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_outcome ON artifacts (outcome);
CREATE INDEX IF NOT EXISTS idx_artifacts_remote ON artifacts (remote);

CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  kind TEXT NOT NULL,
  request_id TEXT,
  service_index INTEGER,
  tx_hash TEXT,
  spec_kind TEXT,
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
    this.db.exec(RESTORATION_INTENTS_SCHEMA);
    this.ensureRewardClaimsTxIndex();
    this.backfillActivityEvents();
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

  /** Generic config row (e.g. last_reward_claim_tick_at). */
  getConfigValue(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setConfigValue(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
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
      `INSERT INTO activity_events (ts, kind, request_id, service_index, tx_hash, spec_kind, outcome, detail)
       VALUES (@ts, @kind, @requestId, @serviceIndex, @txHash, @specKind, @outcome, @detail)`,
    ).run({
      ts: event.ts ?? null,
      kind: event.kind,
      requestId: event.requestId ?? null,
      serviceIndex: event.serviceIndex ?? null,
      txHash: event.txHash ?? null,
      specKind: event.specKind ?? null,
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
      `SELECT id, ts, kind, request_id, service_index, tx_hash, spec_kind, outcome, detail
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
      spec_kind: string | null;
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
      specKind: r.spec_kind,
      outcome: r.outcome,
      detail: r.detail,
    }));
  }

  /** Newer events first, then ascending id for `jinn logs --follow` (oldest in batch printed first in caller). */
  getActivityEventsAfterId(afterId: number, limit: number): ActivityEventRow[] {
    const effectiveLimit = Math.max(0, Math.min(limit, 1000));
    const rows = this.db
      .prepare(
        `SELECT id, ts, kind, request_id, service_index, tx_hash, spec_kind, outcome, detail
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
        spec_kind: string | null;
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
      specKind: r.spec_kind,
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

  getLastProcessedBlock(): bigint | null {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get('last_processed_block') as { value: string } | undefined;
    return row?.value ? BigInt(row.value) : null;
  }

  setLastProcessedBlock(block: bigint): void {
    this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('last_processed_block', block.toString());
  }

  insertArtifact(artifact: {
    id: string;
    desiredStateId: string;
    requestId: string;
    title: string;
    content: string;
    tags: string[];
    outcome: 'SUCCESS' | 'FAILURE' | 'UNKNOWN';
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO artifacts (id, desired_state_id, request_id, title, content, tags, outcome)
      VALUES (@id, @desiredStateId, @requestId, @title, @content, @tags, @outcome)
    `).run({
      ...artifact,
      tags: JSON.stringify(artifact.tags),
    });
  }

  searchArtifacts(query: {
    tags?: string[];
    outcome?: string;
    requestId?: string;
    desiredStateId?: string;
    after?: string;   // ISO timestamp — only return artifacts created after this time
    before?: string;  // ISO timestamp — only return artifacts created before this time
    limit?: number;
  }): Array<{ id: string; title: string; content: string; tags: string[]; outcome: string; request_id: string; desired_state_id: string; created_at: string }> {
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

    if (query.desiredStateId) {
      conditions.push('desired_state_id = @desiredStateId');
      params['desiredStateId'] = query.desiredStateId;
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
      `SELECT id, title, content, tags, outcome, request_id, desired_state_id, created_at FROM artifacts ${where} ORDER BY created_at DESC LIMIT ${limit}`
    ).all(params) as Array<{ id: string; title: string; content: string; tags: string; outcome: string; request_id: string; desired_state_id: string; created_at: string }>;

    return rows.map(row => ({
      ...row,
      tags: JSON.parse(row.tags) as string[],
    }));
  }

  insertRemoteArtifact(artifact: {
    id: string;
    desiredStateId: string;
    requestId: string;
    title: string;
    tags: string[];
    outcome: 'SUCCESS' | 'FAILURE' | 'UNKNOWN';
    ownerAddress: string;
    endpoint: string;
    price?: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO artifacts (id, desired_state_id, request_id, title, tags, outcome, remote, owner_address, endpoint, price)
      VALUES (@id, @desiredStateId, @requestId, @title, @tags, @outcome, 1, @ownerAddress, @endpoint, @price)
    `).run({
      ...artifact,
      tags: JSON.stringify(artifact.tags),
      price: artifact.price ?? null,
    });
  }

  getArtifactContent(id: string): string | null {
    const row = this.db.prepare('SELECT content FROM artifacts WHERE id = ?').get(id) as { content: string | null } | undefined;
    return row?.content ?? null;
  }

  getRemoteArtifactInfo(id: string): { endpoint: string; ownerAddress: string; price?: string } | null {
    const row = this.db.prepare(
      'SELECT endpoint, owner_address, price FROM artifacts WHERE id = ? AND remote = 1'
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

  cacheRemoteContent(id: string, content: string): void {
    this.db.prepare('UPDATE artifacts SET content = ? WHERE id = ?').run(content, id);
  }

  close(): void {
    this.db.close();
  }
}
