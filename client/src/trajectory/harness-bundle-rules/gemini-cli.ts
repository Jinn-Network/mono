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

function expandPath(p: string, home: string, baseDir: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  if (path.isAbsolute(p)) return p;
  return path.resolve(baseDir, p);
}

const PROMPT_KEYS = new Set([
  'systemPromptFile',
  'system_prompt_file',
  'promptFile',
  'prompt_file',
  'promptFiles',
  'prompt_files',
  'instructionsFile',
  'instructions_file',
]);

/**
 * Walk an arbitrary JSON value collecting string values that appear under
 * any key named in PROMPT_KEYS. Tolerant of nesting and arrays-of-strings.
 */
function collectPromptRefs(value: unknown, parentKey: string | null, out: string[]): void {
  if (value == null) return;
  if (typeof value === 'string') {
    if (parentKey && PROMPT_KEYS.has(parentKey)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPromptRefs(item, parentKey, out);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectPromptRefs(v, k, out);
    }
  }
}

/**
 * Gemini CLI harness-bundle snapshot rule.
 *
 * Files (per spec §3.2):
 *   - ~/.gemini/settings.json
 *   - custom prompt files referenced from settings.json (any string value
 *     under a key named systemPromptFile / promptFile / promptFiles /
 *     instructionsFile, snake_case variants accepted)
 *
 * Pragmatic v0 addition:
 *   - every file under ~/.gemini/prompts/ (Gemini CLI's conventional
 *     prompt-snippet directory)
 */
export const geminiCliSnapshotRule: SnapshotRule = {
  tool: 'gemini-cli',
  async candidatePaths(input: { home: string; repoRoot?: string }): Promise<string[]> {
    const dir = path.join(input.home, '.gemini');
    const settingsPath = path.join(dir, 'settings.json');
    const out: string[] = [settingsPath];

    let raw = '';
    try {
      raw = await readFile(settingsPath, 'utf-8');
    } catch {
      // missing settings — no refs to collect
    }
    if (raw) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // malformed JSON — skip ref extraction; caller still gets settings.json itself
      }
      const refs: string[] = [];
      collectPromptRefs(parsed, null, refs);
      for (const ref of refs) {
        out.push(expandPath(ref, input.home, dir));
      }
    }

    // ~/.gemini/prompts/**
    out.push(...(await listFilesRecursive(path.join(dir, 'prompts'))));

    return out;
  },
};

registerRule(geminiCliSnapshotRule);
