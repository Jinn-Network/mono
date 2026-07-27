// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import {
  constants,
  link,
  lstat,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";

import {
  parseSha256Digest,
  type RepositoryOperationOptions,
  type Sha256Digest,
} from "@jinn-network/evidence-repository";

import {
  assertPublicationOperationActive,
  EvidencePublicationError,
} from "../errors.js";
import {
  cloneVersionedPublicationJournalEntry,
  decodeVersionedPublicationJournalEntry,
  encodeVersionedPublicationJournalEntry,
  measureVersionedPublicationJournalEntryBytes,
  snapshotInitialPublicationJournalEntry,
  validateJournalTransition,
} from "../journal.js";
import type {
  PublicationJournalEntry,
  PublicationJournalStore,
  VersionedPublicationJournalEntry,
} from "../types.js";
import {
  assertFilesystemPublicationJournalInfrastructure,
  bundleRevisionDirectory,
  bundleRevisionDirectoryHierarchy,
  prepareBundleRevisionDirectory,
  type FilesystemPublicationJournalPaths,
} from "./paths.js";
import {
  assertManagedFileLinkCount,
  assertPrivateDirectory,
  inspectPrivateRegularFile,
  mapFilesystemError,
  nodeErrorCode,
  openPrivateRegularFile,
  syncDirectory,
} from "./validation.js";

const FINAL_REVISION_PATTERN = /^[0-9]{20}\.json$/u;
const TEMPORARY_REVISION_PATTERN =
  /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;
const ACTIVE_REVISION_PATTERN =
  /^\.writing-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;

export const FILESYSTEM_PUBLICATION_JOURNAL_MAX_REVISION_BYTES =
  8 * 1024 * 1024;

function revisionName(revision: number): string {
  return `${String(revision).padStart(20, "0")}.json`;
}

function assertRevisionFitsFilesystemProfile(
  entry: VersionedPublicationJournalEntry,
): void {
  if (
    measureVersionedPublicationJournalEntryBytes(
      entry,
      FILESYSTEM_PUBLICATION_JOURNAL_MAX_REVISION_BYTES,
    ) > FILESYSTEM_PUBLICATION_JOURNAL_MAX_REVISION_BYTES
  ) {
    throw new EvidencePublicationError(
      "JOURNAL_CORRUPT",
      "The publication revision exceeds the filesystem journal profile.",
    );
  }
}

function sameEntry(
  left: VersionedPublicationJournalEntry,
  right: VersionedPublicationJournalEntry,
): boolean {
  const leftBytes = encodeVersionedPublicationJournalEntry(left);
  const rightBytes = encodeVersionedPublicationJournalEntry(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    leftBytes.every((value, index) => value === rightBytes[index])
  );
}

async function validateRepairablePrivateFile(
  path: string,
  options?: RepositoryOperationOptions,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof openPrivateRegularFile>> | undefined;
  let failure: unknown;
  try {
    handle = await openPrivateRegularFile(
      path,
      constants.O_RDONLY,
      undefined,
      options,
    );
    assertPublicationOperationActive(options);
  } catch (error) {
    failure = error;
  }
  try {
    await handle?.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    if (failure instanceof EvidencePublicationError) throw failure;
    return mapFilesystemError(
      failure,
      "Failed to validate a recoverable publication revision link.",
    );
  }
  assertPublicationOperationActive(options);
}

async function validateRecognizedManagedFile(
  path: string,
  role: string,
  options?: RepositoryOperationOptions,
): Promise<boolean> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await inspectPrivateRegularFile(path, role, options);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    if (error instanceof EvidencePublicationError) throw error;
    return mapFilesystemError(
      error,
      `Failed to inspect ${role}.`,
    );
  }
  assertManagedFileLinkCount(stats, 1, role);
  try {
    await validateRepairablePrivateFile(path, options);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
  return true;
}

