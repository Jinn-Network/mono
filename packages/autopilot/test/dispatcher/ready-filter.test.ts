import { describe, it, expect } from 'vitest';
import { selectReady } from '../../src/dispatcher/ready-filter.js';
import type { PolledIssue } from '../../src/dispatcher/types.js';
import type { StackReady } from '../../src/dispatcher/stack-readiness.js';

const base: PolledIssue = {
  number: 1, title: 't', shape: 'fix', blockedOn: 'Nothing',
  blockedByIssues: [], effort: 'Low', priority: 'P2',
  status: 'Todo', onBoard: true, author: 'alice', projectItemId: 'PVTI_1',
  inCurrentSprint: false,
};

const ALLOW_ALICE: ReadonlySet<string> = new Set(['alice']);
const stack = (e: Record<number, StackReady>): ReadonlyMap<number, StackReady> =>
  new Map(Object.entries(e).map(([k, v]) => [Number(k), v]));

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

  describe('current-sprint priority (#609)', () => {
    it('prioritises a same-priority sprint item over a non-sprint one (FIFO no longer breaks the tie)', () => {
      // Same priority, sprint should win regardless of issue-number FIFO.
      // Lower issue number (non-sprint) would have won pre-#609.
      const sprint = { ...base, number: 50, priority: 'P2' as const, inCurrentSprint: true };
      const nonSprint = { ...base, number: 10, priority: 'P2' as const, inCurrentSprint: false };
      const { ready } = selectReady([nonSprint, sprint], new Set(), ALLOW_ALICE);
      expect(ready.map((i) => i.number)).toEqual([50, 10]);
    });

    it('prioritises a sprint item over a non-sprint one even when the non-sprint has higher Priority', () => {
      // Sprint commitment trumps raw severity (#609): a P3 sprint item beats
      // a P0 non-sprint item. Operators who want this to flip should add the
      // P0 to the sprint instead of relying on raw priority.
      const sprintP3 = { ...base, number: 1, priority: 'P3' as const, inCurrentSprint: true };
      const nonSprintP0 = { ...base, number: 2, priority: 'P0' as const, inCurrentSprint: false };
      const { ready } = selectReady([sprintP3, nonSprintP0], new Set(), ALLOW_ALICE);
      expect(ready.map((i) => i.number)).toEqual([1, 2]);
    });

    it('falls back to Priority then FIFO within each sprint bucket', () => {
      // Three sprint items at different priorities + one non-sprint item.
      // Expect: sprint bucket ordered by Priority/FIFO, then non-sprint last.
      const sprintP1 = { ...base, number: 100, priority: 'P1' as const, inCurrentSprint: true };
      const sprintP3a = { ...base, number: 50, priority: 'P3' as const, inCurrentSprint: true };
      const sprintP3b = { ...base, number: 75, priority: 'P3' as const, inCurrentSprint: true };
      const nonSprintP1 = { ...base, number: 200, priority: 'P1' as const, inCurrentSprint: false };
      const { ready } = selectReady(
        [nonSprintP1, sprintP3b, sprintP1, sprintP3a],
        new Set(),
        ALLOW_ALICE,
      );
      expect(ready.map((i) => i.number)).toEqual([100, 50, 75, 200]);
    });

    it('preserves pre-#609 Priority+FIFO ordering when no items are in the current sprint', () => {
      // Smoke check: with every item out-of-sprint (the no-active-sprint case),
      // the sort behaves identically to the original Priority+FIFO order.
      const a = { ...base, number: 5, priority: 'P3' as const, inCurrentSprint: false };
      const b = { ...base, number: 9, priority: 'P0' as const, inCurrentSprint: false };
      const c = { ...base, number: 3, priority: 'P3' as const, inCurrentSprint: false };
      const { ready } = selectReady([a, b, c], new Set(), ALLOW_ALICE);
      expect(ready.map((i) => i.number)).toEqual([9, 3, 5]);
    });
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

  describe('dependency stacking (spec 2026-07-13)', () => {
    const blocked = { ...base, number: 100, blockedOn: 'Another issue' as const };

    it('drops a Blocked-on-Another-issue issue absent from stackReady', () => {
      const { ready } = selectReady([blocked], new Set(), ALLOW_ALICE, new Map());
      expect(ready).toEqual([]);
    });

    it('NEVER admits a Blocked-on-Human issue even when it appears in stackReady', () => {
      // The Human lane is an unconditional operator override — a satisfied
      // native blocker must not override an explicit `Blocked on: Human`.
      const humanBlocked = { ...base, number: 200, blockedOn: 'Human' as const };
      const { ready } = selectReady(
        [humanBlocked],
        new Set(),
        ALLOW_ALICE,
        stack({ 200: { baseBranch: 'feat/50-blocker' } }),
      );
      expect(ready).toEqual([]);
    });

    it('admits a blocked issue in stackReady and stamps its stackBase (real blocker branch)', () => {
      const { ready } = selectReady(
        [blocked],
        new Set(),
        ALLOW_ALICE,
        stack({ 100: { baseBranch: 'feat/50-blocker' } }),
      );
      expect(ready.map((i) => i.number)).toEqual([100]);
      expect(ready[0].stackBase).toBe('feat/50-blocker');
    });

    it('admits a blocked issue whose blockers all merged (base=next) with NO stackBase', () => {
      const { ready } = selectReady(
        [blocked],
        new Set(),
        ALLOW_ALICE,
        stack({ 100: { baseBranch: 'next' } }),
      );
      expect(ready.map((i) => i.number)).toEqual([100]);
      expect(ready[0].stackBase).toBeUndefined();
    });

    it('never stamps stackBase on a normally-unblocked (Nothing) issue', () => {
      // Even if it somehow appears in stackReady, a Nothing issue dispatches off next.
      const { ready } = selectReady(
        [base],
        new Set(),
        ALLOW_ALICE,
        stack({ 1: { baseBranch: 'feat/50-blocker' } }),
      );
      expect(ready.map((i) => i.number)).toEqual([1]);
      expect(ready[0].stackBase).toBeUndefined();
    });
  });
});
