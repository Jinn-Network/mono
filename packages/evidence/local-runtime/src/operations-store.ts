// SPDX-License-Identifier: MIT
import Database from "better-sqlite3";
import { createHash } from "node:crypto";

import {
  createRecordReference,
  parseEvidenceRecordFamily,
  parseEvidenceRecordReference,
  parseSha256Digest,
  type EvidenceRecordReference,
} from "@jinn-network/evidence-repository";

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
  listPendingPublications(options?: {
    readonly validate?: boolean;
  }): Promise<readonly PublicationIntent[]>;
  markPublicationStored(operationKey: string): Promise<void>;
  markPublicationAnnounced(operationKey: string): Promise<void>;
  completePublication(operationKey: string): Promise<void>;
  getCheckpoint(generationId: string, sourceId: string): Promise<string | undefined>;
  validateGenerationState(
    generationId: string,
    sourceId: string,
  ): Promise<string | undefined>;
  getProcessedCursor(
    generationId: string,
    sourceId: string,
    cursor: string,
  ): Promise<{ readonly indexed: number; readonly failed: number } | null>;
  recordIndexedAndCheckpoint(input: IndexedCheckpointInput): Promise<void>;
  recordFailureAndCheckpoint(input: FailedCheckpointInput): Promise<void>;
  getOutcome(generationId: string, reference: EvidenceRecordReference): Promise<StoredIndexingOutcome | null>;
  setTransientFailure(generationId: string, failure: LocalTransientIndexingFailure): Promise<void>;
  clearTransientFailure(generationId: string): Promise<void>;
  listFailures(
    generationId: string,
    query?: LocalIndexingFailureQuery,
  ): Promise<LocalIndexingFailurePage>;
  getSummary(generationId: string): Promise<LocalOperationsSummary>;
  close(): Promise<void>;
}

interface OutboxRow {
  readonly operation_key: string;
  readonly family: EvidenceRecordReference["family"];
  readonly digest: EvidenceRecordReference["digest"];
  readonly record_bytes: Buffer;
  readonly byte_size: number;
  readonly announcement_id: string;
  readonly state: PublicationIntent["state"];
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

const FAILURE_CATEGORIES = new Set([
  "protocol-nonconformance",
  "content-corrupt",
  "announcement-invalid",
  "validated-record-inconsistent",
  "catalog-conflict",
]);
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const CANONICAL_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length &&
    keys.every((key) => allowed.includes(key));
}

function invalidQuery(message: string, cause?: unknown): never {
  throw new LocalEvidenceRuntimeError(
    "INVALID_QUERY",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function snapshotFailureQueryRecord(
  value: unknown,
  allowed: readonly string[],
  role: string,
): Record<string, unknown> {
  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch (error) {
    invalidQuery(`${role} could not be inspected safely.`, error);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null)
  ) {
    invalidQuery(`${role} must be a plain object.`);
  }
  const accepted: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key]!;
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      invalidQuery(`${role} contains an unsupported or unsafe member.`);
    }
    accepted[key] = descriptor.value;
  }
  return accepted;
}

function validateFailureQuery(
  untrustedQuery: unknown = {},
): {
  readonly query: LocalIndexingFailureQuery;
  readonly limit: number;
} {
  const allowed = ["reference", "category", "limit", "cursor"] as const;
  const raw = snapshotFailureQueryRecord(
    untrustedQuery,
    allowed,
    "Failure query",
  );
  let reference: EvidenceRecordReference | undefined;
  if (raw.reference !== undefined) {
    let acceptedReference: Record<string, unknown>;
    try {
      acceptedReference = snapshotFailureQueryRecord(
        raw.reference,
        ["family", "digest"],
        "Failure query reference",
      );
    } catch (error) {
      if (error instanceof LocalEvidenceRuntimeError) throw error;
      invalidQuery("Failure query reference is invalid.");
    }
    if (!hasExactKeys(acceptedReference, ["family", "digest"])) {
      invalidQuery("Failure query reference is invalid.");
    }
    try {
      reference = parseEvidenceRecordReference(acceptedReference);
    } catch (error) {
      invalidQuery("Failure query reference is invalid.", error);
    }
  }
  if (
    raw.category !== undefined &&
    (typeof raw.category !== "string" ||
      !FAILURE_CATEGORIES.has(raw.category))
  ) {
    invalidQuery("Failure query category is invalid.");
  }
  if (
    raw.cursor !== undefined &&
    typeof raw.cursor !== "string"
  ) {
    invalidQuery("Failure query cursor must be a string.");
  }
  const limit = raw.limit ?? 50;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    invalidQuery("Failure query limit must be an integer from 1 through 100.");
  }
  return {
    query: {
      ...(reference === undefined ? {} : { reference }),
      ...(raw.category === undefined
        ? {}
        : { category: raw.category as LocalIndexingFailureQuery["category"] }),
      ...(raw.cursor === undefined
        ? {}
        : { cursor: raw.cursor as string }),
      limit,
    },
    limit,
  };
}

