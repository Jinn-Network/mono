// SPDX-License-Identifier: MIT
import {
  EvidenceCatalogError,
  type CatalogLocationReceipt,
  type CatalogOperationOptions,
  type CatalogRecordProjection,
  type CatalogWriteReceipt,
  type EvidenceCatalogWriter,
  type EvidenceRecordReference,
  type RecordLocationObservation,
  type RecordLocationWithdrawal,
} from "@jinn-network/evidence-discovery";
import type Database from "better-sqlite3";

import { catalogIoError } from "./errors.js";
import {
  buildProjectionRows,
  canonicalJsonSnapshot,
  sha256Text,
  snapshotLocationObservation,
  snapshotLocationWithdrawal,
  snapshotReference,
  type ProjectionRows,
} from "./projection-row.js";

type ActiveGuard = (options?: CatalogOperationOptions) => void;

function sqliteCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function mapProjectionWriteError(error: unknown): EvidenceCatalogError {
  if (error instanceof EvidenceCatalogError) return error;
  if (sqliteCode(error)?.startsWith("SQLITE_CONSTRAINT") === true) {
    return new EvidenceCatalogError(
      "INVALID_PROJECTION",
      "Projection rows violate the SQLite Evidence Catalog schema.",
      { cause: error },
    );
  }
  return catalogIoError(error, "Unable to persist SQLite Catalog projection.");
}

function mapLocationWriteError(error: unknown): EvidenceCatalogError {
  if (error instanceof EvidenceCatalogError) return error;
  if (sqliteCode(error)?.startsWith("SQLITE_CONSTRAINT") === true) {
    return new EvidenceCatalogError(
      "INVALID_PROJECTION",
      "Location rows violate the SQLite Evidence Catalog schema.",
      { cause: error },
    );
  }
  return catalogIoError(error, "Unable to persist SQLite Catalog location event.");
}

interface ExistingProjection {
  readonly projection_hash: string;
  readonly projection_json: string;
}

interface AnnouncementKey {
  readonly event_kind: string;
  readonly payload_hash: string;
}

export class SqliteCatalogWriter implements EvidenceCatalogWriter {
  readonly #findRecord;
  readonly #insertRecord;
  readonly #insertEntity;
  readonly #insertExecution;
  readonly #insertExecutionResult;
  readonly #insertExecutionIdentifier;
  readonly #insertEvaluation;
  readonly #insertEvaluationResult;
  readonly #insertVerification;
  readonly #findAnnouncement;
  readonly #insertAnnouncement;
  readonly #insertObservation;
  readonly #findObservation;
  readonly #findForeignObservation;
  readonly #findWithdrawalForTarget;
  readonly #insertWithdrawal;
  readonly #putRows;
  readonly #observe;
  readonly #withdraw;

