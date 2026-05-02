import { describe, it, expect } from 'vitest';
import { scoreCalmarV1 } from '../../../../src/harnesses/impls/portfolio-v0-evaluator/score.js';

describe('scoreCalmarV1', () => {
  // ── Non-PASS verdicts always return "0" ──────────────────────────────────────

  it('returns "0" for FAIL verdict', () => {
    expect(scoreCalmarV1(10, 2, 'FAIL')).toBe('0');
  });

  it('returns "0" for REJECTED verdict', () => {
    expect(scoreCalmarV1(10, 2, 'REJECTED')).toBe('0');
  });

  it('returns "0" for INDETERMINATE verdict', () => {
    expect(scoreCalmarV1(10, 2, 'INDETERMINATE')).toBe('0');
  });

  // ── PASS verdict with various return/dd combos ────────────────────────────────

  it('computes score for positive return with drawdown', () => {
    // ratio = 5 / max(2, 1) = 5/2 = 2.5 → 2.5 * 1e17 = 2.5e17
    const score = scoreCalmarV1(5, 2, 'PASS');
    expect(BigInt(score)).toBe(BigInt(Math.round(2.5 * 1e17)));
  });

  it('clamps ratio to 10 when return/dd > 10', () => {
    // ratio = 100/1 = 100 → clamped to 10 → 10 * 1e17 = 1e18
    const score = scoreCalmarV1(100, 1, 'PASS');
    expect(score).toBe(String(BigInt(Math.round(10 * 1e17))));
    // Max value = 1e18
    expect(BigInt(score)).toBe(BigInt(1e18));
  });

  it('returns "0" when equityReturnPct is 0 with PASS verdict', () => {
    // ratio = 0/max(2,1) = 0 → 0
    const score = scoreCalmarV1(0, 2, 'PASS');
    expect(BigInt(score)).toBe(0n);
  });

  it('uses max(dd, 1%) denominator when dd < 1%', () => {
    // dd = 0.5, so denominator = max(0.5, 1.0) = 1.0
    // ratio = 5/1 = 5 → 5 * 1e17
    const score = scoreCalmarV1(5, 0.5, 'PASS');
    expect(BigInt(score)).toBe(BigInt(Math.round(5 * 1e17)));
  });

  it('uses max(dd, 1%) denominator when dd = 0', () => {
    // dd = 0, denominator = 1.0
    // ratio = 10/1 = 10 → clamped to 10 → 1e18
    const score = scoreCalmarV1(10, 0, 'PASS');
    expect(score).toBe(String(BigInt(1e18)));
  });

  it('returns "0" when return is negative with PASS verdict (clamped at 0)', () => {
    // negative return → ratio = clamp(negative, 0, 10) = 0
    const score = scoreCalmarV1(-5, 2, 'PASS');
    expect(BigInt(score)).toBe(0n);
  });

  it('score is bounded in [0, 1e18] range', () => {
    // Test various combos
    const cases: [number, number][] = [
      [0, 0],
      [5, 2],
      [100, 100], // ratio = 1, clamped stays 1
      [0.1, 0.01],
    ];
    for (const [ret, dd] of cases) {
      const score = scoreCalmarV1(ret, dd, 'PASS');
      const n = BigInt(score);
      expect(n).toBeGreaterThanOrEqual(0n);
      expect(n).toBeLessThanOrEqual(BigInt(1e18));
    }
  });

  it('produces exact 1e18 for max calmar ratio', () => {
    // ratio = 10/1 = 10 → exactly 1e18
    const score = scoreCalmarV1(10, 1, 'PASS');
    expect(score).toBe('1000000000000000000');
  });

  it('produces a mid-range score correctly', () => {
    // return=3%, dd=3% → ratio=1 → 1*1e17 = 100000000000000000
    const score = scoreCalmarV1(3, 3, 'PASS');
    expect(BigInt(score)).toBe(BigInt(Math.round(1 * 1e17)));
  });
});
