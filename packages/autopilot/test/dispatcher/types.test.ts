import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import type { PolledPr, ReviewablePr, InFlightReview } from '../../src/dispatcher/types.js';

describe('review-loop types', () => {
  it('DEFAULT_CONFIG carries review-loop fields', () => {
    expect(DEFAULT_CONFIG.reviewCap).toBe(3);
    expect(DEFAULT_CONFIG.engineReviewLabel).toBe('engine:review');
    expect(DEFAULT_CONFIG.reviewBotLogin).toBe('');
  });

  it('ReviewablePr narrows PolledPr', () => {
    const pr: ReviewablePr = {
      number: 42, title: 't', headRefName: 'feat/42-x', headRefOid: 'abc',
      isDraft: true, author: 'alice', hasReviewLabel: true, needsReview: true,
    };
    const widened: PolledPr = pr;
    expect(widened.number).toBe(42);
  });

  it('InFlightReview is PR-keyed', () => {
    const s: InFlightReview = { prNumber: 42, branch: 'feat/42-x', worktreePath: '/p/pr-42', pid: 1, startedAt: 0 };
    expect(s.prNumber).toBe(42);
  });

  it('DEFAULT_CONFIG uses one process-wide Claude runtime', () => {
    expect(DEFAULT_CONFIG.runtime).toBe('claude');
  });
});
