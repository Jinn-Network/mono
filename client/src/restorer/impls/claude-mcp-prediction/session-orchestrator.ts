/**
 * Session orchestrator for claude-mcp-prediction.
 *
 * Single-session (no cadence loop, no market-move triggers). Spawns Claude
 * once with the prediction MCP + prompt, polls a shared "submitted" flag to
 * detect `submit_prediction` tool call, and terminates after a short grace
 * period so Claude's tool response reaches it.
 *
 * Slimmed-down version of:
 *   client/src/restorer/impls/claude-mcp-hyperliquid/session-orchestrator.ts:97-209
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { SessionResult } from './types.js';
import type { TrajectoryCollector } from '../../../trajectory/index.js';

export interface OrchestratorDeps {
  claudePath: string;
  claudeModel?: string;
  mcpConfigPath: string;
  workingDir: string;
  abort: AbortSignal;
  log: (event: { level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }) => void;
  /** Poll callback — returns true once submit_prediction has been invoked. */
  isSubmitted: () => boolean;
  /** Max wall time for the session (ms). Default 3 min. */
  sessionMaxMs?: number;
  /** Interval at which we poll isSubmitted (ms). Default 500. */
  pollIntervalMs?: number;
  /** Grace period after submission before killing Claude (ms). Default 2s. */
  submissionGraceMs?: number;
  /** Injected spawn fn for tests. Defaults to child_process.spawn. */
  _spawnFn?: typeof spawn;
  /**
   * Trajectory collector — when present, each session spawn emits a
   * jinn.state_transition span covering the subprocess lifetime.
   * Scope §3.2 traced-I/O boundary.
   */
  trajectory?: TrajectoryCollector;
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
  const startNs = `${BigInt(startedAt) * 1_000_000n}`;
  writeFileSync(
    transcriptPath,
    `=== Session ${sessionId} started at ${new Date(startedAt).toISOString()} ===\n\n`,
  );

  const args = [
    '-p', prompt,
    '--mcp-config', deps.mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools', 'mcp__jinn-prediction__*',
  ];
  if (deps.claudeModel) args.push('--model', deps.claudeModel);

  // Minimal env allowlist — same set as the HL orchestrator.
  const agentEnv: Record<string, string> = {};
  for (const key of [
    'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'NODE_PATH', 'NODE_OPTIONS', 'NPM_CONFIG_PREFIX',
    // Anthropic auth — required for Claude Code to reach the model.
    'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY',
  ]) {
    if (process.env[key]) agentEnv[key] = process.env[key]!;
  }

  deps.log({ level: 'info', msg: `prediction-session: spawning ${sessionId}`, data: { claudePath: deps.claudePath } });

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
        deps.log({ level: 'warn', msg: `prediction-session: ${sessionId} reached sessionMaxMs; killing`, data: { sessionMaxMs } });
        child.kill('SIGTERM');
      }
    }, sessionMaxMs);

    // Poll for submit_prediction: once the flag flips, give Claude a short grace
    // window to receive the tool response + close the connection, then SIGTERM.
    let graceTimer: NodeJS.Timeout | null = null;
    const pollTimer = setInterval(() => {
      if (graceTimer || child.killed) return;
      if (deps.isSubmitted()) {
        deps.log({ level: 'info', msg: `prediction-session: ${sessionId} submit_prediction invoked; scheduling graceful termination` });
        terminatedEarly = true;
        graceTimer = setTimeout(() => {
          if (!child.killed) child.kill('SIGTERM');
        }, submissionGraceMs);
      }
    }, pollIntervalMs);

    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      deps.log({ level: 'info', msg: `prediction-session: ${sessionId} window abort; killing` });
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
      const endNs = `${BigInt(endedAt) * 1_000_000n}`;
      appendFileSync(
        transcriptPath,
        `\n\n=== Session ended at ${new Date(endedAt).toISOString()} (code=${code} signal=${signal} submitted=${deps.isSubmitted()} terminatedEarly=${terminatedEarly} aborted=${aborted}) ===\n`,
      );
      deps.log({
        level: 'info',
        msg: `prediction-session: ${sessionId} exited`,
        data: { code, signal, durationMs: endedAt - startedAt, submitted: deps.isSubmitted(), aborted },
      });
      const exitCode = code ?? -1;
      deps.trajectory?.addSpan({
        name: `subprocess.${deps.claudePath}`,
        kind: 'INTERNAL',
        startTimeUnixNano: startNs,
        endTimeUnixNano: endNs,
        attributes: {
          'jinn.span.kind': 'jinn.state_transition',
          'jinn.state.from': 'PREPARED',
          'jinn.state.to': 'RAN_CLAUDE',
          'subprocess.cmd': deps.claudePath,
          'subprocess.args': args,
          'subprocess.exit_code': exitCode,
          'session.id': sessionId,
          'prediction.submitted': deps.isSubmitted(),
        },
        events: [],
        status: exitCode === 0 || signal ? { code: 'OK' } : { code: 'ERROR', message: `exit ${exitCode}` },
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
      const endNs = `${BigInt(endedAt) * 1_000_000n}`;
      appendFileSync(transcriptPath, `\n\n=== Session spawn error: ${err.message} ===\n`);
      deps.log({ level: 'error', msg: `prediction-session: ${sessionId} spawn error`, data: { err: err.message } });
      deps.trajectory?.addSpan({
        name: `subprocess.${deps.claudePath}`,
        kind: 'INTERNAL',
        startTimeUnixNano: startNs,
        endTimeUnixNano: endNs,
        attributes: {
          'jinn.span.kind': 'jinn.state_transition',
          'jinn.state.from': 'PREPARED',
          'jinn.state.to': 'RAN_CLAUDE',
          'subprocess.cmd': deps.claudePath,
          'subprocess.args': args,
          'subprocess.exit_code': -1,
          'session.id': sessionId,
          'prediction.submitted': deps.isSubmitted(),
        },
        events: [{ timeUnixNano: endNs, name: 'exception', attributes: { 'exception.message': err.message } }],
        status: { code: 'ERROR', message: err.message },
      });
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
