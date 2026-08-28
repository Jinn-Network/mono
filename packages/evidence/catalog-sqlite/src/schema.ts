// SPDX-License-Identifier: MIT
import type Database from "better-sqlite3";

import {
  CATALOG_SCHEMA_VERSION,
  EvidenceCatalogError,
  type CatalogGeneration,
} from "@jinn-network/evidence-discovery";

import { catalogIoError } from "./errors.js";

export const SQLITE_EVIDENCE_CATALOG_SCHEMA_VERSION = 3 as const;

const SCHEMA_SQL = `
CREATE TABLE catalog_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  sqlite_schema_version INTEGER NOT NULL,
  catalog_schema_version TEXT NOT NULL,
  projector_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE records (
  family TEXT NOT NULL,
  digest TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  projection_json TEXT NOT NULL,
  projection_hash TEXT NOT NULL,
  PRIMARY KEY (family, digest)
);

CREATE TABLE entity_keys (
  family TEXT NOT NULL,
  digest TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (family, digest, entity_id),
  FOREIGN KEY (family, digest) REFERENCES records(family, digest)
);

CREATE TABLE execution_records (
  family TEXT NOT NULL CHECK (family = 'execution-evidence'),
  digest TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_digest TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  runtime_digest TEXT NOT NULL,
  outcome TEXT NOT NULL,
  started_ms INTEGER NOT NULL,
  ended_ms INTEGER NOT NULL,
  published_ms INTEGER NOT NULL,
  PRIMARY KEY (family, digest),
  FOREIGN KEY (family, digest) REFERENCES records(family, digest)
);

CREATE TABLE execution_results (
  family TEXT NOT NULL CHECK (family = 'execution-evidence'),
  digest TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  result_id TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  PRIMARY KEY (family, digest, ordinal),
  FOREIGN KEY (family, digest) REFERENCES records(family, digest)
);

CREATE TABLE execution_identifiers (
  family TEXT NOT NULL CHECK (family = 'execution-evidence'),
  digest TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  scheme TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (family, digest, ordinal),
  FOREIGN KEY (family, digest) REFERENCES records(family, digest)
);

CREATE TABLE evaluation_records (
  family TEXT NOT NULL CHECK (family = 'result-evaluation'),
  digest TEXT NOT NULL,
  task_digest TEXT NOT NULL,
  evaluator_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  evaluated_ms INTEGER NOT NULL,
  PRIMARY KEY (family, digest),
  FOREIGN KEY (family, digest) REFERENCES records(family, digest)
);

CREATE TABLE evaluation_results (
  family TEXT NOT NULL CHECK (family = 'result-evaluation'),
  digest TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  result_digest TEXT NOT NULL,
  PRIMARY KEY (family, digest, ordinal),
  FOREIGN KEY (family, digest) REFERENCES records(family, digest)
);

CREATE TABLE verification_records (
  family TEXT NOT NULL CHECK (family = 'execution-verification'),
  digest TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  subject_record_digest TEXT NOT NULL,
  verifier_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  verified_ms INTEGER NOT NULL,
  PRIMARY KEY (family, digest),
  FOREIGN KEY (family, digest) REFERENCES records(family, digest)
);

CREATE TABLE announcement_keys (
  source_id TEXT NOT NULL,
  announcement_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  PRIMARY KEY (source_id, announcement_id)
);

CREATE TABLE location_observations (
  source_id TEXT NOT NULL,
  announcement_id TEXT NOT NULL,
  family TEXT NOT NULL,
  digest TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  binding_profile TEXT,
  locator_json TEXT,
  PRIMARY KEY (source_id, announcement_id),
  FOREIGN KEY (family, digest) REFERENCES records(family, digest),
  FOREIGN KEY (source_id, announcement_id)
    REFERENCES announcement_keys(source_id, announcement_id)
);

CREATE TABLE location_withdrawals (
  source_id TEXT NOT NULL,
  announcement_id TEXT NOT NULL,
  retracts_announcement_id TEXT NOT NULL,
  PRIMARY KEY (source_id, announcement_id),
  FOREIGN KEY (source_id, announcement_id)
    REFERENCES announcement_keys(source_id, announcement_id)
);

-- The announcement edge index (record-discovery design §12, amendment 2026-08-28). Unlike every
-- table above it is fed from announcement facts cards, never from a fetched record: a card
-- declares its kind's outbound references, and those edges are what lets an index answer join
-- -- "this environment, its attempts, their verdicts" -- without fetching anything. It is keyed
-- by record-kind URI rather than by evidence family, because the feed carries every kind.
CREATE TABLE announcement_edges (
  record_kind TEXT NOT NULL,
  record_digest TEXT NOT NULL,
  field TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  target_digest TEXT NOT NULL,
  PRIMARY KEY (record_kind, record_digest, field, ordinal)
);

CREATE INDEX records_family_digest_idx
  ON records(family, digest);
CREATE INDEX entity_keys_entity_family_digest_idx
  ON entity_keys(entity_id, family, digest);
CREATE INDEX execution_records_order_idx
  ON execution_records(started_ms DESC, digest ASC);
CREATE INDEX execution_records_execution_idx
  ON execution_records(execution_id, started_ms DESC, digest ASC);
CREATE INDEX execution_records_task_id_idx
  ON execution_records(task_id, started_ms DESC, digest ASC);
CREATE INDEX execution_records_task_digest_idx
  ON execution_records(task_digest, started_ms DESC, digest ASC);
CREATE INDEX execution_records_executor_idx
  ON execution_records(executor_id, started_ms DESC, digest ASC);
CREATE INDEX execution_records_runtime_digest_idx
  ON execution_records(runtime_digest, started_ms DESC, digest ASC);
CREATE INDEX execution_records_published_idx
  ON execution_records(published_ms DESC, digest ASC);
CREATE INDEX execution_records_outcome_idx
  ON execution_records(outcome, started_ms DESC, digest ASC);
CREATE INDEX execution_results_result_id_idx
  ON execution_results(result_id, family, digest);
CREATE INDEX execution_results_result_digest_idx
  ON execution_results(result_digest, family, digest);
CREATE INDEX execution_results_pair_idx
  ON execution_results(result_id, result_digest, family, digest);
CREATE INDEX execution_identifiers_scheme_value_idx
  ON execution_identifiers(scheme, value, family, digest);
CREATE INDEX evaluation_records_order_idx
  ON evaluation_records(evaluated_ms DESC, digest ASC);
CREATE INDEX evaluation_records_task_idx
  ON evaluation_records(task_digest, evaluated_ms DESC, digest ASC);
CREATE INDEX evaluation_records_evaluator_idx
  ON evaluation_records(evaluator_id, evaluated_ms DESC, digest ASC);
CREATE INDEX evaluation_records_verdict_idx
  ON evaluation_records(verdict, evaluated_ms DESC, digest ASC);
CREATE INDEX evaluation_results_digest_idx
  ON evaluation_results(result_digest, family, digest);
CREATE INDEX verification_records_order_idx
  ON verification_records(verified_ms DESC, digest ASC);
CREATE INDEX verification_records_execution_idx
  ON verification_records(execution_id, verified_ms DESC, digest ASC);
CREATE INDEX verification_records_subject_idx
  ON verification_records(subject_record_digest, verified_ms DESC, digest ASC);
CREATE INDEX verification_records_verifier_idx
  ON verification_records(verifier_id, verified_ms DESC, digest ASC);
CREATE INDEX verification_records_verdict_idx
  ON verification_records(verdict, verified_ms DESC, digest ASC);
CREATE INDEX location_observations_record_idx
  ON location_observations(family, digest, source_id, announcement_id);
CREATE INDEX location_withdrawals_target_idx
  ON location_withdrawals(source_id, retracts_announcement_id);
CREATE INDEX announcement_keys_kind_idx
  ON announcement_keys(event_kind, source_id, announcement_id);
CREATE INDEX announcement_edges_source_idx
  ON announcement_edges(record_digest, field, ordinal);
-- The referrers inversion (design section 8): which records point at this digest.
CREATE INDEX announcement_edges_target_idx
  ON announcement_edges(target_digest, record_kind, record_digest);
`;

