import { describe, it, expect } from 'vitest';
import { pairedCostVerdict } from '../../src/eval/capability-stats.js';

describe('cost gate statistic', () => {
  it('declares "lower" when corpus is consistently cheaper', () => {
    const diffs = Array.from({ length: 20 }, (_, i) => -(i + 1)); // all negative
    const v = pairedCostVerdict(diffs, { minN: 10 });
    expect(v.verdict).toBe('lower');
    expect(v.pValue!).toBeLessThan(0.05);
  });
  it('declares "not-lower" when corpus is consistently costlier', () => {
    const diffs = Array.from({ length: 20 }, (_, i) => i + 1); // all positive
    expect(pairedCostVerdict(diffs, { minN: 10 }).verdict).toBe('not-lower');
  });
  it('is INCONCLUSIVE below the pre-registered floor', () => {
    expect(pairedCostVerdict([-3, -1, -2], { minN: 10 }).verdict).toBe('inconclusive');
  });
});
