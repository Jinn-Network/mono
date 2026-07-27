// SPDX-License-Identifier: Apache-2.0
import {
  constants,
  chmod,
  lstat,
  open,
  type FileHandle,
} from "node:fs/promises";

import type {
  RepositoryOperationOptions,
} from "@jinn-network/evidence-repository";

import {
  assertPublicationOperationActive,
  EvidencePublicationError,
} from "../errors.js";

export function nodeErrorCode(error: unknown): string | undefined {
  const direct = (
      typeof error === "object" &&
      error !== null &&
      "code" in error
    )
    ? String((error as { code?: unknown }).code)
    : undefined;
  if (direct !== undefined && direct !== "IO_FAILURE") return direct;
  return (
      typeof error === "object" &&
      error !== null &&
      "cause" in error
    )
    ? nodeErrorCode((error as { cause?: unknown }).cause)
    : direct;
}

export function mapFilesystemError(error: unknown, message: string): never {
  if (error instanceof EvidencePublicationError) throw error;
  throw new EvidencePublicationError("IO_FAILURE", message, { cause: error });
}

function assertOwned(
  stats: Awaited<ReturnType<typeof lstat>>,
  role: string,
): void {
  const uid = process.platform === "win32" ? undefined : process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new EvidencePublicationError(
      "JOURNAL_CORRUPT",
      `${role} is not owned by the current user.`,
    );
  }
}

export async function inspectPrivateRegularFile(
  path: string,
  role: string,
  options?: RepositoryOperationOptions,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  assertPublicationOperationActive(options);
  const stats = await lstat(path);
  assertPublicationOperationActive(options);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new EvidencePublicationError(
      "JOURNAL_CORRUPT",
      `${role} must be a non-symlink regular file.`,
    );
  }
  assertOwned(stats, role);
  return stats;
}

export function assertManagedFileLinkCount(
  stats: Awaited<ReturnType<typeof lstat>>,
  expected: number,
  role: string,
): void {
  if (stats.nlink !== expected) {
    throw new EvidencePublicationError(
      "JOURNAL_CORRUPT",
      `${role} must have exactly ${expected} managed link${expected === 1 ? "" : "s"}.`,
    );
  }
}

export async function assertPrivateDirectory(
  path: string,
  role: string,
  options?: RepositoryOperationOptions,
): Promise<void> {
  assertPublicationOperationActive(options);
  const stats = await lstat(path);
  assertPublicationOperationActive(options);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new EvidencePublicationError(
      "JOURNAL_CORRUPT",
      `${role} must be a non-symlink directory.`,
    );
  }
  assertOwned(stats, role);
  if (process.platform !== "win32" && (stats.mode & 0o7777) !== 0o700) {
    assertPublicationOperationActive(options);
    await chmod(path, 0o700);
    assertPublicationOperationActive(options);
  }
}

export async function openPrivateRegularFile(
  path: string,
  flags: number,
  mode?: number,
  options?: RepositoryOperationOptions,
): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    assertPublicationOperationActive(options);
    handle = await open(path, flags | (constants.O_NOFOLLOW ?? 0), mode);
    assertPublicationOperationActive(options);
    const stats = await handle.stat();
    assertPublicationOperationActive(options);
    if (!stats.isFile()) {
      throw new EvidencePublicationError(
        "JOURNAL_CORRUPT",
        "A journal-managed file is not regular.",
      );
    }
    const uid = process.platform === "win32" ? undefined : process.getuid?.();
    if (uid !== undefined && stats.uid !== uid) {
      throw new EvidencePublicationError(
        "JOURNAL_CORRUPT",
        "A journal-managed file is not owned by the current user.",
      );
    }
    if (
      process.platform !== "win32" &&
      (stats.mode & 0o7777) !== 0o600
    ) {
      assertPublicationOperationActive(options);
      await handle.chmod(0o600);
      assertPublicationOperationActive(options);
    }
    return handle;
  } catch (error) {
    let closeFailure: unknown;
    try {
      await handle?.close();
    } catch (cleanupError) {
      closeFailure = cleanupError;
    }
    if (closeFailure !== undefined) {
      throw new EvidencePublicationError(
        "IO_FAILURE",
        "A journal file could not be closed after safe-open validation failed.",
        {
          cause: new AggregateError(
            [error, closeFailure],
            "Journal file validation and cleanup both failed.",
          ),
        },
      );
    }
    if (error instanceof EvidencePublicationError) throw error;
    return mapFilesystemError(error, "Failed to open a journal file safely.");
  }
}

export async function syncDirectory(
  path: string,
  options?: RepositoryOperationOptions,
): Promise<void> {
  assertPublicationOperationActive(options);
  if (process.platform === "win32") {
    assertPublicationOperationActive(options);
    return;
  }
  let handle: FileHandle | undefined;
  let failure: unknown;
  try {
    assertPublicationOperationActive(options);
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    );
    assertPublicationOperationActive(options);
    await handle.sync();
    assertPublicationOperationActive(options);
  } catch (error) {
    failure = error;
  }
  try {
    if (handle !== undefined) {
      try {
        assertPublicationOperationActive(options);
      } catch (error) {
        failure ??= error;
      }
      await handle.close();
      if (failure === undefined) {
        assertPublicationOperationActive(options);
      }
    }
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    if (failure instanceof EvidencePublicationError) throw failure;
    return mapFilesystemError(
      failure,
      "Failed to synchronize a publication journal directory.",
    );
  }
}
