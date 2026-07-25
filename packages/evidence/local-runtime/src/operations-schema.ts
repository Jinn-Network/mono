// SPDX-License-Identifier: MIT
import type Database from "better-sqlite3";

import { LocalEvidenceRuntimeError } from "./errors.js";

export const LOCAL_OPERATIONS_SCHEMA_VERSION = 1 as const;

const EXPECTED_COLUMNS = {
  publication_outbox: [
    "operation_key",
    "family",
    "digest",
    "record_bytes",
    "byte_size",
    "state",
    "announcement_id",
    "created_at",
    "updated_at",
  ],
  indexer_checkpoints: ["generation_id", "source_id", "cursor"],
  indexing_outcomes: [
    "generation_id",
    "source_id",
    "announcement_id",
    "family",
    "digest",
    "status",
    "failure_code",
    "failure_json",
    "journal_cursor",
    "updated_at",
  ],
  processed_cursors: [
    "generation_id",
    "source_id",
    "cursor",
    "indexed_total",
    "failed_total",
    "processed_at",
  ],
  transient_indexing_failure: [
    "generation_id",
    "failure_json",
    "updated_at",
  ],
} as const;

function validateSchema(database: Database.Database): void {
  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    const actual = (database.pragma(`table_info(${table})`) as Array<{
      name: string;
    }>).map((column) => column.name);
    if (
      actual.length !== expected.length ||
      actual.some((column, index) => column !== expected[index])
    ) {
      throw new LocalEvidenceRuntimeError(
        "RUNTIME_CORRUPT",
        `The operations database table ${table} has an incompatible schema.`,
      );
    }
  }
}

export function createLocalOperationsSchema(database: Database.Database): void {
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS publication_outbox (
      operation_key TEXT PRIMARY KEY,
      family TEXT NOT NULL,
      digest TEXT NOT NULL,
      record_bytes BLOB NOT NULL,
      byte_size INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('staged', 'stored', 'announced')),
      announcement_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS indexer_checkpoints (
      generation_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      cursor TEXT NOT NULL,
      PRIMARY KEY (generation_id, source_id)
    );
    CREATE TABLE IF NOT EXISTS indexing_outcomes (
      generation_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      announcement_id TEXT NOT NULL,
      family TEXT NOT NULL,
      digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('indexed', 'failed')),
      failure_code TEXT,
      failure_json TEXT,
      journal_cursor TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (generation_id, family, digest)
    );
    CREATE TABLE IF NOT EXISTS processed_cursors (
      generation_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      cursor TEXT NOT NULL,
      indexed_total INTEGER NOT NULL,
      failed_total INTEGER NOT NULL,
      processed_at TEXT NOT NULL,
      PRIMARY KEY (generation_id, source_id, cursor)
    );
    CREATE TABLE IF NOT EXISTS transient_indexing_failure (
      generation_id TEXT PRIMARY KEY,
      failure_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  validateSchema(database);
  const quick = database.pragma("quick_check", { simple: true });
  if (quick !== "ok") {
    throw new LocalEvidenceRuntimeError(
      "RUNTIME_CORRUPT",
      `The operations database failed quick_check: ${String(quick)}`,
    );
  }
}
