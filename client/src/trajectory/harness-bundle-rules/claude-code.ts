import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { registerRule, type SnapshotRule } from './types.js';

/**
 * Recursively list all regular files beneath `dir`. Returns absolute paths.
 * Returns [] if the directory does not exist (no throw).
 */
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
 * Claude Code harness-bundle snapshot rule.
 *
 * Files (per spec §3.2):
 *   - ~/.claude/CLAUDE.md
 *   - <repoRoot>/CLAUDE.md (when repoRoot supplied)
 *   - ~/.claude/settings.json (subset filtering — model + hooks + mcpServers —
 *     happens at content-canonicalisation time downstream of the assembler;
 *     this rule returns the raw file path)
 *   - every file under ~/.claude/skills/
 *   - every file under ~/.claude/plugins/<plugin>/skills/
 *
 * Existence and allowedDirectories filtering are applied by the assembler.
 */
export const claudeCodeSnapshotRule: SnapshotRule = {
  tool: 'claude-code',
  async candidatePaths(input: { home: string; repoRoot?: string }): Promise<string[]> {
    const out: string[] = [];

    out.push(path.join(input.home, '.claude', 'CLAUDE.md'));
    if (input.repoRoot) {
      out.push(path.join(input.repoRoot, 'CLAUDE.md'));
    }
    out.push(path.join(input.home, '.claude', 'settings.json'));

    // ~/.claude/skills/**
    out.push(...(await listFilesRecursive(path.join(input.home, '.claude', 'skills'))));

    // ~/.claude/plugins/<plugin>/skills/**
    const pluginsDir = path.join(input.home, '.claude', 'plugins');
    let plugins: Dirent[];
    try {
      plugins = await readdir(pluginsDir, { withFileTypes: true });
    } catch {
      plugins = [];
    }
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      out.push(...(await listFilesRecursive(path.join(pluginsDir, plugin.name, 'skills'))));
    }

    return out;
  },
};

registerRule(claudeCodeSnapshotRule);
