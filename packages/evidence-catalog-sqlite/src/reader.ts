// SPDX-License-Identifier: MIT
import {
  EvidenceCatalogError,
  type CatalogOperationOptions,
  type CatalogPage,
  type CatalogRecordProjection,
  type EntityRecordQuery,
  type EvaluationCatalogQuery,
  type EvidenceCatalogReader,
  type EvidenceRecordLocation,
  type EvidenceRecordReference,
  type ExecutionCatalogQuery,
  type ExecutionEvidenceProjection,
  type ExecutionVerificationProjection,
  type JsonValue,
  type ResultEvaluationProjection,
  type VerificationCatalogQuery,
} from "@jinn-network/evidence-discovery";
import type Database from "better-sqlite3";

import {
  encodeSqliteCatalogCursor,
  prepareEntityQuery,
  prepareEvaluationQuery,
  prepareExecutionQuery,
  prepareVerificationQuery,
  type PreparedPageQuery,
  type SqliteCatalogOrder,
} from "./cursors.js";
import { catalogIoError } from "./errors.js";
import {
  buildProjectionRows,
  canonicalJsonSnapshot,
  sha256Text,
  snapshotReference,
  type ProjectionRows,
} from "./projection-row.js";

type ActiveGuard = (options?: CatalogOperationOptions) => void;

interface StoredRecordRow {
  readonly family: unknown;
  readonly digest: unknown;
  readonly byte_size: unknown;
  readonly projection_json: unknown;
  readonly projection_hash: unknown;
}

interface KeyRow {
  readonly family: string;
  readonly digest: string;
  readonly order_value?: number;
}

interface LocationRow {
  readonly repository_id: unknown;
  readonly binding_profile: unknown;
  readonly locator_json: unknown;
}

function corruption(message: string, cause?: unknown): EvidenceCatalogError {
  return new EvidenceCatalogError("IO_FAILURE", message, { cause });
}

function equalJson(left: unknown, right: unknown): boolean {
  return (
    canonicalJsonSnapshot(left).json === canonicalJsonSnapshot(right).json
  );
}

