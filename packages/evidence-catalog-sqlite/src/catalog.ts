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
} from "@jinn-network/evidence-catalog";
import type Database from "better-sqlite3";

import { openCatalogDatabase } from "./database.js";
import { closedCatalogError } from "./errors.js";
import {
  createSchema,
  quickCheck,
  readGeneration,
} from "./schema.js";
import type {
  CreateSqliteEvidenceCatalogOptions,
  OpenSqliteEvidenceCatalogOptions,
  SqliteCatalogIntegrityReport,
  SqliteEvidenceCatalog,
} from "./types.js";
import { SqliteCatalogWriter } from "./writer.js";

class SqliteEvidenceCatalogHandle implements SqliteEvidenceCatalog {
  #closed = false;
  readonly #writer: SqliteCatalogWriter;

  constructor(
    readonly databasePath: string,
    readonly generation: SqliteEvidenceCatalog["generation"],
    private readonly database: Database.Database,
  ) {
    this.#writer = new SqliteCatalogWriter(
      database,
      (options) => this.#active(options),
    );
  }

  #active(options?: CatalogOperationOptions): void {
    if (this.#closed) throw closedCatalogError();
    assertCatalogOperationActive(options);
  }

  #notImplemented(options?: CatalogOperationOptions): never {
    this.#active(options);
    throw new EvidenceCatalogError(
      "IO_FAILURE",
      "SQLite Evidence Catalog Reader and Writer are not initialized.",
    );
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

  async withdrawRecordLocationObservation(
    withdrawal: RecordLocationWithdrawal,
    options?: CatalogOperationOptions,
  ): Promise<CatalogLocationReceipt> {
    return this.#writer.withdrawRecordLocationObservation(withdrawal, options);
  }

  async getRecord(
    _reference: EvidenceRecordReference,
    options?: CatalogOperationOptions,
  ): Promise<CatalogRecordProjection | null> {
    return this.#notImplemented(options);
  }

  async findRecordsForEntity(
    _entityId: string,
    _query: EntityRecordQuery = {},
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<CatalogRecordProjection>> {
    return this.#notImplemented(options);
  }

  async findExecutions(
    _query: ExecutionCatalogQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<ExecutionEvidenceProjection>> {
    return this.#notImplemented(options);
  }

  async findEvaluations(
    _query: EvaluationCatalogQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<ResultEvaluationProjection>> {
    return this.#notImplemented(options);
  }

  async findVerifications(
    _query: VerificationCatalogQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<ExecutionVerificationProjection>> {
    return this.#notImplemented(options);
  }

  async getRecordLocations(
    _reference: EvidenceRecordReference,
    options?: CatalogOperationOptions,
  ): Promise<readonly EvidenceRecordLocation[]> {
    return this.#notImplemented(options);
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
    throw error;
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
    throw error;
  }
}
