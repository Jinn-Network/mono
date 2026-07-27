// SPDX-License-Identifier: Apache-2.0
import {
  constants,
  lstat,
  mkdir,
  realpath,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  RepositoryOperationOptions,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

import {
  assertPublicationOperationActive,
  EvidencePublicationError,
} from "../errors.js";
import {
  assertManagedFileLinkCount,
  assertPrivateDirectory,
  inspectPrivateRegularFile,
  mapFilesystemError,
  nodeErrorCode,
  openPrivateRegularFile,
  syncDirectory,
} from "./validation.js";

export const FILESYSTEM_PUBLICATION_JOURNAL_FORMAT = {
  format: "jinn-evidence-publication-journal",
  version: 1,
} as const;

export const FILESYSTEM_PUBLICATION_JOURNAL_MARKER_BYTES =
  new TextEncoder().encode(
    `${JSON.stringify(FILESYSTEM_PUBLICATION_JOURNAL_FORMAT)}\n`,
  );

export interface FilesystemPublicationJournalPaths {
  readonly rootDir: string;
  readonly markerPath: string;
  readonly entriesDir: string;
  readonly pathAnchors: readonly FilesystemPathAnchor[];
}

interface FilesystemPathAnchor {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

function assertContained(rootDir: string, path: string): void {
  const child = relative(rootDir, path);
  if (
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new EvidencePublicationError(
      "JOURNAL_CORRUPT",
      "A journal-managed path escapes its root.",
    );
  }
}

async function rejectExistingSymlinkComponents(
  path: string,
  options?: RepositoryOperationOptions,
): Promise<void> {
  const parsed = parse(path);
  const components = path
    .slice(parsed.root.length)
    .split(sep)
    .filter(Boolean);
  let current = parsed.root;
  for (const component of components) {
    current = resolve(current, component);
    try {
      assertPublicationOperationActive(options);
      const stats = await lstat(current);
      assertPublicationOperationActive(options);
      if (stats.isSymbolicLink()) {
        throw new EvidencePublicationError(
          "JOURNAL_CORRUPT",
          "A journal-managed path contains a symbolic link.",
        );
      }
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return;
      if (error instanceof EvidencePublicationError) throw error;
      return mapFilesystemError(error, "Failed to inspect a journal path.");
    }
  }
}

async function canonicalizeConfiguredRoot(path: string): Promise<string> {
  const lexicalRoot = resolve(path);
  let unmanagedAncestor = dirname(lexicalRoot);
  for (;;) {
    try {
      await lstat(unmanagedAncestor);
      break;
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") {
        if (error instanceof EvidencePublicationError) throw error;
        return mapFilesystemError(
          error,
          "Failed to inspect the publication journal ancestor.",
        );
      }
      const parent = dirname(unmanagedAncestor);
      if (parent === unmanagedAncestor) {
        return mapFilesystemError(
          error,
          "No existing publication journal ancestor could be resolved.",
        );
      }
      unmanagedAncestor = parent;
    }
  }
  let physicalAncestor: string;
  try {
    physicalAncestor = await realpath(unmanagedAncestor);
    const stats = await lstat(physicalAncestor);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new EvidencePublicationError(
        "JOURNAL_CORRUPT",
        "The publication journal ancestor does not resolve to a directory.",
      );
    }
  } catch (error) {
    if (error instanceof EvidencePublicationError) throw error;
    return mapFilesystemError(
      error,
      "Failed to resolve the publication journal ancestor.",
    );
  }
  const suffix = relative(unmanagedAncestor, lexicalRoot);
  if (
    suffix === ".." ||
    suffix.startsWith(`..${sep}`) ||
    isAbsolute(suffix)
  ) {
    throw new EvidencePublicationError(
      "INVALID_INPUT",
      "The publication journal root escapes its resolved ancestor.",
    );
  }
  return resolve(physicalAncestor, suffix);
}

async function ensurePrivateDirectory(
  path: string,
  options?: RepositoryOperationOptions,
): Promise<void> {
  try {
    await rejectExistingSymlinkComponents(path, options);
    assertPublicationOperationActive(options);
    const firstCreated = await mkdir(path, { recursive: true, mode: 0o700 });
    assertPublicationOperationActive(options);
    await assertPrivateDirectory(path, "Journal directory", options);
    if (firstCreated !== undefined) {
      const first = resolve(firstCreated);
      const target = resolve(path);
      const suffix = relative(first, target);
      if (
        suffix === ".." ||
        suffix.startsWith(`..${sep}`) ||
        isAbsolute(suffix)
      ) {
        throw new EvidencePublicationError(
          "JOURNAL_CORRUPT",
          "A created journal directory escaped its requested hierarchy.",
        );
      }
      const created = [first];
      let current = first;
      for (const component of suffix.split(sep).filter(Boolean)) {
        current = resolve(current, component);
        created.push(current);
      }
      for (const directory of created) {
        await assertPrivateDirectory(
          directory,
          "Journal directory",
          options,
        );
        await syncDirectory(dirname(directory), options);
      }
    } else {
      await syncDirectory(dirname(path), options);
    }
  } catch (error) {
    if (error instanceof EvidencePublicationError) throw error;
    return mapFilesystemError(
      error,
      "Failed to prepare a publication journal directory.",
    );
  }
}

