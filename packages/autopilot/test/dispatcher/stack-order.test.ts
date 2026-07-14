import { describe, it, expect } from 'vitest';
import { enumerateStacks } from '../../src/dispatcher/stack-order.js';
import type { PrDescriptor } from '../../src/dispatcher/stack-order.js';

function pr(number: number, baseRefName: string, headRefName?: string): PrDescriptor {
  return { number, headRefName: headRefName ?? `b/${number}`, baseRefName };
}

describe('enumerateStacks', () => {
  it('fully enumerates a 2-deep stack, lower layer first (Tier-1 ordering)', () => {
    const prs = [pr(10, 'next', 'b/10'), pr(12, 'b/10', 'b/12')];
    const { candidates, orphans } = enumerateStacks(prs, 'next');
    expect(candidates.map((c) => c.number)).toEqual([10, 12]);
    expect(orphans).toEqual([]);
    const root = candidates.find((c) => c.number === 10)!;
    const child = candidates.find((c) => c.number === 12)!;
    expect(root.tier).toBe('root');
    expect(root.parentNumber).toBeNull();
    expect(root.depth).toBe(0);
    expect(root.stackRootNumber).toBe(10);
    expect(child.tier).toBe('stacked');
    expect(child.parentNumber).toBe(10);
    expect(child.depth).toBe(1);
    expect(child.stackRootNumber).toBe(10);
  });

  it('keeps independent roots in FIFO order by number', () => {
    const prs = [pr(40, 'next'), pr(20, 'next'), pr(30, 'next')];
    const { candidates } = enumerateStacks(prs, 'next');
    expect(candidates.map((c) => c.number)).toEqual([20, 30, 40]);
    expect(candidates.every((c) => c.tier === 'root')).toBe(true);
  });

  it('routes a PR whose base is a deleted/unknown branch to orphans, never dropped', () => {
    const prs = [pr(10, 'next', 'b/10'), pr(99, 'deleted-branch', 'b/99')];
    const { candidates, orphans } = enumerateStacks(prs, 'next');
    expect(candidates.map((c) => c.number)).toEqual([10]);
    expect(orphans.map((o) => o.number)).toEqual([99]);
  });

  it('orders a 3-deep stack root → mid → leaf, contiguous', () => {
    const prs = [
      pr(12, 'b/10', 'b/12'),
      pr(10, 'next', 'b/10'),
      pr(11, 'b/10', 'b/11'),
    ];
    const { candidates } = enumerateStacks(prs, 'next');
    expect(candidates.map((c) => c.number)).toEqual([10, 11, 12]);
    expect(candidates.find((c) => c.number === 12)!.depth).toBe(1);
    expect(candidates.find((c) => c.number === 12)!.stackRootNumber).toBe(10);
  });

  it('keeps two independent stacks contiguous, ordered by stack-root number (FIFO)', () => {
    const prs = [
      pr(50, 'next', 'b/50'), pr(52, 'b/50', 'b/52'),
      pr(40, 'next', 'b/40'), pr(42, 'b/40', 'b/42'),
    ];
    const { candidates } = enumerateStacks(prs, 'next');
    expect(candidates.map((c) => c.number)).toEqual([40, 42, 50, 52]);
  });

  it('cycle guard: a base-ref cycle routes the cyclic PRs to orphans, never loops', () => {
    const prs = [pr(70, 'b/71', 'b/70'), pr(71, 'b/70', 'b/71')];
    const { candidates, orphans } = enumerateStacks(prs, 'next');
    expect(candidates).toEqual([]);
    expect(orphans.map((o) => o.number).sort()).toEqual([70, 71]);
  });

  it('defaults baseBranch to "next" when omitted', () => {
    const prs = [pr(10, 'next', 'b/10')];
    const { candidates } = enumerateStacks(prs);
    expect(candidates.map((c) => c.number)).toEqual([10]);
  });
});
