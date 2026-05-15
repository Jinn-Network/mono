import { readdir, readFile } from 'node:fs/promises';
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
 * Expand a leading "~" or "~/" in a path against the supplied home dir.
 * Other paths (absolute or already-relative) are returned unchanged when
 * absolute, or resolved against `baseDir` when relative.
 */
function expandPath(p: string, home: string, baseDir: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  if (path.isAbsolute(p)) return p;
  return path.resolve(baseDir, p);
}

/**
 * Best-effort extraction of file-path values from a Codex config.toml. We
 * deliberately avoid pulling in a TOML parser for v0 — Codex's config is
 * mostly small and stable, and the keys we care about (`instructions_file`,
 * `prompt_file`) are written as `key = "value"` at the top level. If a key
 * appears multiple times we collect each occurrence.
 *
 * Future-proofing note: when richer Codex config support lands (sub-tables,
 * arrays of prompts), swap this for a real TOML parser.
 */
function extractReferencedPaths(toml: string): string[] {
  const keys = ['instructions_file', 'prompt_file', 'prompts_file'];
  const out: string[] = [];
  for (const key of keys) {
    const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'gm');
    let match: RegExpExecArray | null;
    while ((match = re.exec(toml)) !== null) {
      out.push(match[1]);
    }
  }
  return out;
}

/**
 * Codex harness-bundle snapshot rule.
 *
 * Files (per spec §3.2):
 *   - ~/.codex/config.toml
 *   - custom prompt/instruction files referenced from config.toml
 *
 * Pragmatic v0 additions:
 *   - every file under ~/.codex/prompts/ (Codex's conventional prompt-snippet
 *     directory). Paths missing on disk are silently ignored downstream.
 */
export const codexSnapshotRule: SnapshotRule = {
  tool: 'codex',
  async candidatePaths(input: { home: string; repoRoot?: string }): Promise<string[]> {
    const codexDir = path.join(input.home, '.codex');
    const configPath = path.join(codexDir, 'config.toml');
    const out: string[] = [configPath];

    // Read config.toml (if present) to resolve referenced files.
    let toml = '';
    try {
      toml = await readFile(configPath, 'utf-8');
    } catch {
      // missing config — skip referenced-file extraction
    }
    if (toml) {
      for (const ref of extractReferencedPaths(toml)) {
        out.push(expandPath(ref, input.home, codexDir));
      }
    }

    // ~/.codex/prompts/**
    out.push(...(await listFilesRecursive(path.join(codexDir, 'prompts'))));

    return out;
  },
};

registerRule(codexSnapshotRule);