function pathComponents(path: string): readonly string[] {
  const parsed = parse(path);
  const paths = [parsed.root];
  let current = parsed.root;
  for (
    const component of path
      .slice(parsed.root.length)
      .split(sep)
      .filter(Boolean)
  ) {
    current = resolve(current, component);
    paths.push(current);
  }
  return paths;
}

async function capturePathAnchors(
  path: string,
): Promise<readonly FilesystemPathAnchor[]> {
  const anchors: FilesystemPathAnchor[] = [];
  try {
    for (const component of pathComponents(path)) {
      const stats = await lstat(component);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new EvidencePublicationError(
          "JOURNAL_CORRUPT",
          "A publication journal path anchor is not a directory.",
        );
      }
      anchors.push(Object.freeze({
        path: component,
        device: stats.dev,
        inode: stats.ino,
      }));
    }
  } catch (error) {
    if (error instanceof EvidencePublicationError) throw error;
    return mapFilesystemError(
      error,
      "Failed to anchor the publication journal path.",
    );
  }
  return Object.freeze(anchors);
}

async function assertPathAnchors(
  anchors: readonly FilesystemPathAnchor[],
  options?: RepositoryOperationOptions,
): Promise<void> {
  try {
    for (const anchor of anchors) {
      assertPublicationOperationActive(options);
      const stats = await lstat(anchor.path);
      assertPublicationOperationActive(options);
      if (
        stats.isSymbolicLink() ||
        !stats.isDirectory() ||
        stats.dev !== anchor.device ||
        stats.ino !== anchor.inode
      ) {
        throw new EvidencePublicationError(
          "JOURNAL_CORRUPT",
          "A publication journal path anchor changed after construction.",
        );
      }
    }
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      throw new EvidencePublicationError(
        "JOURNAL_CORRUPT",
        "A publication journal path anchor is missing.",
        { cause: error },
      );
    }
    if (error instanceof EvidencePublicationError) throw error;
    return mapFilesystemError(
      error,
      "Failed to revalidate the publication journal path.",
    );
  }
}