async function finishLinkedTemporaryPublication(
  revisionDir: string,
  temporaryPath: string,
  options?: RepositoryOperationOptions,
): Promise<void> {
  let failure: unknown;
  try {
    await syncDirectory(revisionDir);
  } catch (error) {
    failure = error;
  }
  if (failure === undefined) {
    try {
      await rm(temporaryPath);
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") failure = error;
    }
    try {
      await syncDirectory(revisionDir);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) {
    if (failure instanceof EvidencePublicationError) throw failure;
    return mapFilesystemError(
      failure,
      "The publication revision was linked but durability work failed.",
    );
  }
  assertPublicationOperationActive(options);
}

async function repairRecognizedTemporaryLink(
  revisionDir: string,
  finalName: string,
  temporaryNames: readonly string[],
  options?: RepositoryOperationOptions,
): Promise<void> {
  if (temporaryNames.length === 0) return;
  if (temporaryNames.length !== 1) {
    throw new EvidencePublicationError(
      "JOURNAL_CORRUPT",
      "A replayable publication revision has excess temporary links.",
    );
  }
  const finalPath = join(revisionDir, finalName);
  const temporaryPath = join(revisionDir, temporaryNames[0]!);
  let finalStats: Awaited<ReturnType<typeof lstat>>;
  let temporaryStats: Awaited<ReturnType<typeof lstat>>;
  try {
    assertPublicationOperationActive(options);
    finalStats = await lstat(finalPath);
    assertPublicationOperationActive(options);
    temporaryStats = await lstat(temporaryPath);
    assertPublicationOperationActive(options);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return;
    if (error instanceof EvidencePublicationError) throw error;
    return mapFilesystemError(
      error,
      "Failed to inspect a recoverable publication revision link.",
    );
  }
  const uid = process.platform === "win32"
    ? undefined
    : process.getuid?.();
  if (
    finalStats.isSymbolicLink() ||
    temporaryStats.isSymbolicLink() ||
    !finalStats.isFile() ||
    !temporaryStats.isFile() ||
    (uid !== undefined &&
      (finalStats.uid !== uid || temporaryStats.uid !== uid)) ||
    finalStats.dev !== temporaryStats.dev ||
    finalStats.ino !== temporaryStats.ino ||
    finalStats.nlink !== 2 ||
    temporaryStats.nlink !== 2
  ) {
    throw new EvidencePublicationError(
      "JOURNAL_CORRUPT",
      "A recognized publication temporary file is not a repairable hard link.",
    );
  }
  try {
    await validateRepairablePrivateFile(finalPath, options);
    await validateRepairablePrivateFile(temporaryPath, options);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return;
    throw error;
  }
  await finishLinkedTemporaryPublication(
    revisionDir,
    temporaryPath,
    options,
  );
}

async function readRevision(
  path: string,
  options?: RepositoryOperationOptions,
): Promise<VersionedPublicationJournalEntry> {
  assertPublicationOperationActive(options);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await inspectPrivateRegularFile(
      path,
      "A publication revision",
      options,
    );
    assertManagedFileLinkCount(stats, 1, "A publication revision");
  } catch (error) {
    if (error instanceof EvidencePublicationError) throw error;
    return mapFilesystemError(
      error,
      "Failed to inspect a publication revision.",
    );
  }
  const handle = await openPrivateRegularFile(
    path,
    constants.O_RDONLY,
    undefined,
    options,
  );
  let decoded: VersionedPublicationJournalEntry | undefined;
  let failure: unknown;
  try {
    assertPublicationOperationActive(options);
    const handleStats = await handle.stat();
    assertPublicationOperationActive(options);
    if (
      !Number.isSafeInteger(handleStats.size) ||
      handleStats.size < 0 ||
      handleStats.size >
        FILESYSTEM_PUBLICATION_JOURNAL_MAX_REVISION_BYTES
    ) {
      throw new EvidencePublicationError(
        "JOURNAL_CORRUPT",
        "A publication revision exceeds the filesystem journal profile.",
      );
    }
    const bytes = new Uint8Array(handleStats.size + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        bytesRead,
        bytes.byteLength - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
      assertPublicationOperationActive(options);
    }
    if (
      bytesRead !== handleStats.size ||
      bytesRead >
        FILESYSTEM_PUBLICATION_JOURNAL_MAX_REVISION_BYTES
    ) {
      throw new EvidencePublicationError(
        "JOURNAL_CORRUPT",
        "A publication revision changed while it was being read.",
      );
    }
    assertPublicationOperationActive(options);
    decoded = decodeVersionedPublicationJournalEntry(
      bytes.subarray(0, bytesRead),
    );
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    if (failure instanceof EvidencePublicationError) throw failure;
    return mapFilesystemError(
      failure,
      "Failed to read a publication journal revision.",
    );
  }
  assertPublicationOperationActive(options);
  return decoded!;
}

