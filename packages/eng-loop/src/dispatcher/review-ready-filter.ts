import type { PolledPr, ReviewablePr } from './types.js';

/**
 * Filter polled PRs down to those a `review-pr` session should be dispatched
 * for: carry the opt-in label, need a (re)review, and are not already in
 * flight. Ordered FIFO by PR number (oldest first).
 */
export function selectReviewable(
  polled: PolledPr[],
  inFlight: ReadonlySet<number>,
): ReviewablePr[] {
  // Draft PRs are intentionally NOT excluded: engine PRs are opened as drafts
  // (implement-issue Stage 8 `gh pr create --draft --label engine:review`), and
  // review-pr reviews them and un-drafts on approval — that un-draft IS the
  // merge-ready signal (spec 2026-05-29-pr-review-loop-design.md §"The
  // merge-ready signal"). Filtering on !isDraft would review zero engine PRs.
  return polled
    .filter((p): p is ReviewablePr => p.hasReviewLabel && p.needsReview && !inFlight.has(p.number))
    .sort((a, b) => a.number - b.number);
}
