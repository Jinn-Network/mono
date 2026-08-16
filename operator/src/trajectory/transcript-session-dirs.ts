/**
 * Standard per-tool session transcript directories for Path B tail watching.
 *
 * Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §4.2 path B.
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { WatchedDirectory } from './transcript-watcher.js';

export function resolveCodexHomeDir(): string {
  return process.env['CODEX_HOME']?.trim() || join(homedir(), '.codex');
}

export function resolveCodexSessionsDir(): string {
  return join(resolveCodexHomeDir(), 'sessions');
}

export function resolveClaudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

export function sessionIdFromJsonlPath(filePath: string): string {
  const name = basename(filePath);
  return name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name;
}

async function listJsonlFilesRecursive(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listJsonlFilesRecursive(full)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

/** Lists `*.jsonl` session files under `directory` (flat or recursive). */
export async function listSessionJsonlFiles(
  directory: string,
  recursive: boolean,
): Promise<string[]> {
  if (recursive) {
    return listJsonlFilesRecursive(directory);
  }
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => join(directory, e.name));
}

/**
 * Default Path-B directories for tools that write session JSONL to well-known
 * locations. Missing directories are omitted so a fresh operator machine does
 * not fail daemon startup.
 */
export function defaultTranscriptWatchDirectories(): WatchedDirectory[] {
  const dirs: WatchedDirectory[] = [];
  const codexSessions = resolveCodexSessionsDir();
  if (existsSync(codexSessions)) {
    dirs.push({
      tool: 'codex',
      directory: codexSessions,
      sessionIdFromPath: sessionIdFromJsonlPath,
    });
  }
  const claudeProjects = resolveClaudeProjectsDir();
  if (existsSync(claudeProjects)) {
    dirs.push({
      tool: 'claude-code',
      directory: claudeProjects,
      recursive: true,
      sessionIdFromPath: sessionIdFromJsonlPath,
    });
  }
  return dirs;
}