async function prepareMarker(markerPath: string): Promise<void> {
  let handle;
  let failure: unknown;
  try {
    handle = await openPrivateRegularFile(
      markerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await handle.writeFile(FILESYSTEM_PUBLICATION_JOURNAL_MARKER_BYTES);
    await handle.sync();
  } catch (error) {
    failure = error;
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (closeFailure) {
      failure = failure === undefined
        ? closeFailure
        : new EvidencePublicationError(
          "IO_FAILURE",
          "The publication journal marker write and cleanup both failed.",
          {
            cause: new AggregateError(
              [failure, closeFailure],
              "Publication journal marker creation and cleanup both failed.",
            ),
          },
        );
    }
  }
  if (failure === undefined) {
    try {
      await syncDirectory(resolve(markerPath, ".."));
      return;
    } catch (error) {
      if (error instanceof EvidencePublicationError) throw error;
      return mapFilesystemError(
        error,
        "Failed to synchronize the publication journal marker.",
      );
    }
  }
  if (nodeErrorCode(failure) !== "EEXIST") {
    if (failure instanceof EvidencePublicationError) throw failure;
    return mapFilesystemError(
      failure,
      "Failed to create the publication journal marker.",
    );
  }
  await assertFilesystemPublicationJournalMarker(markerPath);
}

async function assertFilesystemPublicationJournalMarker(
  markerPath: string,
  options?: RepositoryOperationOptions,
): Promise<void> {
  let existing;
  let failure: unknown;
  try {
    const markerStats = await inspectPrivateRegularFile(
      markerPath,
      "The publication journal marker",
      options,
    );
    assertManagedFileLinkCount(
      markerStats,
      1,
      "The publication journal marker",
    );
    existing = await openPrivateRegularFile(
      markerPath,
      constants.O_RDONLY,
      undefined,
      options,
    );
    const bytes = new Uint8Array(
      FILESYSTEM_PUBLICATION_JOURNAL_MARKER_BYTES.byteLength + 1,
    );
    let bytesRead = 0;
    while (bytesRead < bytes.byteLength) {
      assertPublicationOperationActive(options);
      const result = await existing.read(
        bytes,
        bytesRead,
        bytes.byteLength - bytesRead,
        bytesRead,
      );
      assertPublicationOperationActive(options);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (
      bytesRead !== FILESYSTEM_PUBLICATION_JOURNAL_MARKER_BYTES.byteLength ||
      !FILESYSTEM_PUBLICATION_JOURNAL_MARKER_BYTES.every(
        (value, index) =>
          value === bytes[index],
      )
    ) {
      throw new EvidencePublicationError(
        "JOURNAL_CORRUPT",
        "The publication journal marker is invalid.",
      );
    }
  } catch (error) {
    failure = error;
  }
  try {
    if (existing !== undefined) {
      try {
        assertPublicationOperationActive(options);
      } catch (error) {
        failure ??= error;
      }
      await existing.close();
      if (failure === undefined) {
        assertPublicationOperationActive(options);
      }
    }
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    if (nodeErrorCode(failure) === "ENOENT") {
      throw new EvidencePublicationError(
        "JOURNAL_CORRUPT",
        "The publication journal marker is missing.",
        { cause: failure },
      );
    }
    if (failure instanceof EvidencePublicationError) throw failure;
    return mapFilesystemError(
      failure,
      "Failed to validate the publication journal marker.",
    );
  }
}

async function assertInfrastructureDirectory(
  path: string,
  role: string,
  options?: RepositoryOperationOptions,
): Promise<void> {
  try {
    await assertPrivateDirectory(path, role, options);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      throw new EvidencePublicationError(
        "JOURNAL_CORRUPT",
        `${role} is missing.`,
        { cause: error },
      );
    }
    if (error instanceof EvidencePublicationError) throw error;
    return mapFilesystemError(
      error,
      `Failed to validate ${role.toLowerCase()}.`,
    );
  }
}

export async function assertFilesystemPublicationJournalInfrastructure(
  paths: FilesystemPublicationJournalPaths,
  options?: RepositoryOperationOptions,
): Promise<void> {
  await assertPathAnchors(paths.pathAnchors, options);
  await assertInfrastructureDirectory(
    paths.rootDir,
    "Publication journal root directory",
    options,
  );
  await assertFilesystemPublicationJournalMarker(paths.markerPath, options);
  await assertInfrastructureDirectory(
    paths.entriesDir,
    "Publication journal entries directory",
    options,
  );
}

export async function prepareFilesystemPublicationJournalPaths(
  rootDirInput: string,
): Promise<FilesystemPublicationJournalPaths> {
  if (
    typeof rootDirInput !== "string" ||
    rootDirInput.length === 0 ||
    rootDirInput.trim() !== rootDirInput
  ) {
    throw new EvidencePublicationError(
      "INVALID_INPUT",
      "The publication journal root must be a non-empty path.",
    );
  }
  const rootDir = await canonicalizeConfiguredRoot(rootDirInput);
  if (rootDir === parse(rootDir).root) {
    throw new EvidencePublicationError(
      "INVALID_INPUT",
      "The filesystem root cannot be a publication journal.",
    );
  }
  await rejectExistingSymlinkComponents(rootDir);
  await ensurePrivateDirectory(rootDir);
  const markerPath = resolve(rootDir, "publication-journal.json");
  const entriesDir = resolve(rootDir, "entries");
  assertContained(rootDir, markerPath);
  assertContained(rootDir, entriesDir);
  await prepareMarker(markerPath);
  await ensurePrivateDirectory(entriesDir);
  const pathAnchors = await capturePathAnchors(rootDir);
  return { rootDir, markerPath, entriesDir, pathAnchors };
}

export function bundleRevisionDirectory(
  paths: FilesystemPublicationJournalPaths,
  bundleKey: Sha256Digest,
): string {
  return bundleRevisionDirectoryHierarchy(paths, bundleKey).at(-1)!;
}

export function bundleRevisionDirectoryHierarchy(
  paths: FilesystemPublicationJournalPaths,
  bundleKey: Sha256Digest,
): readonly [string, string, string] {
  const hex = bundleKey.slice(7);
  const algorithmDir = resolve(paths.entriesDir, "sha256");
  const prefixDir = resolve(algorithmDir, hex.slice(0, 2));
  const revisionDir = resolve(prefixDir, hex.slice(2));
  for (const directory of [algorithmDir, prefixDir, revisionDir]) {
    assertContained(paths.entriesDir, directory);
  }
  return [algorithmDir, prefixDir, revisionDir];
}

export async function prepareBundleRevisionDirectory(
  paths: FilesystemPublicationJournalPaths,
  bundleKey: Sha256Digest,
  options?: RepositoryOperationOptions,
): Promise<string> {
  const [algorithmDir, prefixDir, revisionDir] =
    bundleRevisionDirectoryHierarchy(paths, bundleKey);
  for (const path of [algorithmDir, prefixDir, revisionDir]) {
    await ensurePrivateDirectory(path, options);
  }
  return revisionDir;
}
