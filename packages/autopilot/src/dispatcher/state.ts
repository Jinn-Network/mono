import type { CommandRunner, ProjectSnapshot } from './project-snapshot.js';
import type { InFlightSession } from './types.js';
import { sessionLogPath, sessionStartedAtPath } from './session-log.js';
import {
  type ParsedWorktree,
  parseWorktreePorcelain,
  extractWorktreeNumber,
  shortBranch,
  recoverStartedAt,
} from './worktree-porcelain.js';

// Re-exported so existing consumers (test/dispatcher/recover-started-at.test.ts)
// keep importing from state.ts.
export { recoverStartedAt } from './worktree-porcelain.js';

/**
 * Extract the issue number from a `jinn-mono_worktrees/<N>` worktree path.
 * Returns null if the path is not a task worktree.
 */
function extractTaskIssueNumber(worktreePath: string): number | null {
  return extractWorktreeNumber(worktreePath, '');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** One task worktree (`jinn-mono_worktrees/<N>`) keyed by its issue number. */
export interface TaskWorktree {
  issueNumber: number;
  worktreePath: string;
  /** Short branch name, or '' when the worktree is detached. */
  branch: string;
}

/**
 * List the task worktrees (`jinn-mono_worktrees/<N>`) via
 * `git worktree list --porcelain`. Shared by {@link deriveInFlight} and the
 * drift sweep (#1734) so both read the identical external state.
 */
export async function listTaskWorktrees(
  runner: CommandRunner,
): Promise<Map<number, TaskWorktree>> {
  const raw = await runner('git', ['worktree', 'list', '--porcelain']);
  const out = new Map<number, TaskWorktree>();
  for (const wt of parseWorktreePorcelain(raw)) {
    const n = extractTaskIssueNumber(wt.worktreePath);
    if (n != null) {
      out.set(n, {
        issueNumber: n,
        worktreePath: wt.worktreePath,
        branch: wt.branchRef != null ? shortBranch(wt.branchRef) : '',
      });
    }
  }
  return out;
}

/**
 * Re-derive the dispatcher's in-flight set from authoritative external state:
 * - GitHub Project board (issues with `status === 'In Progress'`), consumed
 *   from the per-cycle {@link ProjectSnapshot} passed in by the orchestrator.
 * - git worktree list (worktrees under `jinn-mono_worktrees/<N>`).
 *
 * A crash or restart simply calls this again — state is never held only in
 * memory.
 *
 * Rules:
 *   matched pair (In Progress issue + jinn-mono_worktrees/<N> worktree) → InFlightSession
 *   In Progress issue with no worktree → drift warning string
 *   jinn-mono_worktrees/<N> worktree with no In Progress issue → drift warning string
 *
 * The dispatcher logs drift but does not act on it automatically. A human
 * resolves drift.
 *
 * Prior to jinn-mono#585 this function called `gh project item-list --limit 500`
 * itself, costing ~96 GraphQL points per cycle. It now reads the shared
 * snapshot (1 GraphQL pt for the whole cycle) and uses `runner` only for the
 * local `git worktree list --porcelain` call.
 */
export async function deriveInFlight(
  snapshot: ProjectSnapshot,
  runner: CommandRunner,
): Promise<{ inFlight: InFlightSession[]; drift: string[] }> {
  // 1. Build a set of issue numbers that are In Progress, from the snapshot.
  //
  //    Escalated sessions (`Blocked on: Human`) are PARKED, not in-flight. An
  //    escalation keeps Status "In Progress" (there is no parked Status) and
  //    retains its worktree so a human can resume it — but it must NOT consume a
  //    concurrency slot, or accumulated escalations freeze the dispatcher (the
  //    slot-leak: 5 escalations wedged a cap-5 loop, observed live 2026-06-13).
  //    We therefore exclude any `Blocked on: Human` issue from the in-flight set
  //    and track it separately so its retained worktree is not mistaken for
  //    orphan drift. Keying on `blockedOn` (not Status) makes this robust to a
  //    future dedicated "Human" Status lane: the escalation marker is the same.
  const inProgressIssues = new Map<number, true>();
  const escalatedIssues = new Set<number>();
  for (const item of snapshot.items) {
    if (item.contentType !== 'Issue') continue;
    // Parked iff escalated by either marker: the `Blocked on: Human` field (set
    // at escalation) or the `Human` Status lane (where the dispatcher promotes
    // escalations). Checking both keeps parking correct even if one is cleared
    // independently — e.g. a human re-opens "Blocked on" while triaging but
    // leaves the issue in the Human lane.
    if (item.blockedOn === 'Human' || item.status === 'Human') {
      escalatedIssues.add(item.number);
      continue;
    }
    if (item.status === 'In Progress') {
      inProgressIssues.set(item.number, true);
    }
  }

  // 2. Fetch worktrees (local — no GraphQL cost).
  const worktreeRaw = await runner('git', ['worktree', 'list', '--porcelain']);
  const worktrees = parseWorktreePorcelain(worktreeRaw);

  // Build a map: issue number → worktree (for jinn-mono_worktrees/<N> paths only)
  const taskWorktrees = new Map<number, ParsedWorktree>();
  for (const wt of worktrees) {
    const n = extractTaskIssueNumber(wt.worktreePath);
    if (n != null) {
      taskWorktrees.set(n, wt);
    }
  }

  // 3. Match
  const inFlight: InFlightSession[] = [];
  const drift: string[] = [];

  // For each In Progress issue, check if there is a task worktree
  for (const issueNumber of inProgressIssues.keys()) {
    const wt = taskWorktrees.get(issueNumber);
    if (wt != null) {
      const branchRef = wt.branchRef;
      inFlight.push({
        issueNumber,
        branch: branchRef != null ? shortBranch(branchRef) : '',
        worktreePath: wt.worktreePath,
        pid: null,
        startedAt: recoverStartedAt(wt.worktreePath, sessionStartedAtPath(issueNumber)),
        // #533: deterministic per-session log path, so a recovered session is
        // still tailable by the same `sessions/<N>.log` scheme.
        logPath: sessionLogPath(issueNumber),
      });
    } else {
      drift.push(
        `drift: issue #${issueNumber} is In Progress on the board but has no jinn-mono_worktrees/${issueNumber} worktree`,
      );
    }
  }

  // For each task worktree, check if there is an In Progress issue.
  // Escalated (parked) issues retain their worktree by design, so a worktree
  // belonging to one is expected — not drift.
  for (const [issueNumber, wt] of taskWorktrees) {
    if (!inProgressIssues.has(issueNumber) && !escalatedIssues.has(issueNumber)) {
      drift.push(
        `drift: worktree ${wt.worktreePath} exists for issue #${issueNumber} but that issue is not In Progress on the board`,
      );
    }
  }

  return { inFlight, drift };
}
