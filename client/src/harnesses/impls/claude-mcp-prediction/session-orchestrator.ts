/**
 * Session orchestrator for claude-mcp-prediction.
 *
 * Single-session (no cadence loop, no market-move triggers). Spawns Claude
 * once with the prediction MCP + prompt, polls a shared "submitted" flag to
 * detect `submit_prediction` tool call, and terminates after a short grace
 * period so Claude's tool response reaches it.
 *
 * Thin wrapper over `claude-mcp-shared/single-session-orchestrator.ts`, which
 * is shared with `claude-mcp-prediction-apy`.
 */

import { spawn } from 'node:child_process';
import {
  runSingleSession,
  type SingleSessionConfig,
} from '../claude-mcp-shared/single-session-orchestrator.js';
import type { TrajectoryCollector } from '../../../trajectory/index.js';
import type { SessionResult } from './types.js';

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

export const PREDICTION_CONFIG: SingleSessionConfig = {
  allowedTools: 'mcp__jinn-prediction__*',
  logTag: 'prediction-session',
  submissionToolName: 'submit_prediction',
};

export async function spawnSession(
  sessionId: string,
  prompt: string,
  deps: OrchestratorDeps,
): Promise<SessionResult> {
  return runSingleSession(sessionId, prompt, PREDICTION_CONFIG, deps);
}