function parseFailureCursor(
  cursor: string,
  queryHash: string,
): {
  readonly updatedAt: string;
  readonly family: EvidenceRecordReference["family"];
  readonly digest: EvidenceRecordReference["digest"];
} {
  if (
    cursor.length === 0 ||
    cursor.length > 4096 ||
    !CANONICAL_BASE64URL_PATTERN.test(cursor)
  ) {
    invalidQuery("Failure cursor is not canonical base64url.");
  }
  let decodedBytes: Buffer;
  let decoded: unknown;
  try {
    decodedBytes = Buffer.from(cursor, "base64url");
    if (decodedBytes.toString("base64url") !== cursor) {
      invalidQuery("Failure cursor is not canonical base64url.");
    }
    decoded = JSON.parse(decodedBytes.toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof LocalEvidenceRuntimeError) throw error;
    invalidQuery("Failure cursor is invalid.", error);
  }
  let canonicalTimestamp = false;
  if (isPlainRecord(decoded) && typeof decoded.updatedAt === "string") {
    try {
      canonicalTimestamp =
        new Date(decoded.updatedAt).toISOString() === decoded.updatedAt;
    } catch {
      canonicalTimestamp = false;
    }
  }
  if (
    !isPlainRecord(decoded) ||
    !hasExactKeys(decoded, [
      "version",
      "queryHash",
      "updatedAt",
      "family",
      "digest",
    ]) ||
    decoded.version !== 1 ||
    decoded.queryHash !== queryHash ||
    typeof decoded.queryHash !== "string" ||
    !SHA256_HEX_PATTERN.test(decoded.queryHash) ||
    !canonicalTimestamp
  ) {
    invalidQuery("Failure cursor does not match this query.");
  }
  try {
    const canonical = {
      version: 1,
      queryHash,
      updatedAt: decoded.updatedAt as string,
      family: parseEvidenceRecordFamily(decoded.family),
      digest: parseSha256Digest(decoded.digest),
    };
    if (
      !Buffer.from(JSON.stringify(canonical)).equals(decodedBytes)
    ) {
      invalidQuery("Failure cursor JSON is not canonical.");
    }
    return {
      updatedAt: canonical.updatedAt,
      family: canonical.family,
      digest: canonical.digest,
    };
  } catch (error) {
    if (error instanceof LocalEvidenceRuntimeError) throw error;
    invalidQuery("Failure cursor contains an invalid record reference.", error);
  }
}

