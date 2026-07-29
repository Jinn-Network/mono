// SPDX-License-Identifier: MIT
import {
  constants,
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  LocalEvidenceRuntimeError,
  localRuntimeIoError,
} from "./errors.js";

export interface LocalRuntimePaths {
  readonly rootDir: string;
  readonly markerPath: string;
  readonly repositoryDir: string;
  readonly announcementsDir: string;
  readonly catalogDir: string;
  readonly generationsDir: string;
  readonly catalogPointerPath: string;
  readonly operationsDir: string;
  readonly lockPath: string;
  readonly operationsDatabasePath: string;
}

function unsafe(message: string, cause?: unknown): LocalEvidenceRuntimeError {
  return new LocalEvidenceRuntimeError(
    "UNSAFE_PATH",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isFilesystemRootChild(path: string): boolean {
  const absolute = resolve(path);
  return dirname(absolute) === parse(absolute).root;
}

function nodeErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

async function rejectSymlinkComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  const components = absolute.slice(root.length).split(sep).filter(Boolean);
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        // Stable platform aliases such as macOS /var -> /private/var are
        // direct children of the filesystem root and are not attacker-controlled.
        if (!isFilesystemRootChild(current)) {
          throw unsafe(`Runtime path must not contain symlinks: ${current}`);
        }
      } else if (index < components.length - 1 && !stat.isDirectory()) {
        throw unsafe(`Runtime path parent must be a directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function rejectNonPlatformAncestorSymlinks(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  const components = absolute.slice(root.length).split(sep).filter(Boolean);
  for (const component of components) {
    current = join(current, component);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() && !isFilesystemRootChild(current)) {
        throw unsafe(`Runtime path must not contain symlinks: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
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
        if (error instanceof LocalEvidenceRuntimeError) throw error;
        throw localRuntimeIoError(
          error,
          "Failed to inspect the runtime ancestor.",
        );
      }
      const parent = dirname(unmanagedAncestor);
      if (parent === unmanagedAncestor) {
        throw localRuntimeIoError(
          error,
          "No existing runtime ancestor could be resolved.",
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
      throw unsafe(
        `Runtime ancestor must resolve to a directory: ${physicalAncestor}`,
      );
    }
  } catch (error) {
    if (error instanceof LocalEvidenceRuntimeError) throw error;
    throw localRuntimeIoError(
      error,
      "Failed to resolve the runtime ancestor.",
    );
  }
  const suffix = relative(unmanagedAncestor, lexicalRoot);
  if (
    suffix === ".." ||
    suffix.startsWith(`..${sep}`) ||
    parse(suffix).root.length > 0
  ) {
    throw unsafe("The runtime root escapes its resolved ancestor.");
  }
  return resolve(physicalAncestor, suffix);
}

async function secureDirectory(path: string): Promise<void> {
  try {
    await rejectSymlinkComponents(path);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(path, { mode: 0o700 });
      stat = await lstat(path);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw unsafe(`Runtime path must be a real directory: ${path}`);
    }
    if (
      process.platform !== "win32" &&
      process.getuid !== undefined &&
      stat.uid !== process.getuid()
    ) {
      throw unsafe(`Runtime path is not owned by the current user: ${path}`);
    }
    if (process.platform !== "win32") {
      const handle = await open(
        path,
        constants.O_RDONLY |
          (constants.O_DIRECTORY ?? 0) |
          (constants.O_NOFOLLOW ?? 0),
      );
      try {
        await handle.chmod(0o700);
      } finally {
        await handle.close();
      }
    }
    await rejectSymlinkComponents(path);
  } catch (error) {
    if (error instanceof LocalEvidenceRuntimeError) throw error;
    throw localRuntimeIoError(error, `Unable to prepare runtime path: ${path}`);
  }
}

export async function prepareRuntimePaths(
  untrustedRootDir: string,
): Promise<LocalRuntimePaths> {
  if (
    typeof untrustedRootDir !== "string" ||
    untrustedRootDir.trim().length === 0
  ) {
    throw unsafe("rootDir must be a non-empty filesystem path.");
  }
  const rootDir = await canonicalizeConfiguredRoot(untrustedRootDir);
  if (!isAbsolute(rootDir)) throw unsafe("rootDir must resolve absolutely.");
  if (rootDir === parse(rootDir).root) {
    throw unsafe("The filesystem root cannot be used as a runtime root.");
  }
  await rejectSymlinkComponents(rootDir);
  await secureDirectory(rootDir);

  const repositoryDir = join(rootDir, "repository");
  const announcementsDir = join(rootDir, "announcements");
  const catalogDir = join(rootDir, "catalog");
  const generationsDir = join(catalogDir, "generations");
  const operationsDir = join(rootDir, "operations");
  for (const path of [
    repositoryDir,
    announcementsDir,
    catalogDir,
    generationsDir,
    operationsDir,
  ]) {
    await secureDirectory(path);
  }
  return {
    rootDir,
    markerPath: join(rootDir, "runtime.json"),
    repositoryDir,
    announcementsDir,
    catalogDir,
    generationsDir,
    catalogPointerPath: join(catalogDir, "current.json"),
    operationsDir,
    lockPath: join(rootDir, "runtime.lock"),
    operationsDatabasePath: join(operationsDir, "runtime.sqlite"),
  };
}