async function recoverRecognizedOrphanTemporary(
  revisionDir: string,
  temporaryName: string,
  bundleKey: Sha256Digest,
  previous: VersionedPublicationJournalEntry | undefined,
  options?: RepositoryOperationOptions,
): Promise<"recovered" | "rescan" | "stale"> {
  const temporaryPath = join(revisionDir, temporaryName);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    assertPublicationOperationActive(options);
    stats = await lstat(temporaryPath);
    assertPublicationOperationActive(options);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return "rescan";
    if (error instanceof EvidencePublicationError) throw error;
    return mapFilesystemError(
      error,
      "Failed to inspect a recoverable publication revision temp.",
    );
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.nlink !== 1
  ) {
    throw new EvidencePublicationError(
      "JOURNAL_CORRUPT",
      "A crash-before-link publication temp must be one regular link.",
    );
  }
  const candidate = await readRevision(temporaryPath, options);
  if (candidate.bundleKey !== bundleKey) {
    throw new EvidencePublicationError(
      "JOURNAL_CORRUPT",
      "A recoverable publication temp does not match its directory key.",
    );
  }
  const expectedRevision = previous === undefined
    ? 0
    : previous.revision + 1;
  if (candidate.revision < expectedRevision) return "stale";
  if (candidate.revision !== expectedRevision) {
    throw new EvidencePublicationError(
      "JOURNAL_CORRUPT",
      "A recoverable publication temp skips a journal revision.",
    );
  }
  const { revision: _revision, ...unversioned } = candidate;
  if (previous === undefined) {
    const initial = snapshotInitialPublicationJournalEntry(unversioned);
    if (!sameEntry({ ...initial, revision: 0 }, candidate)) {
      throw new EvidencePublicationError(
        "JOURNAL_CORRUPT",
        "A recoverable revision-zero temp is not an initial journal entry.",
      );
    }
  } else {
    validateJournalTransition(previous, unversioned);
  }
  const finalPath = join(revisionDir, revisionName(candidate.revision));
  let linked = false;
  try {
    assertPublicationOperationActive(options);
    await link(temporaryPath, finalPath);
    linked = true;
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code !== "EEXIST" && code !== "ENOENT") {
      if (error instanceof EvidencePublicationError) throw error;
      return mapFilesystemError(
        error,
        "Failed to recover a publication revision temp.",
      );
    }
  }
  if (!linked) {
    try {
      const concurrent = await readRevision(finalPath, options);
      if (!sameEntry(concurrent, candidate)) return "rescan";
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return "rescan";
      throw error;
    }
  }
  await finishLinkedTemporaryPublication(
    revisionDir,
    temporaryPath,
    options,
  );
  return "recovered";
}