function publicationCorrupt(message: string, cause?: unknown): never {
  throw new LocalEvidenceRuntimeError(
    "RUNTIME_CORRUPT",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function parseOutboxRow(row: unknown): PublicationIntent {
  if (!isPlainRecord(row)) {
    publicationCorrupt("A publication outbox row is not an object.");
  }
  let reference: EvidenceRecordReference;
  try {
    reference = {
      family: parseEvidenceRecordFamily(row.family),
      digest: parseSha256Digest(row.digest),
    };
  } catch (error) {
    publicationCorrupt("A publication outbox row has an invalid record reference.", error);
  }
  if (
    typeof row.operation_key !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(row.operation_key) ||
    typeof row.announcement_id !== "string" ||
    !/^urn:jinn:local-announcement:sha256:[0-9a-f]{64}$/u.test(row.announcement_id) ||
    !Buffer.isBuffer(row.record_bytes) ||
    typeof row.byte_size !== "number" ||
    !Number.isSafeInteger(row.byte_size) ||
    row.byte_size < 0 ||
    !["staged", "stored", "announced"].includes(String(row.state))
  ) {
    publicationCorrupt("A publication outbox row has invalid metadata.");
  }
  const recordBytes = Uint8Array.from(row.record_bytes);
  if (
    recordBytes.byteLength !== row.byte_size ||
    createRecordReference(reference.family, recordBytes).digest !== reference.digest
  ) {
    publicationCorrupt("A publication outbox row does not match its exact record bytes.");
  }
  return {
    operationKey: row.operation_key,
    reference,
    recordBytes,
    byteSize: row.byte_size,
    announcementId: row.announcement_id,
    state: row.state as PublicationIntent["state"],
  };
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

  async listPendingPublications(options?: {
    readonly validate?: boolean;
  }): Promise<readonly PublicationIntent[]> {
    const rows = this.#active().prepare(`
      SELECT operation_key,family,digest,record_bytes,byte_size,state,announcement_id
      FROM publication_outbox ORDER BY operation_key
    `).all() as OutboxRow[];
    if (options?.validate === true) return rows.map(parseOutboxRow);
    return rows.map((row) => ({
      operationKey: row.operation_key,
      reference: { family: row.family, digest: row.digest },
      recordBytes: Uint8Array.from(row.record_bytes),
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
  async validateGenerationState(
    generationId: string,
    sourceId: string,
  ): Promise<string | undefined> {
    const database = this.#active();
    const checkpoint = database.prepare(`
      SELECT cursor FROM indexer_checkpoints
      WHERE generation_id = ? AND source_id = ?
    `).get(generationId, sourceId) as { cursor: string } | undefined;
    const processed = database.prepare(`
      SELECT cursor,indexed_total,failed_total FROM processed_cursors
      WHERE generation_id = ? AND source_id = ?
    `).all(generationId, sourceId) as Array<{
      cursor: string;
      indexed_total: number;
      failed_total: number;
    }>;
    const outcomes = database.prepare(`
      SELECT status,count(*) AS count FROM indexing_outcomes
      WHERE generation_id = ? AND source_id = ?
      GROUP BY status
    `).all(generationId, sourceId) as Array<{
      status: string;
      count: number;
    }>;
    const foreign = database.prepare(`
      SELECT
        (SELECT count(*) FROM indexer_checkpoints
          WHERE generation_id = ? AND source_id <> ?) +
        (SELECT count(*) FROM processed_cursors
          WHERE generation_id = ? AND source_id <> ?) +
        (SELECT count(*) FROM indexing_outcomes
          WHERE generation_id = ? AND source_id <> ?) AS count
    `).get(
      generationId,
      sourceId,
      generationId,
      sourceId,
      generationId,
      sourceId,
    ) as { count: number };
    if (foreign.count !== 0) {
      publicationCorrupt(
        "The active generation contains indexing state for a foreign source.",
      );
    }
    const indexed = outcomes.find((row) => row.status === "indexed")?.count ?? 0;
    const failed = outcomes.find((row) => row.status === "failed")?.count ?? 0;
    const invalidCount = (value: number) =>
      !Number.isSafeInteger(value) || value < 0;
    if (checkpoint === undefined) {
      if (processed.length !== 0 || indexed !== 0 || failed !== 0) {
        publicationCorrupt(
          "The active generation has outcomes without an exact checkpoint.",
        );
      }
      return undefined;
    }
    const exact = processed.find((row) => row.cursor === checkpoint.cursor);
    if (
      exact === undefined ||
      invalidCount(exact.indexed_total) ||
      invalidCount(exact.failed_total) ||
      exact.indexed_total !== indexed ||
      exact.failed_total !== failed ||
      processed.some((row) =>
        typeof row.cursor !== "string" ||
        invalidCount(row.indexed_total) ||
        invalidCount(row.failed_total) ||
        row.indexed_total > exact.indexed_total ||
        row.failed_total > exact.failed_total
      )
    ) {
      publicationCorrupt(
        "The active generation checkpoint and indexing outcomes are inconsistent.",
      );
    }
    return checkpoint.cursor;
  }
  async getProcessedCursor(
    generationId: string,
    sourceId: string,
    cursor: string,
  ): Promise<{ readonly indexed: number; readonly failed: number } | null> {
    const row = this.#active().prepare(`
      SELECT indexed_total,failed_total FROM processed_cursors
      WHERE generation_id = ? AND source_id = ? AND cursor = ?
    `).get(generationId, sourceId, cursor) as {
      indexed_total: number;
      failed_total: number;
    } | undefined;
    return row === undefined
      ? null
      : { indexed: row.indexed_total, failed: row.failed_total };
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
  async listFailures(
    generationId: string,
    query: LocalIndexingFailureQuery = {},
  ): Promise<LocalIndexingFailurePage> {
    const validated = validateFailureQuery(query);
    query = validated.query;
    const { limit } = validated;
    const queryHash = createHash("sha256").update(JSON.stringify({
      version: 1,
      generationId,
      reference: query.reference ?? null,
      category: query.category ?? null,
    })).digest("hex");
    const clauses = ["generation_id = ?", "status = 'failed'"];
    const values: unknown[] = [generationId];
    if (query.reference !== undefined) {
      clauses.push("family = ?", "digest = ?");
      values.push(query.reference.family, query.reference.digest);
    }
    if (query.category !== undefined) {
      clauses.push("json_extract(failure_json, '$.category') = ?");
      values.push(query.category);
    }
    if (query.cursor !== undefined) {
      const decoded = parseFailureCursor(query.cursor, queryHash);
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
            version: 1,
            queryHash,
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
