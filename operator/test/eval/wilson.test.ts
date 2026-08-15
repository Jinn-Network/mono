import { describe, expect, it } from 'vitest';
import { wilsonInterval, compareRates } from '@/eval/wilson.js';

describe('wilsonInterval', () => {
  it('computes a two-sided 95% interval for 8/10', () => {
    const { p, lo, hi } = wilsonInterval(8, 10);
    expect(p).toBeCloseTo(0.8, 5);
    expect(lo).toBeCloseTo(0.49, 2);
    expect(hi).toBeCloseTo(0.94, 2);
  });

  it('returns a degenerate zero interval for n=0 (no NaN)', () => {
    const r = wilsonInterval(0, 0);
    expect(r).toEqual({ p: 0, lo: 0, hi: 0 });
    expect(Number.isNaN(r.lo)).toBe(false);
    expect(Number.isNaN(r.hi)).toBe(false);
  });

  it('clamps bounds to [0,1] at the extremes', () => {
    const allPass = wilsonInterval(10, 10);
    expect(allPass.p).toBe(1);
    expect(allPass.hi).toBeCloseTo(1.0, 5);
    expect(allPass.lo).toBeGreaterThanOrEqual(0);
    expect(allPass.lo).toBeLessThan(1);

    const allFail = wilsonInterval(0, 10);
    expect(allFail.p).toBe(0);
    expect(allFail.lo).toBeCloseTo(0.0, 5);
    expect(allFail.lo).toBeGreaterThanOrEqual(0);
    expect(allFail.hi).toBeGreaterThan(0);
    expect(allFail.hi).toBeLessThanOrEqual(1);
  });
});

describe('compareRates', () => {
  it('returns within-noise when the intervals overlap', () => {
    // 8/10 = [0.49, 0.94] vs 6/10 = [0.31, 0.83] — overlap.
    const r = compareRates({ passed: 8, scorable: 10 }, { passed: 6, scorable: 10 });
    expect(r.delta).toBeCloseTo(0.2, 5);
    expect(r.verdict).toBe('within-noise');
    expect(r.child.p).toBeCloseTo(0.8, 5);
    expect(r.parent.p).toBeCloseTo(0.6, 5);
  });

  it('returns trustworthy when the intervals do not overlap', () => {
    // 95/100 vs 50/100 — disjoint intervals.
    const r = compareRates({ passed: 95, scorable: 100 }, { passed: 50, scorable: 100 });
    expect(r.delta).toBeCloseTo(0.45, 5);
    expect(r.verdict).toBe('trustworthy');
  });

  it('is symmetric about which arm is higher', () => {
    const r = compareRates({ passed: 50, scorable: 100 }, { passed: 95, scorable: 100 });
    expect(r.delta).toBeCloseTo(-0.45, 5);
    expect(r.verdict).toBe('trustworthy');
  });
});
