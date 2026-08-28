// SPDX-License-Identifier: MIT
import { unlink } from "node:fs/promises";

import {
  assertCatalogOperationActive,
  EvidenceCatalogError,
  type CatalogLocationReceipt,
  type CatalogOperationOptions,
  type CatalogPage,
  type CatalogRecordProjection,
  type CatalogWriteReceipt,
  type EntityRecordQuery,
  type EvaluationCatalogQuery,
  type EvidenceRecordLocation,
  type EvidenceRecordReference,
  type ExecutionCatalogQuery,
  type ExecutionEvidenceProjection,
  type ExecutionVerificationProjection,
  type RecordLocationObservation,
  type RecordLocationWithdrawal,
  type ResultEvaluationProjection,
  type VerificationCatalogQuery,
} from "@jinn-network/evidence-discovery";
import type Database from "better-sqlite3";

import { SqliteAnnouncementEdgeIndex } from "./announcement-edges.js";
import { openCatalogDatabase } from "./database.js";
import { catalogIoError, closedCatalogError } from "./errors.js";
import { SqliteCatalogReader } from "./reader.js";
import {
  createSchema,
  quickCheck,
  readGeneration,
} from "./schema.js";
import type {
  AnnouncementEdge,
  AnnouncementEdgeIndexInput,
  AnnouncementEdgeIndexReceipt,
  AnnouncementEdgeQuery,
  CreateSqliteEvidenceCatalogOptions,
  OpenSqliteEvidenceCatalogOptions,
  SqliteCatalogIntegrityReport,
  SqliteEvidenceCatalog,
} from "./types.js";
import { SqliteCatalogWriter } from "./writer.js";

class SqliteEvidenceCatalogHandle implements SqliteEvidenceCatalog {
  #closed = false;
  readonly #reader: SqliteCatalogReader;
  readonly #writer: SqliteCatalogWriter;
  readonly #edges: SqliteAnnouncementEdgeIndex;

  constructor(
    readonly databasePath: string,
    readonly generation: SqliteEvidenceCatalog["generation"],
    private readonly database: Database.Database,
  ) {
    this.#reader = new SqliteCatalogReader(
      database,
      (options) => this.#active(options),
    );
    this.#writer = new SqliteCatalogWriter(
      database,
      (options) => this.#active(options),
    );
    this.#edges = new SqliteAnnouncementEdgeIndex(
      database,
      (options) => this.#active(options),
    );
  }

  #active(options?: CatalogOperationOptions): void {
    if (this.#closed) throw closedCatalogError();
    assertCatalogOperationActive(options);
  }

  async putRecordProjection(
    projection: CatalogRecordProjection,
    options?: CatalogOperationOptions,
  ): Promise<CatalogWriteReceipt> {
    return this.#writer.putRecordProjection(projection, options);
  }

  async observeRecordLocation(
    reference: EvidenceRecordReference,
    observation: RecordLocationObservation,
    options?: CatalogOperationOptions,
  ): Promise<CatalogLocationReceipt> {
    return this.#writer.observeRecordLocation(reference, observation, options);
  }

  async indexAnnouncementEdges(
    input: AnnouncementEdgeIndexInput,
    options?: CatalogOperationOptions,
  ): Promise<AnnouncementEdgeIndexReceipt> {
    return this.#edges.index(input, options);
  }

  async queryAnnouncementEdges(
    query: AnnouncementEdgeQuery,
    options?: CatalogOperationOptions,
  ): Promise<readonly AnnouncementEdge[]> {
    return this.#edges.query(query, options);
  }

  async withdrawRecordLocationObservation(
    withdrawal: RecordLocationWithdrawal,
    options?: CatalogOperationOptions,
  ): Promise<CatalogLocationReceipt> {
    return this.#writer.withdrawRecordLocationObservation(withdrawal, options);
  }

  async getRecord(
    reference: EvidenceRecordReference,
    options?: CatalogOperationOptions,
  ): Promise<CatalogRecordProjection | null> {
    return this.#reader.getRecord(reference, options);
  }

  async findRecordsForEntity(
    entityId: string,
    query: EntityRecordQuery = {},
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<CatalogRecordProjection>> {
    return this.#reader.findRecordsForEntity(entityId, query, options);
  }

  async findExecutions(
    query: ExecutionCatalogQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<ExecutionEvidenceProjection>> {
    return this.#reader.findExecutions(query, options);
  }

  async findEvaluations(
    query: EvaluationCatalogQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<ResultEvaluationProjection>> {
    return this.#reader.findEvaluations(query, options);
  }

  async findVerifications(
    query: VerificationCatalogQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<ExecutionVerificationProjection>> {
    return this.#reader.findVerifications(query, options);
  }

  async getRecordLocations(
    reference: EvidenceRecordReference,
    options?: CatalogOperationOptions,
  ): Promise<readonly EvidenceRecordLocation[]> {
    return this.#reader.getRecordLocations(reference, options);
  }

  async integrityCheck(
    options?: CatalogOperationOptions,
  ): Promise<SqliteCatalogIntegrityReport> {
    this.#active(options);
    const messages = quickCheck(this.database);
    return { valid: messages.length === 0, messages };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.database.close();
  }
}

export async function createSqliteEvidenceCatalog(
  options: CreateSqliteEvidenceCatalogOptions,
): Promise<SqliteEvidenceCatalog> {
  const opened = await openCatalogDatabase(options.databasePath, true);
  try {
    createSchema(opened.database, options.generation);
    const messages = quickCheck(opened.database);
    if (messages.length > 0) {
      throw new EvidenceCatalogError(
        "IO_FAILURE",
        `New SQLite Evidence Catalog failed integrity check: ${messages.join("; ")}`,
      );
    }
    const generation = readGeneration(opened.database);
    return new SqliteEvidenceCatalogHandle(
      opened.databasePath,
      generation,
      opened.database,
    );
  } catch (error) {
    try {
      opened.database.close();
    } catch {
      // Preserve the creation failure.
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      await unlink(`${opened.databasePath}${suffix}`).catch(() => undefined);
    }
    throw catalogIoError(
      error,
      "Unable to create SQLite Evidence Catalog handle.",
    );
  }
}

export async function openSqliteEvidenceCatalog(
  options: OpenSqliteEvidenceCatalogOptions,
): Promise<SqliteEvidenceCatalog> {
  const opened = await openCatalogDatabase(options.databasePath, false);
  try {
    const generation = readGeneration(opened.database);
    return new SqliteEvidenceCatalogHandle(
      opened.databasePath,
      generation,
      opened.database,
    );
  } catch (error) {
    try {
      opened.database.close();
    } catch {
      // Preserve the opening failure.
    }
    throw catalogIoError(
      error,
      "Unable to open SQLite Evidence Catalog handle.",
    );
  }
}
