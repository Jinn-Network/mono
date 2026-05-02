/**
 * Session orchestration for claude-mcp-hyperliquid — §8.4.
 *
 * v0 simplicity:
 * - Sequential (single Claude session at a time)
 * - Cadence: one session every 30 minutes OR triggered by ≥2% mid-price change
 * - Each session: 5-10 min wall time, interrupted at endTs by AbortSignal
 * - Captures session transcript to workingDir/sessions/<sessionId>/transcript.txt
 */

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { TrajectoryCollector } from '../../../trajectory/index.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SessionResult {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  transcriptPath: string;
  /** Whether the session was aborted by the window AbortSignal */
  aborted: boolean;
  /** Stdout from Claude (also written to transcriptPath) */
  stdout: string;
  /** Fill TIDs initiated during this session (populated by caller after fill matching) */
  initiatedFillTids: number[];
}

export interface OrchestratorConfig {
  /** Session cadence: minimum ms between sessions. Default: 30 min */
  cadenceMs: number;
  /** Max session wall time (ms). Default: 8 min */
  sessionMaxMs: number;
  /** Market move threshold to trigger early session. Default: 0.02 (2%) */
  marketMoveTriggerFraction: number;
  /** Coins to monitor for market-move triggers */
  trackedCoins: string[];
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  cadenceMs: 30 * 60 * 1000,
  sessionMaxMs: 8 * 60 * 1000,
  marketMoveTriggerFraction: 0.02,
  trackedCoins: [],
};

/**
 * Merge caller overrides over defaults while discarding explicit `undefined` fields.
 * Callers commonly pass `{ cadenceMs: impl.config.cadenceMs, ... }` where the source
 * is undefined; a naive spread would override defaults with undefined, producing
 * `setTimeout(fn, undefined)` (fires next tick) and zero-length cadence sleeps.
 */
export function resolveOrchestratorConfig(overrides: Partial<OrchestratorConfig> | undefined): OrchestratorConfig {
  const defined = Object.fromEntries(
    Object.entries(overrides ?? {}).filter(([, v]) => v !== undefined),
  );
  return { ...DEFAULT_ORCHESTRATOR_CONFIG, ...defined };
}

export interface OrchestratorDeps {
  claudePath: string;
  claudeModel?: string;
  /** Path to the MCP config JSON for this session */
  mcpConfigPath: string;
  workingDir: string;
  /** Window abort signal — fires at endTs */
  abort: AbortSignal;
  msUntilEndTs: () => number;
  /** Log function */
  log: (event: { level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }) => void;
  /** Fetch current mid prices for tracked coins — used for market-move trigger */
  getMids?: () => Promise<Record<string, string>>;
  /**
   * Called once per session as soon as the Claude subprocess exits, with the
   * SessionResult. Used by the impl to record a `claude_session_outcome`
   * artifact into SQLite so operators can observe in-flight session activity
   * via /v1/status without waiting for the window to close.
   */
  onSessionEnd?: (result: SessionResult) => void | Promise<void>;
  config?: Partial<OrchestratorConfig>;
  /**
   * Override spawn for testing. When provided, this is called instead of
   * node:child_process.spawn so tests can inject a fake child process.
   * In production, omit this field (real spawn is used).
   */
  _spawnFn?: typeof spawn;
  /**
   * Trajectory collector — when present, each session spawn emits a
   * jinn.state_transition span covering the subprocess lifetime.
   * Scope §3.2 traced-I/O boundary.
   */
  trajectory?: TrajectoryCollector;
}

// ── Session spawn ──────────────────────────────────────────────────────────────

/**
 * Spawn a single Claude session, capturing stdout to a transcript file.
 * The session is aborted if the window AbortSignal fires or sessionMaxMs elapses.
 */
