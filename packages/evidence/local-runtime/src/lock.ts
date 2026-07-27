// SPDX-License-Identifier: MIT
import Database from "better-sqlite3";
import { setTimeout as delay } from "node:timers/promises";

import {
  LocalEvidenceRuntimeError,
  localRuntimeIoError,
} from "./errors.js";
import {
  preparePrivateDatabaseFile,
  verifyPrivateDatabaseFile,
} from "./paths.js";

export interface LocalRuntimeLock {
  close(): Promise<void>;
}

function sqliteCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

const LOCK_RELEASE_RETRY_DELAYS_MS = [10, 25, 50] as const;

async function acquireRuntimeLockAttempt(
  path: string,
  attempt: number,
): Promise<LocalRuntimeLock> {
  let database: Database.Database | undefined;
  const prepared = await preparePrivateDatabaseFile(path);
  try {
    database = new Database(path, { timeout: 0 });
    await verifyPrivateDatabaseFile(path, prepared);
    await prepared.handle.close();
    database.pragma("busy_timeout = 0");
    database.pragma("locking_mode = EXCLUSIVE");
    database.exec(`
      CREATE TABLE IF NOT EXISTS runtime_lock_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        format TEXT NOT NULL
      );
      INSERT INTO runtime_lock_metadata(singleton, format)
        VALUES (1, 'jinn-local-evidence-runtime-lock')
        ON CONFLICT(singleton) DO NOTHING;
      BEGIN EXCLUSIVE;
      UPDATE runtime_lock_metadata SET format = format WHERE singleton = 1;
    `);
    let closed = false;
    return {
      async close() {
        if (closed) return;
        closed = true;
        try {
          database?.exec("ROLLBACK");
        } finally {
          database?.close();
          database = undefined;
        }
      },
    };
  } catch (error) {
    try {
      await prepared.handle.close();
    } catch {
      // Preserve the acquisition failure.
    }
    try {
      database?.close();
    } catch {
      // Preserve the acquisition failure.
    }
    if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(sqliteCode(error) ?? "")) {
      const retryDelay = LOCK_RELEASE_RETRY_DELAYS_MS[attempt];
      if (retryDelay !== undefined) {
        await delay(retryDelay);
        return acquireRuntimeLockAttempt(path, attempt + 1);
      }
      throw new LocalEvidenceRuntimeError(
        "ROOT_IN_USE",
        "The local evidence runtime root is already in use.",
        { cause: error },
      );
    }
    throw localRuntimeIoError(error, "Unable to acquire the runtime root lock.");
  }
}

export async function acquireRuntimeLock(path: string): Promise<LocalRuntimeLock> {
  return acquireRuntimeLockAttempt(path, 0);
}
