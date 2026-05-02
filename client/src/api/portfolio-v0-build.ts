/**
 * portfolio.v0 dashboard data assembly (§10 step 8 of spec/2026-04-17-portfolio-v0-design.md).
 *
 * Collects in-flight restoration tasks, recent verdicts (COMPLETE / FAILED
 * terminal tasks), and recent system_snapshot artifacts for the /v1/status
 * response under the `portfolioV0` key.
 *
 * Designed to be called from gather-status.ts with the Store instance. Does not
 * hit the network — all data comes from SQLite.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Store } from '../store/store.js';
import { TaskRunPersistence } from '../harnesses/engine/persistence.js';
import type { PersistedTaskRun } from '../harnesses/engine/persistence.js';

/** Default per-task engine work root; kept in sync with `config.engine.workingDirRoot`. */
export const DEFAULT_ENGINE_WORKING_DIR_ROOT = join(homedir(), '.jinn-client', 'engine', 'work');
const RECENT_CLAUDE_OUTCOMES_LIMIT = 10;

// ── Public types ──────────────────────────────────────────────────────────────

export interface InFlightTaskSummary {
  requestId: string;
  state: string;
  solverType: string | null;
  implName: string | null;
  windowStartTs: number;
  windowEndTs: number;
  /** Unix ms when the state was last updated. */
  stateUpdatedAt: number;
  lastError: string | null;
}

export interface VerdictSummary {
  requestId: string;
  state: 'COMPLETE' | 'FAILED';
  implName: string | null;
  solverType: string | null;
  windowStartTs: number;
  windowEndTs: number;
  stateUpdatedAt: number;
  failureReason: string | null;
  manifestCid: string | null;
  deliveryTxHash: string | null;
}

export interface SnapshotSummary {
  id: string;
  requestId: string;
  title: string;
  outcome: string;
  createdAt: string;
}

export interface ClaudeOutcomeSummary {
  requestId: string;
  sessionId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  aborted: boolean;
  /**
   * Count of HL fills that occurred during the session's window (±5s padding).
   * Authoritative measure of whether Claude actually traded — sourced from
   * HL's userFillsByTime, not the in-process tool-call counter (which lives
   * in the daemon process while actual trades happen in the MCP subprocess).
   */
  fillsInSessionWindow: number;
  /** Per-coin fill counts for the session window (e.g., {"ETH": 4, "BTC": 2}). */
  coinCounts: Record<string, number>;
  /** Present only if the HL fills query failed — outcome still usable for timing. */
  fillsQueryError?: string;
}