export async function spawnSession(
  sessionId: string,
  prompt: string,
  deps: OrchestratorDeps,
): Promise<SessionResult> {
  const config = resolveOrchestratorConfig(deps.config);
  const sessionDir = join(deps.workingDir, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });

  const transcriptPath = join(sessionDir, 'transcript.txt');
  const startedAt = Date.now();
  const startNs = `${BigInt(startedAt) * 1_000_000n}`;

  writeFileSync(transcriptPath, `=== Session ${sessionId} started at ${new Date(startedAt).toISOString()} ===\n\n`);

  const args = [
    '-p', prompt,
    '--mcp-config', deps.mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools', 'mcp__jinn-hl__*,mcp__jinn-client__*',
  ];
  if (deps.claudeModel) args.push('--model', deps.claudeModel);

  // Build a minimal safe env for the agent subprocess
  const agentEnv: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'NODE_PATH', 'NODE_OPTIONS', 'NPM_CONFIG_PREFIX']) {
    if (process.env[key]) agentEnv[key] = process.env[key]!;
  }

  deps.log({ level: 'info', msg: `session-orchestrator: spawning session ${sessionId}`, data: { claudePath: deps.claudePath } });

  const spawnFn = deps._spawnFn ?? spawn;

  return new Promise((resolve) => {
    const child = spawnFn(deps.claudePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: agentEnv,
    });

    let stdout = '';
    let aborted = false;

    child.stdout?.on('data', (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      appendFileSync(transcriptPath, chunk);
    });
    child.stderr?.on('data', (d: Buffer) => {
      const line = d.toString();
      appendFileSync(transcriptPath, `[stderr] ${line}`);
    });

    // Session timeout
    const sessionTimeout = setTimeout(() => {
      if (!aborted) {
        deps.log({ level: 'info', msg: `session-orchestrator: session ${sessionId} reached max time, killing`, data: { sessionMaxMs: config.sessionMaxMs } });
        child.kill('SIGTERM');
      }
    }, config.sessionMaxMs);

    // Window abort
    const onAbort = () => {
      if (!aborted) {
        aborted = true;
        deps.log({ level: 'info', msg: `session-orchestrator: window abort signal — killing session ${sessionId}` });
        clearTimeout(sessionTimeout);
        child.kill('SIGTERM');
      }
    };
    deps.abort.addEventListener('abort', onAbort);

    child.on('exit', (code, signal) => {
      clearTimeout(sessionTimeout);
      deps.abort.removeEventListener('abort', onAbort);

      const endedAt = Date.now();
      const endNs = `${BigInt(endedAt) * 1_000_000n}`;
      appendFileSync(transcriptPath, `\n\n=== Session ended at ${new Date(endedAt).toISOString()} (code: ${code}, signal: ${signal}) ===\n`);

      deps.log({
        level: 'info',
        msg: `session-orchestrator: session ${sessionId} exited`,
        data: { code, signal, durationMs: endedAt - startedAt, aborted },
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
        },
        events: [],
        status: exitCode === 0 || signal ? { code: 'OK' } : { code: 'ERROR', message: `exit ${exitCode}` },
      });

      resolve({
        sessionId,
        startedAt,
        endedAt,
        transcriptPath,
        aborted: aborted || deps.abort.aborted,
        stdout,
        initiatedFillTids: [], // populated by caller after fill matching
      });
    });

    child.on('error', (err) => {
      clearTimeout(sessionTimeout);
      deps.abort.removeEventListener('abort', onAbort);
      const endedAt = Date.now();
      const endNs = `${BigInt(endedAt) * 1_000_000n}`;
      appendFileSync(transcriptPath, `\n\n=== Session spawn error: ${err.message} ===\n`);
      deps.log({ level: 'error', msg: `session-orchestrator: session ${sessionId} spawn error`, data: { err: err.message } });

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
        },
        events: [{ timeUnixNano: endNs, name: 'exception', attributes: { 'exception.message': err.message } }],
        status: { code: 'ERROR', message: err.message },
      });

      resolve({
        sessionId,
        startedAt,
        endedAt,
        transcriptPath,
        aborted: deps.abort.aborted,
        stdout: '',
        initiatedFillTids: [],
      });
    });
  });
}

