/**
 * Shared reasoning about `<default state dir>/keystore-password` (#2515, #4086).
 *
 * That path is NOT earning-dir relative: `main.ts` and `resolveCliPassword` read
 * exactly this one file whatever earning dir a caller targets, so it is host-wide
 * state, not per-operator state. Both password-rotation surfaces — the
 * `jinn keys change-password` CLI and `POST /v1/setup/change-password` — must
 * therefore prove the file belongs to the keystore they just rotated before
 * touching it. The CLI deletes it; the endpoint rewrites it. Same proof.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mnemonicKeystorePath } from './store.js';

/**
 * Whether the password file is proven stale by a successful rotation — i.e. it
 * holds the authenticated old password and the keystore it opens is the one that
 * was just re-encrypted. The file must contain the authenticated old password,
 * and the default keystore must be either the rotated file or absent (the
 * supported single-operator custom-dir case).
 *
 * Never infer staleness from a failed decryption of another keystore: damaged
 * mnemonic metadata can fail reconstruction while its V3 private key remains
 * recoverable with this password. Preserve any other existing default keystore's
 * password, including corrupt or unfamiliar payloads, without decrypting it.
 * Canonical file paths recognize directory aliases while atomic replacement of a
 * file symlink correctly leaves its former target protected.
 *
 * Call AFTER the new keystore is saved. Filesystem uncertainty keeps the file.
 * Two custom-dir operators sharing this file still cannot be distinguished when
 * no default keystore exists; ceremony.ts already requires explicit passwords
 * for non-default operator directories.
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
    const defaultKeystorePath = mnemonicKeystorePath(defaultEarningDir);
    try {
      lstatSync(defaultKeystorePath);
    } catch (err) {
      // Only absence establishes the custom-dir case. Permission or other errors
      // do not prove that another operator's keystore is absent.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw err;
    }
    // A dangling symlink exists but cannot be classified: realpath then throws
    // into the conservative catch below rather than treating it as absent.
    return realpathSync(defaultKeystorePath) === realpathSync(mnemonicKeystorePath(earningDir));
  } catch (err) {
    warn(
      `[warn] Could not tell whether ${passwordFilePath} is still in use ` +
        `(${err instanceof Error ? err.message : String(err)}); leaving it in place.`,
    );
    return false;
  }
}
