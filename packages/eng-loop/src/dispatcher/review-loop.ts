import type { PrSource } from './pr-source.js';
import type { DispatcherConfig, InFlightReview, ReviewablePr } from './types.js';
import { selectReviewable } from './review-ready-filter.js';

export interface ReviewCycleReport {
  /** PR numbers dispatched this cycle, in dispatch order. */
  dispatched: number[];
  /** Reviewable PRs left undispatched because the cap was reached. */
  skippedForCap: number;
  /** Drift strings from deriveReviewInFlight (currently always empty). */
  drift: string[];
}

export interface ReviewCycleDeps {
  prSource: PrSource;
  cfg: DispatcherConfig;
  deriveReviewInFlight(): Promise<{ inFlight: InFlightReview[]; drift: string[] }>;
  dispatchReview(pr: ReviewablePr): Promise<InFlightReview>;
}

/**
 * One tick of the review loop (mirrors runCycle): poll PRs, derive in-flight
 * reviews, filter reviewable, dispatch up to `reviewCap − inFlight`. Contains
 * NO gh/git calls — all I/O is injected (seam discipline).
 */
export async function runReviewCycle(deps: ReviewCycleDeps): Promise<ReviewCycleReport> {
  const { prSource, cfg, deriveReviewInFlight, dispatchReview } = deps;

  const [polled, { inFlight, drift }] = await Promise.all([
    prSource.poll(),
    deriveReviewInFlight(),
  ]);

  const inFlightSet = new Set<number>(inFlight.map((s) => s.prNumber));
  // Gate 2 (DR-2026-06-15): only review PRs authored by a trusted login — the
  // review session checks out and RUNS the PR branch, so an untrusted fork PR
  // must never reach dispatch. Reuses the dispatcher's author allowlist (which
  // must include the implementer bot so the engine reviews its own PRs).
  const authorAllowlist = new Set(cfg.authorAllowlist.map((s) => s.toLowerCase()));
  const reviewable = selectReviewable(polled, inFlightSet, authorAllowlist);

  const budget = Math.max(0, cfg.reviewCap - inFlight.length);
  const toDispatch = reviewable.slice(0, budget);

  const dispatched: number[] = [];
  for (const pr of toDispatch) {
    await dispatchReview(pr);
    dispatched.push(pr.number);
  }

  return { dispatched, skippedForCap: reviewable.length - toDispatch.length, drift };
}
