// SPDX-License-Identifier: MIT

// The one durable state file every venue adapter shares. Its location is a host parameter
// (`BaseVenueConfig.stateDbPath`) -- this package never derives a path from the environment or
// a home directory. WAL + synchronous=FULL matches the stack's SQLite precedent
// (`packages/evidence/catalog-sqlite/src/database.ts`).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL, VENUE_STATE_SCHEMA_VERSION } from "./schema.js";

export { VENUE_STATE_SCHEMA_VERSION };

export class VenueStateError extends Error {
  override readonly name = "VenueStateError";
}

export interface VenueStateDatabase {
  readonly db: Database.Database;
  transaction<T>(fn: () => T): T;
  close(): void;
}

function applyPragmas(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  const journalMode = db.pragma("journal_mode = WAL", { simple: true });
  if (journalMode !== "wal") {
    throw new VenueStateError(`venue state requires WAL journaling; SQLite reported "${String(journalMode)}"`);
  }
  db.pragma("synchronous = FULL");
  db.pragma("busy_timeout = 5000");
  db.pragma("trusted_schema = OFF");
}

function readSchemaVersion(db: Database.Database): number | undefined {
  const present = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'venue_state_metadata'",
  ).get();
  if (present === undefined) return undefined;
  const row = db.prepare(
    "SELECT schema_version AS version FROM venue_state_metadata WHERE singleton = 1",
  ).get() as { version: number } | undefined;
  return row?.version;
}

/** Opens (creating if absent) the venue state file. Idempotent; safe to call on every boot. */
export function openVenueState(stateDbPath: string): VenueStateDatabase {
  mkdirSync(dirname(stateDbPath), { recursive: true });
  const db = new Database(stateDbPath);
  try {
    applyPragmas(db);
    const version = readSchemaVersion(db);
    if (version === undefined) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(SCHEMA_SQL);
        db.prepare(
          "INSERT INTO venue_state_metadata (singleton, schema_version, created_at_ms) VALUES (1, ?, ?)",
        ).run(VENUE_STATE_SCHEMA_VERSION, Date.now());
        db.exec("COMMIT");
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
    } else if (version !== VENUE_STATE_SCHEMA_VERSION) {
      throw new VenueStateError(
        `venue state at ${stateDbPath} declares schema version ${version}; this build understands `
        + `${VENUE_STATE_SCHEMA_VERSION}. Refusing to read or migrate it.`,
      );
    }
  } catch (cause) {
    db.close();
    throw cause;
  }

  return {
    db,
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
    close() {
      db.close();
    },
  };
}
