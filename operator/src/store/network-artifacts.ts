import type Database from 'better-sqlite3';

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

export class NetworkArtifactsStore {
  constructor(private readonly db: Database.Database) {}

  runMigrations(): void {
    this.ensureNetworkArtifactsPeerCatalogId();
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

  searchRecent(filter: { artifactType?: string; limit: number }): Array<{
    sha256: string;
    artifact_type: string;
    envelope_cid: string | null;
    content_size: number;
    source_operator: string | null;
    source_endpoint: string | null;
    paid_amount_usdc: string;
    fetched_at: string;
  }> {
    const limit = Math.min(Math.max(1, filter.limit), 500);
    const cachedSql = filter.artifactType
      ? `SELECT sha256, artifact_type, envelope_cid, content_size, source_operator, source_endpoint, paid_amount_usdc, fetched_at FROM network_artifacts WHERE artifact_type = @type ORDER BY fetched_at DESC LIMIT @limit`
      : `SELECT sha256, artifact_type, envelope_cid, content_size, source_operator, source_endpoint, paid_amount_usdc, fetched_at FROM network_artifacts ORDER BY fetched_at DESC LIMIT @limit`;
    const params: Record<string, unknown> = { limit };
    if (filter.artifactType) params['type'] = filter.artifactType;
    return this.db.prepare(cachedSql).all(params) as Array<{
      sha256: string;
      artifact_type: string;
      envelope_cid: string | null;
      content_size: number;
      source_operator: string | null;
      source_endpoint: string | null;
      paid_amount_usdc: string;
      fetched_at: string;
    }>;
  }

  getByEnvelopeCids(envelopeCids: readonly string[]): Array<{
    sha256: string;
    artifact_type: string;
    envelope_cid: string | null;
    content_size: number;
    source_operator: string | null;
    source_endpoint: string | null;
    paid_amount_usdc: string;
    fetched_at: string;
  }> {
    if (envelopeCids.length === 0) return [];
    const params: Record<string, unknown> = {};
    const placeholders = envelopeCids.map((cid, index) => {
      const key = `cid${index}`;
      params[key] = cid;
      return `@${key}`;
    }).join(', ');
    return this.db.prepare(
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
  }
}
