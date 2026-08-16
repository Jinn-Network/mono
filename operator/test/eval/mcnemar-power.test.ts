import { describe, it, expect } from 'vitest';
import { mcnemarSampleSize } from '../../src/eval/mcnemar-power.js';

describe('Connor McNemar sample size', () => {
  it('reproduces the spec §6.3 table at 80% power (±3%)', () => {
    const n1 = mcnemarSampleSize(0.25, 0.10).pairs; // spec: 343
    const n2 = mcnemarSampleSize(0.15, 0.05).pairs; // spec: 773
    expect(n1).toBeGreaterThan(333); expect(n1).toBeLessThan(353);
    expect(n2).toBeGreaterThan(750); expect(n2).toBeLessThan(796);
  });
  it('needs more pairs at 90% power than 80%', () => {
    const a = mcnemarSampleSize(0.20, 0.08, { power: 0.8 }).pairs;
    const b = mcnemarSampleSize(0.20, 0.08, { power: 0.9 }).pairs;
    expect(b).toBeGreaterThan(a);
  });
  it('needs more pairs as the effect shrinks', () => {
    const big = mcnemarSampleSize(0.25, 0.10).pairs;
    const small = mcnemarSampleSize(0.10, 0.04).pairs;
    expect(small).toBeGreaterThan(big);
  });
});
