// SPDX-License-Identifier: MIT
import {
  EvidenceCatalogError,
  type CatalogOperationOptions,
  type CatalogPage,
  type Sha256Digest,
} from "@jinn-network/evidence-discovery";
import type Database from "better-sqlite3";

import { snapshotQuery } from "./cursors.js";
import { catalogIoError } from "./errors.js";
import { canonicalJsonSnapshot, sha256Text } from "./projection-row.js";
import type {
  AnnouncementEdge,
  AnnouncementEdgeIndexInput,
  AnnouncementEdgeIndexReceipt,
  AnnouncementEdgeQuery,
} from "./types.js";

type ActiveGuard = (options?: CatalogOperationOptions) => void;

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

/** The page size a read takes when the query names none, matching the rest of this binding. */
export const ANNOUNCEMENT_EDGE_DEFAULT_LIMIT = 50;
/** The largest page a read may take, matching the rest of this binding. */
export const ANNOUNCEMENT_EDGE_MAX_LIMIT = 100;

/** Every field an announcement-edge query may carry; anything else is a typo, not a filter. */
const ANNOUNCEMENT_EDGE_QUERY_FIELDS = [
  "sourceId",
  "recordKind",
  "recordDigest",
  "field",
  "targetDigest",
  "limit",
  "cursor",
] as const;

// The list above is the gate, so a field added to `AnnouncementEdgeQuery` and forgotten here
// would be refused at runtime rather than served. This makes that a compile error: the two
// differences must both be empty, so the list names every key of the type and nothing else.
type SameAsQueryType =
  Exclude<keyof AnnouncementEdgeQuery, (typeof ANNOUNCEMENT_EDGE_QUERY_FIELDS)[number]> extends never
    ? Exclude<(typeof ANNOUNCEMENT_EDGE_QUERY_FIELDS)[number], keyof AnnouncementEdgeQuery> extends never
      ? true
      : false
    : false;
const announcementEdgeQueryFieldsAreExact: SameAsQueryType = true;

/** The ordering key a cursor resumes from: source, record, field, ordinal. */
type EdgeOrder = readonly [string, string, string, number];

interface EdgeRow {
  readonly source_id: string;
  readonly announcement_id: string;
  readonly record_kind: string;
  readonly record_digest: string;
  readonly field: string;
  readonly ordinal: number;
  readonly target_digest: string;
}

function invalidProjection(message: string): never {
  throw new EvidenceCatalogError("INVALID_PROJECTION", message);
}

function invalidQuery(message: string): never {
  throw new EvidenceCatalogError("INVALID_QUERY", message);
}

// A malformed card and a malformed query are different mistakes and this binding reports them
// differently everywhere else, so each validator comes in both flavours rather than one serving
// both paths.
function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && SHA256_DIGEST.test(value);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function cardDigest(value: unknown, where: string): Sha256Digest {
  if (!isDigest(value)) invalidProjection(`${where} must be a sha256:<64 lowercase hex> digest.`);
  return value;
}

function cardString(value: unknown, where: string): string {
  if (!isNonEmpty(value)) invalidProjection(`${where} must be a non-empty string.`);
  return value;
}

function queryDigest(value: unknown, where: string): Sha256Digest {
  if (!isDigest(value)) invalidQuery(`${where} must be a sha256:<64 lowercase hex> digest.`);
  return value;
}

function queryString(value: unknown, where: string): string {
  if (!isNonEmpty(value)) invalidQuery(`${where} must be a non-empty string.`);
  return value;
}

/**
 * Reads the declared outbound references out of one card.
 *
 * A field the card leaves out contributes nothing, and neither does one carrying `null` or
 * `undefined` -- a shape a card round-tripped through a serializer can arrive in, and one that
 * says no more than omission does. Anything else under a reference-bearing name must be a digest,
 * or an array of them in record order; a card that puts something else there is malformed, and
 * refusing it is more useful than indexing it.
 *
 * `referenceFields` is read as a set. A profile that names one field twice describes one edge
 * twice, not two edges, and reading it literally would emit two rows sharing the
 * `(source_id, record_digest, field, ordinal)` primary key -- reporting a card-shaped mistake as
 * the `IO_FAILURE` a constraint violation wraps to.
 */
