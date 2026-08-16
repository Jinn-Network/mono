/**
 * Deterministic recursive package-content hash for `manifest.package.hash`
 * verification. Walks the package directory in sorted order, hashes each
 * file's `relPath + "\0" + contents`, and folds the per-file digests into
 * a rolling sha256 to produce a single hex digest the daemon can compare
 * against the manifest's claimed `sha256:<64hex>`.
 *
 * Exclusions mirror `walkArtifacts` / `createWorkdirTarball` in
 * `engine/packaging.ts`: `node_modules/`, `.git/`, `test/`, dotfiles,
 * symlinks. Absolute paths and symlinks short-circuit (we never follow
 * them) — the publisher must produce a pure tree of regular files.
 *
 * The relative path is normalised to forward-slash form before hashing so
 * the digest is stable across Linux / macOS / Windows publishers.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { JinnManifest } from '../manifest/index.js';

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'test']);

function shouldSkip(name: string): boolean {
  if (name.startsWith('.')) return true; // dotfiles + .git, .DS_Store, etc.
  if (EXCLUDED_DIRS.has(name)) return true;
  return false;
}

function collectFiles(packageDir: string, current: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(current);
  } catch {
    return;
  }
  entries.sort();
  for (const name of entries) {
    if (shouldSkip(name)) continue;
    const full = join(current, name);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    // Refuse to follow symlinks — the package-hash contract is a tree
    // of regular files anchored at packageDir.
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      collectFiles(packageDir, full, out);
    } else if (st.isFile()) {
      // Always exclude the manifest itself: its hash field is a
      // commitment to the rest of the package (and the signature
      // makes it tamper-evident on its own).
      const rel = relative(packageDir, full);
      if (rel === 'jinn.manifest.json') continue;
      out.push(full);
    }
  }
}

/**
 * Compute the deterministic package-content sha256 for `packageDir`.
 * Returned as `sha256:<64hex>` to match the manifest field shape.
 */
export function computePackageHash(packageDir: string): `sha256:${string}` {
  const files: string[] = [];
  collectFiles(packageDir, packageDir, files);
  // collectFiles produces sorted-per-directory order; normalise to a
  // single global sort over POSIX-form relative paths so the digest is
  // platform-stable.
  const ordered = files
    .map((abs) => ({
      abs,
      rel: relative(packageDir, abs).split(sep).join('/'),
    }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const rolling = createHash('sha256');
  for (const { abs, rel } of ordered) {
    const contents = readFileSync(abs);
    const perFile = createHash('sha256')
      .update(rel)
      .update(Buffer.from([0]))
      .update(contents)
      .digest();
    rolling.update(perFile);
  }
  return `sha256:${rolling.digest('hex')}`;
}

/**
 * Verify the package directory matches `manifest.package.hash`.
 * Returns true iff the recomputed digest matches exactly.
 */
export async function verifyPackageHash(
  packageDir: string,
  manifest: JinnManifest,
): Promise<boolean> {
  const expected = manifest.package.hash;
  const actual = computePackageHash(packageDir);
  return actual === expected;
}
