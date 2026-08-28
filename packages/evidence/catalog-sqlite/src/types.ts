// SPDX-License-Identifier: MIT
import type {
  CatalogGeneration,
  CatalogOperationOptions,
  CatalogPage,
  EvidenceCatalogReader,
  EvidenceCatalogWriter,
  Sha256Digest,
} from "@jinn-network/evidence-discovery";

/**
 * One outbound record reference an announcement card declares (record-discovery design §12,
 * amendment 2026-08-28). `ordinal` is the position within a multi-valued field, so an array edge
 * keeps its record order. The announcing source travels with the edge because a card is a
 * holder-authored claim: two sources may say different things about one record, and a consumer
 * has to be able to tell which said what.
 */
export interface AnnouncementEdge {
  readonly sourceId: string;
  readonly announcementId: string;
  readonly recordKind: string;
  readonly recordDigest: Sha256Digest;
  readonly field: string;
  readonly ordinal: number;
  readonly targetDigest: Sha256Digest;
}

/**
 * A card plus the field names its facts profile declares reference-bearing, and the source that
 * announced it. The catalog reads the edges out of the card itself; it never fetches the record,
 * which is the whole point -- for a paid record, fetching to join is not possible at all.
 */
export interface AnnouncementEdgeIndexInput {
  readonly sourceId: string;
  readonly announcementId: string;
  readonly recordKind: string;
  readonly recordDigest: Sha256Digest;
  readonly referenceFields: readonly string[];
  readonly facts: Readonly<Record<string, unknown>>;
}

export interface AnnouncementEdgeIndexReceipt {
  readonly sourceId: string;
  readonly recordKind: string;
  readonly recordDigest: Sha256Digest;
  readonly indexed: number;
}

/**
 * At least one filter is required: the index is not a table scan. Results are ordered by source,
 * record digest, field then ordinal, and paged like every other collection this binding serves --
 * a page that has more behind it returns a `nextCursor`, so a caller never mistakes a full page
 * for the whole answer. The cursor is opaque and bound to the query that produced it.
 */
export interface AnnouncementEdgeQuery {
  readonly sourceId?: string;
  readonly recordKind?: string;
  readonly recordDigest?: Sha256Digest;
  readonly field?: string;
  readonly targetDigest?: Sha256Digest;
  readonly limit?: number;
  readonly cursor?: string;
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
   * to serve join from a feed, and a neutral contract belongs in a follow-up when the in-memory
   * catalog needs to serve it too. Re-indexing a record replaces that source's edges for it, so
   * replaying a feed is idempotent and one source can never displace another's.
   */
  indexAnnouncementEdges(
    input: AnnouncementEdgeIndexInput,
    options?: CatalogOperationOptions,
  ): Promise<AnnouncementEdgeIndexReceipt>;
  queryAnnouncementEdges(
    query: AnnouncementEdgeQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<AnnouncementEdge>>;
  close(): Promise<void>;
}

export interface CreateSqliteEvidenceCatalogOptions {
  readonly databasePath: string;
  readonly generation: CatalogGeneration;
}

export interface OpenSqliteEvidenceCatalogOptions {
  readonly databasePath: string;
}
