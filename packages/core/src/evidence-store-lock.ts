import { constants, closeSync, fchmodSync, fsyncSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  inspectRegularPath,
  nodeErrorCode,
  prepareEvidenceDirectory,
  secureRegularPath,
  type FileIdentity,
} from './evidence-filesystem.js';

const LOCK_FILE = '.jinn-evidence-store-lock.sqlite';
const LOCK_APPLICATION_ID = 0x4a4c4f43;
const LOCK_SCHEMA_VERSION = '1';
const LOCK_BUSY_TIMEOUT_MS = 30_000;

interface StoreLock {
  db: Database.Database;
  path: string;
  identity: FileIdentity;
}

const asyncTails = new Map<string, Promise<void>>();

function prepareLockFile(episodesDir: string): { path: string; identity: FileIdentity } {
  const directory = resolve(episodesDir);
  prepareEvidenceDirectory(directory, 'evidence store', false);
  const path = join(directory, LOCK_FILE);
  let identity = inspectRegularPath(path, 'evidence store lock');
  if (!identity) {
    let fd: number | undefined;
    try {
      fd = openSync(
        path,
        constants.O_RDWR
          | constants.O_CREAT
          | constants.O_EXCL
          | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      if (process.platform !== 'win32') fchmodSync(fd, 0o600);
      fsyncSync(fd);
    } catch (error) {
      if (nodeErrorCode(error) !== 'EEXIST') throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    identity = inspectRegularPath(path, 'evidence store lock');
  }
  if (!identity) throw new Error(`evidence store lock disappeared: ${path}`);
  return { path, identity };
}

function openStoreLock(episodesDir: string): StoreLock {
  const prepared = prepareLockFile(episodesDir);
  const db = new Database(prepared.path);
  try {
    db.pragma(`busy_timeout = ${LOCK_BUSY_TIMEOUT_MS}`);
    db.exec('BEGIN IMMEDIATE');
    try {
      const applicationId = Number(db.pragma('application_id', { simple: true }));
      const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name ASC
      `).all() as Array<{ name: string }>;
      if (applicationId === 0 && tables.length === 0) {
        db.pragma(`application_id = ${LOCK_APPLICATION_ID}`);
        db.exec(`
          CREATE TABLE evidence_store_lock_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          INSERT INTO evidence_store_lock_meta(key, value)
          VALUES ('schema_version', '${LOCK_SCHEMA_VERSION}');
        `);
      } else {
        if (applicationId !== LOCK_APPLICATION_ID) {
          throw new Error(`refusing file that is not a Jinn evidence store lock: ${prepared.path}`);
        }
        if (JSON.stringify(tables.map((row) => row.name)) !== JSON.stringify([
          'evidence_store_lock_meta',
        ])) {
          throw new Error(`refusing evidence store lock with an unexpected schema: ${prepared.path}`);
        }
        const version = db.prepare(
          "SELECT value FROM evidence_store_lock_meta WHERE key = 'schema_version'",
        ).get() as { value?: unknown } | undefined;
        if (version?.value !== LOCK_SCHEMA_VERSION) {
          throw new Error(`unsupported Jinn evidence store lock schema: ${String(version?.value)}`);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw error;
    }
    secureRegularPath(prepared.path, 'evidence store lock', prepared.identity);
    return { db, path: prepared.path, identity: prepared.identity };
  } catch (error) {
    db.close();
    throw error;
  }
}

function closeStoreLock(lock: StoreLock): void {
  let failure: unknown;
  try {
    lock.db.close();
  } catch (error) {
    failure = error;
  }
  try {
    secureRegularPath(lock.path, 'evidence store lock', lock.identity);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

function beginStoreLock(lock: StoreLock): void {
  lock.db.exec('BEGIN IMMEDIATE');
}

function finishStoreLock(lock: StoreLock, commit: boolean): void {
  if (lock.db.inTransaction) lock.db.exec(commit ? 'COMMIT' : 'ROLLBACK');
}

export function withEvidenceStoreLockSync<T>(
  episodesDir: string,
  operation: () => T,
): T {
  const lock = openStoreLock(episodesDir);
  try {
    beginStoreLock(lock);
    try {
      const result = operation();
      finishStoreLock(lock, true);
      return result;
    } catch (error) {
      finishStoreLock(lock, false);
      throw error;
    }
  } finally {
    closeStoreLock(lock);
  }
}

export async function withEvidenceStoreLock<T>(
  episodesDir: string,
  operation: () => Promise<T>,
  afterUnlock?: (result: T) => Promise<void>,
): Promise<T> {
  const key = resolve(episodesDir);
  const previous = asyncTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolveTurn) => {
    release = resolveTurn;
  });
  const tail = previous.catch(() => undefined).then(() => turn);
  asyncTails.set(key, tail);
  await previous.catch(() => undefined);

  try {
    let result: T;
    const lock = openStoreLock(episodesDir);
    try {
      beginStoreLock(lock);
      try {
        result = await operation();
        finishStoreLock(lock, true);
      } catch (error) {
        finishStoreLock(lock, false);
        throw error;
      }
    } finally {
      closeStoreLock(lock);
    }
    await afterUnlock?.(result);
    return result;
  } finally {
    release();
    if (asyncTails.get(key) === tail) asyncTails.delete(key);
  }
}
