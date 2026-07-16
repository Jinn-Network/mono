import { describe, it, expect } from 'vitest';
import { runReviewCycle, REVIEW_REAP_MS } from '../../src/dispatcher/review-loop.js';
import type { PrSource } from '../../src/dispatcher/pr-source.js';
import type { PolledPr, ReviewablePr, InFlightReview, DispatcherConfig } from '../../src/dispatcher/types.js';

const CFG: DispatcherConfig = {
  concurrencyCap: 3, openPrBackpressure: 30, wallClockMs: 1, defaultImplementer: 'claude',
  implementerRules: [],
  // 'a' is the default PR author in pr(); allowlisting it lets these cycle
  // tests exercise dispatch (the review-side author gate, DR-2026-06-15, drops
  // non-allowlisted authors — covered directly in review-ready-filter.test.ts).
  authorAllowlist: ['a'], reviewCap: 2, engineReviewLabel: 'engine:review', reviewBotLogin: 'jinn-bot',
  implGhToken: '', reviewGhToken: '', mergePrepEnabled: false, mergePrepCap: 1,
};
function pr(n: number, over: Partial<PolledPr> = {}): PolledPr {
  return { number: n, title: `t${n}`, headRefName: `b/${n}`, headRefOid: 's', isDraft: false, author: 'a', hasReviewLabel: true, needsReview: true, ...over };
}

