import type { PolledIssue, ReadyIssue, Priority } from './types.js';

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
 * `Blocked on: Nothing`, on the board, in `Todo`, and not already in flight,
 * AND its author is on the configured allowlist (#497 trust boundary).
 * Ready issues are ordered by Priority, then FIFO by issue number.
 *
 * The author check is a second-pass predicate: issues that pass every other
 * predicate but fail the allowlist are recorded in `skippedForAuthor` so
 * operators can see *who* is being blocked, not just a count. Issues that
 * fail the first-pass predicates (shape, board, status, ...) are excluded
 * from both arrays — they're not a trust signal, they're just not ready.
 *
 * `authorAllowlist` is expected to already be lowercased by the caller —
 * the function lowercases the issue side at compare time and does an O(1)
 * `Set.has` lookup. An empty allowlist means "dispatch nothing" by design
 * (fail-safe default; see spec 2026-05-23-author-allowlist-design.md).
 */
export function selectReady(
  polled: PolledIssue[],
  inFlight: ReadonlySet<number>,
  authorAllowlist: ReadonlySet<string>,
): SelectReadyResult {
  // First pass: all the existing readiness predicates. Failures are excluded
  // from both arrays — author-skips only apply to otherwise-ready issues.
  const firstPass = polled.filter(
    (i): i is ReadyIssue =>
      i.shape !== null &&
      i.priority !== null &&
      i.blockedOn === 'Nothing' &&
      i.onBoard &&
      i.status === 'Todo' &&
      !inFlight.has(i.number),
  );

  // Second pass: author allowlist. Partition into ready vs. skippedForAuthor.
  const ready: ReadyIssue[] = [];
  const skippedForAuthor: SkippedForAuthor[] = [];
  for (const issue of firstPass) {
    if (authorAllowlist.has(issue.author.toLowerCase())) {
      ready.push(issue);
    } else {
      skippedForAuthor.push({ number: issue.number, author: issue.author });
    }
  }

  ready.sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      a.number - b.number,
  );

  return { ready, skippedForAuthor };
}