function activeLocationClause(
  familyExpression: string,
  digestExpression: string,
): string {
  return `
    EXISTS (
      SELECT 1
      FROM location_observations AS location
      WHERE location.family = ${familyExpression}
        AND location.digest = ${digestExpression}
        AND NOT EXISTS (
          SELECT 1
          FROM location_withdrawals AS withdrawal
          WHERE withdrawal.source_id = location.source_id
            AND withdrawal.retracts_announcement_id =
              location.announcement_id
        )
    )
  `;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class SqliteCatalogReader implements EvidenceCatalogReader {
  readonly #statements = new Map<string, Database.Statement>();
  readonly #findRecord;
  readonly #entityRows;
  readonly #executionRow;
  readonly #executionResults;
  readonly #evaluationRow;
  readonly #evaluationResults;
  readonly #verificationRow;
  readonly #activeLocations;

  constructor(
    private readonly database: Database.Database,
    private readonly active: ActiveGuard,
  ) {
    this.#findRecord = database.prepare(`
      SELECT family, digest, byte_size, projection_json, projection_hash
      FROM records
      WHERE family = ? AND digest = ?
    `);
    this.#entityRows = database.prepare(`
      SELECT entity_id
      FROM entity_keys
      WHERE family = ? AND digest = ?
      ORDER BY entity_id ASC
    `);
    this.#executionRow = database.prepare(`
      SELECT
        family,
        digest,
        execution_id AS executionId,
        task_id AS taskId,
        task_digest AS taskDigest,
        executor_id AS executorId,
        runtime_id AS runtimeId,
        outcome,
        started_ms AS startedMs,
        ended_ms AS endedMs,
        published_ms AS publishedMs
      FROM execution_records
      WHERE family = ? AND digest = ?
    `);
    this.#executionResults = database.prepare(`
      SELECT
        family,
        digest,
        ordinal,
        result_id AS resultId,
        result_digest AS resultDigest
      FROM execution_results
      WHERE family = ? AND digest = ?
      ORDER BY ordinal ASC
    `);
    this.#evaluationRow = database.prepare(`
      SELECT
        family,
        digest,
        task_digest AS taskDigest,
        evaluator_id AS evaluatorId,
        verdict,
        evaluated_ms AS evaluatedMs
      FROM evaluation_records
      WHERE family = ? AND digest = ?
    `);
    this.#evaluationResults = database.prepare(`
      SELECT
        family,
        digest,
        ordinal,
        result_digest AS resultDigest
      FROM evaluation_results
      WHERE family = ? AND digest = ?
      ORDER BY ordinal ASC
    `);
    this.#verificationRow = database.prepare(`
      SELECT
        family,
        digest,
        execution_id AS executionId,
        subject_record_digest AS subjectRecordDigest,
        verifier_id AS verifierId,
        verdict,
        verified_ms AS verifiedMs
      FROM verification_records
      WHERE family = ? AND digest = ?
    `);
    this.#activeLocations = database.prepare(`
      SELECT
        observation.repository_id,
        observation.binding_profile,
        observation.locator_json
      FROM location_observations AS observation
      WHERE observation.family = ?
        AND observation.digest = ?
        AND NOT EXISTS (
          SELECT 1
          FROM location_withdrawals AS withdrawal
          WHERE withdrawal.source_id = observation.source_id
            AND withdrawal.retracts_announcement_id =
              observation.announcement_id
        )
      ORDER BY
        observation.repository_id ASC,
        observation.binding_profile ASC,
        observation.locator_json ASC
    `);
  }

  #statement(sql: string): Database.Statement {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.database.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  #assertFamilyComplete(
    family:
      | "execution-evidence"
      | "result-evaluation"
      | "execution-verification",
  ): void {
    const table =
      family === "execution-evidence"
        ? "execution_records"
        : family === "result-evaluation"
          ? "evaluation_records"
          : "verification_records";
    const row = this.#statement(`
      SELECT records.digest
      FROM records
      LEFT JOIN ${table} AS family_row
        ON family_row.family = records.family
        AND family_row.digest = records.digest
      WHERE records.family = ?
        AND family_row.digest IS NULL
      LIMIT 1
    `).get(family);
    if (row !== undefined) {
      throw corruption(
        `SQLite Evidence Catalog is missing a normalized ${family} row.`,
      );
    }
  }

  #assertForeignKeys(): void {
    const violations = this.database.pragma("foreign_key_check") as readonly
      unknown[];
    if (violations.length > 0) {
      throw corruption(
        "SQLite Evidence Catalog contains a foreign-key violation.",
      );
    }
  }

  async #decodeStoredRow(
    row: StoredRecordRow,
  ): Promise<CatalogRecordProjection> {
    try {
      if (
        typeof row.family !== "string" ||
        typeof row.digest !== "string" ||
        typeof row.byte_size !== "number" ||
        typeof row.projection_json !== "string" ||
        typeof row.projection_hash !== "string"
      ) {
        throw new Error("Stored record columns have invalid SQLite types.");
      }
      const parsed = JSON.parse(row.projection_json) as CatalogRecordProjection;
      const canonical = canonicalJsonSnapshot(parsed, "stored projection");
      if (
        canonical.json !== row.projection_json ||
        sha256Text(row.projection_json) !== row.projection_hash
      ) {
        throw new Error("Stored projection JSON or hash is inconsistent.");
      }
      const normalized = await buildProjectionRows(canonical.value);
      if (
        normalized.record.family !== row.family ||
        normalized.record.digest !== row.digest ||
        normalized.record.byteSize !== row.byte_size ||
        normalized.record.projectionHash !== row.projection_hash
      ) {
        throw new Error("Stored projection identity is inconsistent.");
      }
      this.#assertNormalizedRows(normalized);
      return canonical.value;
    } catch (error) {
      throw corruption(
        "SQLite Evidence Catalog contains a corrupt stored projection.",
        error,
      );
    }
  }

  #assertNormalizedRows(rows: ProjectionRows): void {
    const { family, digest } = rows.record;
    const entities = (
      this.#entityRows.all(family, digest) as readonly {
        readonly entity_id: unknown;
      }[]
    ).map(({ entity_id }) => entity_id);
    if (!equalJson(entities, rows.entityIds)) {
      throw new Error("Stored projection entity rows are inconsistent.");
    }

    let familyRow: unknown;
    let resultRows: readonly unknown[] = [];
    if (family === "execution-evidence") {
      familyRow = this.#executionRow.get(family, digest);
      resultRows = this.#executionResults.all(family, digest);
    } else if (family === "result-evaluation") {
      familyRow = this.#evaluationRow.get(family, digest);
      resultRows = this.#evaluationResults.all(family, digest);
    } else {
      familyRow = this.#verificationRow.get(family, digest);
    }
    if (
      familyRow === undefined ||
      !equalJson(familyRow, rows.familyRow) ||
      !equalJson(resultRows, rows.resultRows)
    ) {
      throw new Error("Stored projection normalized rows are inconsistent.");
    }
  }

  async #decodeReference(
    family: string,
    digest: string,
  ): Promise<CatalogRecordProjection> {
    const row = this.#findRecord.get(family, digest) as
      | StoredRecordRow
      | undefined;
    if (row === undefined) {
      throw corruption(
        "SQLite Evidence Catalog query references a missing record row.",
      );
    }
    return this.#decodeStoredRow(row);
  }

  async #page<T extends CatalogRecordProjection>(
    rows: readonly KeyRow[],
    prepared: PreparedPageQuery,
    order: (row: KeyRow) => SqliteCatalogOrder,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<T>> {
    const hasMore = rows.length > prepared.limit;
    const acceptedRows = rows.slice(0, prepared.limit);
    const items: T[] = [];
    for (const row of acceptedRows) {
      items.push((await this.#decodeReference(row.family, row.digest)) as T);
      this.active(options);
    }
    return {
      items,
      ...(hasMore && acceptedRows.length > 0
        ? {
            nextCursor: encodeSqliteCatalogCursor(
              prepared.queryHash,
              order(acceptedRows[acceptedRows.length - 1]!),
            ),
          }
        : {}),
    };
  }

  async getRecord(
    referenceInput: EvidenceRecordReference,
    options?: CatalogOperationOptions,
  ): Promise<CatalogRecordProjection | null> {
    this.active(options);
    const reference = snapshotReference(referenceInput);
    try {
      this.#assertForeignKeys();
      const row = this.#findRecord.get(
        reference.family,
        reference.digest,
      ) as StoredRecordRow | undefined;
      if (row === undefined) return null;
      const projection = await this.#decodeStoredRow(row);
      this.active(options);
      return projection;
    } catch (error) {
      if (error instanceof EvidenceCatalogError) throw error;
      throw catalogIoError(error, "Unable to read SQLite Catalog record.");
    }
  }

  async findExecutions(
    queryInput: ExecutionCatalogQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<ExecutionEvidenceProjection>> {
    this.active(options);
    const query = prepareExecutionQuery(queryInput);
    try {
      this.#assertForeignKeys();
      this.#assertFamilyComplete("execution-evidence");
      const clauses = ["records.family = 'execution-evidence'"];
      const parameters: unknown[] = [];
      for (const [column, value] of [
        ["family_row.execution_id", query.executionId],
        ["family_row.task_id", query.taskId],
        ["family_row.task_digest", query.taskDigest],
        ["family_row.executor_id", query.executorId],
        ["family_row.outcome", query.outcome],
      ] as const) {
        if (value !== undefined) {
          clauses.push(`${column} = ?`);
          parameters.push(value);
        }
      }
      if (query.resultId !== undefined || query.resultDigest !== undefined) {
        const resultClauses = [
          "result.family = records.family",
          "result.digest = records.digest",
        ];
        if (query.resultId !== undefined) {
          resultClauses.push("result.result_id = ?");
          parameters.push(query.resultId);
        }
        if (query.resultDigest !== undefined) {
          resultClauses.push("result.result_digest = ?");
          parameters.push(query.resultDigest);
        }
        clauses.push(`
          EXISTS (
            SELECT 1
            FROM execution_results AS result
            WHERE ${resultClauses.join(" AND ")}
          )
        `);
      }
      if (query.startedAfterMs !== undefined) {
        clauses.push("family_row.started_ms > ?");
        parameters.push(query.startedAfterMs);
      }
      if (query.startedBeforeMs !== undefined) {
        clauses.push("family_row.started_ms < ?");
        parameters.push(query.startedBeforeMs);
      }
      if (query.availability === "available") {
        clauses.push(activeLocationClause("records.family", "records.digest"));
      }
      if (query.cursorOrder !== undefined) {
        const [time, digest] = query.cursorOrder as readonly [number, string];
        clauses.push(`
          (
            family_row.started_ms < ?
            OR (family_row.started_ms = ? AND records.digest > ?)
          )
        `);
        parameters.push(time, time, digest);
      }
      parameters.push(query.limit + 1);
      const rows = this.#statement(`
        SELECT
          records.family,
          records.digest,
          family_row.started_ms AS order_value
        FROM records
        LEFT JOIN execution_records AS family_row
          ON family_row.family = records.family
          AND family_row.digest = records.digest
        WHERE ${clauses.join(" AND ")}
        ORDER BY family_row.started_ms DESC, records.digest ASC
        LIMIT ?
      `).all(...parameters) as readonly KeyRow[];
      return await this.#page<ExecutionEvidenceProjection>(
        rows,
        query,
        (row) => [row.order_value!, row.digest],
        options,
      );
    } catch (error) {
      if (error instanceof EvidenceCatalogError) throw error;
      throw catalogIoError(error, "Unable to query SQLite Catalog executions.");
    }
  }

  async findEvaluations(
    queryInput: EvaluationCatalogQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<ResultEvaluationProjection>> {
    this.active(options);
    const query = prepareEvaluationQuery(queryInput);
    try {
      this.#assertForeignKeys();
      this.#assertFamilyComplete("result-evaluation");
      const clauses = ["records.family = 'result-evaluation'"];
      const parameters: unknown[] = [];
      for (const [column, value] of [
        ["family_row.task_digest", query.taskDigest],
        ["family_row.evaluator_id", query.evaluatorId],
        ["family_row.verdict", query.verdict],
      ] as const) {
        if (value !== undefined) {
          clauses.push(`${column} = ?`);
          parameters.push(value);
        }
      }
      if (query.resultDigest !== undefined) {
        clauses.push(`
          EXISTS (
            SELECT 1
            FROM evaluation_results AS result
            WHERE result.family = records.family
              AND result.digest = records.digest
              AND result.result_digest = ?
          )
        `);
        parameters.push(query.resultDigest);
      }
      if (query.evaluatedAfterMs !== undefined) {
        clauses.push("family_row.evaluated_ms > ?");
        parameters.push(query.evaluatedAfterMs);
      }
      if (query.evaluatedBeforeMs !== undefined) {
        clauses.push("family_row.evaluated_ms < ?");
        parameters.push(query.evaluatedBeforeMs);
      }
      if (query.availability === "available") {
        clauses.push(activeLocationClause("records.family", "records.digest"));
      }
      if (query.cursorOrder !== undefined) {
        const [time, digest] = query.cursorOrder as readonly [number, string];
        clauses.push(`
          (
            family_row.evaluated_ms < ?
            OR (family_row.evaluated_ms = ? AND records.digest > ?)
          )
        `);
        parameters.push(time, time, digest);
      }
      parameters.push(query.limit + 1);
      const rows = this.#statement(`
        SELECT
          records.family,
          records.digest,
          family_row.evaluated_ms AS order_value
        FROM records
        LEFT JOIN evaluation_records AS family_row
          ON family_row.family = records.family
          AND family_row.digest = records.digest
        WHERE ${clauses.join(" AND ")}
        ORDER BY family_row.evaluated_ms DESC, records.digest ASC
        LIMIT ?
      `).all(...parameters) as readonly KeyRow[];
      return await this.#page<ResultEvaluationProjection>(
        rows,
        query,
        (row) => [row.order_value!, row.digest],
        options,
      );
    } catch (error) {
      if (error instanceof EvidenceCatalogError) throw error;
      throw catalogIoError(error, "Unable to query SQLite Catalog evaluations.");
    }
  }

  async findVerifications(
    queryInput: VerificationCatalogQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<ExecutionVerificationProjection>> {
    this.active(options);
    const query = prepareVerificationQuery(queryInput);
    try {
      this.#assertForeignKeys();
      this.#assertFamilyComplete("execution-verification");
      const clauses = ["records.family = 'execution-verification'"];
      const parameters: unknown[] = [];
      for (const [column, value] of [
        ["family_row.execution_id", query.executionId],
        ["family_row.subject_record_digest", query.subjectRecordDigest],
        ["family_row.verifier_id", query.verifierId],
        ["family_row.verdict", query.verdict],
      ] as const) {
        if (value !== undefined) {
          clauses.push(`${column} = ?`);
          parameters.push(value);
        }
      }
      if (query.verifiedAfterMs !== undefined) {
        clauses.push("family_row.verified_ms > ?");
        parameters.push(query.verifiedAfterMs);
      }
      if (query.verifiedBeforeMs !== undefined) {
        clauses.push("family_row.verified_ms < ?");
        parameters.push(query.verifiedBeforeMs);
      }
      if (query.availability === "available") {
        clauses.push(activeLocationClause("records.family", "records.digest"));
      }
      if (query.cursorOrder !== undefined) {
        const [time, digest] = query.cursorOrder as readonly [number, string];
        clauses.push(`
          (
            family_row.verified_ms < ?
            OR (family_row.verified_ms = ? AND records.digest > ?)
          )
        `);
        parameters.push(time, time, digest);
      }
      parameters.push(query.limit + 1);
      const rows = this.#statement(`
        SELECT
          records.family,
          records.digest,
          family_row.verified_ms AS order_value
        FROM records
        LEFT JOIN verification_records AS family_row
          ON family_row.family = records.family
          AND family_row.digest = records.digest
        WHERE ${clauses.join(" AND ")}
        ORDER BY family_row.verified_ms DESC, records.digest ASC
        LIMIT ?
      `).all(...parameters) as readonly KeyRow[];
      return await this.#page<ExecutionVerificationProjection>(
        rows,
        query,
        (row) => [row.order_value!, row.digest],
        options,
      );
    } catch (error) {
      if (error instanceof EvidenceCatalogError) throw error;
      throw catalogIoError(
        error,
        "Unable to query SQLite Catalog verifications.",
      );
    }
  }

  async findRecordsForEntity(
    entityId: string,
    queryInput: EntityRecordQuery = {},
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<CatalogRecordProjection>> {
    this.active(options);
    const query = prepareEntityQuery(entityId, queryInput);
    try {
      this.#assertForeignKeys();
      const clauses = ["entity.entity_id = ?"];
      const parameters: unknown[] = [query.entityId];
      if (query.family !== undefined) {
        clauses.push("entity.family = ?");
        parameters.push(query.family);
      }
      if (query.availability === "available") {
        clauses.push(activeLocationClause("entity.family", "entity.digest"));
      }
      if (query.cursorOrder !== undefined) {
        const [family, digest] = query.cursorOrder as readonly [string, string];
        clauses.push(`
          (
            entity.family > ?
            OR (entity.family = ? AND entity.digest > ?)
          )
        `);
        parameters.push(family, family, digest);
      }
      parameters.push(query.limit + 1);
      const rows = this.#statement(`
        SELECT entity.family, entity.digest
        FROM entity_keys AS entity
        LEFT JOIN records
          ON records.family = entity.family
          AND records.digest = entity.digest
        WHERE ${clauses.join(" AND ")}
        ORDER BY entity.family ASC, entity.digest ASC
        LIMIT ?
      `).all(...parameters) as readonly KeyRow[];
      return await this.#page<CatalogRecordProjection>(
        rows,
        query,
        (row) => [row.family, row.digest],
        options,
      );
    } catch (error) {
      if (error instanceof EvidenceCatalogError) throw error;
      throw catalogIoError(
        error,
        "Unable to query SQLite Catalog entity records.",
      );
    }
  }

  async getRecordLocations(
    referenceInput: EvidenceRecordReference,
    options?: CatalogOperationOptions,
  ): Promise<readonly EvidenceRecordLocation[]> {
    this.active(options);
    const reference = snapshotReference(referenceInput);
    try {
      this.#assertForeignKeys();
      const record = this.#findRecord.get(
        reference.family,
        reference.digest,
      ) as StoredRecordRow | undefined;
      if (record === undefined) return [];
      await this.#decodeStoredRow(record);
      this.active(options);
      const rows = this.#activeLocations.all(
        reference.family,
        reference.digest,
      ) as readonly LocationRow[];
      const deduplicated = new Map<
        string,
        {
          readonly location: EvidenceRecordLocation;
          readonly bindingProfile: string;
          readonly locatorJson: string;
        }
      >();
      for (const row of rows) {
        if (typeof row.repository_id !== "string") {
          throw corruption("SQLite Catalog location row is corrupt.");
        }
        let location: EvidenceRecordLocation;
        let bindingProfile = "";
        let locatorJson = "";
        if (
          row.binding_profile === null &&
          row.locator_json === null
        ) {
          location = { repositoryId: row.repository_id };
        } else {
          if (
            typeof row.binding_profile !== "string" ||
            typeof row.locator_json !== "string"
          ) {
            throw corruption("SQLite Catalog published location is corrupt.");
          }
          const locator = JSON.parse(row.locator_json) as unknown;
          const canonical = canonicalJsonSnapshot(locator, "stored locator");
          if (
            canonical.json !== row.locator_json ||
            typeof canonical.value !== "object" ||
            canonical.value === null ||
            Array.isArray(canonical.value)
          ) {
            throw corruption("SQLite Catalog locator JSON is corrupt.");
          }
          bindingProfile = row.binding_profile;
          locatorJson = row.locator_json;
          location = {
            repositoryId: row.repository_id,
            publishedLocation: {
              bindingProfile,
              locator: canonical.value as Readonly<
                Record<string, JsonValue>
              >,
            },
          };
        }
        const identity =
          location.publishedLocation === undefined
            ? canonicalJsonSnapshot(["local", location.repositoryId]).json
            : canonicalJsonSnapshot([
                "published",
                bindingProfile,
                JSON.parse(locatorJson),
              ]).json;
        const candidate = { location, bindingProfile, locatorJson };
        const existing = deduplicated.get(identity);
        if (
          existing === undefined ||
          compareText(
            candidate.location.repositoryId,
            existing.location.repositoryId,
          ) < 0
        ) {
          deduplicated.set(identity, candidate);
        }
      }
      return [...deduplicated.values()]
        .sort(
          (left, right) =>
            compareText(
              left.location.repositoryId,
              right.location.repositoryId,
            ) ||
            compareText(left.bindingProfile, right.bindingProfile) ||
            compareText(left.locatorJson, right.locatorJson),
        )
        .map(({ location }) => location);
    } catch (error) {
      if (error instanceof EvidenceCatalogError) throw error;
      throw catalogIoError(error, "Unable to read SQLite Catalog locations.");
    }
  }
}
