import type { PrSource } from './pr-source.js';
import type { DispatcherConfig, InFlightReview, ReviewablePr } from './types.js';
import { selectReviewable } from './review-ready-filter.js';

/**
 * Staleness ceiling for `pr-<N>` review worktrees (jinn-mono#1764). Nothing
 * else reaps this namespace: the drift sweep only reconciles numeric task
 * worktrees, and `review-pr` sessions have no other cleanup path. Left
 * unbounded, a review session that never exits (crash, hang, orphaned
 * process) keeps its worktree forever and its `pr-<N>` entry counts against
 * `reviewCap` in `deriveReviewInFlight` permanently, eventually wedging the
 * cap at zero. Deliberately independent from any merge-prep reap constant —
 * the two worktree namespaces (`pr-<N>` vs. a future `merge-<N>`) are tuned
 * separately.
 */
export const REVIEW_REAP_MS = 2 * 60 * 60 * 1000;

export interface ReviewCycleReport {
  /** PR numbers dispatched this cycle, in dispatch order. */
  dispatched: number[];
  /** Reviewable PRs left undispatched because the cap was reached. */
  skippedForCap: number;
  /** Drift strings from deriveReviewInFlight (currently always empty). */
  drift: string[];
  /**
   * PR numbers whose stale `pr-<N>` worktree was reaped this cycle (order:
   * as returned by deriveReviewInFlight). Freed slots count toward this
   * cycle's dispatch budget, so a waiting PR can dispatch the same cycle
   * its blocker's worktree was reaped.
   */
  reaped: number[];
}

export interface ReviewCycleDeps {
  prSource: PrSource;
  cfg: DispatcherConfig;
  deriveReviewInFlight(): Promise<{ inFlight: InFlightReview[]; drift: string[] }>;
  dispatchReview(pr: ReviewablePr): Promise<InFlightReview>;
  /**
   * PR numbers with a live merge-prep session (a `merge-<N>` worktree). Excluded
   * from review dispatch so a review and a prep never push to the same branch
   * concurrently (DR-2026-07-16 — the symmetric counterpart to the prep loop's
   * `reviewInFlight` guard). They do NOT consume the review cap. Optional; empty
   * when merge-prep is disarmed.
   */
  busyPrNumbers?: ReadonlySet<number>;
  /**
   * Remove a stale review worktree (`git worktree remove --force`, jinn-mono#1764).
   * Must not throw on the caller's behalf — `runReviewCycle` catches and logs
   * failures itself, treating the worktree as still-live so one stuck removal
   * cannot wedge the rest of the cycle.
   */
  removeWorktree(w: InFlightReview): Promise<void>;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?(): number;
}

/**
 * One tick of the review loop (mirrors runCycle): poll PRs, derive in-flight
 * reviews, reap stale `pr-<N>` worktrees (jinn-mono#1764), filter reviewable,
 * dispatch up to `reviewCap − live`. Contains NO gh/git calls — all I/O is
 * injected (seam discipline).
 */
export async function runReviewCycle(deps: ReviewCycleDeps): Promise<ReviewCycleReport> {
  const { prSource, cfg, deriveReviewInFlight, dispatchReview, removeWorktree } = deps;
  const now = deps.now ?? Date.now;

  const [polled, { inFlight, drift }] = await Promise.all([
    prSource.poll(),
    deriveReviewInFlight(),
  ]);

  // Reap stale worktrees before computing the dispatch budget, so a freed
  // slot is available to the same cycle's dispatch pass. startedAt === 0
  // means deriveReviewInFlight's recoverStartedAt couldn't stat the
  // worktree (unknown age) — never reap that; it protects a session whose
  // worktree creation is still racing the stat call.
  const live: InFlightReview[] = [];
  const reaped: number[] = [];
  for (const w of inFlight) {
    const stale = w.startedAt > 0 && now() - w.startedAt > REVIEW_REAP_MS;
    if (!stale) {
      live.push(w);
      continue;
    }
    try {
      await removeWorktree(w);
      reaped.push(w.prNumber);
    } catch (err) {
      console.error(`[review-loop] reap failed for PR #${w.prNumber} (continuing):`, err);
      live.push(w); // degrade to today's behaviour — occupied slot, not aborted pass
    }
  }

  // Exclude LIVE reviews (post-reap, so a reaped PR is dispatchable again this
  // cycle) AND PRs with a live merge-prep session — the latter don't count
  // against the review cap, they just must not be reviewed while a prep is
  // pushing to the same branch (DR-2026-07-16).
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

  const dispatched: number[] = [];
  for (const pr of toDispatch) {
    await dispatchReview(pr);
    dispatched.push(pr.number);
  }

  return { dispatched, skippedForCap: reviewable.length - toDispatch.length, drift, reaped };
}
