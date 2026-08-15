import { describe, expect, it } from 'vitest';
import { leastSquaresSlope } from '@/eval/slope.js';

describe('leastSquaresSlope', () => {
  it('is positive for an improving (rising) resolved-rate sequence', () => {
    const slope = leastSquaresSlope([
      { cycleIndex: 0, rate: 0.2 },
      { cycleIndex: 2, rate: 0.4 },
      { cycleIndex: 4, rate: 0.6 },
      { cycleIndex: 6, rate: 0.8 },
    ]);
    expect(slope).toBeCloseTo(0.1, 6); // +0.2 rate per +2 cycles = 0.1/cycle
  });

  it('is negative for a declining resolved-rate sequence', () => {
    const slope = leastSquaresSlope([
      { cycleIndex: 0, rate: 0.8 },
      { cycleIndex: 2, rate: 0.4 },
      { cycleIndex: 4, rate: 0.0 },
    ]);
    expect(slope).toBeLessThan(0);
    expect(slope).toBeCloseTo(-0.2, 6);
  });

  it('is exactly 0 for a flat sequence', () => {
    const slope = leastSquaresSlope([
      { cycleIndex: 0, rate: 0.5 },
      { cycleIndex: 2, rate: 0.5 },
      { cycleIndex: 4, rate: 0.5 },
    ]);
    expect(slope).toBe(0);
  });

  it('returns 0 for n<2 (a single point has no slope)', () => {
    expect(leastSquaresSlope([{ cycleIndex: 0, rate: 0.5 }])).toBe(0);
    expect(leastSquaresSlope([])).toBe(0);
  });

  it('returns 0 when all x are identical (degenerate, zero variance)', () => {
    expect(
      leastSquaresSlope([
        { cycleIndex: 3, rate: 0.2 },
        { cycleIndex: 3, rate: 0.8 },
      ]),
    ).toBe(0);
  });
});
