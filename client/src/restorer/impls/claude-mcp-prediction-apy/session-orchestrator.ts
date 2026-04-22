/**
 * Session orchestrator for claude-mcp-prediction-apy.
 *
 * Single-session. Spawns Claude once with the APY prediction MCP + prompt,
 * polls for submit_apy_prediction, then terminates after a short grace period.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { SessionResult } from './types.js';

export interface OrchestratorDeps {
  claudePath: string;
  claudeModel?: string;
  mcpConfigPath: string;
  workingDir: string;
  abort: AbortSignal;
  log: (event: { level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }) => void;
  /** Poll callback — returns true once submit_apy_prediction has been invoked. */
  isSubmitted: () => boolean;
  sessionMaxMs?: number;
  pollIntervalMs?: number;
  submissionGraceMs?: number;
  _spawnFn?: typeof spawn;
}

const DEFAULT_SESSION_MAX_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_SUBMISSION_GRACE_MS = 2_000;

export async function spawnSession(sessionId: string, prompt: string, deps: OrchestratorDeps): Promise<SessionResult> {
  const sessionMaxMs = deps.sessionMaxMs ?? DEFAULT_SESSION_MAX_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const submissionGraceMs = deps.submissionGraceMs ?? DEFAULT_SUBMISSION_GRACE_MS;

  const sessionDir = join(deps.workingDir, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });

  const transcriptPath = join(sessionDir, 'transcript.txt');
  const startedAt = Date.now();
  writeFileSync(
    transcriptPath,
    `=== Session ${sessionId} started at ${new Date(startedAt).toISOString()} ===\n\n`,
  );

  const args = [
    '-p', prompt,
    '--mcp-config', deps.mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools', 'mcp__jinn-apy-prediction__*',
  ];
  if (deps.claudeModel) args.push('--model', deps.claudeModel);

  const agentEnv: Record<string, string> = {};
  for (const key of [
    'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'NODE_PATH', 'NODE_OPTIONS', 'NPM_CONFIG_PREFIX',
    'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY',
  ]) {
    if (process.env[key]) agentEnv[key] = process.env[key]!;
  }

  deps.log({ level: 'info', msg: `apy-prediction-session: spawning ${sessionId}`, data: { claudePath: deps.claudePath } });

  const spawnFn = deps._spawnFn ?? spawn;

  return new Promise<SessionResult>((resolve) => {
    const child: ChildProcess = spawnFn(deps.claudePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: agentEnv,
    });

    let stdout = '';
    let aborted = false;
    let terminatedEarly = false;

    child.stdout?.on('data', (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      appendFileSync(transcriptPath, chunk);
    });
    child.stderr?.on('data', (d: Buffer) => {
      appendFileSync(transcriptPath, `[stderr] ${d.toString()}`);
    });

    const sessionTimeout = setTimeout(() => {
      if (!child.killed) {
        deps.log({ level: 'warn', msg: `apy-prediction-session: ${sessionId} reached sessionMaxMs; killing`, data: { sessionMaxMs } });
        child.kill('SIGTERM');
      }
    }, sessionMaxMs);

    let graceTimer: NodeJS.Timeout | null = null;
    const pollTimer = setInterval(() => {
      if (graceTimer || child.killed) return;
      if (deps.isSubmitted()) {
        deps.log({ level: 'info', msg: `apy-prediction-session: ${sessionId} submit_apy_prediction invoked; scheduling graceful termination` });
        terminatedEarly = true;
        graceTimer = setTimeout(() => {
          if (!child.killed) child.kill('SIGTERM');
        }, submissionGraceMs);
      }
    }, pollIntervalMs);

    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      deps.log({ level: 'info', msg: `apy-prediction-session: ${sessionId} window abort; killing` });
      child.kill('SIGTERM');
    };
    deps.abort.addEventListener('abort', onAbort);

    const cleanup = () => {
      clearTimeout(sessionTimeout);
      if (graceTimer) clearTimeout(graceTimer);
      clearInterval(pollTimer);
      deps.abort.removeEventListener('abort', onAbort);
    };

    child.on('exit', (code, signal) => {
      cleanup();
      const endedAt = Date.now();
      appendFileSync(
        transcriptPath,
        `\n\n=== Session ended at ${new Date(endedAt).toISOString()} (code=${code} signal=${signal} submitted=${deps.isSubmitted()} terminatedEarly=${terminatedEarly} aborted=${aborted}) ===\n`,
      );
      deps.log({
        level: 'info',
        msg: `apy-prediction-session: ${sessionId} exited`,
        data: { code, signal, durationMs: endedAt - startedAt, submitted: deps.isSubmitted(), aborted },
      });
      resolve({
        sessionId,
        startedAt,
        endedAt,
        transcriptPath,
        submitted: deps.isSubmitted(),
        stdout,
        aborted: aborted || deps.abort.aborted,
      });
    });

    child.on('error', (err) => {
      cleanup();
      const endedAt = Date.now();
      appendFileSync(transcriptPath, `\n\n=== Session spawn error: ${err.message} ===\n`);
      deps.log({ level: 'error', msg: `apy-prediction-session: ${sessionId} spawn error`, data: { err: err.message } });
      resolve({
        sessionId,
        startedAt,
        endedAt,
        transcriptPath,
        submitted: deps.isSubmitted(),
        stdout,
        aborted: deps.abort.aborted,
      });
    });
  });
}
