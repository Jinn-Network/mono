import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  type Stats,
} from 'node:fs';
import { dirname } from 'node:path';

export interface FileIdentity {
  dev: number;
  ino: number;
  uid: number;
  nlink: number;
}

export function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function identityFrom(stat: Stats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    nlink: stat.nlink,
  };
}

export function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function assertSafeOwner(stat: Stats, path: string, label: string): void {
  const uid = process.platform === 'win32' ? undefined : process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${label} must be owned by uid ${uid}: ${path}`);
  }
}

export function assertRegularStat(stat: Stats, path: string, label: string): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a symlink or other file type: ${path}`);
  }
  if (stat.nlink !== 1) {
    throw new Error(`${label} must not be hardlinked: ${path}`);
  }
  assertSafeOwner(stat, path, label);
}

export function inspectRegularPath(path: string, label: string): FileIdentity | undefined {
  try {
    const stat = lstatSync(path);
    assertRegularStat(stat, path, label);
    return identityFrom(stat);
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

export function openVerifiedRegular(
  path: string,
  label: string,
  expected?: FileIdentity,
): { fd: number; identity: FileIdentity } {
  const before = inspectRegularPath(path, label);
  if (!before) throw new Error(`${label} disappeared before it could be opened: ${path}`);
  if (expected && !sameIdentity(before, expected)) {
    throw new Error(`${label} changed while it was being processed: ${path}`);
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    assertRegularStat(opened, path, label);
    const identity = identityFrom(opened);
    if (!sameIdentity(identity, before) || (expected && !sameIdentity(identity, expected))) {
      throw new Error(`${label} changed while it was being opened: ${path}`);
    }
    return { fd, identity };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function secureRegularPath(
  path: string,
  label: string,
  expected?: FileIdentity,
): FileIdentity {
  const opened = openVerifiedRegular(path, label, expected);
  try {
    if (process.platform !== 'win32') fchmodSync(opened.fd, 0o600);
    return opened.identity;
  } finally {
    closeSync(opened.fd);
  }
}

export function validateDirectory(path: string, label: string, secure: boolean): FileIdentity {
  // Validate the terminal directory entry and its opened descriptor. Ancestor
  // components remain outside this guarantee because Node does not expose
  // portable openat-style traversal for pinning every component.
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory, not a symlink: ${path}`);
  }
  assertSafeOwner(before, path, label);

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const directoryOnly = constants.O_DIRECTORY ?? 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow | directoryOnly);
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || opened.isSymbolicLink()) {
      throw new Error(`${label} changed while it was being opened: ${path}`);
    }
    assertSafeOwner(opened, path, label);
    const beforeIdentity = identityFrom(before);
    const openedIdentity = identityFrom(opened);
    if (!sameIdentity(beforeIdentity, openedIdentity)) {
      throw new Error(`${label} changed while it was being opened: ${path}`);
    }
    if (secure && process.platform !== 'win32') fchmodSync(fd, 0o700);
    return openedIdentity;
  } finally {
    closeSync(fd);
  }
}

export function prepareEvidenceDirectory(
  path: string,
  label: string,
  secure: boolean,
): FileIdentity {
  try {
    return validateDirectory(path, label, secure);
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') throw error;
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const identity = validateDirectory(path, label, secure);
    fsyncDirectory(dirname(path));
    return identity;
  }
}

export function fsyncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0),
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readVerifiedText(
  path: string,
  label: string,
  expected?: FileIdentity,
): { text: string; identity: FileIdentity } {
  const opened = openVerifiedRegular(path, label, expected);
  try {
    return {
      text: readFileSync(opened.fd, 'utf8'),
      identity: opened.identity,
    };
  } finally {
    closeSync(opened.fd);
  }
}