export interface PreparedPrivateDatabaseFile {
  readonly handle: FileHandle;
  readonly device: number;
  readonly inode: number;
}

async function assertHandleMatchesPath(
  path: string,
  prepared: PreparedPrivateDatabaseFile,
): Promise<void> {
  await rejectSymlinkComponents(path);
  const pathStat = await lstat(path);
  const handleStat = await prepared.handle.stat();
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    !handleStat.isFile() ||
    pathStat.nlink !== 1 ||
    handleStat.nlink !== 1 ||
    pathStat.dev !== prepared.device ||
    pathStat.ino !== prepared.inode ||
    handleStat.dev !== prepared.device ||
    handleStat.ino !== prepared.inode
  ) {
    throw unsafe(`Runtime database path changed while opening: ${path}`);
  }
}

export async function preparePrivateDatabaseFile(
  path: string,
): Promise<PreparedPrivateDatabaseFile> {
  let handle: FileHandle | undefined;
  try {
    if (!isAbsolute(path) || resolve(path) !== path) {
      throw unsafe("Runtime database paths must be normalized and absolute.");
    }
    await rejectSymlinkComponents(dirname(path));
    try {
      handle = await open(
        path,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw unsafe(`Runtime database path must be a regular file: ${path}`);
      }
      handle = await open(
        path,
        constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      );
    }
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw unsafe(`Runtime database path must be a regular file: ${path}`);
    }
    if (stat.nlink !== 1) {
      throw unsafe(`Runtime database path must have exactly one link: ${path}`);
    }
    if (
      process.platform !== "win32" &&
      process.getuid !== undefined &&
      stat.uid !== process.getuid()
    ) {
      throw unsafe(`Runtime database path is not owned by the current user: ${path}`);
    }
    if (process.platform !== "win32") await handle.chmod(0o600);
    const prepared = {
      handle,
      device: stat.dev,
      inode: stat.ino,
    };
    await assertHandleMatchesPath(path, prepared);
    return prepared;
  } catch (error) {
    await handle?.close();
    if (error instanceof LocalEvidenceRuntimeError) throw error;
    if (["ELOOP", "ENOTDIR"].includes(
      (error as NodeJS.ErrnoException).code ?? "",
    )) {
      throw unsafe(`Runtime database path is unsafe: ${path}`, error);
    }
    throw localRuntimeIoError(error, `Unable to prepare runtime database: ${path}`);
  }
}

export async function verifyPrivateDatabaseFile(
  path: string,
  prepared: PreparedPrivateDatabaseFile,
): Promise<void> {
  try {
    await assertHandleMatchesPath(path, prepared);
  } catch (error) {
    if (error instanceof LocalEvidenceRuntimeError) throw error;
    throw localRuntimeIoError(error, `Unable to verify runtime database: ${path}`);
  }
}

export async function enforcePrivateFile(path: string): Promise<void> {
  let handle;
  try {
    await rejectSymlinkComponents(path);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw unsafe(`Runtime control path must be a regular file: ${path}`);
    }
    if (stat.nlink !== 1) {
      throw unsafe(`Runtime control path must have exactly one link: ${path}`);
    }
    if (
      process.platform !== "win32" &&
      process.getuid !== undefined &&
      stat.uid !== process.getuid()
    ) {
      throw unsafe(`Runtime control path is not owned by the current user: ${path}`);
    }
    handle = await open(
      path,
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    );
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.nlink !== 1 ||
      openedStat.dev !== stat.dev ||
      openedStat.ino !== stat.ino ||
      (
        process.platform !== "win32" &&
        process.getuid !== undefined &&
        openedStat.uid !== process.getuid()
      )
    ) {
      throw unsafe(`Runtime control path changed while opening: ${path}`);
    }
    if (process.platform !== "win32") await handle.chmod(0o600);
    await rejectSymlinkComponents(path);
  } catch (error) {
    if (error instanceof LocalEvidenceRuntimeError) throw error;
    throw localRuntimeIoError(error, `Unable to secure runtime file: ${path}`);
  } finally {
    await handle?.close();
  }
}
