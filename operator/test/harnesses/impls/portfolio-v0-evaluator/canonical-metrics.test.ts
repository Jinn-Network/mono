import { describe, it, expect } from 'vitest';
import {
  equityCurve,
  maxDrawdownPct,
  equityReturnPct,
  closedTradesCount,
  tradedNotionalMultiple,
} from '../../../../src/harnesses/impls/portfolio-v0-evaluator/canonical-metrics.js';
import { makeFill } from './test-helpers.js';

// ── equityReturnPct ───────────────────────────────────────────────────────────

describe('equityReturnPct', () => {
  it('computes positive return', () => {
    expect(equityReturnPct(1000, 1100)).toBeCloseTo(10.0, 6);
  });

  it('computes negative return', () => {
    expect(equityReturnPct(1000, 900)).toBeCloseTo(-10.0, 6);
  });

  it('returns 0 for zero pre-value', () => {
    expect(equityReturnPct(0, 1000)).toBe(0);
  });

  it('returns 0 for flat equity', () => {
    expect(equityReturnPct(1000, 1000)).toBe(0);
  });

  it('handles fractional values', () => {
    expect(equityReturnPct(10000.5, 10500.525)).toBeCloseTo(5.0, 3);
  });
});

// ── equityCurve ───────────────────────────────────────────────────────────────

describe('equityCurve', () => {
  it('returns at least pre and post points', () => {
    const curve = equityCurve(0, 1000, 1000, 1100, []);
    expect(curve).toHaveLength(2);
    expect(curve[0]).toEqual({ ts: 0, value: 1000 });
    expect(curve[1]).toEqual({ ts: 1000, value: 1100 });
  });

  it('inserts fill time points via linear interpolation', () => {
    // pre=0,val=1000  post=1000,val=2000  fill at t=500
    // interpolated value at 500 = 1000 + 0.5*(2000-1000) = 1500
    const curve = equityCurve(0, 1000, 1000, 2000, [500]);
    expect(curve).toHaveLength(3);
    const midPoint = curve.find((p) => p.ts === 500);
    expect(midPoint).toBeDefined();
    expect(midPoint!.value).toBeCloseTo(1500, 4);
  });

  it('clamps fill times to [pre, post] range', () => {
    const curve = equityCurve(100, 1000, 500, 2000, [50, 600]);
    // 50 is before pre → clamped to 100; 600 is after post → clamped to 500
    const tss = curve.map((p) => p.ts);
    expect(tss.every((t) => t >= 100 && t <= 500)).toBe(true);
  });

  it('sorts fill times in ascending order', () => {
    const curve = equityCurve(0, 1000, 1000, 2000, [700, 300, 500]);
    const tss = curve.map((p) => p.ts);
    for (let i = 1; i < tss.length; i++) {
      expect(tss[i]).toBeGreaterThanOrEqual(tss[i - 1]!);
    }
  });
});

// ── maxDrawdownPct ────────────────────────────────────────────────────────────

describe('maxDrawdownPct', () => {
  it('returns 0 for monotonically increasing curve', () => {
    const curve = equityCurve(0, 1000, 1000, 2000, [500]);
    expect(maxDrawdownPct(curve)).toBeCloseTo(0, 6);
  });

  it('returns 0 for fewer than 2 points', () => {
    expect(maxDrawdownPct([{ ts: 0, value: 1000 }])).toBe(0);
    expect(maxDrawdownPct([])).toBe(0);
  });

  it('computes simple drawdown', () => {
    // peak 1000, then drops to 900: dd = 100/1000*100 = 10%
    const curve = [
      { ts: 0, value: 1000 },
      { ts: 1, value: 900 },
    ];
    expect(maxDrawdownPct(curve)).toBeCloseTo(10.0, 6);
  });

  it('tracks peak before drawdown', () => {
    // 1000 → 1200 → 900: peak=1200, dd at 900 = 300/1200*100 = 25%
    const curve = [
      { ts: 0, value: 1000 },
      { ts: 1, value: 1200 },
      { ts: 2, value: 900 },
    ];
    expect(maxDrawdownPct(curve)).toBeCloseTo(25.0, 4);
  });

  it('returns max over multiple drawdowns', () => {
    // 1000 → 800 (dd=20%) → 900 → 700 (from new peak 900: dd=22.2%)
    const curve = [
      { ts: 0, value: 1000 },
      { ts: 1, value: 800 },  // dd = 20%
      { ts: 2, value: 900 },  // new point, peak = 1000, dd = 10%
      { ts: 3, value: 700 },  // peak = 1000, dd = 30%
    ];
    expect(maxDrawdownPct(curve)).toBeCloseTo(30.0, 4);
  });

  it('handles full-journey calculation with fills', () => {
    // Real scenario: start 10000, goes to 12000, drops to 9000
    // Peak at 12000, max dd = (12000-9000)/12000*100 = 25%
    const curve = equityCurve(0, 10000, 1000, 9000, [500]);
    // At t=500, interpolated value between 10000 and 9000 at midpoint = 9500
    // Peak = 10000 (start), at 9500 dd = 5%, at 9000 dd = 10%
    expect(maxDrawdownPct(curve)).toBeCloseTo(10.0, 2);
  });
});

