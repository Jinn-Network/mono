import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSolverPluginManifest } from './validator.js';
import type { SolverPluginManifest } from './types.js';

export const MANIFEST_LOOKUP_ORDER = [
  'jinn.plugin.json',
  '.claude-plugin/plugin.json',
  'gemini-extension.json',
] as const;

export function findSolverPluginManifest(root: string): string {
  for (const rel of MANIFEST_LOOKUP_ORDER) {
    const path = join(root, rel);
    if (existsSync(path)) return path;
  }
  throw new Error(`No SolverPlugin manifest found in ${root}`);
}

export function loadSolverPluginManifest(root: string): {
  path: string;
  manifest: SolverPluginManifest;
} {
  const path = findSolverPluginManifest(root);
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  return { path, manifest: validateSolverPluginManifest(raw) };
}