export class FilesystemPublicationJournalStore
  implements PublicationJournalStore {
  readonly #paths: FilesystemPublicationJournalPaths;

  constructor(paths: FilesystemPublicationJournalPaths) {
    this.#paths = paths;
  }

  async load(
    untrustedBundleKey: Sha256Digest,
    options?: RepositoryOperationOptions,
  ): Promise<VersionedPublicationJournalEntry | null> {
    assertPublicationOperationActive(options);
    let bundleKey: Sha256Digest;
    try {
      bundleKey = parseSha256Digest(untrustedBundleKey);
    } catch (cause) {
      throw new EvidencePublicationError(
        "INVALID_INPUT",
        "The publication bundle key is invalid.",
        { cause },
      );
    }
    await assertFilesystemPublicationJournalInfrastructure(
      this.#paths,
      options,
    );
    assertPublicationOperationActive(options);
    const revisionDir = bundleRevisionDirectory(this.#paths, bundleKey);
    const managedDirectories = [
      ...bundleRevisionDirectoryHierarchy(this.#paths, bundleKey),
    ];
    let names: string[];
    try {
      for (const [index, directory] of managedDirectories.entries()) {
        await assertPrivateDirectory(
          directory,
          `Publication journal directory ${index}`,
          options,
        );
        assertPublicationOperationActive(options);
      }
      names = await readdir(revisionDir);
      assertPublicationOperationActive(options);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return null;
      if (error instanceof EvidencePublicationError) throw error;
      return mapFilesystemError(
        error,
        "Failed to inspect publication journal revisions.",
      );
    }
    const finals = names.filter((name) => FINAL_REVISION_PATTERN.test(name));
    const temporaryNames = names.filter((name) =>
      TEMPORARY_REVISION_PATTERN.test(name)
    );
    const activeNames = names.filter((name) =>
      ACTIVE_REVISION_PATTERN.test(name)
    );
    if (
      names.some((name) =>
        !FINAL_REVISION_PATTERN.test(name) &&
        !TEMPORARY_REVISION_PATTERN.test(name) &&
        !ACTIVE_REVISION_PATTERN.test(name)
      )
    ) {
      throw new EvidencePublicationError(
        "JOURNAL_CORRUPT",
        "The publication bundle directory contains invalid files.",
      );
    }
    for (const name of activeNames) {
      const present = await validateRecognizedManagedFile(
        join(revisionDir, name),
        "A recognized active publication revision",
        options,
      );
      if (!present) return this.load(bundleKey, options);
    }
    finals.sort();
    if (
      finals.some((name, index) => name !== revisionName(index))
    ) {
      throw new EvidencePublicationError(
        "JOURNAL_CORRUPT",
        "Publication journal revisions must be contiguous and canonical.",
      );
    }
    let orphanTemporaryName: string | undefined;
    const temporaryStats = new Map<
      string,
      Awaited<ReturnType<typeof lstat>>
    >();
    for (const temporaryName of temporaryNames) {
      try {
        temporaryStats.set(
          temporaryName,
          await inspectPrivateRegularFile(
            join(revisionDir, temporaryName),
            "A recognized temporary publication revision",
            options,
          ),
        );
      } catch (error) {
        if (nodeErrorCode(error) === "ENOENT") {
          return this.load(bundleKey, options);
        }
        if (error instanceof EvidencePublicationError) throw error;
        return mapFilesystemError(
          error,
          "Failed to inspect a recognized temporary publication revision.",
        );
      }
    }
    if (temporaryNames.length > 1) {
      for (const temporaryName of temporaryNames) {
        assertManagedFileLinkCount(
          temporaryStats.get(temporaryName)!,
          1,
          "A concurrent publication revision temp",
        );
        try {
          await validateRepairablePrivateFile(
            join(revisionDir, temporaryName),
            options,
          );
        } catch (error) {
          if (nodeErrorCode(error) === "ENOENT") {
            return this.load(bundleKey, options);
          }
          throw error;
        }
      }
    }
    if (temporaryNames.length === 1) {
      const temporaryPath = join(revisionDir, temporaryNames[0]!);
      const stats = temporaryStats.get(temporaryNames[0]!)!;
      if (stats.nlink === 2 && finals.length > 0) {
        await repairRecognizedTemporaryLink(
          revisionDir,
          finals.at(-1)!,
          temporaryNames,
          options,
        );
      } else if (stats.nlink === 1) {
        try {
          await validateRepairablePrivateFile(temporaryPath, options);
        } catch (error) {
          if (nodeErrorCode(error) === "ENOENT") {
            return this.load(bundleKey, options);
          }
          throw error;
        }
        orphanTemporaryName = temporaryNames[0]!;
      } else {
        throw new EvidencePublicationError(
          "JOURNAL_CORRUPT",
          "A publication revision temp has an invalid link count.",
        );
      }
    }
    if (finals.length === 0 && orphanTemporaryName === undefined) return null;
    let previous: VersionedPublicationJournalEntry | undefined;
    for (const [revision, name] of finals.entries()) {
      await assertFilesystemPublicationJournalInfrastructure(
        this.#paths,
        options,
      );
      assertPublicationOperationActive(options);
      for (const [index, directory] of managedDirectories.entries()) {
        await assertPrivateDirectory(
          directory,
          `Publication journal directory ${index}`,
          options,
        );
        assertPublicationOperationActive(options);
      }
      const current = await readRevision(join(revisionDir, name), options);
      if (
        current.bundleKey !== bundleKey ||
        current.revision !== revision
      ) {
        throw new EvidencePublicationError(
          "JOURNAL_CORRUPT",
          "A publication revision does not match its path.",
        );
      }
      if (previous !== undefined) {
        const { revision: _revision, ...unversioned } = current;
        validateJournalTransition(previous, unversioned);
      }
      previous = current;
    }
    if (orphanTemporaryName !== undefined) {
      const recovery = await recoverRecognizedOrphanTemporary(
        revisionDir,
        orphanTemporaryName,
        bundleKey,
        previous,
        options,
      );
      if (recovery !== "stale") return this.load(bundleKey, options);
    }
    if (previous === undefined) return null;
    return cloneVersionedPublicationJournalEntry(previous!);
  }

  async create(
    input: PublicationJournalEntry,
    options?: RepositoryOperationOptions,
  ): Promise<VersionedPublicationJournalEntry> {
    assertPublicationOperationActive(options);
    assertRevisionFitsFilesystemProfile({ ...input, revision: 0 });
    const entry = snapshotInitialPublicationJournalEntry(input);
    if (await this.load(entry.bundleKey, options) !== null) {
      throw new EvidencePublicationError(
        "JOURNAL_CONFLICT",
        "The publication journal entry already exists.",
      );
    }
    return this.#publish(
      { ...entry, revision: 0 },
      options,
    );
  }

  async compareAndSwap(
    expected: VersionedPublicationJournalEntry,
    input: PublicationJournalEntry,
    options?: RepositoryOperationOptions,
  ): Promise<VersionedPublicationJournalEntry> {
    assertPublicationOperationActive(options);
    assertRevisionFitsFilesystemProfile(expected);
    assertRevisionFitsFilesystemProfile({
      ...input,
      revision: expected.revision + 1,
    });
    const current = await this.load(expected.bundleKey, options);
    if (current === null || !sameEntry(current, expected)) {
      throw new EvidencePublicationError(
        "JOURNAL_CONFLICT",
        "The publication journal advanced in another writer.",
      );
    }
    const next = validateJournalTransition(current, input);
    return this.#publish(
      { ...next, revision: current.revision + 1 },
      options,
    );
  }

  async #publish(
    entry: VersionedPublicationJournalEntry,
    options?: RepositoryOperationOptions,
  ): Promise<VersionedPublicationJournalEntry> {
    assertPublicationOperationActive(options);
    await assertFilesystemPublicationJournalInfrastructure(
      this.#paths,
      options,
    );
    assertPublicationOperationActive(options);
    assertRevisionFitsFilesystemProfile(entry);
    const bytes = encodeVersionedPublicationJournalEntry(entry);
    if (
      bytes.byteLength >
        FILESYSTEM_PUBLICATION_JOURNAL_MAX_REVISION_BYTES
    ) {
      throw new EvidencePublicationError(
        "JOURNAL_CORRUPT",
        "The publication revision exceeds the filesystem journal profile.",
      );
    }
    const revisionDir = await prepareBundleRevisionDirectory(
      this.#paths,
      entry.bundleKey,
      options,
    );
    assertPublicationOperationActive(options);
    const temporaryId = randomUUID();
    const activePath = join(
      revisionDir,
      `.writing-${temporaryId}.json`,
    );
    const temporaryPath = join(revisionDir, `.tmp-${temporaryId}.json`);
    const finalPath = join(revisionDir, revisionName(entry.revision));
    let handle;
    let published = false;
    try {
      handle = await openPrivateRegularFile(
        activePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
        options,
      );
      assertPublicationOperationActive(options);
      await handle.writeFile(bytes);
      assertPublicationOperationActive(options);
      await handle.sync();
      assertPublicationOperationActive(options);
      await handle.close();
      handle = undefined;
      assertPublicationOperationActive(options);
      await rename(activePath, temporaryPath);
      assertPublicationOperationActive(options);
      try {
        await link(temporaryPath, finalPath);
        published = true;
      } catch (error) {
        const code = nodeErrorCode(error);
        if (code !== "EEXIST" && code !== "ENOENT") throw error;
        if (code === "EEXIST") {
          try {
            const temporaryStats = await lstat(temporaryPath);
            const finalStats = await lstat(finalPath);
            if (
              temporaryStats.dev !== finalStats.dev ||
              temporaryStats.ino !== finalStats.ino
            ) {
              throw new EvidencePublicationError(
                "JOURNAL_CONFLICT",
                "The publication revision was written by another writer.",
                { cause: error },
              );
            }
          } catch (inspectionError) {
            if (nodeErrorCode(inspectionError) !== "ENOENT") {
              throw inspectionError;
            }
          }
        }
        let concurrent: VersionedPublicationJournalEntry;
        try {
          concurrent = await readRevision(finalPath);
        } catch {
          throw error;
        }
        if (!sameEntry(concurrent, entry)) {
          throw new EvidencePublicationError(
            "JOURNAL_CONFLICT",
            "The publication revision was written by another writer.",
            { cause: error },
          );
        }
        published = true;
      }
      await finishLinkedTemporaryPublication(
        revisionDir,
        temporaryPath,
        options,
      );
      return cloneVersionedPublicationJournalEntry(entry);
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      try {
        await handle?.close();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      if (!published) {
        try {
          await rm(activePath, { force: true });
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
        try {
          await rm(temporaryPath, { force: true });
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (cleanupFailures.length > 0) {
        throw new EvidencePublicationError(
          "IO_FAILURE",
          "An unpublished publication revision could not be cleaned up safely.",
          {
            cause: new AggregateError(
              [error, ...cleanupFailures],
              "Publication failure and cleanup uncertainty.",
            ),
          },
        );
      }
      if (nodeErrorCode(error) === "EEXIST") {
        throw new EvidencePublicationError(
          "JOURNAL_CONFLICT",
          "The publication revision was written by another writer.",
          { cause: error },
        );
      }
      if (error instanceof EvidencePublicationError) throw error;
      return mapFilesystemError(
        error,
        published
          ? "The publication revision was linked but durability work failed."
          : "Failed to publish a publication journal revision.",
      );
    }
  }
}
