import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function escapesPackageDir(relativePath: string): boolean {
  return relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath);
}

/** True when `candidate` resolves to `root` or one of its descendants. */
export function isInsidePackageDir(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || !escapesPackageDir(rel);
}

export interface PackageTreeFile {
  /** Package-relative path below the selected output root. */
  path: string;
  content: string | Uint8Array;
}

interface PathIdentity {
  dev: number;
  ino: number;
}

interface CreatedDirectory {
  path: string;
  identity: PathIdentity;
}

interface CommittedFile {
  target: string;
  parents: Array<{ path: string; identity: PathIdentity }>;
  backup?: string;
  installed?: PathIdentity;
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function identity(stat: Stats): PathIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function assertDirectory(
  path: string,
  label: string,
  expected?: PathIdentity,
): PathIdentity {
  const before = lstatSync(path);
  if (before.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${path}`);
  }
  if (!before.isDirectory()) {
    throw new Error(`${label} must be a directory: ${path}`);
  }
  const beforeIdentity = identity(before);
  if (expected && !sameIdentity(beforeIdentity, expected)) {
    throw new Error(`${label} changed while the skill was being installed: ${path}`);
  }

  // Opening a directory is not portable on Windows. POSIX gets an additional
  // lstat/open/fstat identity check and O_NOFOLLOW defence for the terminal
  // component. Node does not expose openat/renameat, so callers also revalidate
  // the full component chain immediately before every commit operation.
  if (process.platform === 'win32') return beforeIdentity;
  const fd = openSync(
    path,
    constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_DIRECTORY ?? 0),
  );
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory()) {
      throw new Error(`${label} changed while it was being opened: ${path}`);
    }
    const openedIdentity = identity(opened);
    if (!sameIdentity(beforeIdentity, openedIdentity)) {
      throw new Error(`${label} changed while it was being opened: ${path}`);
    }
    return openedIdentity;
  } finally {
    closeSync(fd);
  }
}

function assertRegularTarget(path: string, label: string): Stats | undefined {
  const stat = lstatIfPresent(path);
  if (!stat) return undefined;
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
  return stat;
}

function pathSegments(relativePath: string): string[] {
  return relativePath.split(sep).filter((part) => part !== '');
}

function assertOutputTreeSafe(
  root: string,
  files: Array<{ relativePath: string; target: string }>,
  expectedRoot?: PathIdentity,
): PathIdentity | undefined {
  const rootStat = lstatIfPresent(root);
  if (!rootStat) return undefined;
  const rootIdentity = assertDirectory(root, 'skill install directory', expectedRoot);

  for (const file of files) {
    const segments = pathSegments(file.relativePath);
    let current = root;
    let missingParent = false;
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      const stat = lstatIfPresent(current);
      if (!stat) {
        missingParent = true;
        break;
      }
      assertDirectory(current, 'skill companion path component');
    }
    if (!missingParent) assertRegularTarget(file.target, 'skill output target');
  }
  return rootIdentity;
}

function ensureTargetParent(
  root: string,
  relativePath: string,
  rootIdentity: PathIdentity,
  created: CreatedDirectory[],
): Array<{ path: string; identity: PathIdentity }> {
  const parents: Array<{ path: string; identity: PathIdentity }> = [
    { path: root, identity: assertDirectory(root, 'skill install directory', rootIdentity) },
  ];
  let current = root;
  for (const segment of pathSegments(relativePath).slice(0, -1)) {
    current = join(current, segment);
    let stat = lstatIfPresent(current);
    if (!stat) {
      try {
        mkdirSync(current);
      } catch (error) {
        // A concurrent creator is acceptable only if it made the exact kind of
        // entry we require; assertDirectory below rejects links and files.
        if (nodeErrorCode(error) !== 'EEXIST') throw error;
      }
      stat = lstatIfPresent(current);
      if (!stat) throw new Error(`skill companion directory disappeared: ${current}`);
      const directoryIdentity = assertDirectory(current, 'skill companion path component');
      created.push({ path: current, identity: directoryIdentity });
      parents.push({ path: current, identity: directoryIdentity });
      continue;
    }
    parents.push({
      path: current,
      identity: assertDirectory(current, 'skill companion path component'),
    });
  }

  // Close the check/use window as far as portable Node permits: every opened
  // component must still name the same directory immediately before commit.
  for (const parent of parents) {
    assertDirectory(
      parent.path,
      parent.path === root ? 'skill install directory' : 'skill companion path component',
      parent.identity,
    );
  }
  return parents;
}

function removeCreatedDirectories(created: CreatedDirectory[]): void {
  for (const directory of [...created].reverse()) {
    try {
      const stat = lstatIfPresent(directory.path);
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (!sameIdentity(identity(stat), directory.identity)) continue;
      rmdirSync(directory.path);
    } catch (error) {
      // Non-empty means a prior directory already owns committed content or a
      // concurrent writer used it. Either way, recursive cleanup is unsafe.
      if (nodeErrorCode(error) !== 'ENOTEMPTY' && nodeErrorCode(error) !== 'EEXIST') throw error;
    }
  }
}

function rollbackCommittedFiles(committed: CommittedFile[]): void {
  const failures: string[] = [];
  for (const file of [...committed].reverse()) {
    try {
      for (const parent of file.parents) {
        assertDirectory(
          parent.path,
          'skill output parent during rollback',
          parent.identity,
        );
      }
      if (file.installed) {
        const target = lstatIfPresent(file.target);
        if (
          target
          && !target.isSymbolicLink()
          && target.isFile()
          && sameIdentity(identity(target), file.installed)
        ) {
          unlinkSync(file.target);
        } else if (target) {
          failures.push(`installed target changed before rollback: ${file.target}`);
        }
      }
      if (file.backup) {
        if (lstatIfPresent(file.target)) {
          failures.push(`cannot restore occupied target: ${file.target}`);
        } else {
          renameSync(file.backup, file.target);
        }
      }
    } catch (error) {
      failures.push(`${file.target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`skill install rollback incomplete — ${failures.join('; ')}`);
  }
}

/**
 * Install a package tree without following pre-existing links below `root`.
 *
 * All content is first written beneath a private sibling directory. A missing
 * destination is published by one directory rename. An existing destination
 * retains merge/overwrite semantics: every output path is preflighted before
 * the first mutation, existing regular files are moved to private backups,
 * and staged files are atomically renamed into place. This replacement model
 * leaves hardlinked outside inodes unchanged and works on Windows, where
 * renaming directly over an existing file is not reliably supported.
 */
export function writePackageTreeSafely(root: string, files: PackageTreeFile[]): void {
  const absoluteRoot = resolve(root);
  const normalized = new Map<string, { relativePath: string; target: string; content: string | Uint8Array }>();
  for (const file of files) {
    const target = resolve(absoluteRoot, file.path);
    const relativePath = relative(absoluteRoot, target);
    if (
      relativePath === ''
      || escapesPackageDir(relativePath)
    ) {
      throw new Error(`skill output path escapes the install directory: ${file.path}`);
    }
    if (normalized.has(relativePath)) {
      throw new Error(`duplicate skill output path: ${file.path}`);
    }
    normalized.set(relativePath, { relativePath, target, content: file.content });
  }
  const outputs = [...normalized.values()];

  // Reject a stable unsafe tree before even creating the private staging area.
  const initialRootIdentity = assertOutputTreeSafe(absoluteRoot, outputs);
  mkdirSync(dirname(absoluteRoot), { recursive: true });
  const stagingRoot = mkdtempSync(join(dirname(absoluteRoot), '.jinn-skill-install-'));
  const payloadRoot = join(stagingRoot, 'payload');
  const backupRoot = join(stagingRoot, 'backup');
  const committed: CommittedFile[] = [];
  const createdDirectories: CreatedDirectory[] = [];
  let cleanupStaging = true;

  try {
    mkdirSync(payloadRoot);
    for (const file of outputs) {
      const staged = join(payloadRoot, file.relativePath);
      mkdirSync(dirname(staged), { recursive: true });
      if (lstatIfPresent(staged)) {
        throw new Error(`duplicate skill output path on this filesystem: ${file.relativePath}`);
      }
      writeFileSync(staged, file.content);
    }

    const rootIdentity = assertOutputTreeSafe(absoluteRoot, outputs, initialRootIdentity);
    if (!rootIdentity) {
      // rename(2) replaces a raced final symlink rather than following it on
      // POSIX, and fails closed on Windows when the destination is occupied.
      renameSync(payloadRoot, absoluteRoot);
      assertDirectory(absoluteRoot, 'installed skill directory');
      return;
    }

    mkdirSync(backupRoot, { mode: 0o700 });
    for (let index = 0; index < outputs.length; index += 1) {
      const file = outputs[index]!;
      const parents = ensureTargetParent(
        absoluteRoot,
        file.relativePath,
        rootIdentity,
        createdDirectories,
      );
      const existing = assertRegularTarget(file.target, 'skill output target');
      for (const parent of parents) {
        assertDirectory(
          parent.path,
          parent.path === absoluteRoot ? 'skill install directory' : 'skill companion path component',
          parent.identity,
        );
      }

      const commit: CommittedFile = { target: file.target, parents };
      committed.push(commit);
      if (existing) {
        const backup = join(backupRoot, String(index));
        // Rename never follows the final component. A hardlink or a raced
        // symlink is moved as a directory entry, not opened for writing.
        renameSync(file.target, backup);
        commit.backup = backup;
      }
      for (const parent of parents) {
        assertDirectory(parent.path, 'skill output parent before commit', parent.identity);
      }
      renameSync(join(payloadRoot, file.relativePath), file.target);
      const installed = assertRegularTarget(file.target, 'installed skill output');
      if (!installed) throw new Error(`installed skill output disappeared: ${file.target}`);
      commit.installed = identity(installed);
      for (const parent of parents) {
        assertDirectory(parent.path, 'skill output parent after commit', parent.identity);
      }
    }
  } catch (error) {
    try {
      rollbackCommittedFiles(committed);
      removeCreatedDirectories(createdDirectories);
    } catch (rollbackError) {
      // Backups may be the only remaining copy of overwritten user files. Keep
      // the private directory for manual recovery rather than deleting them.
      cleanupStaging = false;
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; `
          + `${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}; `
          + `recovery files retained at ${stagingRoot}`,
      );
    }
    throw error;
  } finally {
    if (cleanupStaging) rmSync(stagingRoot, { recursive: true, force: true });
  }
}
