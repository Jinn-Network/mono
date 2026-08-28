// SPDX-License-Identifier: MIT
import {
  EvidenceCatalogError,
  type CatalogOperationOptions,
  type Sha256Digest,
} from "@jinn-network/evidence-discovery";
import type Database from "better-sqlite3";

import { catalogIoError } from "./errors.js";
import type {
  AnnouncementEdge,
  AnnouncementEdgeIndexInput,
  AnnouncementEdgeIndexReceipt,
  AnnouncementEdgeQuery,
} from "./types.js";

type ActiveGuard = (options?: CatalogOperationOptions) => void;

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

interface EdgeRow {
  readonly record_kind: string;
  readonly record_digest: string;
  readonly field: string;
  readonly ordinal: number;
  readonly target_digest: string;
}

function invalid(message: string): never {
  throw new EvidenceCatalogError("INVALID_PROJECTION", message);
}

function digestOrThrow(value: unknown, where: string): Sha256Digest {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    invalid(`${where} must be a sha256:<64 lowercase hex> digest.`);
  }
  return value as Sha256Digest;
}

/**
 * Reads the declared outbound references out of one card. A field the card does not announce
 * contributes nothing -- the holder said nothing, and §15's unannounced-field skip is symmetric.
 * A field it does announce must be a digest or an array of digests: a reference-bearing field
 * holding anything else is a malformed card, and saying so is more useful than indexing it.
 */
export function announcementEdgesFromCard(
  input: AnnouncementEdgeIndexInput,
): readonly AnnouncementEdge[] {
  const recordDigest = digestOrThrow(input.recordDigest, "recordDigest");
  if (input.recordKind.length === 0) invalid("recordKind must not be empty.");
  const edges: AnnouncementEdge[] = [];
  for (const field of input.referenceFields) {
    if (!Object.prototype.hasOwnProperty.call(input.facts, field)) continue;
    const announced = input.facts[field];
    const values = Array.isArray(announced) ? announced : [announced];
    values.forEach((value, ordinal) => {
      edges.push({
        recordKind: input.recordKind,
        recordDigest,
        field,
        ordinal,
        targetDigest: digestOrThrow(value, `facts.${field}`),
      });
    });
  }
  return edges;
}

export class SqliteAnnouncementEdgeIndex {
  readonly #deleteEdges;
  readonly #insertEdge;
  readonly #replace;

  constructor(
    private readonly database: Database.Database,
    private readonly active: ActiveGuard,
  ) {
    this.#deleteEdges = database.prepare(`
      DELETE FROM announcement_edges WHERE record_kind = ? AND record_digest = ?
    `);
    this.#insertEdge = database.prepare(`
      INSERT INTO announcement_edges (
        record_kind, record_digest, field, ordinal, target_digest
      ) VALUES (?, ?, ?, ?, ?)
    `);
    this.#replace = database.transaction(
      (
        recordKind: string,
        recordDigest: Sha256Digest,
        edges: readonly AnnouncementEdge[],
      ): AnnouncementEdgeIndexReceipt => {
        this.#deleteEdges.run(recordKind, recordDigest);
        for (const edge of edges) {
          this.#insertEdge.run(
            edge.recordKind,
            edge.recordDigest,
            edge.field,
            edge.ordinal,
            edge.targetDigest,
          );
        }
        return { recordKind, recordDigest, indexed: edges.length };
      },
    );
  }

  async index(
    input: AnnouncementEdgeIndexInput,
    options?: CatalogOperationOptions,
  ): Promise<AnnouncementEdgeIndexReceipt> {
    this.active(options);
    const edges = announcementEdgesFromCard(input);
    const recordDigest = digestOrThrow(input.recordDigest, "recordDigest");
    this.active(options);
    try {
      return this.#replace.immediate(input.recordKind, recordDigest, edges);
    } catch (error) {
      if (error instanceof EvidenceCatalogError) throw error;
      throw catalogIoError(error, "Unable to persist SQLite Catalog announcement edges.");
    }
  }

  async query(
    query: AnnouncementEdgeQuery,
    options?: CatalogOperationOptions,
  ): Promise<readonly AnnouncementEdge[]> {
    this.active(options);
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (query.recordKind !== undefined) {
      clauses.push("record_kind = ?");
      parameters.push(query.recordKind);
    }
    if (query.recordDigest !== undefined) {
      clauses.push("record_digest = ?");
      parameters.push(digestOrThrow(query.recordDigest, "recordDigest"));
    }
    if (query.field !== undefined) {
      clauses.push("field = ?");
      parameters.push(query.field);
    }
    if (query.targetDigest !== undefined) {
      clauses.push("target_digest = ?");
      parameters.push(digestOrThrow(query.targetDigest, "targetDigest"));
    }
    if (clauses.length === 0) {
      invalid("An announcement-edge query requires at least one filter.");
    }
    try {
      const rows = this.database
        .prepare(`
          SELECT record_kind, record_digest, field, ordinal, target_digest
          FROM announcement_edges
          WHERE ${clauses.join(" AND ")}
          ORDER BY record_kind ASC, record_digest ASC, field ASC, ordinal ASC
        `)
        .all(...parameters) as EdgeRow[];
      return rows.map((row) => ({
        recordKind: row.record_kind,
        recordDigest: row.record_digest as Sha256Digest,
        field: row.field,
        ordinal: row.ordinal,
        targetDigest: row.target_digest as Sha256Digest,
      }));
    } catch (error) {
      throw catalogIoError(error, "Unable to read SQLite Catalog announcement edges.");
    }
  }
}
