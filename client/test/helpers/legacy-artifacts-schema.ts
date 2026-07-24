import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Creates a fresh SQLite file at a temp path with the pre-Task-native-IDs
 * (#406) `artifacts` schema, where `desired_state_id` is `TEXT NOT NULL`.
 * `Store`'s startup migration (`ensureArtifactsTaskColumns`) detects this
 * legacy column and `insertArtifact` mirrors `task_id` into it (#511) —
 * tests exercising that path, or guarding its regression (#506), open a
 * `Store` against the path this returns.
 *
 * Does not open a `Store` itself and does not create the caller's temp
 * directory — only the DB file's schema. Callers are responsible for
 * cleaning up the returned directory.
 */
export function createLegacyArtifactsSchemaDb(dirPrefix: string): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), dirPrefix));
  const dbPath = join(dir, 'jinn.db');
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      desired_state_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE', 'UNKNOWN')),
      remote INTEGER NOT NULL DEFAULT 0,
      owner_address TEXT,
      endpoint TEXT,
      price TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  legacy.close();
  return { dir, dbPath };
}
