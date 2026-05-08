import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { registerRule, type SnapshotRule } from './types.js';

async function listFilesRecursive(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Cursor harness-bundle snapshot rule.
 *
 * Files (per spec §3.2):
 *   - <repoRoot>/.cursor/rules/  (every file, recursive)
 *   - <repoRoot>/.cursorrules    (legacy single-file rules)
 *   - <repoRoot>/.cursorignore
 *
 * Caveat (spec §3.2 footnote): Cursor stores its model selection in a
 * SQLite database, not in a file under .cursor/. We deliberately do NOT
 * reach into that SQLite for v0 — it requires a writeable connection
 * which collides with Cursor's own process and the model field is not
 * load-bearing for a replayable harness bundle anyway. Revisit if/when
 * Cursor exposes its config via a stable file path.
 *
 * If `repoRoot` is not supplied, the rule returns an empty list — Cursor
 * is purely repo-local; there are no per-user files to snapshot.
 */
export const cursorSnapshotRule: SnapshotRule = {
  tool: 'cursor',
  async candidatePaths(input: { home: string; repoRoot?: string }): Promise<string[]> {
    if (!input.repoRoot) return [];
    const out: string[] = [];
    out.push(path.join(input.repoRoot, '.cursorrules'));
    out.push(path.join(input.repoRoot, '.cursorignore'));
    out.push(...(await listFilesRecursive(path.join(input.repoRoot, '.cursor', 'rules'))));
    return out;
  },
};

registerRule(cursorSnapshotRule);