export function announcementEdgesFromCard(
  input: AnnouncementEdgeIndexInput,
): readonly AnnouncementEdge[] {
  const sourceId = cardString(input.sourceId, "sourceId");
  const announcementId = cardString(input.announcementId, "announcementId");
  const recordKind = cardString(input.recordKind, "recordKind");
  const recordDigest = cardDigest(input.recordDigest, "recordDigest");
  const edges: AnnouncementEdge[] = [];
  for (const field of new Set(input.referenceFields)) {
    if (!Object.prototype.hasOwnProperty.call(input.facts, field)) continue;
    const announced = input.facts[field];
    if (announced === undefined || announced === null) continue;
    const values = Array.isArray(announced) ? announced : [announced];
    values.forEach((value, ordinal) => {
      edges.push({
        sourceId,
        announcementId,
        recordKind,
        recordDigest,
        field,
        ordinal,
        targetDigest: cardDigest(value, `facts.${field}`),
      });
    });
  }
  return edges;
}

/**
 * The exact page statement one filter shape reads through. Exported so an index-coverage test can
 * take `EXPLAIN QUERY PLAN` over the statement the binding really runs, rather than over a
 * restatement of it that could drift. It is package-internal: `index.ts` exports an explicit list
 * and does not include it.
 *
 * `where` is interpolated, so it may only ever be clause text this module builds -- every value a
 * caller supplies is a bound parameter and none of it reaches this string.
 */
export function announcementEdgeSelectSql(where: string): string {
  return `
      SELECT source_id, announcement_id, record_kind, record_digest, field, ordinal, target_digest
      FROM announcement_edges
      WHERE ${where}
      ORDER BY source_id ASC, record_digest ASC, field ASC, ordinal ASC
      LIMIT ?
    `;
}

export class SqliteAnnouncementEdgeIndex {
  readonly #deleteEdges;
  readonly #insertEdge;
  readonly #selectEdges = new Map<string, Database.Statement>();
  readonly #replace;

  constructor(
    private readonly database: Database.Database,
    private readonly active: ActiveGuard,
  ) {
    // Scoped to the announcing source: replacing a card replaces that source's own edge set for
    // the record, and can never reach another source's rows.
    this.#deleteEdges = database.prepare(`
      DELETE FROM announcement_edges WHERE source_id = ? AND record_digest = ?
    `);
    this.#insertEdge = database.prepare(`
      INSERT INTO announcement_edges (
        source_id, announcement_id, record_kind, record_digest, field, ordinal, target_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.#replace = database.transaction(
      (
        input: AnnouncementEdgeIndexInput,
        edges: readonly AnnouncementEdge[],
      ): AnnouncementEdgeIndexReceipt => {
        this.#deleteEdges.run(input.sourceId, input.recordDigest);
        for (const edge of edges) {
          this.#insertEdge.run(
            edge.sourceId,
            edge.announcementId,
            edge.recordKind,
            edge.recordDigest,
            edge.field,
            edge.ordinal,
            edge.targetDigest,
          );
        }
        return {
          sourceId: input.sourceId,
          recordKind: input.recordKind,
          recordDigest: input.recordDigest,
          indexed: edges.length,
        };
      },
    );
  }

  async index(
    input: AnnouncementEdgeIndexInput,
    options?: CatalogOperationOptions,
  ): Promise<AnnouncementEdgeIndexReceipt> {
    this.active(options);
    const edges = announcementEdgesFromCard(input);
    this.active(options);
    try {
      return this.#replace.immediate(input, edges);
    } catch (error) {
      throw catalogIoError(error, "Unable to persist SQLite Catalog announcement edges.");
    }
  }

  /** One prepared statement per filter shape; there are at most a few dozen. */
  #statementFor(where: string): Database.Statement {
    const cached = this.#selectEdges.get(where);
    if (cached !== undefined) return cached;
    const statement = this.database.prepare(announcementEdgeSelectSql(where));
    this.#selectEdges.set(where, statement);
    return statement;
  }

  async query(
    unchecked: AnnouncementEdgeQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<AnnouncementEdge>> {
    this.active(options);
    // A field this binding does not serve is refused rather than ignored: a `sourceID` typo that
    // silently dropped the source filter would return every source's edges, and `sourceId` is the
    // whole isolation boundary.
    const query = snapshotQuery(
      unchecked,
      ANNOUNCEMENT_EDGE_QUERY_FIELDS,
      "Announcement-edge query",
    ) as AnnouncementEdgeQuery;
    const clauses: string[] = [];
    const parameters: (string | number)[] = [];
    if (query.sourceId !== undefined) {
      clauses.push("source_id = ?");
      parameters.push(queryString(query.sourceId, "sourceId"));
    }
    if (query.recordKind !== undefined) {
      clauses.push("record_kind = ?");
      parameters.push(queryString(query.recordKind, "recordKind"));
    }
    if (query.recordDigest !== undefined) {
      clauses.push("record_digest = ?");
      parameters.push(queryDigest(query.recordDigest, "recordDigest"));
    }
    if (query.field !== undefined) {
      clauses.push("field = ?");
      parameters.push(queryString(query.field, "field"));
    }
    if (query.targetDigest !== undefined) {
      clauses.push("target_digest = ?");
      parameters.push(queryDigest(query.targetDigest, "targetDigest"));
    }
    if (clauses.length === 0) {
      invalidQuery("An announcement-edge query requires at least one filter.");
    }

    const limit = pageLimit(query.limit);
    const queryHash = hashOfFilters(clauses, parameters);
    const resume = decodeCursor(query.cursor, queryHash);
    if (resume !== undefined) {
      // Row-value comparison resumes exactly at the ordering key the last page ended on.
      clauses.push("(source_id, record_digest, field, ordinal) > (?, ?, ?, ?)");
      parameters.push(...resume);
    }

    try {
      const rows = this.#statementFor(clauses.join(" AND ")).all(
        ...parameters,
        limit + 1,
      ) as EdgeRow[];
      const items = rows.slice(0, limit).map((row) => ({
        sourceId: row.source_id,
        announcementId: row.announcement_id,
        recordKind: row.record_kind,
        recordDigest: row.record_digest as Sha256Digest,
        field: row.field,
        ordinal: row.ordinal,
        targetDigest: row.target_digest as Sha256Digest,
      }));
      // One row beyond the page proves there is more; the caller is never left guessing whether a
      // full page means "all of them" or "the first hundred of them".
      if (rows.length <= limit) return { items };
      const last = items[items.length - 1]!;
      return {
        items,
        nextCursor: encodeCursor(queryHash, [
          last.sourceId,
          last.recordDigest,
          last.field,
          last.ordinal,
        ]),
      };
    } catch (error) {
      if (error instanceof EvidenceCatalogError) throw error;
      throw catalogIoError(error, "Unable to read SQLite Catalog announcement edges.");
    }
  }
}