interface MetadataRow {
  readonly sqlite_schema_version: unknown;
  readonly catalog_schema_version: unknown;
  readonly projector_version: unknown;
  readonly created_at: unknown;
}

function validCreatedAt(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
    value,
  ) && Number.isFinite(Date.parse(value));
}

export function validateGeneration(generation: CatalogGeneration): void {
  if (
    generation === null ||
    typeof generation !== "object" ||
    generation.catalogSchemaVersion !== CATALOG_SCHEMA_VERSION ||
    typeof generation.projectorVersion !== "string" ||
    generation.projectorVersion.trim().length === 0 ||
    typeof generation.createdAt !== "string" ||
    !validCreatedAt(generation.createdAt)
  ) {
    throw new EvidenceCatalogError(
      "IO_FAILURE",
      "SQLite Evidence Catalog generation metadata is invalid.",
    );
  }
}

export function createSchema(
  database: Database.Database,
  generation: CatalogGeneration,
): void {
  validateGeneration(generation);
  try {
    const transaction = database.transaction(() => {
      database.exec(SCHEMA_SQL);
      database.prepare(`
        INSERT INTO catalog_metadata (
          singleton,
          sqlite_schema_version,
          catalog_schema_version,
          projector_version,
          created_at
        ) VALUES (1, ?, ?, ?, ?)
      `).run(
        SQLITE_EVIDENCE_CATALOG_SCHEMA_VERSION,
        generation.catalogSchemaVersion,
        generation.projectorVersion,
        generation.createdAt,
      );
    });
    transaction.immediate();
  } catch (error) {
    throw catalogIoError(error, "Unable to create SQLite Evidence Catalog schema.");
  }
}

