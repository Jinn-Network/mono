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
 * Continue.dev harness-bundle snapshot rule.
 *
 * Files (per spec §3.2):
 *   - ~/.continue/config.yaml
 *   - every file under ~/.continue/prompts/
 *   - every file under ~/.continue/assistants/
 */
export const continueSnapshotRule: SnapshotRule = {
  tool: 'continue',
  async candidatePaths(input: { home: string; repoRoot?: string }): Promise<string[]> {
    const dir = path.join(input.home, '.continue');
    const out: string[] = [path.join(dir, 'config.yaml')];
    out.push(...(await listFilesRecursive(path.join(dir, 'prompts'))));
    out.push(...(await listFilesRecursive(path.join(dir, 'assistants'))));
    return out;
  },
};

registerRule(continueSnapshotRule);
