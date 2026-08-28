// SPDX-License-Identifier: MIT
import type {
  CatalogGeneration,
  CatalogOperationOptions,
  EvidenceCatalogReader,
  EvidenceCatalogWriter,
  Sha256Digest,
} from "@jinn-network/evidence-discovery";

/**
 * One outbound record reference an announcement card declares (record-discovery design §12,
 * amendment 2026-08-28). `ordinal` is the position within a multi-valued field, so an array edge
 * keeps its record order.
 */
export interface AnnouncementEdge {
  readonly recordKind: string;
  readonly recordDigest: Sha256Digest;
  readonly field: string;
  readonly ordinal: number;
  readonly targetDigest: Sha256Digest;
}

/**
 * A card plus the field names its facts profile declares reference-bearing. The catalog reads
 * the edges out of the card itself; it never fetches the record, which is the whole point --
 * for a paid record, fetching to join is not possible at all.
 */
export interface AnnouncementEdgeIndexInput {
  readonly recordKind: string;
  readonly recordDigest: Sha256Digest;
  readonly referenceFields: readonly string[];
  readonly facts: Readonly<Record<string, unknown>>;
}

export interface AnnouncementEdgeIndexReceipt {
  readonly recordKind: string;
  readonly recordDigest: Sha256Digest;
  readonly indexed: number;
}

/**
 * At least one filter is required: the index is not a table scan. Results are ordered by record
 * kind, record digest, field then ordinal, and bounded by `ANNOUNCEMENT_EDGE_QUERY_LIMIT`.
 */
export interface AnnouncementEdgeQuery {
  readonly recordKind?: string;
  readonly recordDigest?: Sha256Digest;
  readonly field?: string;
  readonly targetDigest?: Sha256Digest;
}

export interface SqliteCatalogIntegrityReport {
  readonly valid: boolean;
  readonly messages: readonly string[];
}

export interface SqliteEvidenceCatalog
  extends EvidenceCatalogReader, EvidenceCatalogWriter {
  readonly databasePath: string;
  readonly generation: CatalogGeneration;
  integrityCheck(
    options?: CatalogOperationOptions,
  ): Promise<SqliteCatalogIntegrityReport>;
  /**
   * Card-driven, SQLite-only surface. The shared catalog contracts and the in-memory catalog
   * index fetched records and know nothing about announcement cards; this is the first backend
   * to serve join from a feed, and a neutral contract for it belongs in a follow-up once a
   * second backend needs one. Re-indexing a record digest replaces all of its edges, so
   * replaying a feed is idempotent.
   */
  indexAnnouncementEdges(
    input: AnnouncementEdgeIndexInput,
    options?: CatalogOperationOptions,
  ): Promise<AnnouncementEdgeIndexReceipt>;
  queryAnnouncementEdges(
    query: AnnouncementEdgeQuery,
    options?: CatalogOperationOptions,
  ): Promise<readonly AnnouncementEdge[]>;
  close(): Promise<void>;
}

export interface CreateSqliteEvidenceCatalogOptions {
  readonly databasePath: string;
  readonly generation: CatalogGeneration;
}

export interface OpenSqliteEvidenceCatalogOptions {
  readonly databasePath: string;
}