describe('runReviewCycle', () => {
  it('dispatches reviewable PRs up to reviewCap − inFlight, FIFO', async () => {
    const polled = [pr(3), pr(1), pr(2)];
    const source: PrSource = { poll: async () => polled };
    const dispatched: number[] = [];
    const report = await runReviewCycle({
      prSource: source,
      cfg: CFG,
      deriveReviewInFlight: async () => ({ inFlight: [] as InFlightReview[], drift: [] }),
      removeWorktree: async () => {},
      dispatchReview: async (p: ReviewablePr) => { dispatched.push(p.number); return { prNumber: p.number, branch: p.headRefName, worktreePath: `/pr-${p.number}`, pid: 1, startedAt: 0 }; },
    });
    expect(dispatched).toEqual([1, 2]);
    expect(report.dispatched).toEqual([1, 2]);
    expect(report.skippedForCap).toBe(1);
  });

  it('respects in-flight reviews against the cap', async () => {
    const source: PrSource = { poll: async () => [pr(5), pr(6)] };
    const dispatched: number[] = [];
    await runReviewCycle({
      prSource: source,
      cfg: CFG,
      deriveReviewInFlight: async () => ({ inFlight: [{ prNumber: 9, branch: 'x', worktreePath: '/pr-9', pid: 1, startedAt: 0 }], drift: [] }),
      removeWorktree: async () => {},
      dispatchReview: async (p: ReviewablePr) => { dispatched.push(p.number); return { prNumber: p.number, branch: p.headRefName, worktreePath: '/x', pid: 1, startedAt: 0 }; },
    });
    expect(dispatched).toEqual([5]);
  });

  it('excludes a PR with a live merge-prep session (busyPrNumbers), without consuming the review cap', async () => {
    const source: PrSource = { poll: async () => [pr(5), pr(6)] };
    const dispatched: number[] = [];
    const report = await runReviewCycle({
      prSource: source,
      cfg: CFG, // reviewCap 2
      deriveReviewInFlight: async () => ({ inFlight: [] as InFlightReview[], drift: [] }),
      dispatchReview: async (p: ReviewablePr) => { dispatched.push(p.number); return { prNumber: p.number, branch: p.headRefName, worktreePath: `/pr-${p.number}`, pid: 1, startedAt: 0 }; },
      busyPrNumbers: new Set([5]),
    });
    expect(dispatched).toEqual([6]);       // #5 excluded (prep in flight)
    expect(report.skippedForCap).toBe(0);  // #5 did NOT eat a cap slot
  });

  it('does not re-dispatch a PR already in flight', async () => {
    const source: PrSource = { poll: async () => [pr(7)] };
    const dispatched: number[] = [];
    await runReviewCycle({
      prSource: source,
      cfg: CFG,
      deriveReviewInFlight: async () => ({ inFlight: [{ prNumber: 7, branch: 'b/7', worktreePath: '/pr-7', pid: 1, startedAt: 0 }], drift: [] }),
      removeWorktree: async () => {},
      dispatchReview: async (p: ReviewablePr) => { dispatched.push(p.number); return { prNumber: p.number, branch: p.headRefName, worktreePath: '/x', pid: 1, startedAt: 0 }; },
    });
    expect(dispatched).toEqual([]);
  });

  it('never dispatches a review for a non-allowlisted PR author (gate 2 wiring, DR-2026-06-15)', async () => {
    // Proves cfg.authorAllowlist is actually threaded into selectReviewable —
    // an untrusted fork PR must not reach dispatch (its branch would be checked
    // out and run by the app-test stage).
    const source: PrSource = { poll: async () => [pr(8, { author: 'a' }), pr(9, { author: 'mallory' })] };
    const dispatched: number[] = [];
    await runReviewCycle({
      prSource: source,
      cfg: CFG, // allowlists 'a' only
      deriveReviewInFlight: async () => ({ inFlight: [] as InFlightReview[], drift: [] }),
      removeWorktree: async () => {},
      dispatchReview: async (p: ReviewablePr) => { dispatched.push(p.number); return { prNumber: p.number, branch: p.headRefName, worktreePath: '/x', pid: 1, startedAt: 0 }; },
    });
    expect(dispatched).toEqual([8]);
  });

  it('reaps a stale worktree, frees its cap slot, and dispatches a waiting PR in the same cycle', async () => {
    const NOW = 10_000_000_000; // arbitrary fixed instant
    const stale: InFlightReview = { prNumber: 20, branch: 'b/20', worktreePath: '/pr-20', pid: 1, startedAt: NOW - REVIEW_REAP_MS - 1 };
    const fresh: InFlightReview = { prNumber: 21, branch: 'b/21', worktreePath: '/pr-21', pid: 1, startedAt: NOW - 1_000 };
    const unknown: InFlightReview = { prNumber: 22, branch: 'b/22', worktreePath: '/pr-22', pid: 1, startedAt: 0 };
    const source: PrSource = { poll: async () => [pr(30)] }; // 30 = the waiting reviewable PR
    const removed: number[] = [];
    const dispatched: number[] = [];
    const report = await runReviewCycle({
      prSource: source,
      // reviewCap: 3, deliberately equal to the 3 in-flight worktrees below —
      // the cap is fully occupied (budget 0) BEFORE the reap runs, so a
      // dispatch after reaping only the stale one proves the freed slot (not
      // just spare cap) is what let PR 30 through: live drops to 2 (fresh +
      // unknown), budget = max(0, 3 − 2) = 1.
      cfg: { ...CFG, reviewCap: 3 },
      now: () => NOW,
      deriveReviewInFlight: async () => ({ inFlight: [stale, fresh, unknown], drift: [] }),
      removeWorktree: async (w) => { removed.push(w.prNumber); },
      dispatchReview: async (p: ReviewablePr) => { dispatched.push(p.number); return { prNumber: p.number, branch: p.headRefName, worktreePath: `/pr-${p.number}`, pid: 1, startedAt: NOW }; },
    });
    expect(removed).toEqual([20]);
    expect(report.reaped).toEqual([20]);
    expect(dispatched).toEqual([30]);
    expect(report.dispatched).toEqual([30]);
  });

  it('keeps a worktree counted as live when removeWorktree throws, without aborting other dispatch', async () => {
    const NOW = 10_000_000_000;
    const stale: InFlightReview = { prNumber: 40, branch: 'b/40', worktreePath: '/pr-40', pid: 1, startedAt: NOW - REVIEW_REAP_MS - 1 };
    const source: PrSource = { poll: async () => [pr(41)] };
    const dispatched: number[] = [];
    const report = await runReviewCycle({
      prSource: source,
      cfg: CFG, // reviewCap: 2
      now: () => NOW,
      deriveReviewInFlight: async () => ({ inFlight: [stale], drift: [] }),
      removeWorktree: async () => { throw new Error('git worktree remove failed: locked'); },
      dispatchReview: async (p: ReviewablePr) => { dispatched.push(p.number); return { prNumber: p.number, branch: p.headRefName, worktreePath: `/pr-${p.number}`, pid: 1, startedAt: NOW }; },
    });
    expect(report.reaped).toEqual([]);
    // stale(40) still counts as live (1 slot used) + reviewCap 2 ⇒ budget 1 ⇒ PR 41 still dispatches
    expect(dispatched).toEqual([41]);
    expect(report.dispatched).toEqual([41]);
  });
});
