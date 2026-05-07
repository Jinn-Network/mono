/**
 * Deterministic content hashing for implStateDir directories.
 *
 * Used by the daemon's freeze-fence (`client/src/daemon/freeze-fence.ts`)
 * to detect violations of the frozen-mode contract — a harness MUST NOT
 * mutate `implStateDir` when running with `ctx.mode === 'frozen'`. The
 * daemon hashes the directory before and after each Task and rejects the
 * envelope on mismatch.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.3
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

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
 * Cost: O(total bytes) read + SHA-256. For typical claude-code-learner
 * implStateDir (~few MB) this is sub-second.
 *
 * Returns a 64-character lowercase hex string (no `sha256:` prefix; callers
 * that need that prefix add it themselves).
 */
export async function hashImplStateDir(dirPath: string): Promise<string> {
  const entries: Array<{ relPath: string; fileHash: string }> = [];

  async function walk(currentPath: string): Promise<void> {
    const items = (await readdir(currentPath)).sort();
    for (const item of items) {
      const full = join(currentPath, item);
      const s = await stat(full);
      if (s.isDirectory()) {
        await walk(full);
      } else if (s.isFile()) {
        const content = await readFile(full);
        const fileHash = createHash('sha256').update(content).digest('hex');
        entries.push({ relPath: relative(dirPath, full), fileHash });
      }
      // Symlinks and special files are skipped (not expected in implStateDir).
    }
  }

  await walk(dirPath);

  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const combined = entries.map((e) => `${e.relPath}:${e.fileHash}`).join('\n');
  return createHash('sha256').update(combined).digest('hex');
}
