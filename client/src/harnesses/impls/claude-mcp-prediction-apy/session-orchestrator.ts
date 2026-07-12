/**
 * Session orchestrator for claude-mcp-prediction-apy.
 *
 * Single-session. Spawns Claude once with the APY prediction MCP + prompt,
 * polls for submit_apy_prediction, then terminates after a short grace period.
 *
 * Thin wrapper over `claude-mcp-shared/single-session-orchestrator.ts`, which
 * is shared with `claude-mcp-prediction`.
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
  /** Poll callback — returns true once submit_apy_prediction has been invoked. */
  isSubmitted: () => boolean;
  sessionMaxMs?: number;
  pollIntervalMs?: number;
  submissionGraceMs?: number;
  _spawnFn?: typeof spawn;
  /**
   * Trajectory collector — when present, each session spawn emits a
   * jinn.state_transition span covering the subprocess lifetime.
   * Scope §3.2 traced-I/O boundary.
   */
  trajectory?: TrajectoryCollector;
}

export const PREDICTION_APY_CONFIG: SingleSessionConfig = {
  allowedTools: 'mcp__jinn-apy-prediction__*',
  logTag: 'apy-prediction-session',
  submissionToolName: 'submit_apy_prediction',
};

export async function spawnSession(
  sessionId: string,
  prompt: string,
  deps: OrchestratorDeps,
): Promise<SessionResult> {
  return runSingleSession(sessionId, prompt, PREDICTION_APY_CONFIG, deps);
}
