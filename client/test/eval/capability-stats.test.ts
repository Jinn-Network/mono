import { describe, it, expect } from 'vitest';
import { nonInferiorityVerdict, pairedRateDiffLowerBound, type TaskRates } from '../../src/eval/capability-stats.js';

// Deterministic LCG so bootstrap resampling is reproducible in tests.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

describe('quality gate statistic', () => {
  it('a strong uniform improvement clears non-inferiority (lower bound > -δ)', () => {
    const rates: TaskRates[] = Array.from({ length: 60 }, () => ({ pA: 0.3, pB: 0.6 }));
    const v = nonInferiorityVerdict(rates, { rng: lcg(1), stockBaseRate: 0.3 });
    expect(v.pass).toBe(true);
    expect(v.lowerBound).toBeGreaterThan(-0.05);
  });

  it('a clear regression fails non-inferiority', () => {
    const rates: TaskRates[] = Array.from({ length: 60 }, () => ({ pA: 0.6, pB: 0.3 }));
    const v = nonInferiorityVerdict(rates, { rng: lcg(2), stockBaseRate: 0.6 });
    expect(v.pass).toBe(false);
  });

  it('the relative guard fails a small-absolute-but-large-relative regression at a low base rate', () => {
    // base rate 0.15, arm B drops ~4pp absolute = ~27% relative → within δ=5pp abs but over 15% rel.
    const rates: TaskRates[] = Array.from({ length: 200 }, () => ({ pA: 0.15, pB: 0.11 }));
    const v = nonInferiorityVerdict(rates, { rng: lcg(3), stockBaseRate: 0.15 });
    expect(v.relativeRegression).toBeGreaterThan(0.15);
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => /relative/.test(r))).toBe(true);
  });

  it('lower bound is deterministic under a fixed rng', () => {
    const rates: TaskRates[] = Array.from({ length: 40 }, (_, i) => ({ pA: 0.4, pB: i % 2 ? 0.5 : 0.45 }));
    const a = pairedRateDiffLowerBound(rates, { rng: lcg(7), alpha: 0.05, resamples: 2000 });
    const b = pairedRateDiffLowerBound(rates, { rng: lcg(7), alpha: 0.05, resamples: 2000 });
    expect(a).toBe(b);
  });
});
