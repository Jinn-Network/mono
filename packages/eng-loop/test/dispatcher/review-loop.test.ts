import { describe, it, expect } from 'vitest';
import { runReviewCycle } from '../../src/dispatcher/review-loop.js';
import type { PrSource } from '../../src/dispatcher/pr-source.js';
import type { PolledPr, ReviewablePr, InFlightReview, DispatcherConfig } from '../../src/dispatcher/types.js';

const CFG: DispatcherConfig = {
  concurrencyCap: 3, openPrBackpressure: 30, wallClockMs: 1, defaultImplementer: 'claude',
  implementerRules: [],
  // 'a' is the default PR author in pr(); allowlisting it lets these cycle
  // tests exercise dispatch (the review-side author gate, DR-2026-06-15, drops
  // non-allowlisted authors — covered directly in review-ready-filter.test.ts).
  authorAllowlist: ['a'], reviewCap: 2, engineReviewLabel: 'engine:review', reviewBotLogin: 'jinn-bot',
  implGhToken: '', reviewGhToken: '',
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
      dispatchReview: async (p: ReviewablePr) => { dispatched.push(p.number); return { prNumber: p.number, branch: p.headRefName, worktreePath: '/x', pid: 1, startedAt: 0 }; },
    });
    expect(dispatched).toEqual([5]);
  });

  it('does not re-dispatch a PR already in flight', async () => {
    const source: PrSource = { poll: async () => [pr(7)] };
    const dispatched: number[] = [];
    await runReviewCycle({
      prSource: source,
      cfg: CFG,
      deriveReviewInFlight: async () => ({ inFlight: [{ prNumber: 7, branch: 'b/7', worktreePath: '/pr-7', pid: 1, startedAt: 0 }], drift: [] }),
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
      dispatchReview: async (p: ReviewablePr) => { dispatched.push(p.number); return { prNumber: p.number, branch: p.headRefName, worktreePath: '/x', pid: 1, startedAt: 0 }; },
    });
    expect(dispatched).toEqual([8]);
  });
});