function pageLimit(value: unknown): number {
  if (value === undefined) return ANNOUNCEMENT_EDGE_DEFAULT_LIMIT;
  if (
    !Number.isInteger(value)
    || Number(value) < 1
    || Number(value) > ANNOUNCEMENT_EDGE_MAX_LIMIT
  ) {
    invalidQuery(
      `Announcement-edge query limit must be an integer from 1 through ${ANNOUNCEMENT_EDGE_MAX_LIMIT}.`,
    );
  }
  return Number(value);
}

/** Binds a cursor to the query that produced it, as the rest of this binding's cursors are. */
function hashOfFilters(clauses: readonly string[], parameters: readonly (string | number)[]): string {
  return sha256Text(
    canonicalJsonSnapshot(
      { clauses: [...clauses], parameters: [...parameters] },
      "announcement-edge query",
    ).json,
  );
}

function encodeCursor(queryHashValue: string, order: EdgeOrder): string {
  return Buffer.from(
    JSON.stringify({ version: 1, queryHash: queryHashValue, order }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(encoded: string | undefined, expectedHash: string): EdgeOrder | undefined {
  if (encoded === undefined) return undefined;
  if (typeof encoded !== "string" || encoded.length > 16_384 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    invalidQuery("Announcement-edge cursor is malformed.");
  }
  let candidate: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    // A cursor has exactly one spelling: reject any encoding that does not round-trip.
    if (bytes.toString("base64url") !== encoded) invalidQuery("Announcement-edge cursor is malformed.");
    candidate = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof EvidenceCatalogError) throw error;
    invalidQuery("Announcement-edge cursor is malformed.");
  }
  if (
    typeof candidate !== "object"
    || candidate === null
    || Array.isArray(candidate)
    || Object.keys(candidate).sort().join(",") !== "order,queryHash,version"
  ) {
    invalidQuery("Announcement-edge cursor is malformed.");
  }
  const { version, queryHash, order } = candidate as {
    version: unknown;
    queryHash: unknown;
    order: unknown;
  };
  if (
    version !== 1
    || queryHash !== expectedHash
    || !Array.isArray(order)
    || order.length !== 4
    || typeof order[0] !== "string"
    || typeof order[1] !== "string"
    || typeof order[2] !== "string"
    || !Number.isInteger(order[3])
  ) {
    invalidQuery("Announcement-edge cursor is invalid for this query.");
  }
  return [order[0], order[1], order[2], order[3]] as EdgeOrder;
}