// ── Market-move trigger ────────────────────────────────────────────────────────

/**
 * Check if any tracked coin has moved ≥ threshold since the last snapshot.
 */
export function checkMarketMoveTrigger(
  prevMids: Record<string, string>,
  currMids: Record<string, string>,
  trackedCoins: string[],
  threshold: number,
): { triggered: boolean; coin?: string; moveFraction?: number } {
  for (const coin of trackedCoins) {
    const prev = parseFloat(prevMids[coin] ?? '0');
    const curr = parseFloat(currMids[coin] ?? '0');
    if (prev === 0) continue;
    const moveFraction = Math.abs(curr - prev) / prev;
    if (moveFraction >= threshold) {
      return { triggered: true, coin, moveFraction };
    }
  }
  return { triggered: false };
}

// ── Session loop ───────────────────────────────────────────────────────────────

export interface SessionLoopResult {
  sessions: SessionResult[];
  totalSessions: number;
}

/**
 * Run the full session loop until the window ends (abort fires).
 *
 * - Runs sessions sequentially
 * - Waits cadenceMs between sessions (unless market-move trigger fires early)
 * - Each session runs up to sessionMaxMs (also aborted by window signal)
 */
export async function runSessionLoop(
  buildPrompt: (sessionNum: number, sessionId: string) => string,
  deps: OrchestratorDeps,
): Promise<SessionLoopResult> {
  const config = resolveOrchestratorConfig(deps.config);
  const sessions: SessionResult[] = [];
  let sessionNum = 0;
  let lastMids: Record<string, string> = {};

  while (!deps.abort.aborted && deps.msUntilEndTs() > 0) {
    sessionNum++;
    const sessionId = randomUUID();

    const prompt = buildPrompt(sessionNum, sessionId);
    const result = await spawnSession(sessionId, prompt, deps);
    sessions.push(result);

    // Fire outcome hook. Swallow its errors so a telemetry failure never
    // interrupts the trading loop.
    if (deps.onSessionEnd) {
      try {
        await deps.onSessionEnd(result);
      } catch (err) {
        deps.log({
          level: 'warn',
          msg: 'session-orchestrator: onSessionEnd hook threw',
          data: { err: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    if (result.aborted || deps.abort.aborted) {
      deps.log({ level: 'info', msg: 'session-orchestrator: window ended, stopping loop' });
      break;
    }

    // Wait up to cadenceMs before next session, polling for market-move triggers
    const cadenceEnd = Date.now() + config.cadenceMs;
    let triggered = false;

    while (!deps.abort.aborted && Date.now() < cadenceEnd && deps.msUntilEndTs() > 0) {
      // Poll mids every 30s for market-move trigger (capped at remaining cadence time)
      const remainingCadenceMs = Math.max(0, cadenceEnd - Date.now());
      await sleepMs(Math.min(30_000, remainingCadenceMs), deps.abort);
      if (deps.abort.aborted) break;

      if (deps.getMids && config.trackedCoins.length > 0) {
        try {
          const currMids = await deps.getMids();
          const check = checkMarketMoveTrigger(
            lastMids,
            currMids,
            config.trackedCoins,
            config.marketMoveTriggerFraction,
          );
          lastMids = currMids;

          if (check.triggered) {
            deps.log({
              level: 'info',
              msg: `session-orchestrator: market-move trigger for ${check.coin} (+${((check.moveFraction ?? 0) * 100).toFixed(2)}%)`,
            });
            triggered = true;
            break;
          }
        } catch {
          // Non-fatal — just skip the trigger check
        }
      }
    }

    if (!triggered) {
      deps.log({ level: 'info', msg: `session-orchestrator: cadence elapsed, starting next session` });
    }
  }

  return { sessions, totalSessions: sessions.length };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleepMs(ms: number, abort?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    abort?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