  constructor(
    private readonly database: Database.Database,
    private readonly active: ActiveGuard,
  ) {
    this.#findRecord = database.prepare(`
      SELECT projection_hash, projection_json
      FROM records
      WHERE family = ? AND digest = ?
    `);
    this.#insertRecord = database.prepare(`
      INSERT INTO records (
        family, digest, byte_size, projection_json, projection_hash
      ) VALUES (?, ?, ?, ?, ?)
    `);
    this.#insertEntity = database.prepare(`
      INSERT INTO entity_keys (family, digest, entity_id)
      VALUES (?, ?, ?)
    `);
    this.#insertExecution = database.prepare(`
      INSERT INTO execution_records (
        family, digest, execution_id, task_id, task_digest, executor_id,
        runtime_id, runtime_digest, outcome, started_ms, ended_ms, published_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#insertExecutionResult = database.prepare(`
      INSERT INTO execution_results (
        family, digest, ordinal, result_id, result_digest
      ) VALUES (?, ?, ?, ?, ?)
    `);
    this.#insertExecutionIdentifier = database.prepare(`
      INSERT INTO execution_identifiers (
        family, digest, ordinal, entity_id, scheme, value
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.#insertEvaluation = database.prepare(`
      INSERT INTO evaluation_records (
        family, digest, task_digest, evaluator_id, verdict, evaluated_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.#insertEvaluationResult = database.prepare(`
      INSERT INTO evaluation_results (
        family, digest, ordinal, result_digest
      ) VALUES (?, ?, ?, ?)
    `);
    this.#insertVerification = database.prepare(`
      INSERT INTO verification_records (
        family, digest, execution_id, subject_record_digest, verifier_id,
        verdict, verified_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.#findAnnouncement = database.prepare(`
      SELECT event_kind, payload_hash
      FROM announcement_keys
      WHERE source_id = ? AND announcement_id = ?
    `);
    this.#insertAnnouncement = database.prepare(`
      INSERT INTO announcement_keys (
        source_id, announcement_id, event_kind, payload_hash
      ) VALUES (?, ?, ?, ?)
    `);
    this.#insertObservation = database.prepare(`
      INSERT INTO location_observations (
        source_id, announcement_id, family, digest, repository_id,
        binding_profile, locator_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.#findObservation = database.prepare(`
      SELECT source_id, announcement_id
      FROM location_observations
      WHERE source_id = ? AND announcement_id = ?
    `);
    this.#findForeignObservation = database.prepare(`
      SELECT source_id
      FROM location_observations
      WHERE announcement_id = ? AND source_id <> ?
      LIMIT 1
    `);
    this.#findWithdrawalForTarget = database.prepare(`
      SELECT announcement_id
      FROM location_withdrawals
      WHERE source_id = ? AND retracts_announcement_id = ?
      LIMIT 1
    `);
    this.#insertWithdrawal = database.prepare(`
      INSERT INTO location_withdrawals (
        source_id, announcement_id, retracts_announcement_id
      ) VALUES (?, ?, ?)
    `);

    this.#putRows = database.transaction(
      (rows: ProjectionRows): CatalogWriteReceipt => {
        const { record } = rows;
        const existing = this.#findRecord.get(
          record.family,
          record.digest,
        ) as ExistingProjection | undefined;
        if (existing !== undefined) {
          if (
            existing.projection_hash !== record.projectionHash ||
            existing.projection_json !== record.projectionJson
          ) {
            throw new EvidenceCatalogError(
              "PROJECTION_CONFLICT",
              "An unequal projection already exists for this record reference.",
            );
          }
          return {
            reference: { family: record.family, digest: record.digest },
            status: "existing",
          };
        }

        this.#insertRecord.run(
          record.family,
          record.digest,
          record.byteSize,
          record.projectionJson,
          record.projectionHash,
        );
        for (const entityId of rows.entityIds) {
          this.#insertEntity.run(record.family, record.digest, entityId);
        }
        const row = rows.familyRow;
        if (record.family === "execution-evidence") {
          this.#insertExecution.run(
            row.family,
            row.digest,
            row.executionId,
            row.taskId,
            row.taskDigest,
            row.executorId,
            row.runtimeId,
            row.runtimeDigest,
            row.outcome,
            row.startedMs,
            row.endedMs,
            row.publishedMs,
          );
          for (const result of rows.resultRows) {
            this.#insertExecutionResult.run(
              result.family,
              result.digest,
              result.ordinal,
              result.resultId,
              result.resultDigest,
            );
          }
          for (const identifier of rows.identifierRows) {
            this.#insertExecutionIdentifier.run(
              identifier.family,
              identifier.digest,
              identifier.ordinal,
              identifier.entityId,
              identifier.scheme,
              identifier.value,
            );
          }
        } else if (record.family === "result-evaluation") {
          this.#insertEvaluation.run(
            row.family,
            row.digest,
            row.taskDigest,
            row.evaluatorId,
            row.verdict,
            row.evaluatedMs,
          );
          for (const result of rows.resultRows) {
            this.#insertEvaluationResult.run(
              result.family,
              result.digest,
              result.ordinal,
              result.resultDigest,
            );
          }
        } else {
          this.#insertVerification.run(
            row.family,
            row.digest,
            row.executionId,
            row.subjectRecordDigest,
            row.verifierId,
            row.verdict,
            row.verifiedMs,
          );
        }
        return {
          reference: { family: record.family, digest: record.digest },
          status: "created",
        };
      },
    );

    this.#observe = database.transaction(
      (
        reference: EvidenceRecordReference,
        observation: RecordLocationObservation,
        payloadHash: string,
        locatorJson: string | null,
      ): CatalogLocationReceipt => {
        if (
          this.#findRecord.get(reference.family, reference.digest) === undefined
        ) {
          throw new EvidenceCatalogError(
            "INVALID_PROJECTION",
            "A location cannot be observed before its projection exists.",
          );
        }
        const prior = this.#findAnnouncement.get(
          observation.sourceId,
          observation.announcementId,
        ) as AnnouncementKey | undefined;
        if (prior !== undefined) {
          if (
            prior.event_kind === "available" &&
            prior.payload_hash === payloadHash
          ) {
            return { status: "existing" };
          }
          throw new EvidenceCatalogError(
            "LOCATION_CONFLICT",
            "The source announcement identifies another record or location.",
          );
        }
        this.#insertAnnouncement.run(
          observation.sourceId,
          observation.announcementId,
          "available",
          payloadHash,
        );
        this.#insertObservation.run(
          observation.sourceId,
          observation.announcementId,
          reference.family,
          reference.digest,
          observation.repositoryId,
          observation.publishedLocation?.bindingProfile ?? null,
          locatorJson,
        );
        return { status: "created" };
      },
    );

    this.#withdraw = database.transaction(
      (
        withdrawal: RecordLocationWithdrawal,
        payloadHash: string,
      ): CatalogLocationReceipt => {
        const prior = this.#findAnnouncement.get(
          withdrawal.sourceId,
          withdrawal.announcementId,
        ) as AnnouncementKey | undefined;
        if (prior !== undefined) {
          if (
            prior.event_kind === "withdrawn" &&
            prior.payload_hash === payloadHash
          ) {
            return { status: "existing" };
          }
          throw new EvidenceCatalogError(
            "LOCATION_CONFLICT",
            "The withdrawal announcement identifier targets another event.",
          );
        }
        const target = this.#findObservation.get(
          withdrawal.sourceId,
          withdrawal.retractsAnnouncementId,
        );
        if (
          target === undefined &&
          this.#findForeignObservation.get(
            withdrawal.retractsAnnouncementId,
            withdrawal.sourceId,
          ) !== undefined
        ) {
          throw new EvidenceCatalogError(
            "LOCATION_CONFLICT",
            "A source cannot withdraw another source's observation.",
          );
        }
        const alreadyWithdrawn =
          target !== undefined &&
          this.#findWithdrawalForTarget.get(
            withdrawal.sourceId,
            withdrawal.retractsAnnouncementId,
          ) !== undefined;
        this.#insertAnnouncement.run(
          withdrawal.sourceId,
          withdrawal.announcementId,
          "withdrawn",
          payloadHash,
        );
        this.#insertWithdrawal.run(
          withdrawal.sourceId,
          withdrawal.announcementId,
          withdrawal.retractsAnnouncementId,
        );
        return {
          status:
            target === undefined || alreadyWithdrawn ? "absent" : "withdrawn",
        };
      },
    );
  }

  async putRecordProjection(
    projection: CatalogRecordProjection,
    options?: CatalogOperationOptions,
  ): Promise<CatalogWriteReceipt> {
    this.active(options);
    const rows = await buildProjectionRows(projection);
    this.active(options);
    try {
      return this.#putRows.immediate(rows);
    } catch (error) {
      throw mapProjectionWriteError(error);
    }
  }

  async observeRecordLocation(
    referenceInput: EvidenceRecordReference,
    observationInput: RecordLocationObservation,
    options?: CatalogOperationOptions,
  ): Promise<CatalogLocationReceipt> {
    this.active(options);
    try {
      const reference = snapshotReference(referenceInput);
      const observation = snapshotLocationObservation(observationInput);
      const { json: payloadJson } = canonicalJsonSnapshot(
        {
          kind: "available",
          reference,
          repositoryId: observation.repositoryId,
          publishedLocation: observation.publishedLocation ?? null,
        },
        "location payload",
      );
      const locatorJson =
        observation.publishedLocation === undefined
          ? null
          : canonicalJsonSnapshot(
              observation.publishedLocation.locator,
              "locator",
            ).json;
      this.active(options);
      return this.#observe.immediate(
        reference,
        observation,
        sha256Text(payloadJson),
        locatorJson,
      );
    } catch (error) {
      throw mapLocationWriteError(error);
    }
  }

  async withdrawRecordLocationObservation(
    withdrawalInput: RecordLocationWithdrawal,
    options?: CatalogOperationOptions,
  ): Promise<CatalogLocationReceipt> {
    this.active(options);
    try {
      const withdrawal = snapshotLocationWithdrawal(withdrawalInput);
      const { json: payloadJson } = canonicalJsonSnapshot(
        {
          kind: "withdrawn",
          retractsAnnouncementId: withdrawal.retractsAnnouncementId,
        },
        "withdrawal payload",
      );
      this.active(options);
      return this.#withdraw.immediate(
        withdrawal,
        sha256Text(payloadJson),
      );
    } catch (error) {
      throw mapLocationWriteError(error);
    }
  }
}
