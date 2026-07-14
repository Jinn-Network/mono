import { statSync } from 'node:fs';
import type { CommandRunner, ProjectSnapshot } from './project-snapshot.js';
import type { InFlightSession } from './types.js';
import { sessionLogPath, sessionStartedAtPath } from './session-log.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Path component that identifies a task worktree's parent directory.
 *
 * Per CLAUDE.md AI rule #1, multi-agent worktrees live in
 * `../jinn-mono_worktrees/<name>` — sibling of the main repo checkout.
 * Task worktrees use the issue number as `<name>`, so the full shape is
 * `…/jinn-mono_worktrees/<N>`.
 */
const WORKTREE_PARENT_COMPONENT = 'jinn-mono_worktrees';

// ---------------------------------------------------------------------------
// Parser: git worktree list --porcelain
// ---------------------------------------------------------------------------

/**
 * One parsed worktree block from `git worktree list --porcelain`.
 *
 * Real output shape (observed 2026-05-21):
 *
 *   worktree /path/to/worktree
 *   HEAD <sha>
 *   branch refs/heads/<branch>   ← present for checked-out branch
 *   detached                     ← present instead of branch for detached HEAD
 *
 * Blocks are separated by blank lines.
 */
interface ParsedWorktree {
  worktreePath: string;
  /** Full branch ref, e.g. "refs/heads/feat/418-something". Null if detached. */
  branchRef: string | null;
}

function parseWorktreePorcelain(output: string): ParsedWorktree[] {
  const result: ParsedWorktree[] = [];
  // Split on blank lines to get blocks; trim trailing whitespace per line
  const blocks = output.split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length === 0 || lines[0] === '') continue;

    let worktreePath: string | null = null;
    let branchRef: string | null = null;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.slice('worktree '.length);
      } else if (line.startsWith('branch ')) {
        branchRef = line.slice('branch '.length);
      }
      // 'detached' line → branchRef stays null
    }

    if (worktreePath != null) {
      result.push({ worktreePath, branchRef });
    }
  }

  return result;
}

/**
 * Extract the issue number from a `jinn-mono_worktrees/<N>` worktree path.
 * Returns null if the path is not a task worktree.
 *
 * Matches `jinn-mono_worktrees/<N>` as proper path components (split on `/`)
 * so that a repo mounted under a path whose directory name itself contains
 * the fragment (e.g. `/home/user/jinn-mono_worktrees-backup/foo/jinn-mono_worktrees/418`)
 * is not misidentified — only the single component before the issue number
 * is examined.
 */
function extractTaskIssueNumber(worktreePath: string): number | null {
  // Split on '/' into proper path components (filter leading '' from absolute paths).
  const parts = worktreePath.split('/').filter((p, i) => i > 0 || p !== '');
  // Find the `jinn-mono_worktrees/<N>` sequence as proper components.
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === WORKTREE_PARENT_COMPONENT) {
      const candidate = parts[i + 1];
      if (candidate == null) return null;
      // Must be the final component (no trailing path segments after the issue number).
      if (i + 2 !== parts.length) return null;
      const n = parseInt(candidate, 10);
      if (isNaN(n) || String(n) !== candidate) return null;
      return n;
    }
  }
  return null;
}

/**
 * Strip the "refs/heads/" prefix from a branch ref.
 * Returns the ref unchanged if it doesn't start with that prefix.
 */
function shortBranch(branchRef: string): string {
  const prefix = 'refs/heads/';
  return branchRef.startsWith(prefix) ? branchRef.slice(prefix.length) : branchRef;
}

/**
 * Recover the best-available evidence of when a worktree session was
 * started, taking the MAX of two signals:
 *
 * - The dispatch-time marker file's mtime (`markerPath`, written — and
 *   truncated — at every dispatch by the production spawn lambda in
 *   run-eng-loop.ts). 0 if it cannot be stat-ed.
 * - The worktree directory's creation time (`birthtimeMs`), falling back to
 *   `mtimeMs` when `birthtimeMs` is 0 (common on Linux where birthtime is not
 *   tracked by the filesystem). 0 if it cannot be stat-ed.
 *
 * The marker is preferred evidence: when `dispatchIssue` reuses a
 * pre-existing worktree (the crash-recovery path around dispatch.ts:238-255),
 * the worktree directory's birthtime is wrong — it reflects when the
 * worktree was first created by an earlier, possibly abandoned session, not
 * when the current session started. This previously caused a false
 * wall-clock pause of a session that had started only minutes earlier
 * (observed live 2026-07-14 on issues #1296/#1393). Taking the max of both
 * signals means "most recent evidence of a session start" wins, without
 * regressing the plain worktree-birthtime case when no marker exists yet
 * (e.g. a worktree created outside the dispatcher).
 *
 * Returns 0 (unknown-age sentinel) if both signals are unavailable — the
 * WallClock guards against `startedAt <= 0` and will not force-pause an
 * unknown-age session.
 *
 * Exported for direct unit testing (test/dispatcher/recover-started-at.test.ts).
 */
export function recoverStartedAt(worktreePath: string, markerPath: string): number {
  let markerMs = 0;
  try {
    markerMs = statSync(markerPath).mtimeMs;
  } catch {
    markerMs = 0;
  }

  let worktreeMs = 0;
  try {
    const st = statSync(worktreePath);
    worktreeMs = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
  } catch {
    worktreeMs = 0;
  }

  return Math.max(markerMs, worktreeMs);
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
