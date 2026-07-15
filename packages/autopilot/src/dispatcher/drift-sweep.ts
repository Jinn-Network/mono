import { statSync } from 'node:fs';
import type { CommandRunner, ProjectSnapshot } from './project-snapshot.js';
import type { FieldCache } from './field-cache.js';
import type { PrLink } from './pr-links.js';
import type { TaskWorktree } from './state.js';
import { sessionLogPath } from './session-log.js';
import { REPO } from './constants.js';

/**
 * Self-healing drift sweep (#1734).
 *
 * `deriveInFlight` detects board↔worktree drift every cycle but only LOGS it;
 * observed live 2026-07-14/15, unhealed drift wedged the dispatcher twice
 * (stale worktrees saturated the concurrency cap ~5h; a phantom In-Progress
 * issue froze its slot in the ready queue) and dead sessions stranded
 * committed work on local branches with no PR. This sweep reconciles each
 * drift class conservatively:
 *
 * 1. PHANTOM — issue In Progress on the board, no task worktree:
 *      · an OPEN closing PR exists  → Status = In Review (session finished,
 *        the worktree was cleaned; the board just never moved).
 *      · no closing PR at all       → Status = Todo + explanatory comment
 *        (the session died before producing anything; re-dispatchable).
 *      · only MERGED closing PRs    → skipped (the merge will close the
 *        issue; flipping status here would race GitHub).
 *
 * 2. STALE WORKTREE — worktree present, board status Todo or Done (or the
 *    issue is absent from the board but has a MERGED closing PR):
 *      · dirty working tree         → skipped (uncommitted state needs a
 *        human eye — `--force` would destroy it).
 *      · detached HEAD w/ unpushed  → skipped (no branch ref to preserve the
 *        commits through removal).
 *      · otherwise                  → `git worktree remove --force` (any
 *        commits survive on the branch ref; only the checkout goes).
 *    `In Review` worktrees are EXPECTED (PR open, awaiting merge) and
 *    `Blocked on: Human` worktrees are parked by design — both untouched.
 *
 * 3. STRAND — issue In Progress WITH a worktree, but no open/merged closing
 *    PR and the session is dead (session log idle past `reapIdleMs` — a live
 *    `claude -p` session streams to its log continuously, so a stale log is
 *    a high-confidence death signal):
 *      · push the branch and open a draft PR (`Closes #N`, review label) so
 *        the work enters the normal review pipeline; Status = In Review.
 *      · detached HEAD → skipped (nothing addressable to push).
 *
 * Best-effort per item (a failure is logged, never fatal) and idempotent —
 * mirrors `syncStackBases` / `syncHumanLane`.
 */

export interface DriftSweepReport {
  /** Phantom issues moved In Progress → In Review (open PR found). */
  toInReview: number[];
  /** Phantom issues moved In Progress → Todo (no PR; re-dispatchable). */
  toTodo: number[];
  /** Issue numbers whose stale worktrees were removed. */
  removed: number[];
  /** Stranded issues reaped into a draft PR (issue → new PR number). */
  reaped: Array<{ issueNumber: number; prNumber: number | null }>;
  /** Human-readable reasons for items deliberately left alone. */
  skipped: string[];
}

export interface DriftSweepOpts {
  /** Session-log idle threshold before a strand is reaped. Default 45 min. */
  reapIdleMs?: number;
  /**
   * Age of a file's last modification in ms, or null when unreadable.
   * Injectable for tests; defaults to `statSync` mtime against `Date.now()`.
   */
  fileAgeMs?: (path: string) => number | null;
  /** Review label applied to reaped PRs. Default `engine:review`. */
  reviewLabel?: string;
}

const DEFAULT_REAP_IDLE_MS = 45 * 60_000;

