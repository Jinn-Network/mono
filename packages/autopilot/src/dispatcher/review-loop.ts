import type { PrSource } from './pr-source.js';
import type { DispatcherConfig, InFlightReview, ReviewablePr } from './types.js';
import { selectReviewable } from './review-ready-filter.js';
import { reviewWorktreePath } from './review-lease.js';

export const REVIEW_REAP_MS = 2 * 60 * 60 * 1000;

export interface ReviewCycleReport {
  /** PR numbers dispatched this cycle, in dispatch order. */
  dispatched: number[];
  /** Reviewable PRs left undispatched because the cap was reached. */
  skippedForCap: number;
  /** Drift strings from deriveReviewInFlight (currently always empty). */
  drift: string[];
  /**
   * PR numbers whose dispatch threw this cycle. Isolated — the remaining PRs
   * still dispatched. Before this, one failing `git worktree add` aborted the
   * entire review pass, so a single bad PR silently starved every other PR
   * every cycle (observed live 2026-07-17).
   */
  failed: number[];
  /** PR numbers whose stale review worktrees were removed this cycle. */
  reaped: number[];
}

export interface ReviewCycleDeps {
  prSource: PrSource;
  cfg: DispatcherConfig;
  deriveReviewInFlight(): Promise<{ inFlight: InFlightReview[]; drift: string[] }>;
  removeWorktree(w: InFlightReview): Promise<void>;
  dispatchReview(pr: ReviewablePr): Promise<InFlightReview>;
  now?(): number;
  /** True only when the persisted reviewer pid is still alive. Fail-safe default
   * treats every pid as alive, disabling fallback cleanup unless wired. */
  isProcessAlive?(pid: number): boolean;
  /**
   * PR numbers with a live merge-prep session (a `merge-<N>` worktree). Excluded
   * from review dispatch so a review and a prep never push to the same branch
   * concurrently (DR-2026-07-16 — the symmetric counterpart to the prep loop's
   * `reviewInFlight` guard). They do NOT consume the review cap. Optional; empty
   * when merge-prep is disarmed.
   */
  busyPrNumbers?: ReadonlySet<number>;
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

  const now = deps.now ?? Date.now;
  const live: InFlightReview[] = [];
  const reaped: number[] = [];

  for (const review of inFlight) {
    let canonical = false;
    try {
      canonical = review.worktreePath === reviewWorktreePath(review.prNumber);
    } catch {
      canonical = false;
    }
    let processDead = false;
    if (canonical && review.pid != null) {
      try {
        processDead = !(deps.isProcessAlive ?? (() => true))(review.pid);
      } catch {
        processDead = false;
      }
    }
    const stale =
      canonical &&
      review.pid != null &&
      processDead &&
      review.startedAt > 0 &&
      now() - review.startedAt > REVIEW_REAP_MS;
    if (!stale) {
      live.push(review);
      continue;
    }

    try {
      await deps.removeWorktree(review);
      reaped.push(review.prNumber);
    } catch (err) {
      console.error(
        `[review-loop] reap failed for PR #${review.prNumber} (continuing):`,
        err,
      );
      live.push(review);
    }
  }

  // Exclude both in-flight reviews AND PRs with a live merge-prep session (the
  // latter don't count against the review cap — they just must not be reviewed
  // while a prep is pushing to the same branch).
  const excludeSet = new Set<number>([
    ...live.map((s) => s.prNumber),
    ...(deps.busyPrNumbers ?? []),
  ]);
  // Gate 2 (DR-2026-06-15): only review PRs authored by a trusted login — the
  // review session checks out and RUNS the PR branch, so an untrusted fork PR
  // must never reach dispatch. Reuses the dispatcher's author allowlist (which
  // must include the implementer bot so the engine reviews its own PRs).
  const authorAllowlist = new Set(cfg.authorAllowlist.map((s) => s.toLowerCase()));
  const reviewable = selectReviewable(polled, excludeSet, authorAllowlist);

  const budget = Math.max(0, cfg.reviewCap - live.length);
  const toDispatch = reviewable.slice(0, budget);

  // Isolate each dispatch: one PR's failure (e.g. a git worktree collision)
  // must never abort the pass and starve every other PR. Mirrors
  // merge-prep-loop's per-PR isolation and Stage A's escalateStuckPrs.
  const dispatched: number[] = [];
  const failed: number[] = [];
  for (const pr of toDispatch) {
    try {
      await dispatchReview(pr);
      dispatched.push(pr.number);
    } catch (err) {
      console.error(`[review-loop] dispatch failed for PR #${pr.number} (continuing):`, err);
      failed.push(pr.number);
    }
  }

  return { dispatched, skippedForCap: reviewable.length - toDispatch.length, drift, failed, reaped };
}
