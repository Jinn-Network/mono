import { describe, expect, it } from 'vitest';
import { bracketGridPoints } from '../../../src/venues/hyperliquid/grid.js';
import type { HlGridPoint } from '../../../src/venues/hyperliquid/types.js';

// Synthetic grid for pure arithmetic tests — no network required.
const GRID: HlGridPoint[] = [
  [1000, '100.0'],
  [2000, '110.0'],
  [3000, '120.0'],
  [4000, '130.0'],
  [5000, '140.0'],
];

describe('bracketGridPoints', () => {
  it('returns null for an empty grid', () => {
    expect(bracketGridPoints([], 2500)).toBeNull();
  });

  it('returns null when target is before all grid points', () => {
    expect(bracketGridPoints(GRID, 500)).toBeNull();
  });

  it('returns null when target is exactly the last grid point', () => {
    expect(bracketGridPoints(GRID, 5000)).toBeNull();
  });

  it('returns null when target is after all grid points', () => {
    expect(bracketGridPoints(GRID, 9999)).toBeNull();
  });

  it('brackets a target strictly between two points', () => {
    const bracket = bracketGridPoints(GRID, 2500);
    expect(bracket).not.toBeNull();
    expect(bracket!.before).toEqual([2000, '110.0']);
    expect(bracket!.after).toEqual([3000, '120.0']);
  });

  it('uses a point as before when target is exactly on it (non-last)', () => {
    const bracket = bracketGridPoints(GRID, 2000);
    expect(bracket).not.toBeNull();
    expect(bracket!.before).toEqual([2000, '110.0']);
    expect(bracket!.after).toEqual([3000, '120.0']);
  });

  it('brackets the first interval (target just after first point)', () => {
    const bracket = bracketGridPoints(GRID, 1001);
    expect(bracket).not.toBeNull();
    expect(bracket!.before).toEqual([1000, '100.0']);
    expect(bracket!.after).toEqual([2000, '110.0']);
  });

  it('handles an unsorted input grid', () => {
    const shuffled: HlGridPoint[] = [
      [5000, '140.0'],
      [1000, '100.0'],
      [3000, '120.0'],
      [2000, '110.0'],
      [4000, '130.0'],
    ];
    const bracket = bracketGridPoints(shuffled, 2500);
    expect(bracket).not.toBeNull();
    expect(bracket!.before).toEqual([2000, '110.0']);
    expect(bracket!.after).toEqual([3000, '120.0']);
  });

  it('handles a single-point grid (no bracket possible)', () => {
    const single: HlGridPoint[] = [[1000, '100.0']];
    expect(bracketGridPoints(single, 1000)).toBeNull();
    expect(bracketGridPoints(single, 500)).toBeNull();
    expect(bracketGridPoints(single, 1500)).toBeNull();
  });

  it('brackets correctly near the last interval', () => {
    const bracket = bracketGridPoints(GRID, 4999);
    expect(bracket).not.toBeNull();
    expect(bracket!.before).toEqual([4000, '130.0']);
    expect(bracket!.after).toEqual([5000, '140.0']);
  });
});
