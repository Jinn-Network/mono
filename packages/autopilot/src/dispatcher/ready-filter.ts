import type { PolledIssue, ReadyIssue, Priority } from './types.js';
import type { StackReady } from './stack-readiness.js';
import { isMachineChildIssue } from '../lifecycle/child-issues.js';

const PRIORITY_RANK: Record<Priority, number> = {
  P0: 0, P1: 1, P2: 2, P3: 3, P4: 4,
};

/** Audit shape for an issue dropped because its author is not on the allowlist (#497). */
export interface SkippedForAuthor {
  number: number;
  author: string;
}

/** Output of `selectReady`: ready issues + author-skipped audit list (#497). */
export interface SelectReadyResult {
  ready: ReadyIssue[];
  skippedForAuthor: SkippedForAuthor[];
}

/**
 * An issue is **ready** when it is triage-complete (Issue Type set),
 * `Blocked on: Nothing` (or dependency-satisfied), on the board, not already
 * in flight, AND its author is on the allowlist (#497 trust boundary).
 * Project Status is paint-only and is not an admission gate. Output is
 * ordered by current-sprint membership first, then Priority, then FIFO by
 * issue number (#609).
 *
 * The author check is a *second-pass* predicate so `skippedForAuthor` only
 * surfaces issues that would otherwise be ready — operators need to see
 * *who* is being blocked, not just a count. First-pass failures (shape,
 * board, blocked-on, in-flight, ...) are excluded from both arrays.
 *
 * `authorAllowlist` must already be lowercased by the caller; the function
 * lowercases the issue side at compare time. Empty allowlist = dispatch
 * nothing (fail-safe default; spec 2026-05-23-author-allowlist-design.md).
 */
export function selectReady(
  polled: PolledIssue[],
  inFlight: ReadonlySet<number>,
  authorAllowlist: ReadonlySet<string>,
  // Empty map (the default) = no dependency admission → identical to pre-feature
  // behaviour; the live call site (loop.ts) passes the resolved map.
  stackReady: ReadonlyMap<number, StackReady> = new Map(),
): SelectReadyResult {
  // First pass: existing readiness predicates. Failures are excluded from both
  // arrays — author-skips only apply to otherwise-ready issues. The blocked-on
  // gate admits either `Nothing` OR an issue whose blocker(s) are satisfied per
  // the dependency resolver (`stackReady`) — so a dependent can be dispatched
  // stacked on its blocker's open PR (spec 2026-07-13-eng-loop-dependency-stacking).
  const firstPass = polled.filter((i) => {
    const child = isMachineChildIssue(i);
    const priorityOk = i.priority !== null;
    const shapeOk = i.shape !== null || child;
    const blockedOk = i.blockedOn === 'Nothing'
      || (i.blockedOn === 'Another issue' && stackReady.has(i.number));
    const boardOk = i.onBoard && i.projectItemId !== null;
    return shapeOk
      && priorityOk
      && blockedOk
      && boardOk
      && !inFlight.has(i.number);
  });

  // Second pass: partition by author allowlist, and stamp the stacked-dispatch
  // base branch onto issues admitted via the dependency path.
  const ready: ReadyIssue[] = [];
  const skippedForAuthor: SkippedForAuthor[] = [];
  for (const issue of firstPass) {
    if (authorAllowlist.has(issue.author.toLowerCase())) {
      const child = isMachineChildIssue(issue);
      const priority = issue.priority;
      if (priority === null) continue;
      const normalized: ReadyIssue = {
        ...issue,
        shape: issue.shape ?? 'fix',
        priority,
        projectItemId: issue.projectItemId!,
      };
      // stackBase is set only when the issue was admitted *because* a blocker
      // has an open PR (blockedOn !== 'Nothing') and the base is a real blocker
      // branch — the all-blockers-merged case has baseBranch 'next' and
      // dispatches off `origin/next` normally (stackBase stays undefined).
      const sb = stackReady.get(issue.number)?.baseBranch;
      const stackBase =
        !child
        && issue.blockedOn === 'Another issue'
        && sb != null
        && sb !== 'next'
          ? sb
          : undefined;
      ready.push(stackBase != null ? { ...normalized, stackBase } : normalized);
    } else {
      skippedForAuthor.push({ number: issue.number, author: issue.author });
    }
  }

  // Sort: in-current-sprint first (sprint commitment wins over backlog
  // discovery order), then Priority (P0 → P4 raw severity), then FIFO by
  // issue number. Sprint membership is the highest-precedence key per #609 —
  // a P3 sprint item beats a P0 non-sprint item. This matches the operator's
  // expectation that the declared sprint is the commitment surface; an
  // out-of-sprint P0 should be added to the sprint before it can race in.
  // When no active sprint exists (or the snapshot doesn't surface Sprint),
  // every issue's `inCurrentSprint` is false and this key is a no-op —
  // ordering falls through to Priority + FIFO, identical to pre-#609 behaviour.
  ready.sort((a, b) => {
    const sprintRank = Number(b.inCurrentSprint) - Number(a.inCurrentSprint);
    return sprintRank
      || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      || a.number - b.number;
  });

  return { ready, skippedForAuthor };
}
