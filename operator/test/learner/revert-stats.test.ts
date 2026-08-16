import { describe, it, expect } from 'vitest';
import { twoProportionZTest, mannWhitneyU } from '../../src/learner/revert-stats.js';

describe('twoProportionZTest', () => {
  it('returns z≈0 and p≈1 for identical proportions', () => {
    const r = twoProportionZTest({ passesA: 50, totalA: 100, passesB: 50, totalB: 100 });
    expect(r.z).toBeCloseTo(0, 6);
    expect(r.pValue).toBeCloseTo(1, 3);
  });

  it('computes a known z for a clear difference (90/100 vs 50/100)', () => {
    // pooled p = 140/200 = 0.7; se = sqrt(0.7*0.3*(1/100+1/100)) = sqrt(0.0042) = 0.0648074
    // z = (0.9 - 0.5) / 0.0648074 = 6.172
    const r = twoProportionZTest({ passesA: 90, totalA: 100, passesB: 50, totalB: 100 });
    expect(r.z).toBeCloseTo(6.172, 2);
    expect(r.pValue).toBeLessThan(0.001);
  });

  it('sign of z reflects A minus B (worse A => negative z)', () => {
    const r = twoProportionZTest({ passesA: 40, totalA: 100, passesB: 70, totalB: 100 });
    expect(r.z).toBeLessThan(0);
    expect(r.delta).toBeCloseTo(0.4 - 0.7, 6);
  });

  it('returns z=0,p=1 (no signal) when either arm total is 0', () => {
    const r = twoProportionZTest({ passesA: 0, totalA: 0, passesB: 5, totalB: 10 });
    expect(r.z).toBe(0);
    expect(r.pValue).toBe(1);
  });
});

describe('mannWhitneyU', () => {
  it('no signal when distributions are identical', () => {
    const r = mannWhitneyU([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    expect(r.pValue).toBeCloseTo(1, 5);
  });

  it('detects A < B (A regressed)', () => {
    const r = mannWhitneyU([0.1, 0.2, 0.15, 0.05], [0.8, 0.9, 0.85, 0.95]);
    expect(r.z).toBeLessThan(0);
    expect(r.pValue).toBeLessThan(0.05);
  });

  it('handles ties via tie-corrected variance', () => {
    const r = mannWhitneyU([0.5, 0.5, 0.6], [0.5, 0.5, 0.4]);
    expect(Number.isFinite(r.pValue)).toBe(true);
  });

  it('returns no-signal (p=1) when either arm is empty', () => {
    expect(mannWhitneyU([], [0.5]).pValue).toBe(1);
  });

  it('matches the hand-computed U for a small case', () => {
    // A=[0.1,0.3], B=[0.2,0.4]: U_A = 1.
    const r = mannWhitneyU([0.1, 0.3], [0.2, 0.4]);
    expect(r.u).toBeCloseTo(1, 5);
  });
});
