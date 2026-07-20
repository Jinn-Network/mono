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
  readdirSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';

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

function openVerifiedRegularWithFlags(
  path: string,
  label: string,
  flags: number,
  expected?: FileIdentity,
): { fd: number; identity: FileIdentity } {
  const before = inspectRegularPath(path, label);
  if (!before) throw new Error(`${label} disappeared before it could be opened: ${path}`);
  if (expected && !sameIdentity(before, expected)) {
    throw new Error(`${label} changed while it was being processed: ${path}`);
  }

  const fd = openSync(path, flags | (constants.O_NOFOLLOW ?? 0));
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

export function openVerifiedRegular(
  path: string,
  label: string,
  expected?: FileIdentity,
): { fd: number; identity: FileIdentity } {
  return openVerifiedRegularWithFlags(path, label, constants.O_RDONLY, expected);
}

export function openVerifiedRegularForUpdate(
  path: string,
  label: string,
  expected?: FileIdentity,
): { fd: number; identity: FileIdentity } {
  return openVerifiedRegularWithFlags(path, label, constants.O_RDWR, expected);
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

function writerTempCanonicalName(name: string): string | undefined {
  const coreWriter = /^\.(.+\.episode\.json)\.\d+\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/i
    .exec(name);
  if (coreWriter) return coreWriter[1];
  const pythonWriter = /^\.(.+)\.([A-Za-z0-9_-]{8})\.tmp$/.exec(name);
  return pythonWriter ? `${pythonWriter[1]}.episode.json` : undefined;
}

function isWriterTempAlias(name: string, canonicalName: string): boolean {
  return writerTempCanonicalName(name) === canonicalName;
}

function assertLinkedPublicationStat(stat: Stats, path: string, label: string): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
  assertSafeOwner(stat, path, label);
}

/**
 * Complete the one recoverable interval in no-clobber episode publication.
 *
 * Both writers fsync a complete private temp file, hardlink it at the
 * canonical name, fsync the directory, and finally remove the temp alias. A
 * process or host crash after link(2) can therefore leave exactly two names
 * for the same inode. Under the store lock, recognize only the two writer
 * namespaces and remove the proven temp alias. Arbitrary hardlinks remain
 * rejected by the normal reader path.
 */
export function recoverWriterPublicationAliases(directory: string): void {
  const names = readdirSync(directory).sort();
  const canonicalNames = names.filter((name) => name.endsWith('.episode.json'));
  for (const canonicalName of canonicalNames) {
    const canonicalPath = join(directory, canonicalName);
    const canonical = lstatSync(canonicalPath);
    if (canonical.nlink === 1) continue;
    assertLinkedPublicationStat(canonical, canonicalPath, 'published evidence episode');
    if (canonical.nlink !== 2) continue;

    const canonicalIdentity = identityFrom(canonical);
    const aliases = names.filter((name) => {
      if (!isWriterTempAlias(name, canonicalName)) return false;
      const alias = lstatSync(join(directory, name));
      return sameIdentity(identityFrom(alias), canonicalIdentity);
    });
    if (aliases.length !== 1) continue;

    const aliasPath = join(directory, aliases[0]!);
    const alias = lstatSync(aliasPath);
    assertLinkedPublicationStat(alias, aliasPath, 'evidence publication temp alias');
    if (alias.nlink !== 2 || !sameIdentity(identityFrom(alias), canonicalIdentity)) continue;

    // Pin both names before cleanup. The evidence directory is owner-only and
    // all Jinn writers hold the shared lock; deliberate mutation by another
    // process running as the same uid is outside the local-store threat model.
    const canonicalFd = openSync(
      canonicalPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const aliasFd = openSync(aliasPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const openedCanonical = fstatSync(canonicalFd);
      const openedAlias = fstatSync(aliasFd);
      assertLinkedPublicationStat(
        openedCanonical,
        canonicalPath,
        'published evidence episode',
      );
      assertLinkedPublicationStat(
        openedAlias,
        aliasPath,
        'evidence publication temp alias',
      );
      if (
        openedCanonical.nlink !== 2
        || openedAlias.nlink !== 2
        || !sameIdentity(identityFrom(openedCanonical), canonicalIdentity)
        || !sameIdentity(identityFrom(openedAlias), canonicalIdentity)
      ) {
        throw new Error(`evidence publication aliases changed during recovery: ${canonicalPath}`);
      }
      const aliasAtCommit = lstatSync(aliasPath);
      const canonicalAtCommit = lstatSync(canonicalPath);
      if (
        !sameIdentity(identityFrom(aliasAtCommit), canonicalIdentity)
        || !sameIdentity(identityFrom(canonicalAtCommit), canonicalIdentity)
      ) {
        throw new Error(`evidence publication aliases changed before recovery: ${canonicalPath}`);
      }
      unlinkSync(aliasPath);
      fsyncDirectory(directory);
    } finally {
      closeSync(aliasFd);
      closeSync(canonicalFd);
    }
    secureRegularPath(canonicalPath, 'recovered evidence episode', canonicalIdentity);
  }

  // A crash before link(2) leaves only the complete nlink=1 temp. Because
  // temp creation also happens under this store lock, no cooperating writer
  // can still be using it while recovery holds the lock.
  for (const name of names) {
    if (!writerTempCanonicalName(name)) continue;
    const path = join(directory, name);
    let identity: FileIdentity | undefined;
    try {
      identity = inspectRegularPath(path, 'abandoned evidence publication temp');
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') continue;
      throw error;
    }
    if (!identity) continue;
    const opened = openVerifiedRegular(
      path,
      'abandoned evidence publication temp',
      identity,
    );
    try {
      const atCommit = lstatSync(path);
      assertRegularStat(atCommit, path, 'abandoned evidence publication temp');
      if (!sameIdentity(identityFrom(atCommit), opened.identity)) {
        throw new Error(`evidence publication temp changed before cleanup: ${path}`);
      }
      unlinkSync(path);
      fsyncDirectory(directory);
    } finally {
      closeSync(opened.fd);
    }
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
