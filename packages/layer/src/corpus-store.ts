import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  CorpusStorePort,
  NetworkArtifactRow,
  SaveNetworkArtifactInput,
  ServedArtifactRow,
} from '@jinn-network/core/corpus-read';

/**
 * Standalone corpus cache implementing core's read-side store port. The table
 * names and columns intentionally match the client database so an existing
 * `JINN_LAYER_DB_PATH` remains readable after extraction.
 */
export class SqliteCorpusStore implements CorpusStorePort {
  readonly path: string;
  readonly #db: Database.Database;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path);
    this.#db.exec(`
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
      CREATE TABLE IF NOT EXISTS network_artifacts (
        sha256 TEXT PRIMARY KEY,
        artifact_type TEXT NOT NULL,
        envelope_cid TEXT,
        content BLOB NOT NULL,
        content_size INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (
          source IN ('origin', 'route-resolver', 'self-store-mirror')
        ),
        source_operator TEXT,
        source_endpoint TEXT,
        paid_amount_usdc TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.#db.close();
  }

  getNetworkArtifact(sha256: string): NetworkArtifactRow | null {
    const row = this.#db
      .prepare(
        `SELECT sha256, artifact_type, envelope_cid, content, source,
                source_operator, source_endpoint, paid_amount_usdc, fetched_at
           FROM network_artifacts
          WHERE sha256 = ?`,
      )
      .get(sha256) as
      | {
          sha256: string;
          artifact_type: string;
          envelope_cid: string | null;
          content: Buffer;
          source: SaveNetworkArtifactInput['source'];
          source_operator: string | null;
          source_endpoint: string | null;
          paid_amount_usdc: string;
          fetched_at: string;
        }
      | undefined;
    return row
      ? {
          sha256: row.sha256,
          artifactType: row.artifact_type,
          content: row.content,
          sourceOperator: row.source_operator,
          fetchedAt: row.fetched_at,
        }
      : null;
  }

  touchNetworkArtifactUsage(sha256: string, usedAt: string): void {
    this.#db
      .prepare(
        'UPDATE network_artifacts SET last_used_at = ? WHERE sha256 = ?',
      )
      .run(usedAt, sha256);
  }

  saveNetworkArtifact(input: SaveNetworkArtifactInput): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO network_artifacts
           (sha256, artifact_type, envelope_cid, content, content_size, source,
            source_operator, source_endpoint, paid_amount_usdc, fetched_at,
            last_used_at)
         VALUES
           (@sha256, @artifactType, @envelopeCid, @content, @contentSize,
            @source, @sourceOperator, @sourceEndpoint, @paidAmountUsdc,
            @fetchedAt, @fetchedAt)`,
      )
      .run({
        ...input,
        envelopeCid: input.envelopeCid ?? null,
        contentSize: input.content.length,
        sourceOperator: input.sourceOperator ?? null,
        sourceEndpoint: input.sourceEndpoint ?? null,
      });
  }

  getServedArtifact(sha256: string): ServedArtifactRow | null {
    const row = this.#db
      .prepare(
        `SELECT artifact_type, envelope_cid, content
           FROM served_artifacts
          WHERE sha256 = ?`,
      )
      .get(sha256) as
      | {
          artifact_type: string;
          envelope_cid: string | null;
          content: Buffer;
        }
      | undefined;
    return row
      ? {
          artifactType: row.artifact_type,
          envelopeCid: row.envelope_cid,
          content: row.content,
        }
      : null;
  }
}
