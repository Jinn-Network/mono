// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { CORPUS_ERROR_CODES, CorpusMirrorError, nodeErrorCode } from "./errors.js";

export const CORPUS_SYNC_LOCK_FORMAT = "jinn-corpus-mirror-sync-lock" as const;

export interface CorpusSyncLock {
  close(): Promise<void>;
}

function sqliteCode(error: unknown): string | undefined {
  return nodeErrorCode(error);
}

async function ensureLockFile(path: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.close();
  } catch (error) {
    if (nodeErrorCode(error) === "EEXIST") return;
    throw new CorpusMirrorError(
      CORPUS_ERROR_CODES.syncLockIo,
      `Unable to prepare the mirror sync lock at ${path}.`,
      { cause: error },
    );
  }
}

/**
 * Acquires the exclusive advisory lock guarding mirror sync, or returns
 * `undefined` when another instance already holds it (cross-plan contract 5).
 *
 * SKIP-IF-HELD, deliberately: the stack's precedent
 * (`packages/evidence/local-runtime/src/lock.ts`) retries three times and
 * then throws `ROOT_IN_USE`, because a local runtime that cannot open its
 * root has failed. A mirror sync that cannot take the lock has NOT failed —
 * a peer instance is already doing exactly this work — so waiting would
 * convert concurrency into latency for no benefit. `busy_timeout = 0` makes
 * SQLite report contention immediately rather than blocking.
 *
 * SQLite's unix VFS shares lock state across connections within one process,
 * so two instances in one process contend exactly as two processes do.
 */
export async function tryAcquireSyncLock(path: string): Promise<CorpusSyncLock | undefined> {
  await ensureLockFile(path);

  let database: Database.Database | undefined;
  try {
    database = new Database(path, { fileMustExist: true, timeout: 0 });
    database.pragma("busy_timeout = 0");
    database.pragma("locking_mode = EXCLUSIVE");
    database.exec(
      "CREATE TABLE IF NOT EXISTS corpus_sync_lock (" +
        "singleton INTEGER PRIMARY KEY CHECK (singleton = 1), format TEXT NOT NULL)",
    );
    database
      .prepare(
        "INSERT INTO corpus_sync_lock(singleton, format) VALUES (1, ?) " +
          "ON CONFLICT(singleton) DO NOTHING",
      )
      .run(CORPUS_SYNC_LOCK_FORMAT);
    database.exec("BEGIN EXCLUSIVE");
    database.prepare("UPDATE corpus_sync_lock SET format = format WHERE singleton = 1").run();

    let closed = false;
    return {
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        try {
          database?.exec("ROLLBACK");
        } catch {
          // The lock is released by closing the connection regardless.
        } finally {
          database?.close();
          database = undefined;
        }
      },
    };
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the acquisition failure.
    }
    if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(sqliteCode(error) ?? "")) return undefined;
    throw new CorpusMirrorError(
      CORPUS_ERROR_CODES.syncLockIo,
      `Unable to acquire the mirror sync lock at ${path}.`,
      { cause: error },
    );
  }
}
