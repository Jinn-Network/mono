/**
 * Per-operator keystore password files (#4087).
 *
 * The primary path is `<earningDir>/keystore-password`, next to the keystore.
 * A host-wide `<default state dir>/keystore-password` remains a read fallback
 * for existing single-operator installs. New auto-generation never writes the
 * legacy file. Rotation may mutate legacy only for the default operator.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveDefaultStateDir } from '../state-dir.js';
import { mnemonicKeystorePath } from './store.js';

export function primaryKeystorePasswordPath(earningDir: string): string {
  return join(earningDir, 'keystore-password');
}

export function legacyKeystorePasswordPath(options?: {
  home?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = options?.env ?? process.env;
  const home = options?.home ?? env['HOME'] ?? env['USERPROFILE'] ?? homedir();
  return join(resolveDefaultStateDir({ home, env }), 'keystore-password');
}

function readNonEmptyPasswordFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const value = readFileSync(path, 'utf-8').trim();
  return value.length > 0 ? value : undefined;
}

export function readKeystorePasswordFile(
  earningDir: string | undefined,
  env: NodeJS.ProcessEnv,
): { password: string; path: string; source: 'primary' | 'legacy' } | undefined {
  const home = env['HOME'] ?? env['USERPROFILE'] ?? homedir();
  if (earningDir) {
    const primaryPath = primaryKeystorePasswordPath(earningDir);
    const primary = readNonEmptyPasswordFile(primaryPath);
    if (primary) return { password: primary, path: primaryPath, source: 'primary' };
  }
  const legacyPath = legacyKeystorePasswordPath({ home, env });
  const legacy = readNonEmptyPasswordFile(legacyPath);
  if (legacy) return { password: legacy, path: legacyPath, source: 'legacy' };
  return undefined;
}

/**
 * Persist a keystore password at `path` via `replacePasswordFileAtomically`
 * (sibling tmp + rename): a failed write never truncates a live file, and a
 * symlink at `path` is replaced rather than written through (#4610).
 */
export function writeKeystorePasswordFile(path: string, password: string): void {
  replacePasswordFileAtomically(path, password + '\n');
}

export function writePrimaryKeystorePassword(earningDir: string, password: string): string {
  const path = primaryKeystorePasswordPath(earningDir);
  writeKeystorePasswordFile(path, password);
  return path;
}

/**
 * Whether the host-wide legacy password file is proven stale by a successful
 * default-operator rotation. The file must hold the authenticated old password,
 * and `earningDir` must be the default operator's keystore. Absence of the
 * default keystore is not license to delete a shared file.
 *
 * Call AFTER the new keystore is saved. Filesystem uncertainty keeps the file.
 */
export function passwordFileIsStale(
  passwordFilePath: string,
  defaultEarningDir: string,
  earningDir: string,
  currentPassword: string,
  newPassword: string,
  warn: (message: string) => void,
): boolean {
  if (!existsSync(passwordFilePath)) return false;
  try {
    const value = readFileSync(passwordFilePath, 'utf-8').trim();
    if (value !== currentPassword || value === newPassword) return false;
    return isDefaultOperatorKeystore(defaultEarningDir, earningDir, warn);
  } catch (err) {
    warn(
      `[warn] Could not tell whether ${passwordFilePath} is still in use ` +
        `(${err instanceof Error ? err.message : String(err)}); leaving it in place.`,
    );
    return false;
  }
}

/**
 * Whether `earningDir` holds the very keystore the host-wide password file is
 * for — i.e. this is a default-operator rotation. Only then may a rotation
 * mutate that file. Filesystem uncertainty answers "no".
 *
 * Call AFTER the new keystore is saved, so the rotated file is known to exist.
 */
export function isDefaultOperatorKeystore(
  defaultEarningDir: string,
  earningDir: string,
  warn: (message: string) => void,
): boolean {
  try {
    return (
      realpathSync(mnemonicKeystorePath(defaultEarningDir)) ===
      realpathSync(mnemonicKeystorePath(earningDir))
    );
  } catch (err) {
    warn(
      `[warn] Could not tell whether ${earningDir} is the default operator's keystore ` +
        `(${err instanceof Error ? err.message : String(err)}); not writing a password file.`,
    );
    return false;
  }
}

/**
 * Replace `path` with `contents` at mode 0600 via a sibling temp file and
 * rename. A failed write never truncates the live file. `rename` replaces a
 * symlink at `path` rather than writing through it, so the former target
 * stays protected (#4610).
 */
export function replacePasswordFileAtomically(path: string, contents: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, contents, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* tmp may never have been created */ }
    throw err;
  }
}
