import type Database from 'better-sqlite3';

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

export class ServedArtifactsStore {
  constructor(private readonly db: Database.Database) {}

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

  searchRecent(filter: { artifactType?: string; limit: number }): Array<{
    sha256: string;
    artifact_type: string;
    envelope_cid: string | null;
    content_size: number;
    price_usdc: string;
    created_at: string;
  }> {
    const limit = Math.min(Math.max(1, filter.limit), 500);
    const ownSql = filter.artifactType
      ? `SELECT sha256, artifact_type, envelope_cid, content_size, price_usdc, created_at FROM served_artifacts WHERE artifact_type = @type ORDER BY created_at DESC LIMIT @limit`
      : `SELECT sha256, artifact_type, envelope_cid, content_size, price_usdc, created_at FROM served_artifacts ORDER BY created_at DESC LIMIT @limit`;
    const params: Record<string, unknown> = { limit };
    if (filter.artifactType) params['type'] = filter.artifactType;
    return this.db.prepare(ownSql).all(params) as Array<{
      sha256: string;
      artifact_type: string;
      envelope_cid: string | null;
      content_size: number;
      price_usdc: string;
      created_at: string;
    }>;
  }

  getByEnvelopeCids(envelopeCids: readonly string[]): Array<{
    sha256: string;
    artifact_type: string;
    envelope_cid: string | null;
    content_size: number;
    price_usdc: string;
    created_at: string;
  }> {
    if (envelopeCids.length === 0) return [];
    const params: Record<string, unknown> = {};
    const placeholders = envelopeCids.map((cid, index) => {
      const key = `cid${index}`;
      params[key] = cid;
      return `@${key}`;
    }).join(', ');
    return this.db.prepare(
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
  }
}
