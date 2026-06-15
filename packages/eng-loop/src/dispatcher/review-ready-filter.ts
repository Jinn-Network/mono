import type { PolledPr, ReviewablePr } from './types.js';

/**
 * Filter polled PRs down to those a `review-pr` session should be dispatched
 * for: carry the opt-in label, need a (re)review, are not already in flight,
 * and are authored by a trusted (allowlisted) login. Ordered FIFO by PR number
 * (oldest first).
 *
 * The author gate is a SECURITY boundary, not a convenience filter (gate 2,
 * DR-2026-06-15): a `review-pr` session checks out the PR head branch and the
 * `app-test` stage RUNS it, so dispatching a review for an untrusted fork PR is
 * arbitrary code execution on the runner. We therefore never let a
 * non-allowlisted author's PR reach dispatch/checkout. `authorAllowlist` must
 * already be lowercased by the caller (mirrors the implement-side ready-filter)
 * and must include the implementer bot so the engine reviews its own PRs.
 */
export function selectReviewable(
  polled: PolledPr[],
  inFlight: ReadonlySet<number>,
  authorAllowlist: ReadonlySet<string>,
): ReviewablePr[] {
  // Draft PRs are intentionally NOT excluded: engine PRs are opened as drafts
  // (implement-issue Stage 8 `gh pr create --draft --label engine:review`), and
  // review-pr reviews them and un-drafts on approval — that un-draft IS the
  // merge-ready signal (spec 2026-05-29-pr-review-loop-design.md §"The
  // merge-ready signal"). Filtering on !isDraft would review zero engine PRs.
  return polled
    .filter(
      (p): p is ReviewablePr =>
        p.hasReviewLabel &&
        p.needsReview &&
        !inFlight.has(p.number) &&
        authorAllowlist.has(p.author.toLowerCase()),
    )
    .sort((a, b) => a.number - b.number);
}