export interface PortfolioV0Status {
  totals: {
    /** Tasks that reached terminal success and delivered their result. */
    delivered: number;
    failed: number;
    active: number;
  };
  /** Tasks currently being processed (not in a terminal state). */
  inFlight: InFlightTaskSummary[];
  /** Last N completed or failed tasks — most recent first. */
  recentVerdicts: VerdictSummary[];
  /** Recent system_snapshot artifacts from the store — most recent first. */
  recentSnapshots: SnapshotSummary[];
  /**
   * Last N Claude session outcomes (per-session telemetry). Populated
   * in-flight: each session writes `outcome.json` to its working dir as
   * soon as it exits, so operators can observe trading activity without
   * waiting for the window to close.
   */
  recentClaudeOutcomes: ClaudeOutcomeSummary[];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const RECENT_VERDICTS_LIMIT = 10;
const RECENT_SNAPSHOTS_LIMIT = 5;

function toInFlightTask(task: PersistedTaskRun): InFlightTaskSummary {
  return {
    requestId: task.requestId,
    state: task.state,
    solverType: task.solverType,
    implName: task.implName,
    windowStartTs: task.windowStartTs,
    windowEndTs: task.windowEndTs,
    stateUpdatedAt: task.stateUpdatedAt,
    lastError: task.failureReason,
  };
}

function toVerdict(task: PersistedTaskRun): VerdictSummary {
  return {
    requestId: task.requestId,
    state: task.state as 'COMPLETE' | 'FAILED',
    implName: task.implName,
    solverType: task.solverType,
    windowStartTs: task.windowStartTs,
    windowEndTs: task.windowEndTs,
    stateUpdatedAt: task.stateUpdatedAt,
    failureReason: task.failureReason,
    manifestCid: task.manifestCid,
    deliveryTxHash: task.deliveryTxHash,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Gather portfolio.v0 dashboard data from SQLite. Safe to call even when the
 * task_runs table does not exist yet (table created on first Store
 * construction, so this is always present when the daemon is running).
 */
export function gatherPortfolioV0Status(
  store: Store,
  workingDirRoot: string = DEFAULT_ENGINE_WORKING_DIR_ROOT,
): PortfolioV0Status {
  const persistence = new TaskRunPersistence(store.db);

  // In-flight: all non-terminal task runs
  const inFlight = persistence.getInFlight().map(toInFlightTask);

  // Recent verdicts: last N COMPLETE + FAILED task runs combined, newest first
  const complete = persistence.getByState('COMPLETE');
  const failed = persistence.getByState('FAILED');
  const allTerminal = [...complete, ...failed].sort(
    (a, b) => b.stateUpdatedAt - a.stateUpdatedAt,
  );
  const recentVerdicts = allTerminal.slice(0, RECENT_VERDICTS_LIMIT).map(toVerdict);
  const totals = {
    delivered: complete.length,
    failed: failed.length,
    active: inFlight.length,
  };

  // Recent system_snapshot artifacts (tagged with 'system_snapshot')
  let recentSnapshots: SnapshotSummary[] = [];
  try {
    const snapshotArtifacts = store.searchArtifacts({
      tags: ['system_snapshot'],
      limit: RECENT_SNAPSHOTS_LIMIT,
    });
    recentSnapshots = snapshotArtifacts.map((a) => ({
      id: a.id,
      requestId: a.request_id,
      title: a.title,
      outcome: a.outcome,
      createdAt: a.created_at,
    }));
  } catch {
    // searchArtifacts should never throw, but guard defensively
    recentSnapshots = [];
  }

  const recentClaudeOutcomes = gatherRecentClaudeOutcomes(workingDirRoot);

  return { totals, inFlight, recentVerdicts, recentSnapshots, recentClaudeOutcomes };
}

/**
 * Scan session outcome files: each task dir under `workingDirRoot` may contain
 * `sessions/<id>/outcome.json`. Return the most recent N. Swallows all filesystem
 * errors so a missing or malformed working dir never breaks the status endpoint.
 */
function gatherRecentClaudeOutcomes(workingDirRoot: string): ClaudeOutcomeSummary[] {
  if (!existsSync(workingDirRoot)) return [];
  const outcomes: ClaudeOutcomeSummary[] = [];

  let intentDirs: string[];
  try {
    intentDirs = readdirSync(workingDirRoot);
  } catch {
    return [];
  }

  for (const intentDir of intentDirs) {
    const sessionsDir = join(workingDirRoot, intentDir, 'sessions');
    if (!existsSync(sessionsDir)) continue;
    let sessionDirs: string[];
    try {
      sessionDirs = readdirSync(sessionsDir);
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      const outcomePath = join(sessionsDir, sessionDir, 'outcome.json');
      if (!existsSync(outcomePath)) continue;
      try {
        const raw = readFileSync(outcomePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<ClaudeOutcomeSummary>;
        if (
          typeof parsed.requestId === 'string' &&
          typeof parsed.sessionId === 'string' &&
          typeof parsed.startedAt === 'number' &&
          typeof parsed.endedAt === 'number'
        ) {
          outcomes.push({
            requestId: parsed.requestId,
            sessionId: parsed.sessionId,
            startedAt: parsed.startedAt,
            endedAt: parsed.endedAt,
            durationMs: parsed.durationMs ?? (parsed.endedAt - parsed.startedAt),
            aborted: parsed.aborted ?? false,
            fillsInSessionWindow: parsed.fillsInSessionWindow ?? 0,
            coinCounts: parsed.coinCounts ?? {},
            ...(parsed.fillsQueryError !== undefined ? { fillsQueryError: parsed.fillsQueryError } : {}),
          });
        }
      } catch {
        // Malformed outcome file — skip.
      }
    }
  }

  outcomes.sort((a, b) => b.endedAt - a.endedAt);
  return outcomes.slice(0, RECENT_CLAUDE_OUTCOMES_LIMIT);
}
