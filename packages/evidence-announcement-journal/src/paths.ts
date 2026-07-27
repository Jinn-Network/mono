// SPDX-License-Identifier: MIT
import {
  constants,
  chmod,
  lstat,
  mkdir,
  open,
  type FileHandle,
} from "node:fs/promises";
import { parse, relative, resolve, sep } from "node:path";

import { EvidenceAnnouncementJournalError } from "./errors.js";

export interface JournalPaths {
  readonly rootDir: string;
  readonly markerPath: string;
  readonly eventsDir: string;
}

function journalError(message: string, cause?: unknown): EvidenceAnnouncementJournalError {
  return new EvidenceAnnouncementJournalError(
    "JOURNAL_CORRUPT",
    message,
    cause === undefined ? undefined : { cause },
  );
}

export function mapIoError(error: unknown, message: string): never {
  if (error instanceof EvidenceAnnouncementJournalError) throw error;
  throw new EvidenceAnnouncementJournalError("IO_FAILURE", message, {
    cause: error,
  });
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function assertContained(rootDir: string, candidate: string): void {
  const path = relative(rootDir, candidate);
  if (
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    parse(path).root.length > 0
  ) {
    throw journalError("A journal-managed path escapes its root.");
  }
}

async function rejectExistingSymlinkComponents(path: string): Promise<void> {
  const parsed = parse(path);
  const components = path.slice(parsed.root.length).split(sep).filter(Boolean);
  let current = parsed.root;
  for (const component of components) {
    current = resolve(current, component);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw journalError("A journal-managed path contains a symbolic link.");
      }
    } catch (error) {
      if (isMissing(error)) return;
      if (error instanceof EvidenceAnnouncementJournalError) throw error;
      mapIoError(error, "Failed to inspect a journal path.");
    }
  }
}

function assertOwned(stats: Awaited<ReturnType<typeof lstat>>, role: string): void {
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    stats.uid !== process.getuid()
  ) {
    throw journalError(`${role} is not owned by the current user.`);
  }
}

export async function assertManagedDirectory(
  path: string,
  role: string,
): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw journalError(`${role} must be a non-symlink directory.`);
  }
  assertOwned(stats, role);
  if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o700) {
    await chmod(path, 0o700);
  }
}

export async function assertManagedRegularFile(
  path: string,
  role: string,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw journalError(`${role} must be a non-symlink regular file.`);
  }
  assertOwned(stats, role);
  if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600) {
    await chmod(path, 0o600);
  }
  return stats;
}

export async function prepareJournalPaths(rootDirInput: string): Promise<JournalPaths> {
  if (typeof rootDirInput !== "string" || rootDirInput.trim().length === 0) {
    throw journalError("The journal root must be a non-empty path.");
  }
  const rootDir = resolve(rootDirInput);
  if (rootDir === parse(rootDir).root) {
    throw journalError("The filesystem root cannot be used as a journal root.");
  }
  await rejectExistingSymlinkComponents(rootDir);
  try {
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    await assertManagedDirectory(rootDir, "Journal root");
    const markerPath = resolve(rootDir, "journal.json");
    const eventsDir = resolve(rootDir, "events");
    assertContained(rootDir, markerPath);
    assertContained(rootDir, eventsDir);
    await rejectExistingSymlinkComponents(eventsDir);
    try {
      await mkdir(eventsDir, { mode: 0o700 });
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as { code?: unknown }).code !== "EEXIST"
      ) {
        throw error;
      }
    }
    await assertManagedDirectory(eventsDir, "Journal events directory");
    return { rootDir, markerPath, eventsDir };
  } catch (error) {
    if (error instanceof EvidenceAnnouncementJournalError) throw error;
    return mapIoError(error, "Failed to prepare the announcement journal root.");
  }
}

export async function openRegularNoFollow(
  path: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  try {
    const handle = await open(path, flags | constants.O_NOFOLLOW, mode);
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      throw journalError("A journal-managed file is not regular.");
    }
    assertOwned(stats, "Journal-managed file");
    return handle;
  } catch (error) {
    if (error instanceof EvidenceAnnouncementJournalError) throw error;
    return mapIoError(error, "Failed to open a journal-managed file.");
  }
}

export async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_DIRECTORY),
    );
    await handle.sync();
  } catch (error) {
    return mapIoError(error, "Failed to synchronize a journal directory.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
