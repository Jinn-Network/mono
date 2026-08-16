/**
 * Shared single-session orchestrator for the claude-mcp-prediction* impls.
 *
 * Both `claude-mcp-prediction` (probability) and `claude-mcp-prediction-apy`
 * (integer APY bps) follow the same single-session shape:
 *
 *   1. Spawn Claude with a prompt + a single allowed MCP tool namespace.
 *   2. Poll a shared "submitted" flag to detect the submit-tool call.
 *   3. Terminate after a short grace period so Claude's tool response reaches it.
 *
 * The only differences across the two variants are:
 *   - the `--allowedTools` value (e.g. `mcp__jinn-prediction__*`)
 *   - log prefixes (e.g. `prediction-session` vs `apy-prediction-session`)
 *   - the named submit-tool referenced in log lines (cosmetic)
 *
 * Hyperliquid uses a different shape (cadence + market-move trigger) and is
 * intentionally not refactored through this module.
 *
 * Slimmed-down version of:
 *   operator/src/harnesses/impls/claude-mcp-hyperliquid/session-orchestrator.ts:97-209
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { TrajectoryCollector } from '../../../trajectory/index.js';

export interface SingleSessionResult {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  transcriptPath: string;
  /** True iff the configured submit tool was invoked before timeout/abort. */
  submitted: boolean;
  /** Accumulated stdout for post-mortem. */
  stdout: string;
  aborted: boolean;
}

export interface SingleSessionConfig {
  /**
   * Value passed to `--allowedTools`, e.g. `mcp__jinn-prediction__*` or
   * `mcp__jinn-apy-prediction__*`.
   */
  allowedTools: string;
  /**
   * Short tag used as the prefix for log lines, e.g. `prediction-session` or
   * `apy-prediction-session`.
   */
  logTag: string;
  /**
   * Name of the submit tool, used only in human-readable log messages
   * (e.g. `submit_prediction`, `submit_apy_prediction`).
   */
  submissionToolName: string;
}

export interface SingleSessionDeps {
  claudePath: string;
  claudeModel?: string;
  mcpConfigPath: string;
  workingDir: string;
  abort: AbortSignal;
  log: (event: { level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }) => void;
  /** Poll callback — returns true once the submit tool has been invoked. */
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

/**
 * Spawn a single Claude session, poll for a submit-tool flag, and resolve
 * with the session result once the child exits.
 */
export async function runSingleSession(
  sessionId: string,
  prompt: string,
  config: SingleSessionConfig,
  deps: SingleSessionDeps,
): Promise<SingleSessionResult> {
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
    '--allowedTools', config.allowedTools,
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

  deps.log({
    level: 'info',
    msg: `${config.logTag}: spawning ${sessionId}`,
    data: { claudePath: deps.claudePath },
  });

  const spawnFn = deps._spawnFn ?? spawn;

  return new Promise<SingleSessionResult>((resolve) => {
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
        deps.log({
          level: 'warn',
          msg: `${config.logTag}: ${sessionId} reached sessionMaxMs; killing`,
          data: { sessionMaxMs },
        });
        child.kill('SIGTERM');
      }
    }, sessionMaxMs);

    // Poll for the submit tool: once the flag flips, give Claude a short grace
    // window to receive the tool response + close the connection, then SIGTERM.
    let graceTimer: NodeJS.Timeout | null = null;
    const pollTimer = setInterval(() => {
      if (graceTimer || child.killed) return;
      if (deps.isSubmitted()) {
        deps.log({
          level: 'info',
          msg: `${config.logTag}: ${sessionId} ${config.submissionToolName} invoked; scheduling graceful termination`,
        });
        terminatedEarly = true;
        graceTimer = setTimeout(() => {
          if (!child.killed) child.kill('SIGTERM');
        }, submissionGraceMs);
      }
    }, pollIntervalMs);

    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      deps.log({ level: 'info', msg: `${config.logTag}: ${sessionId} window abort; killing` });
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
        msg: `${config.logTag}: ${sessionId} exited`,
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
      deps.log({
        level: 'error',
        msg: `${config.logTag}: ${sessionId} spawn error`,
        data: { err: err.message },
      });
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
