// SPDX-License-Identifier: Apache-2.0
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { INDEX_SCHEMA_SQL, INDEX_SCHEMA_VERSION, INDEX_TOKENIZER } from "./schema.js";

export type RelevanceIndexErrorCode = "FTS5_UNAVAILABLE" | "INDEX_IO";

export class RelevanceIndexError extends Error {
  constructor(
    readonly code: RelevanceIndexErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "RelevanceIndexError";
  }
}

/**
 * Narrow filesystem port for index open/rebuild. Injected from the composition root or
 * tests so library code stays free of `node:fs*` (C3 AST custody, C6-P3).
 */
export interface IndexDatabaseIO {
  ensureOwnerOnlyDirectory(path: string): Promise<void>;
  ensureOwnerOnlyFile(path: string): Promise<void>;
  removeFile(path: string): Promise<void>;
}

export interface OpenIndexDatabaseOptions {
  readonly databasePath: string;
  readonly io: IndexDatabaseIO;
  /** Injected so index writes are reproducible under test. */
  readonly now?: () => string;
}

export interface OpenedIndexDatabase {
  readonly database: Database.Database;
  readonly databasePath: string;
  /** True when this open created the schema — the caller should repopulate. */
  readonly rebuiltFromScratch: boolean;
}

function assertFts5(database: Database.Database): void {
  try {
    database.exec("CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x)");
    database.exec("DROP TABLE temp.fts5_probe");
  } catch (cause) {
    throw new RelevanceIndexError(
      "FTS5_UNAVAILABLE",
      "This SQLite build has no FTS5 module, so corpus relevance cannot be indexed.",
      { cause },
    );
  }
}

function currentGeneration(
  database: Database.Database,
): { schemaVersion: number; tokenizer: string } | undefined {
  const table = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'index_metadata'")
    .get();
  if (table === undefined) return undefined;
  const row = database
    .prepare("SELECT schema_version AS schemaVersion, tokenizer FROM index_metadata WHERE singleton = 1")
    .get() as { schemaVersion: number; tokenizer: string } | undefined;
  return row;
}

/**
 * Opens (creating if absent) the relevance index. The index is a derived cache over the
 * archive and the mirror: it is never announced, never sealed, and never a source of
 * truth. A schema-version or tokenizer mismatch therefore drops and recreates rather than
 * migrating — the caller repopulates from the planes.
 */
export async function openIndexDatabase(
  options: OpenIndexDatabaseOptions,
): Promise<OpenedIndexDatabase> {
  const now = options.now ?? (() => new Date().toISOString());
  try {
    await options.io.ensureOwnerOnlyDirectory(dirname(options.databasePath));
  } catch (cause) {
    throw new RelevanceIndexError("INDEX_IO", "Could not create the index directory.", { cause });
  }

  let database: Database.Database;
  try {
    database = new Database(options.databasePath);
  } catch (cause) {
    throw new RelevanceIndexError("INDEX_IO", "Could not open the relevance index.", { cause });
  }

  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("busy_timeout = 5000");
  database.pragma("trusted_schema = OFF");
  database.pragma("foreign_keys = ON");
  assertFts5(database);

  const generation = currentGeneration(database);
  const stale =
    generation !== undefined &&
    (generation.schemaVersion !== INDEX_SCHEMA_VERSION || generation.tokenizer !== INDEX_TOKENIZER);

  if (stale) {
    database.close();
    for (const path of [
      options.databasePath,
      `${options.databasePath}-wal`,
      `${options.databasePath}-shm`,
    ]) {
      await options.io.removeFile(path).catch(() => undefined);
    }
    return openIndexDatabase(options);
  }

  const rebuiltFromScratch = generation === undefined;
  if (rebuiltFromScratch) {
    database.exec(INDEX_SCHEMA_SQL);
    database
      .prepare(
        `INSERT INTO index_metadata(
           singleton, schema_version, tokenizer, created_at, last_indexed_at, excluded_by_trust
         ) VALUES (1, ?, ?, ?, NULL, 0)`,
      )
      .run(INDEX_SCHEMA_VERSION, INDEX_TOKENIZER, now());
  }

  for (const path of [
    options.databasePath,
    `${options.databasePath}-wal`,
    `${options.databasePath}-shm`,
  ]) {
    await options.io.ensureOwnerOnlyFile(path).catch(() => undefined);
  }

  return { database, databasePath: options.databasePath, rebuiltFromScratch };
}