export function readGeneration(database: Database.Database): CatalogGeneration {
  let row: MetadataRow | undefined;
  try {
    row = database.prepare(`
      SELECT
        sqlite_schema_version,
        catalog_schema_version,
        projector_version,
        created_at
      FROM catalog_metadata
      WHERE singleton = 1
    `).get() as MetadataRow | undefined;
  } catch (error) {
    throw catalogIoError(error, "Unable to read SQLite Evidence Catalog metadata.");
  }
  if (
    row === undefined ||
    row.sqlite_schema_version !== SQLITE_EVIDENCE_CATALOG_SCHEMA_VERSION
  ) {
    throw new EvidenceCatalogError(
      "IO_FAILURE",
      "SQLite Evidence Catalog schema version is unsupported.",
    );
  }
  const generation = {
    catalogSchemaVersion: row.catalog_schema_version,
    projectorVersion: row.projector_version,
    createdAt: row.created_at,
  } as CatalogGeneration;
  validateGeneration(generation);
  return Object.freeze({ ...generation });
}

export function quickCheck(database: Database.Database): readonly string[] {
  try {
    const rows = database.pragma("quick_check") as readonly Record<
      string,
      unknown
    >[];
    const messages = rows
      .flatMap((row) => Object.values(row))
      .filter((value): value is string => typeof value === "string")
      .filter((message) => message !== "ok");
    const foreignKeys = database.pragma("foreign_key_check") as readonly {
      readonly table?: unknown;
      readonly rowid?: unknown;
      readonly parent?: unknown;
      readonly fkid?: unknown;
    }[];
    messages.push(
      ...foreignKeys.map(
        (row) =>
          `foreign key violation: table=${String(row.table)} rowid=${String(
            row.rowid,
          )} parent=${String(row.parent)} fkid=${String(row.fkid)}`,
      ),
    );
    return messages.sort();
  } catch (error) {
    throw catalogIoError(error, "Unable to check SQLite Evidence Catalog integrity.");
  }
}