// ── closedTradesCount ─────────────────────────────────────────────────────────

describe('closedTradesCount', () => {
  it('counts fills with non-zero closedPnl', () => {
    const fills = [
      makeFill({ closedPnl: '0.0' }),
      makeFill({ closedPnl: '100.5', tid: 2 }),
      makeFill({ closedPnl: '-50.0', tid: 3 }),
      makeFill({ closedPnl: '0.0', tid: 4 }),
    ];
    expect(closedTradesCount(fills)).toBe(2);
  });

  it('returns 0 if all fills have closedPnl "0.0"', () => {
    const fills = [
      makeFill({ closedPnl: '0.0' }),
      makeFill({ closedPnl: '0.0', tid: 2 }),
    ];
    expect(closedTradesCount(fills)).toBe(0);
  });

  it('returns 0 for empty fills array', () => {
    expect(closedTradesCount([])).toBe(0);
  });

  it('counts all fills if all have non-zero closedPnl', () => {
    const fills = [
      makeFill({ closedPnl: '50.0' }),
      makeFill({ closedPnl: '-25.0', tid: 2 }),
    ];
    expect(closedTradesCount(fills)).toBe(2);
  });

  // ── numeric zero-variants exclusion (finding #13) ─────────────────────────
  // All of these are numerically zero — must be excluded from closedTradesCount.

  it.each([
    ['0'],
    ['0.0'],
    ['0.00'],
    ['-0.0'],
    ['+0.0'],
  ])('excludes fill with closedPnl "%s" (numeric zero)', (closedPnl) => {
    expect(closedTradesCount([makeFill({ closedPnl })])).toBe(0);
  });

  // These are non-zero — must be included.
  it.each([
    ['5.0'],
    ['-3.5'],
    ['0.1'],
  ])('includes fill with closedPnl "%s" (non-zero)', (closedPnl) => {
    expect(closedTradesCount([makeFill({ closedPnl })])).toBe(1);
  });

  // Non-numeric / empty — treat as not-closed (excluded).
  it.each([
    ['NaN'],
    [''],
  ])('excludes fill with closedPnl "%s" (non-numeric)', (closedPnl) => {
    expect(closedTradesCount([makeFill({ closedPnl })])).toBe(0);
  });
});

// ── tradedNotionalMultiple ────────────────────────────────────────────────────

describe('tradedNotionalMultiple', () => {
  it('computes sum of |sz*px| / preValue', () => {
    // 2 fills: |0.1 * 10000| + |0.2 * 10000| = 1000 + 2000 = 3000 / 10000 = 0.3
    const fills = [
      makeFill({ sz: '0.1', px: '10000' }),
      makeFill({ sz: '0.2', px: '10000', tid: 2 }),
    ];
    expect(tradedNotionalMultiple(fills, 10000)).toBeCloseTo(0.3, 6);
  });

  it('handles negative sz (short positions)', () => {
    // sz is absolute via Math.abs
    const fills = [makeFill({ sz: '-0.5', px: '20000' })];
    // |-0.5 * 20000| = 10000 / 10000 = 1.0
    expect(tradedNotionalMultiple(fills, 10000)).toBeCloseTo(1.0, 6);
  });

  it('returns 0 for zero preValue', () => {
    const fills = [makeFill({ sz: '1', px: '1000' })];
    expect(tradedNotionalMultiple(fills, 0)).toBe(0);
  });

  it('returns 0 for empty fills', () => {
    expect(tradedNotionalMultiple([], 10000)).toBeCloseTo(0, 6);
  });

  it('handles large notional correctly', () => {
    // 5x notional: 5 fills of 1 unit at 10000 with preValue 10000
    const fills = Array.from({ length: 5 }, (_, i) =>
      makeFill({ sz: '1', px: '10000', tid: i + 1 }),
    );
    expect(tradedNotionalMultiple(fills, 10000)).toBeCloseTo(5.0, 6);
  });
});
