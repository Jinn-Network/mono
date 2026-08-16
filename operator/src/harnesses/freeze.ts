/**
 * Deterministic content hashing for implStateDir directories.
 *
 * Used by the daemon's freeze-fence (`operator/src/daemon/freeze-fence.ts`)
 * to detect violations of the frozen-mode contract — a harness MUST NOT
 * mutate `implStateDir` when running with `ctx.mode === 'frozen'`. The
 * daemon hashes the directory before and after each Task and rejects the
 * envelope on mismatch. The same digest is stamped on the delivery envelope
 * as `codeDigest` and surfaced on the daemon status panel.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.3
 * Profiles: docs/superpowers/specs/2026-07-23-impl-state-sharing-by-codedigest-spike.md §3.2/§4.1
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, lstat, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolveHashProfile, type HashProfile, type HashProfileId } from './hash-profile.js';

export interface HashImplStateDirOptions {
  /**
   * Ad hoc ignore list. Legacy surface, kept for harnesses that have no
   * registered public hash profile (`hermes-agent`'s runtime credentials).
   * Mutually exclusive with `profile`.
   */
  ignoreRelPaths?: readonly string[];
  /**
   * Named hash profile. A profile fixes the ignore list *and* enforces the
   * profile's top-level classification: unknown roots, symlinks, and special
   * files fail closed rather than being silently skipped.
   */
  profile?: HashProfileId;
}

/** A top-level path the profile neither ignores nor allows, or a non-regular file. */
export class HashProfileViolationError extends Error {
  readonly profileId: string;
  readonly relPath: string;
  constructor(profileId: string, relPath: string, reason: string) {
    super(`impl-state hash profile "${profileId}" refuses "${relPath}": ${reason}`);
    this.name = 'HashProfileViolationError';
    this.profileId = profileId;
    this.relPath = relPath;
  }
}

function normalizeRelPath(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).join('/');
}

function shouldIgnore(relPath: string, ignored: readonly string[]): boolean {
  return ignored.some((ignoredPath) => relPath === ignoredPath || relPath.startsWith(`${ignoredPath}/`));
}

/**
 * Resolve the hash options a harness's own declaration implies. A registered
 * profile always wins over a legacy ignore list, so a harness that declares
 * both cannot produce two digests for one tree.
 *
 * Every surface that hashes a harness's `implStateDir` calls this — the
 * freeze-fence, the screening runner, the probe scripts — so none of them can
 * drift into hashing with a different exclusion set.
 */
export function harnessHashOptions(harness: {
  freezeStateHashProfile?: HashProfileId;
  freezeStateHashIgnore?: readonly string[];
}): HashImplStateDirOptions | undefined {
  if (harness.freezeStateHashProfile) return { profile: harness.freezeStateHashProfile };
  if (harness.freezeStateHashIgnore?.length) return { ignoreRelPaths: [...harness.freezeStateHashIgnore] };
  return undefined;
}

/**
 * Compute a deterministic SHA-256 hash of an `implStateDir`'s contents.
 *
 * Algorithm:
 *   1. Walk the directory tree recursively.
 *   2. For each file, hash its content with SHA-256.
 *   3. Sort entries by relative path (canonical ordering, OS-independent).
 *   4. Combine "<relpath>:<filehash>\n" lines and hash the whole thing.
 *
 * Properties:
 *   - Deterministic: same content → same hash.
 *   - Order-stable: filesystem listing order does not affect output.
 *   - Order-sensitive: file path differences DO affect output.
 *   - Recursive: walks subdirectories.
 *   - Metadata-independent: mtimes, permissions, file order do not affect output.
 *
 * With `opts.profile`, the walk additionally enforces the profile's top-level
 * classification and refuses anything that is not a directory or a regular
 * file. A profile-ignored root contributes nothing, at any depth, whatever it
 * contains.
 *
 * Cost: O(total bytes) read + SHA-256. For typical claude-code-learner
 * implStateDir (~few MB) this is sub-second.
 *
 * Returns a 64-character lowercase hex string (no `sha256:` prefix; callers
 * that need that prefix add it themselves).
 */
export async function hashImplStateDir(
  dirPath: string,
  opts: HashImplStateDirOptions = {},
): Promise<string> {
  if (opts.profile && opts.ignoreRelPaths) {
    throw new Error('hashImplStateDir: `profile` and `ignoreRelPaths` are mutually exclusive');
  }
  const profile: HashProfile | undefined = opts.profile ? resolveHashProfile(opts.profile) : undefined;
  const entries: Array<{ relPath: string; fileHash: string }> = [];
  const ignored = (profile?.ignoreRelPaths ?? opts.ignoreRelPaths ?? [])
    .map(normalizeRelPath)
    .filter(Boolean);

  async function walk(currentPath: string, depth: number): Promise<void> {
    const items = (await readdir(currentPath)).sort();
    for (const item of items) {
      const full = join(currentPath, item);
      const relPath = normalizeRelPath(relative(dirPath, full));
      if (shouldIgnore(relPath, ignored)) continue;
      // A control character in a path component could forge the LF-joined
      // "<relPath>:<fileHash>" combining format (a "\n" inside a path merges
      // two entries into one line). Refusal is digest-neutral for every
      // legitimate tree; fail closed under a profile.
      if (profile && /[\u0000-\u001f\u007f]/u.test(item)) {
        throw new HashProfileViolationError(profile.id, relPath, 'control character in path component');
      }
      // Under a profile, lstat: a symlink must fail closed rather than be
      // followed into whatever it points at (spike §4.1).
      const s = profile ? await lstat(full) : await stat(full);
      if (s.isDirectory()) {
        if (profile && depth === 0 && !profile.allowedDirs.includes(item)) {
          throw new HashProfileViolationError(profile.id, relPath, 'unclassified top-level directory');
        }
        await walk(full, depth + 1);
      } else if (s.isFile()) {
        if (profile && depth === 0 && !profile.allowedFiles.includes(item)) {
          throw new HashProfileViolationError(profile.id, relPath, 'unclassified top-level file');
        }
        const content = await readFile(full);
        const fileHash = createHash('sha256').update(content).digest('hex');
        entries.push({ relPath, fileHash });
      } else if (profile) {
        // Symlinks and special files: fail closed rather than inherit the
        // no-profile walk's silent skip.
        throw new HashProfileViolationError(profile.id, relPath, 'not a directory or regular file');
      }
      // No profile: symlinks and special files are skipped (legacy behaviour).
    }
  }

  await walk(dirPath, 0);

  // UTF-16 code-unit order, never localeCompare: the default collator resolves
  // from the host locale (LANG), so the same tree would hash to different
  // values on different machines — and ICU order is not what an independent
  // implementation infers from "sort by relative path". Code-unit comparison
  // is the one order reproducible from the profile's published description.
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const combined = entries.map((e) => `${e.relPath}:${e.fileHash}`).join('\n');
  return createHash('sha256').update(combined).digest('hex');
}
