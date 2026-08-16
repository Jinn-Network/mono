/**
 * Path containment helpers — defence against `..` traversal and
 * absolute-path escapes when joining attacker-influenced relative
 * paths into a daemon-owned base directory.
 *
 * Manifest-bearing packages honour the convention that manifest entries are
 * package-relative paths; this helper enforces that contract at runtime as
 * belt-and-suspenders for the schema regex.
 */

import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Returns true iff `candidate` resolves to a path strictly inside
 * `baseDir`. Rejects:
 *   - dotdot traversal (`./../etc/passwd`)
 *   - absolute paths that point outside (`/etc/passwd`)
 *   - paths equal to `baseDir` itself (the base is a directory, not a
 *     file we'd expect to import)
 *
 * Symlink escapes are NOT resolved here — callers that hand untrusted
 * symlink-bearing trees should additionally `fs.realpath` both sides.
 */
export function isInsidePackageDir(baseDir: string, candidate: string): boolean {
  const base = resolve(baseDir);
  const cand = resolve(candidate);
  const rel = relative(base, cand);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
