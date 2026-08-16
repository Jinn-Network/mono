import { describe, it, expect } from 'vitest';
import {
  brierScore,
  resolveGroundTruth,
  decCmp,
} from '../../../../src/harnesses/impls/prediction-v0-evaluator/canonical-metrics.js';

describe('decCmp', () => {
  it('compares integer decimals', () => {
    expect(decCmp('3500', '3499')).toBeGreaterThan(0);
    expect(decCmp('3500', '3500')).toBe(0);
    expect(decCmp('3499', '3500')).toBeLessThan(0);
  });
  it('compares fractional decimals', () => {
    expect(decCmp('3500.01', '3500.009')).toBeGreaterThan(0);
    expect(decCmp('3500.1', '3500.10')).toBe(0);
  });
});

describe('brierScore', () => {
  it('returns 1e18 for a perfect (p=1, outcome=1)', () => {
    expect(brierScore('1', 1)).toBe('1000000000000000000');
  });
  it('returns 0 for the worst (p=1, outcome=0)', () => {
    expect(brierScore('1', 0)).toBe('0');
  });
  it('returns 0.75 × 1e18 for a coin-flip (p=0.5, any outcome)', () => {
    expect(brierScore('0.5', 1)).toBe('750000000000000000');
    expect(brierScore('0.5', 0)).toBe('750000000000000000');
  });
  it('returns 0.7975 × 1e18 for p=0.55, outcome=YES', () => {
    expect(brierScore('0.55', 1)).toBe('797500000000000000');
  });
});

describe('resolveGroundTruth', () => {
  it('threshold GT — YES when price > threshold', () => {
    const q = { kind: 'threshold' as const, operator: 'GT' as const, threshold: '3500', resolveTs: 0 };
    expect(resolveGroundTruth(q, '3501')).toBe('YES');
    expect(resolveGroundTruth(q, '3500')).toBe('NO');
    expect(resolveGroundTruth(q, '3499')).toBe('NO');
  });
  it('threshold GTE — YES when price >= threshold', () => {
    const q = { kind: 'threshold' as const, operator: 'GTE' as const, threshold: '3500', resolveTs: 0 };
    expect(resolveGroundTruth(q, '3500')).toBe('YES');
    expect(resolveGroundTruth(q, '3499')).toBe('NO');
  });
  it('threshold LT — YES when price < threshold', () => {
    const q = { kind: 'threshold' as const, operator: 'LT' as const, threshold: '3500', resolveTs: 0 };
    expect(resolveGroundTruth(q, '3499')).toBe('YES');
    expect(resolveGroundTruth(q, '3500')).toBe('NO');
  });
  it('range — YES when lower ≤ price < upper', () => {
    const q = { kind: 'range' as const, lowerBound: '3000', upperBound: '3500', resolveTs: 0 };
    expect(resolveGroundTruth(q, '3000')).toBe('YES');
    expect(resolveGroundTruth(q, '3499.99')).toBe('YES');
    expect(resolveGroundTruth(q, '3500')).toBe('NO');
    expect(resolveGroundTruth(q, '2999.99')).toBe('NO');
  });
});
