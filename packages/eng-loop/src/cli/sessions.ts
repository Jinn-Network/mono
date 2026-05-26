/**
 * `yarn eng:loop sessions` — surface live and recently-finished Claude Code
 * sessions spawned by the dispatcher.
 *
 * Spec: docs/superpowers/specs/2026-05-26-eng-loop-sessions-subcommand.md
 * Plan: docs/superpowers/plans/2026-05-26-eng-loop-sessions-subcommand-plan.md
 *
 * Issue: jinn-mono#587
 */

export interface SessionRecord {
  issueNumber: number;
  status: 'alive' | 'done' | 'stale';
  pid: number | null;
  worktreePath: string;
  transcriptPath: string;
  sessionId: string;
  lastActivity: string;           // ISO-8601
  lastSummary: string | null;     // truncated to 200 chars
  prUrl: string | null;
}

export interface SessionsDeps {
  worktreesBase: string;
  claudeProjectsDir: string;
  now: () => number;
  listProjectDirs: (dir: string) => Promise<string[]>;
  listJsonlFiles: (dir: string) => Promise<Array<{ name: string; mtimeMs: number }>>;
  readJsonl: (path: string) => Promise<string>;
  listClaudeProcesses: () => Promise<Array<{ pid: number }>>;
  resolveProcessCwd: (pid: number) => Promise<string | null>;
  spawnTail: (path: string) => { stdout: NodeJS.ReadableStream; kill: (sig: NodeJS.Signals) => void };
  sendSignal: (pid: number, sig: NodeJS.Signals) => void;
  confirm: (prompt: string) => Promise<boolean>;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  onSigint?: (handler: () => void) => void;
}

export interface KillOptions { force: boolean; }
export interface TailOptions { tailLines: number; /* default 50 */ }

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Encode an absolute worktree path the way Claude Code does when it persists a
 * session transcript under `~/.claude/projects/<dir>/`: every non-alphanumeric
 * character becomes a single `-`, runs of `-` collapse, and any trailing `-`
 * (e.g. from a trailing slash) is trimmed. The leading `-` (from the leading
 * `/` on an absolute path) is preserved — it is load-bearing for round-trips.
 */
export function encodeWorktreePathToProjectDir(path: string): string {
  return path
    .replace(/[^A-Za-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/-+$/, '');
}

import { basename, dirname, resolve as pathResolve } from 'node:path';

/**
 * Return the numeric issue id if `worktreePath` is a direct child of `base`
 * whose leaf is `^\d+$`. The dispatcher's convention is one worktree per
 * issue at `<WORKTREES_BASE>/<N>` — anything else (different base, non-numeric
 * leaf, nested subdirectory) returns null.
 */
export function parseIssueNumberFromWorktree(worktreePath: string, base: string): number | null {
  const resolvedBase = pathResolve(base);
  const resolvedWt = pathResolve(worktreePath);
  if (dirname(resolvedWt) !== resolvedBase) return null;
  const leaf = basename(resolvedWt);
  if (!/^\d+$/.test(leaf)) return null;
  return parseInt(leaf, 10);
}
