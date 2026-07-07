import { describe, it, expect } from 'vitest';
import { selectReviewable } from '../../src/dispatcher/review-ready-filter.js';
import type { PolledPr } from '../../src/dispatcher/types.js';

function pr(number: number, over: Partial<PolledPr> = {}): PolledPr {
  return {
    number, title: `pr ${number}`, headRefName: `b/${number}`, headRefOid: 's',
    isDraft: false, author: 'a', hasReviewLabel: true, needsReview: true, ...over,
  };
}

describe('selectReviewable', () => {
  it('keeps labelled PRs needing review, drops in-flight, orders FIFO by number', () => {
    const polled = [pr(30), pr(10), pr(20, { needsReview: false }), pr(40)];
    const inFlight = new Set<number>([40]);
    const ready = selectReviewable(polled, inFlight);
    expect(ready.map((p) => p.number)).toEqual([10, 30]);
  });

  it('drops PRs without the label (defensive)', () => {
    const ready = selectReviewable([pr(1, { hasReviewLabel: false })], new Set());
    expect(ready).toEqual([]);
  });
});
