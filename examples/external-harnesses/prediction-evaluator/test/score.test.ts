import { describe, it, expect } from 'vitest';
import { brier, decomposeBrier } from '../src/score.js';

describe('brier', () => {
  it('returns 0 for a confident-correct forecast', () => {
    expect(brier(1, 1)).toBe(0);
    expect(brier(0, 0)).toBe(0);
  });
  it('returns 1 for a confident-wrong forecast', () => {
    expect(brier(1, 0)).toBe(1);
    expect(brier(0, 1)).toBe(1);
  });
  it('returns 0.25 for an indifferent forecast', () => {
    expect(brier(0.5, 1)).toBeCloseTo(0.25, 6);
    expect(brier(0.5, 0)).toBeCloseTo(0.25, 6);
  });
});

describe('decomposeBrier', () => {
  it('returns zeros on empty input', () => {
    const out = decomposeBrier([]);
    expect(out).toEqual({ reliability: 0, resolution: 0, uncertainty: 0 });
  });

  it('decomposes Brier into reliability + resolution + uncertainty (Murphy 1973)', () => {
    const forecasts = [
      { p: 0.9, outcome: 1 },
      { p: 0.8, outcome: 1 },
      { p: 0.2, outcome: 0 },
      { p: 0.1, outcome: 0 },
    ] as const;
    const out = decomposeBrier(forecasts);
    const meanBrier =
      forecasts.reduce((s, f) => s + brier(f.p, f.outcome), 0) /
      forecasts.length;
    // Murphy identity: meanBrier = reliability - resolution + uncertainty.
    expect(meanBrier).toBeCloseTo(
      out.reliability - out.resolution + out.uncertainty,
      4,
    );
  });
});
