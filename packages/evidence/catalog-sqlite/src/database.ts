// SPDX-License-Identifier: MIT
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, parse, relative, resolve, sep } from "node:path";

import Database from "better-sqlite3";

import { EvidenceCatalogError } from "@jinn-network/evidence-discovery";

import { catalogIoError } from "./errors.js";

export interface OpenedCatalogDatabase {
  readonly database: Database.Database;
  readonly databasePath: string;
  readonly created: boolean;
}

function nodeErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function isFilesystemRootChild(path: string): boolean {
  const absolute = resolve(path);
  return dirname(absolute) === parse(absolute).root;
}

async function rejectNonPlatformAncestorSymlinks(path: string): Promise<void> {
  const parsed = parse(path);
  const relativePath = path.slice(parsed.root.length);
  const segments = relativePath.split(/[\\/]/u).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() && !isFilesystemRootChild(current)) {
        throw catalogIoError(
          undefined,
          `SQLite Catalog parent path must be a non-symlink directory: ${current}`,
        );
      }
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return;
      throw error;
    }
  }
}

async function canonicalizeConfiguredPath(path: string): Promise<string> {
  const lexicalPath = resolve(path);
  let unmanagedAncestor = dirname(lexicalPath);
  for (;;) {
    try {
      await lstat(unmanagedAncestor);
      break;
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
      const parent = dirname(unmanagedAncestor);
      if (parent === unmanagedAncestor) {
        throw catalogIoError(
          error,
          "No existing SQLite Catalog ancestor could be resolved.",
        );
      }
      unmanagedAncestor = parent;
    }
  }
  await rejectNonPlatformAncestorSymlinks(unmanagedAncestor);
  let physicalAncestor: string;
  try {
    physicalAncestor = await realpath(unmanagedAncestor);
    const stats = await lstat(physicalAncestor);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw catalogIoError(
        undefined,
        `SQLite Catalog ancestor must resolve to a directory: ${physicalAncestor}`,
      );
    }
  } catch (error) {
    if (error instanceof EvidenceCatalogError) throw error;
    throw catalogIoError(
      error,
      "Failed to resolve the SQLite Catalog ancestor.",
    );
  }
  const suffix = relative(unmanagedAncestor, lexicalPath);
  if (
    suffix === ".." ||
    suffix.startsWith(`..${sep}`) ||
    parse(suffix).root.length > 0
  ) {
    throw catalogIoError(
      undefined,
      "The SQLite Catalog path escapes its resolved ancestor.",
    );
  }
  return resolve(physicalAncestor, suffix);
}

async function ensureSafeParentChain(parentPath: string): Promise<void> {
  const parsed = parse(parentPath);
  const relativePath = parentPath.slice(parsed.root.length);
  const segments = relativePath.split(/[\\/]/u).filter(Boolean);
  let current = parsed.root;

  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw catalogIoError(
          undefined,
          `SQLite Catalog parent path must be a non-symlink directory: ${current}`,
        );
      }
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      if (process.platform !== "win32") await chmod(current, 0o700);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw catalogIoError(
          undefined,
          `SQLite Catalog parent path changed while creating it: ${current}`,
        );
      }
    }
  }
}

async function assertSafeExistingDatabase(path: string): Promise<void> {
  const pathStat = await lstat(path);
  const currentUid = process.getuid?.();
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    pathStat.nlink !== 1 ||
    (currentUid !== undefined && pathStat.uid !== currentUid)
  ) {
    throw catalogIoError(
      undefined,
      `SQLite Catalog database must be an owned, single-link regular file: ${path}`,
    );
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const handleStat = await handle.stat();
    if (
      !handleStat.isFile() ||
      handleStat.nlink !== 1 ||
      (currentUid !== undefined && handleStat.uid !== currentUid) ||
      handleStat.dev !== pathStat.dev ||
      handleStat.ino !== pathStat.ino
    ) {
      throw catalogIoError(
        undefined,
        `SQLite Catalog database path changed while opening it: ${path}`,
      );
    }
  } finally {
    await handle.close();
  }
}

async function assertSafeExistingSidecars(path: string): Promise<void> {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      await assertSafeExistingDatabase(`${path}${suffix}`);
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
    }
  }
}

async function reserveNewDatabase(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_RDWR |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    if (process.platform !== "win32") await handle.chmod(0o600);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw catalogIoError(
        undefined,
        `SQLite Catalog database is not a regular file: ${path}`,
      );
    }
  } finally {
    await handle.close();
  }
}

function applyRequiredPragmas(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  const journalMode = database.pragma("journal_mode = WAL", {
    simple: true,
  });
  if (String(journalMode).toLowerCase() !== "wal") {
    throw new Error("SQLite refused WAL journal mode.");
  }
  database.pragma("synchronous = FULL");
  database.pragma("busy_timeout = 5000");
  database.pragma("trusted_schema = OFF");
}

export async function openCatalogDatabase(
  path: string,
  createNew: boolean,
): Promise<OpenedCatalogDatabase> {
  const databasePath = await canonicalizeConfiguredPath(path);
  let database: Database.Database | undefined;
  let created = false;
  try {
    await ensureSafeParentChain(dirname(databasePath));
    if (createNew) {
      await reserveNewDatabase(databasePath);
      created = true;
    } else {
      await assertSafeExistingDatabase(databasePath);
    }
    await assertSafeExistingDatabase(databasePath);
    await assertSafeExistingSidecars(databasePath);
    database = new Database(databasePath, {
      fileMustExist: true,
      timeout: 5_000,
    });
    await assertSafeExistingDatabase(databasePath);
    await assertSafeExistingSidecars(databasePath);
    applyRequiredPragmas(database);
    await assertSafeExistingDatabase(databasePath);
    await assertSafeExistingSidecars(databasePath);
    return { database, databasePath, created };
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the primary opening failure.
    }
    if (created) {
      await unlink(databasePath).catch(() => undefined);
    }
    throw catalogIoError(error, `Unable to open SQLite Evidence Catalog: ${databasePath}`);
  }
}
