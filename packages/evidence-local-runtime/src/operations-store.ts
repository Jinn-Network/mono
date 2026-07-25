// SPDX-License-Identifier: MIT
import Database from "better-sqlite3";

import type { EvidenceRecordReference } from "@jinn-network/evidence-repository";

import {
  LocalEvidenceRuntimeError,
  localRuntimeIoError,
} from "./errors.js";
import { createLocalOperationsSchema } from "./operations-schema.js";
import {
  preparePrivateDatabaseFile,
  verifyPrivateDatabaseFile,
} from "./paths.js";
import type {
  LocalIndexingFailure,
  LocalIndexingFailurePage,
  LocalIndexingFailureQuery,
  LocalTransientIndexingFailure,
} from "./types.js";

export interface PublicationIntent {
  readonly operationKey: string;
  readonly reference: EvidenceRecordReference;
  readonly recordBytes: Uint8Array;
  readonly byteSize: number;
  readonly announcementId: string;
  readonly state: "staged" | "stored" | "announced";
}

export interface IndexingCheckpointInput {
  readonly generationId: string;
  readonly sourceId: string;
  readonly announcementId: string;
  readonly reference: EvidenceRecordReference;
  readonly journalCursor: string;
  readonly indexedTotal: number;
  readonly failedTotal: number;
  readonly observedAt: string;
}

export type IndexedCheckpointInput = IndexingCheckpointInput;
export interface FailedCheckpointInput extends IndexingCheckpointInput {
  readonly failure: LocalIndexingFailure;
}

export type StoredIndexingOutcome =
  | {
      readonly status: "indexed";
      readonly reference: EvidenceRecordReference;
      readonly journalCursor: string;
    }
  | {
      readonly status: "failed";
      readonly reference: EvidenceRecordReference;
      readonly journalCursor: string;
      readonly failure: LocalIndexingFailure;
    };

export interface LocalOperationsSummary {
  readonly pendingPublications: number;
  readonly checkpointCursor?: string;
  readonly indexed: number;
  readonly failed: number;
  readonly transientFailure?: LocalTransientIndexingFailure;
}

export interface LocalOperationsStore {
  stagePublication(intent: PublicationIntent): Promise<"created" | "existing">;
  listPendingPublications(): Promise<readonly PublicationIntent[]>;
  markPublicationStored(operationKey: string): Promise<void>;
  markPublicationAnnounced(operationKey: string): Promise<void>;
  completePublication(operationKey: string): Promise<void>;
  getCheckpoint(generationId: string, sourceId: string): Promise<string | undefined>;
  recordIndexedAndCheckpoint(input: IndexedCheckpointInput): Promise<void>;
  recordFailureAndCheckpoint(input: FailedCheckpointInput): Promise<void>;
  getOutcome(generationId: string, reference: EvidenceRecordReference): Promise<StoredIndexingOutcome | null>;
  setTransientFailure(generationId: string, failure: LocalTransientIndexingFailure): Promise<void>;
  clearTransientFailure(generationId: string): Promise<void>;
  listFailures(query?: LocalIndexingFailureQuery): Promise<LocalIndexingFailurePage>;
  getSummary(generationId: string): Promise<LocalOperationsSummary>;
  close(): Promise<void>;
}

interface OutboxRow {
  operation_key: string;
  family: EvidenceRecordReference["family"];
  digest: EvidenceRecordReference["digest"];
  record_bytes: Buffer;
  byte_size: number;
  announcement_id: string;
  state: PublicationIntent["state"];
}

interface OutcomeRow {
  status: "indexed" | "failed";
  family: EvidenceRecordReference["family"];
  digest: EvidenceRecordReference["digest"];
  journal_cursor: string;
  failure_json: string | null;
}

function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new LocalEvidenceRuntimeError(
      "RUNTIME_CORRUPT",
      "The operations database contains invalid JSON.",
      { cause: error },
    );
  }
}

function validateFailureQuery(query: LocalIndexingFailureQuery = {}): number {
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new LocalEvidenceRuntimeError(
      "INVALID_QUERY",
      "Failure query limit must be an integer from 1 through 100.",
    );
  }
  return limit;
}

class SqliteLocalOperationsStore implements LocalOperationsStore {
  #closed = false;
  constructor(private database: Database.Database) {}

