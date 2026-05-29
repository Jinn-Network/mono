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
  return polled
    .filter((p): p is ReviewablePr => p.hasReviewLabel && p.needsReview && !inFlight.has(p.number))
    .sort((a, b) => a.number - b.number);
}
