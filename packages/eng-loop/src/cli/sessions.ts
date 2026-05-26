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

export {};
