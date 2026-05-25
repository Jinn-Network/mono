import { describe, it, expect } from 'vitest';
import { selectReady } from '../../src/dispatcher/ready-filter.js';
import type { PolledIssue } from '../../src/dispatcher/types.js';

const base: PolledIssue = {
  number: 1, title: 't', shape: 'fix', blockedOn: 'Nothing',
  blockedOnIssue: null, effort: 'Low', priority: 'P2',
  status: 'Todo', onBoard: true, author: 'alice', projectItemId: 'PVTI_1',
};

const ALLOW_ALICE: ReadonlySet<string> = new Set(['alice']);

describe('selectReady', () => {
  it('keeps a triage-complete, unblocked, on-board, Todo issue', () => {
    const { ready } = selectReady([base], new Set(), ALLOW_ALICE);
    expect(ready.map((i) => i.number)).toEqual([1]);
  });
  it('drops an issue with no Issue Type', () => {
    const { ready } = selectReady([{ ...base, shape: null }], new Set(), ALLOW_ALICE);
    expect(ready).toEqual([]);
  });
  it('drops an issue Blocked on Human', () => {
    const { ready } = selectReady([{ ...base, blockedOn: 'Human' }], new Set(), ALLOW_ALICE);
    expect(ready).toEqual([]);
  });
  it('drops an issue not on the board', () => {
    const { ready } = selectReady([{ ...base, onBoard: false }], new Set(), ALLOW_ALICE);
    expect(ready).toEqual([]);
  });
  it('drops an issue already in flight', () => {
    const { ready } = selectReady([base], new Set([1]), ALLOW_ALICE);
    expect(ready).toEqual([]);
  });
  it('orders by Priority then FIFO by issue number', () => {
    const a = { ...base, number: 5, priority: 'P3' as const };
    const b = { ...base, number: 9, priority: 'P0' as const };
    const c = { ...base, number: 3, priority: 'P3' as const };
    const { ready } = selectReady([a, b, c], new Set(), ALLOW_ALICE);
    expect(ready.map((i) => i.number)).toEqual([9, 3, 5]);
  });

  describe('author allowlist', () => {
    it('drops an otherwise-ready issue when the allowlist is empty', () => {
      const { ready, skippedForAuthor } = selectReady([base], new Set(), new Set());
      expect(ready).toEqual([]);
      expect(skippedForAuthor).toEqual([{ number: 1, author: 'alice' }]);
    });

    it('keeps an issue when its author is on the allowlist (exact match)', () => {
      const { ready, skippedForAuthor } = selectReady([base], new Set(), new Set(['alice']));
      expect(ready.map((i) => i.number)).toEqual([1]);
      expect(skippedForAuthor).toEqual([]);
    });

    it('keeps an issue when its author matches the allowlist case-insensitively', () => {
      // allowlist already lowercased by caller; the issue author has different casing
      const { ready, skippedForAuthor } = selectReady(
        [{ ...base, author: 'Alice' }],
        new Set(),
        new Set(['alice']),
      );
      expect(ready.map((i) => i.number)).toEqual([1]);
      expect(skippedForAuthor).toEqual([]);
    });

    it('skips an issue whose author is not on the allowlist', () => {
      const { ready, skippedForAuthor } = selectReady(
        [{ ...base, author: 'bob' }],
        new Set(),
        new Set(['alice']),
      );
      expect(ready).toEqual([]);
      expect(skippedForAuthor).toEqual([{ number: 1, author: 'bob' }]);
    });

    it('splits a mixed batch into ready and skippedForAuthor', () => {
      const aliceIssue = { ...base, number: 10, author: 'alice' };
      const bobIssue = { ...base, number: 11, author: 'bob' };
      const { ready, skippedForAuthor } = selectReady(
        [aliceIssue, bobIssue],
        new Set(),
        new Set(['alice']),
      );
      expect(ready.map((i) => i.number)).toEqual([10]);
      expect(skippedForAuthor).toEqual([{ number: 11, author: 'bob' }]);
    });

    it('does NOT include first-pass failures (e.g. not-on-board) in skippedForAuthor', () => {
      // An issue that fails the shape/board/etc. predicates is excluded from both arrays.
      const { ready, skippedForAuthor } = selectReady(
        [{ ...base, onBoard: false, author: 'mallory' }],
        new Set(),
        new Set(['alice']),
      );
      expect(ready).toEqual([]);
      expect(skippedForAuthor).toEqual([]);
    });
  });
});
