import { describe, it, expect } from 'vitest';
import { selectReviewable } from '../../src/dispatcher/review-ready-filter.js';
import type { PolledPr } from '../../src/dispatcher/types.js';

function pr(number: number, over: Partial<PolledPr> = {}): PolledPr {
  return {
    number, title: `pr ${number}`, headRefName: `b/${number}`, headRefOid: 's',
    isDraft: false, author: 'a', hasReviewLabel: true, needsReview: true, ...over,
  };
}

// Lowercased trusted-author set (the caller lowercases; mirrors implement-side
// ready-filter). Must include the implementer bot so the engine reviews its own
// PRs, plus the trusted humans.
const ALLOW = new Set(['a', 'jinn-impl-bot']);

describe('selectReviewable', () => {
  it('keeps labelled PRs needing review, drops in-flight, orders FIFO by number', () => {
    const polled = [pr(30), pr(10), pr(20, { needsReview: false }), pr(40)];
    const inFlight = new Set<number>([40]);
    const ready = selectReviewable(polled, inFlight, ALLOW);
    expect(ready.map((p) => p.number)).toEqual([10, 30]);
  });

  it('drops PRs without the label (defensive)', () => {
    const ready = selectReviewable([pr(1, { hasReviewLabel: false })], new Set(), ALLOW);
    expect(ready).toEqual([]);
  });

  it('drops PRs whose author is NOT in the allowlist — never selects an untrusted branch for checkout (gate 2, DR-2026-06-15)', () => {
    // review-pr checks out the PR head branch and the app-test stage RUNS it;
    // a non-allowlisted fork PR must never reach dispatch (= RCE prevention).
    const polled = [pr(10, { author: 'jinn-impl-bot' }), pr(11, { author: 'mallory' })];
    const ready = selectReviewable(polled, new Set(), ALLOW);
    expect(ready.map((p) => p.number)).toEqual([10]);
  });

  it('matches the author allowlist case-insensitively', () => {
    const ready = selectReviewable([pr(12, { author: 'JINN-Impl-Bot' })], new Set(), ALLOW);
    expect(ready.map((p) => p.number)).toEqual([12]);
  });

  it('drops everything when the allowlist is empty (fail-safe)', () => {
    const ready = selectReviewable([pr(1), pr(2)], new Set(), new Set());
    expect(ready).toEqual([]);
  });
});
