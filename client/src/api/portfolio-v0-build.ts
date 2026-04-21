/**
 * portfolio.v0 dashboard data assembly (§10 step 8 of spec/2026-04-17-portfolio-v0-design.md).
 *
 * Collects in-flight restoration intents, recent verdicts (COMPLETE / FAILED
 * terminal intents), and recent system_snapshot artifacts for the /v1/status
 * response under the `portfolioV0` key.
 *
 * Designed to be called from gather-status.ts with the Store instance. Does not
 * hit the network — all data comes from SQLite.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store/store.js';
import { IntentPersistence } from '../restorer/engine/persistence.js';
import type { PersistedIntent } from '../restorer/engine/persistence.js';

const WORKING_DIR_ROOT = '/tmp/jinn-engine-working';
const RECENT_CLAUDE_OUTCOMES_LIMIT = 10;

// ── Public types ──────────────────────────────────────────────────────────────

export interface InFlightIntentSummary {
  requestId: string;
  state: string;
  specKind: string | null;
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
  specKind: string | null;
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
  /** Intents currently being processed (not in a terminal state). */
  inFlight: InFlightIntentSummary[];
  /** Last N completed or failed intents — most recent first. */
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

function toInFlight(intent: PersistedIntent): InFlightIntentSummary {
  return {
    requestId: intent.requestId,
    state: intent.state,
    specKind: intent.specKind,
    implName: intent.implName,
    windowStartTs: intent.windowStartTs,
    windowEndTs: intent.windowEndTs,
    stateUpdatedAt: intent.stateUpdatedAt,
    lastError: intent.failureReason,
  };
}

function toVerdict(intent: PersistedIntent): VerdictSummary {
  return {
    requestId: intent.requestId,
    state: intent.state as 'COMPLETE' | 'FAILED',
    implName: intent.implName,
    specKind: intent.specKind,
    windowStartTs: intent.windowStartTs,
    windowEndTs: intent.windowEndTs,
    stateUpdatedAt: intent.stateUpdatedAt,
    failureReason: intent.failureReason,
    manifestCid: intent.manifestCid,
    deliveryTxHash: intent.deliveryTxHash,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Gather portfolio.v0 dashboard data from SQLite. Safe to call even when the
 * restoration_intents table does not exist yet (table created on first Store
 * construction, so this is always present when the daemon is running).
 */
export function gatherPortfolioV0Status(store: Store): PortfolioV0Status {
  const persistence = new IntentPersistence(store.db);

  // In-flight: all non-terminal intents
  const inFlight = persistence.getInFlight().map(toInFlight);

  // Recent verdicts: last N COMPLETE + FAILED intents combined, newest first
  const complete = persistence.getByState('COMPLETE');
  const failed = persistence.getByState('FAILED');
  const allTerminal = [...complete, ...failed].sort(
    (a, b) => b.stateUpdatedAt - a.stateUpdatedAt,
  );
  const recentVerdicts = allTerminal.slice(0, RECENT_VERDICTS_LIMIT).map(toVerdict);

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

  const recentClaudeOutcomes = gatherRecentClaudeOutcomes();

  return { inFlight, recentVerdicts, recentSnapshots, recentClaudeOutcomes };
}

/**
 * Scan the session outcome files under `/tmp/jinn-engine-working/*\/sessions/*\/outcome.json`
 * and return the most recent N. Swallows all filesystem errors so a missing or
 * malformed working dir never breaks the status endpoint.
 */
function gatherRecentClaudeOutcomes(): ClaudeOutcomeSummary[] {
  if (!existsSync(WORKING_DIR_ROOT)) return [];
  const outcomes: ClaudeOutcomeSummary[] = [];

  let intentDirs: string[];
  try {
    intentDirs = readdirSync(WORKING_DIR_ROOT);
  } catch {
    return [];
  }

  for (const intentDir of intentDirs) {
    const sessionsDir = join(WORKING_DIR_ROOT, intentDir, 'sessions');
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
