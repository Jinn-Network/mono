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

/** Lists `*.jsonl` session files directly under a directory (non-recursive). */
export async function listCodexSessionJsonlFiles(sessionsDir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => join(sessionsDir, e.name));
}

/** Lists all `*.jsonl` files under `~/.claude/projects/**`. */
export async function listClaudeCodeSessionJsonlFiles(projectsDir: string): Promise<string[]> {
  return listJsonlFilesRecursive(projectsDir);
}

export interface TranscriptWatchDirectorySpec {
  tool: WatchedDirectory['tool'];
  directory: string;
  recursive: boolean;
}

/**
 * Default Path-B directories for tools that write session JSONL to well-known
 * locations. Missing directories are omitted so a fresh operator machine does
 * not fail daemon startup.
 */
export function defaultTranscriptWatchDirectorySpecs(): TranscriptWatchDirectorySpec[] {
  const specs: TranscriptWatchDirectorySpec[] = [];
  const codexSessions = resolveCodexSessionsDir();
  if (existsSync(codexSessions)) {
    specs.push({ tool: 'codex', directory: codexSessions, recursive: false });
  }
  const claudeProjects = resolveClaudeProjectsDir();
  if (existsSync(claudeProjects)) {
    specs.push({ tool: 'claude-code', directory: claudeProjects, recursive: true });
  }
  return specs;
}

export function toWatchedDirectories(
  specs: TranscriptWatchDirectorySpec[],
): WatchedDirectory[] {
  return specs.map((spec) => ({
    tool: spec.tool,
    directory: spec.directory,
    recursive: spec.recursive,
    sessionIdFromPath: sessionIdFromJsonlPath,
  }));
}

export async function listSessionJsonlFilesForSpec(
  spec: TranscriptWatchDirectorySpec,
): Promise<string[]> {
  return spec.recursive
    ? listClaudeCodeSessionJsonlFiles(spec.directory)
    : listCodexSessionJsonlFiles(spec.directory);
}