  #active(): Database.Database {
    if (this.#closed) {
      throw new LocalEvidenceRuntimeError("RUNTIME_CLOSED", "Operations store is closed.");
    }
    return this.database;
  }

  async stagePublication(intent: PublicationIntent): Promise<"created" | "existing"> {
    const db = this.#active();
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO publication_outbox
        (operation_key,family,digest,record_bytes,byte_size,state,announcement_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(operation_key) DO NOTHING
    `).run(intent.operationKey, intent.reference.family, intent.reference.digest,
      Buffer.from(intent.recordBytes), intent.byteSize, intent.state,
      intent.announcementId, now, now);
    if (result.changes === 1) return "created";
    const existing = db.prepare(`
      SELECT operation_key,family,digest,record_bytes,byte_size,state,announcement_id
      FROM publication_outbox WHERE operation_key = ?
    `).get(intent.operationKey) as OutboxRow | undefined;
    if (
      existing === undefined ||
      existing.family !== intent.reference.family ||
      existing.digest !== intent.reference.digest ||
      existing.byte_size !== intent.byteSize ||
      existing.announcement_id !== intent.announcementId ||
      !existing.record_bytes.equals(Buffer.from(intent.recordBytes))
    ) {
      throw new LocalEvidenceRuntimeError(
        "RUNTIME_CORRUPT",
        "A publication operation key conflicts with stored intent.",
      );
    }
    return "existing";
  }

  async listPendingPublications(): Promise<readonly PublicationIntent[]> {
    return (this.#active().prepare(`
      SELECT operation_key,family,digest,record_bytes,byte_size,state,announcement_id
      FROM publication_outbox ORDER BY operation_key
    `).all() as OutboxRow[]).map((row) => ({
      operationKey: row.operation_key,
      reference: { family: row.family, digest: row.digest },
      recordBytes: new Uint8Array(row.record_bytes),
      byteSize: row.byte_size,
      announcementId: row.announcement_id,
      state: row.state,
    }));
  }

  async #mark(operationKey: string, state: PublicationIntent["state"]): Promise<void> {
    const result = this.#active().prepare(`
      UPDATE publication_outbox SET state = ?, updated_at = ? WHERE operation_key = ?
    `).run(state, new Date().toISOString(), operationKey);
    if (result.changes !== 1) {
      throw new LocalEvidenceRuntimeError("RUNTIME_CORRUPT", "Publication intent is missing.");
    }
  }
  async markPublicationStored(key: string): Promise<void> { await this.#mark(key, "stored"); }
  async markPublicationAnnounced(key: string): Promise<void> { await this.#mark(key, "announced"); }
  async completePublication(key: string): Promise<void> {
    this.#active().prepare("DELETE FROM publication_outbox WHERE operation_key = ?").run(key);
  }
  async getCheckpoint(generationId: string, sourceId: string): Promise<string | undefined> {
    return (this.#active().prepare(`
      SELECT cursor FROM indexer_checkpoints WHERE generation_id = ? AND source_id = ?
    `).get(generationId, sourceId) as { cursor: string } | undefined)?.cursor;
  }

  #record(input: IndexingCheckpointInput, failure?: LocalIndexingFailure): void {
    this.#active().transaction(() => {
      this.database.prepare(`
        INSERT INTO indexing_outcomes
          (generation_id,source_id,announcement_id,family,digest,status,failure_code,failure_json,journal_cursor,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(generation_id,family,digest) DO UPDATE SET
          source_id=excluded.source_id,announcement_id=excluded.announcement_id,
          status=excluded.status,failure_code=excluded.failure_code,
          failure_json=excluded.failure_json,journal_cursor=excluded.journal_cursor,
          updated_at=excluded.updated_at
      `).run(input.generationId, input.sourceId, input.announcementId,
        input.reference.family, input.reference.digest,
        failure === undefined ? "indexed" : "failed",
        failure?.sourceCode ?? null,
        failure === undefined ? null : JSON.stringify(failure),
        input.journalCursor, input.observedAt);
      this.database.prepare(`
        INSERT INTO processed_cursors
          (generation_id,source_id,cursor,indexed_total,failed_total,processed_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(generation_id,source_id,cursor) DO UPDATE SET
          indexed_total=excluded.indexed_total,failed_total=excluded.failed_total,
          processed_at=excluded.processed_at
      `).run(input.generationId, input.sourceId, input.journalCursor,
        input.indexedTotal, input.failedTotal, input.observedAt);
      this.database.prepare(`
        INSERT INTO indexer_checkpoints(generation_id,source_id,cursor) VALUES (?,?,?)
        ON CONFLICT(generation_id,source_id) DO UPDATE SET cursor=excluded.cursor
      `).run(input.generationId, input.sourceId, input.journalCursor);
    })();
  }
  async recordIndexedAndCheckpoint(input: IndexedCheckpointInput): Promise<void> {
    this.#record(input);
  }
  async recordFailureAndCheckpoint(input: FailedCheckpointInput): Promise<void> {
    this.#record(input, input.failure);
  }
  async getOutcome(generationId: string, reference: EvidenceRecordReference): Promise<StoredIndexingOutcome | null> {
    const row = this.#active().prepare(`
      SELECT status,family,digest,journal_cursor,failure_json FROM indexing_outcomes
      WHERE generation_id = ? AND family = ? AND digest = ?
    `).get(generationId, reference.family, reference.digest) as OutcomeRow | undefined;
    if (row === undefined) return null;
    const base = {
      status: row.status,
      reference: { family: row.family, digest: row.digest },
      journalCursor: row.journal_cursor,
    };
    return row.status === "indexed"
      ? base as StoredIndexingOutcome
      : { ...base, failure: parseJson<LocalIndexingFailure>(row.failure_json ?? "") } as StoredIndexingOutcome;
  }
  async setTransientFailure(generationId: string, failure: LocalTransientIndexingFailure): Promise<void> {
    this.#active().prepare(`
      INSERT INTO transient_indexing_failure(generation_id,failure_json,updated_at)
      VALUES (?,?,?) ON CONFLICT(generation_id) DO UPDATE SET
        failure_json=excluded.failure_json,updated_at=excluded.updated_at
    `).run(generationId, JSON.stringify(failure), failure.observedAt);
  }
  async clearTransientFailure(generationId: string): Promise<void> {
    this.#active().prepare("DELETE FROM transient_indexing_failure WHERE generation_id = ?").run(generationId);
  }
  async listFailures(query: LocalIndexingFailureQuery = {}): Promise<LocalIndexingFailurePage> {
    const limit = validateFailureQuery(query);
    const clauses = ["status = 'failed'"];
    const values: unknown[] = [];
    if (query.reference !== undefined) {
      clauses.push("family = ?", "digest = ?");
      values.push(query.reference.family, query.reference.digest);
    }
    if (query.category !== undefined) {
      clauses.push("json_extract(failure_json, '$.category') = ?");
      values.push(query.category);
    }
    if (query.cursor !== undefined) {
      let decoded: { updatedAt: string; family: string; digest: string };
      try {
        decoded = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      } catch (error) {
        throw new LocalEvidenceRuntimeError("INVALID_QUERY", "Failure cursor is invalid.", { cause: error });
      }
      clauses.push("(updated_at < ? OR (updated_at = ? AND (family > ? OR (family = ? AND digest > ?))))");
      values.push(decoded.updatedAt, decoded.updatedAt, decoded.family, decoded.family, decoded.digest);
    }
    const rows = this.#active().prepare(`
      SELECT family,digest,failure_json,updated_at FROM indexing_outcomes
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC,family,digest LIMIT ?
    `).all(...values, limit + 1) as Array<{
      family: string; digest: string; failure_json: string; updated_at: string;
    }>;
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map((row) => parseJson<LocalIndexingFailure>(row.failure_json));
    const last = pageRows.at(-1);
    return {
      items,
      ...(rows.length > limit && last !== undefined
        ? { nextCursor: Buffer.from(JSON.stringify({
            updatedAt: last.updated_at,
            family: last.family,
            digest: last.digest,
          })).toString("base64url") }
        : {}),
    };
  }
  async getSummary(generationId: string): Promise<LocalOperationsSummary> {
    const db = this.#active();
    const pending = db.prepare("SELECT count(*) AS count FROM publication_outbox").get() as { count: number };
    const totals = db.prepare(`
      SELECT COALESCE(SUM(status='indexed'),0) AS indexed,
             COALESCE(SUM(status='failed'),0) AS failed
      FROM indexing_outcomes WHERE generation_id = ?
    `).get(generationId) as { indexed: number; failed: number };
    const checkpoint = db.prepare(`
      SELECT cursor FROM indexer_checkpoints WHERE generation_id = ? ORDER BY source_id LIMIT 1
    `).get(generationId) as { cursor: string } | undefined;
    const transient = db.prepare(`
      SELECT failure_json FROM transient_indexing_failure WHERE generation_id = ?
    `).get(generationId) as { failure_json: string } | undefined;
    return {
      pendingPublications: pending.count,
      indexed: totals.indexed,
      failed: totals.failed,
      ...(checkpoint === undefined ? {} : { checkpointCursor: checkpoint.cursor }),
      ...(transient === undefined ? {} : {
        transientFailure: parseJson<LocalTransientIndexingFailure>(transient.failure_json),
      }),
    };
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.database.close();
  }
}

export async function openLocalOperationsStore(path: string): Promise<LocalOperationsStore> {
  let database: Database.Database | undefined;
  const prepared = await preparePrivateDatabaseFile(path);
  try {
    database = new Database(path);
    await verifyPrivateDatabaseFile(path, prepared);
    await prepared.handle.close();
    createLocalOperationsSchema(database);
    return new SqliteLocalOperationsStore(database);
  } catch (error) {
    try { await prepared.handle.close(); } catch { /* preserve primary error */ }
    try { database?.close(); } catch { /* preserve primary error */ }
    throw localRuntimeIoError(error, "Unable to open the local operations database.");
  }
}