function defaultFileAgeMs(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

async function setStatus(
  itemId: string,
  optionId: string,
  fieldCache: FieldCache,
  runner: CommandRunner,
): Promise<void> {
  await runner('gh', [
    'project', 'item-edit',
    '--id', itemId,
    '--project-id', fieldCache.projectId,
    '--field-id', fieldCache.status.fieldId,
    '--single-select-option-id', optionId,
  ]);
}

/** True when the worktree has uncommitted changes (`git status --porcelain`). */
async function isDirty(wt: TaskWorktree, runner: CommandRunner): Promise<boolean> {
  const out = await runner('git', ['-C', wt.worktreePath, 'status', '--porcelain']);
  return out.trim() !== '';
}

/** True when the worktree HEAD commit is not reachable from any remote ref. */
async function hasUnpushedHead(wt: TaskWorktree, runner: CommandRunner): Promise<boolean> {
  const out = await runner('git', [
    '-C', wt.worktreePath,
    'log', '--oneline', '-1', '--not', '--remotes',
  ]);
  return out.trim() !== '';
}

export async function syncDrift(
  snapshot: ProjectSnapshot,
  prByIssue: ReadonlyMap<number, PrLink[]>,
  taskWorktrees: ReadonlyMap<number, TaskWorktree>,
  fieldCache: FieldCache,
  runner: CommandRunner,
  opts: DriftSweepOpts = {},
): Promise<DriftSweepReport> {
  const reapIdleMs = opts.reapIdleMs ?? DEFAULT_REAP_IDLE_MS;
  const fileAgeMs = opts.fileAgeMs ?? defaultFileAgeMs;
  const reviewLabel = opts.reviewLabel ?? 'engine:review';

  const report: DriftSweepReport = {
    toInReview: [],
    toTodo: [],
    removed: [],
    reaped: [],
    skipped: [],
  };

  const boardByIssue = new Map<
    number,
    { status: string | null; blockedOn: string | null; itemId: string }
  >();
  for (const item of snapshot.items) {
    if (item.contentType !== 'Issue') continue;
    boardByIssue.set(item.number, {
      status: item.status,
      blockedOn: item.blockedOn,
      itemId: item.id,
    });
  }

  const openPr = (n: number): PrLink | undefined =>
    prByIssue.get(n)?.find((l) => l.state === 'OPEN');
  const mergedPr = (n: number): PrLink | undefined =>
    prByIssue.get(n)?.find((l) => l.state === 'MERGED');

  // ── 1. Phantoms: In Progress on the board, no worktree ────────────────────
  for (const [issueNumber, board] of boardByIssue) {
    if (board.status !== 'In Progress') continue;
    if (board.blockedOn === 'Human') continue; // parked by design
    if (taskWorktrees.has(issueNumber)) continue; // matched pair — not drift

    try {
      if (openPr(issueNumber) != null) {
        await setStatus(board.itemId, fieldCache.status.options['In Review'], fieldCache, runner);
        report.toInReview.push(issueNumber);
      } else if (mergedPr(issueNumber) != null) {
        report.skipped.push(`#${issueNumber}: phantom with merged PR — merge will close it`);
      } else {
        await setStatus(board.itemId, fieldCache.status.options.Todo, fieldCache, runner);
        await runner('gh', [
          'issue', 'comment', String(issueNumber),
          '--repo', REPO,
          '--body',
          'Auto-reset by the dispatcher drift sweep: this issue was In Progress on the ' +
            'board with no worktree and no PR (the session died before producing ' +
            'anything). Status is back to Todo so it can re-dispatch.',
        ]);
        report.toTodo.push(issueNumber);
      }
    } catch (err) {
      console.error(`[drift-sweep] phantom reconcile failed for #${issueNumber} (continuing):`, err);
    }
  }

  // ── 2 & 3. Worktree-side: stale removal + strand reaping ─────────────────
  for (const [issueNumber, wt] of taskWorktrees) {
    const board = boardByIssue.get(issueNumber);
    const status = board?.status ?? null;
    const parked = board?.blockedOn === 'Human' || status === 'Human';
    if (parked) continue; // escalations retain their worktree by design
    if (status === 'In Review') continue; // PR open, awaiting merge — expected

    // ── 3. Strand: In Progress + worktree, dead session, no PR ─────────────
    if (status === 'In Progress') {
      if (openPr(issueNumber) != null || mergedPr(issueNumber) != null) continue; // normal in-flight/finishing
      const logAge = fileAgeMs(sessionLogPath(issueNumber));
      if (logAge == null || logAge < reapIdleMs) continue; // alive or unknown — leave it
      if (wt.branch === '') {
        report.skipped.push(`#${issueNumber}: stranded but detached HEAD — needs a human`);
        continue;
      }
      try {
        if (await isDirty(wt, runner)) {
          report.skipped.push(`#${issueNumber}: stranded with uncommitted changes — needs a human`);
          continue;
        }
        await runner('git', ['-C', wt.worktreePath, 'push', '-u', 'origin', wt.branch]);
        const prOut = await runner('gh', [
          'pr', 'create',
          '--repo', REPO,
          '--draft',
          '--base', 'next',
          '--head', wt.branch,
          '--label', reviewLabel,
          '--title', `chore(reap): recover stranded session work for #${issueNumber}`,
          '--body',
          `Auto-recovered by the dispatcher drift sweep: the session for #${issueNumber} ` +
            `died leaving committed work on \`${wt.branch}\` with no PR. Opening as a ` +
            `draft so it enters the normal review pipeline.\n\nCloses #${issueNumber}`,
        ]);
        const m = /\/pull\/(\d+)/.exec(prOut);
        if (board != null) {
          await setStatus(board.itemId, fieldCache.status.options['In Review'], fieldCache, runner);
        }
        report.reaped.push({ issueNumber, prNumber: m ? Number(m[1]) : null });
      } catch (err) {
        console.error(`[drift-sweep] strand reap failed for #${issueNumber} (continuing):`, err);
      }
      continue;
    }

    // ── 2. Stale: Todo / Done on the board, or off-board with a merged PR ──
    const offBoardButMerged = board == null && mergedPr(issueNumber) != null;
    const staleOnBoard = status === 'Todo' || status === 'Done';
    if (!staleOnBoard && !offBoardButMerged) {
      if (board == null) {
        report.skipped.push(`#${issueNumber}: worktree for an off-board issue with no merged PR — needs a human`);
      }
      continue;
    }
    try {
      if (await isDirty(wt, runner)) {
        report.skipped.push(`#${issueNumber}: stale worktree is dirty — needs a human`);
        continue;
      }
      if (wt.branch === '') {
        if (await hasUnpushedHead(wt, runner)) {
          report.skipped.push(`#${issueNumber}: stale worktree detached with unpushed commits — needs a human`);
          continue;
        }
        await runner('git', ['worktree', 'remove', '--force', wt.worktreePath]);
        report.removed.push(issueNumber);
        continue;
      }
      // Removing the worktree but LEAVING the local branch ref is the broken
      // middle state (review 2026-07-15): `dispatch.ts` re-dispatches the same
      // issue with the same deterministic branch name via `worktree add -b`,
      // which fatals on an existing ref and aborts the cycle's dispatch loop.
      // So removal must clear the ref too — and only when the commits are safe:
      //   · the issue's work LANDED (Done, or a merged closing PR): the branch
      //     is a disposable squash-merge leftover regardless of remote refs;
      //   · otherwise the head must be reachable from a remote (fully pushed).
      // An unpushed, unlanded branch keeps its worktree instead — a retained
      // worktree is reused safely on re-dispatch (dispatch.ts path-exists
      // check); only the ref-without-worktree state wedges.
      const landed = status === 'Done' || mergedPr(issueNumber) != null;
      if (!landed && (await hasUnpushedHead(wt, runner))) {
        report.skipped.push(`#${issueNumber}: stale worktree has unpushed commits — worktree retained for re-dispatch`);
        continue;
      }
      await runner('git', ['worktree', 'remove', '--force', wt.worktreePath]);
      await runner('git', ['branch', '-D', wt.branch]);
      report.removed.push(issueNumber);
    } catch (err) {
      console.error(`[drift-sweep] stale removal failed for #${issueNumber} (continuing):`, err);
    }
  }

  return report;
}
