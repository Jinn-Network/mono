import { describe, it, expect } from 'vitest';
import { tallyPilot, type SolveOutcome } from '../../src/pilot/tally.js';

function lcg(seed: number): () => number { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; }; }

// Build R=2 outcomes for N tasks where arm B matches A's quality and is cheaper.
function mk(n: number): SolveOutcome[] {
  const out: SolveOutcome[] = [];
  for (let i = 0; i < n; i++) for (const r of [0, 1]) {
    out.push({ instance_id: `t${i}`, arm: 'stock', repeat: r, passed: i % 2 === 0, costUsd: 0.03 });
    out.push({ instance_id: `t${i}`, arm: 'mini', repeat: r, passed: i % 2 === 0, costUsd: 0.02 });
    out.push({ instance_id: `t${i}`, arm: 'gpt55', repeat: r, passed: i % 2 === 0, costUsd: 0.025 });
  }
  return out;
}

describe('pilot tally', () => {
  it('computes per-arm resolve rate and the both-solve cost delta, surfacing the cost n', () => {
    const rep = tallyPilot(mk(10), { rng: lcg(1), baselineArm: 'stock' });
    expect(rep.n).toBe(10);
    expect(rep.arms.stock.resolveRate).toBeCloseTo(0.5, 5);
    expect(rep.arms.mini.resolveRate).toBeCloseTo(0.5, 5);
    expect(rep.comparisons.mini.quality.lowerBound).toBeGreaterThan(-0.05); // non-inferior
    expect(rep.comparisons.mini.cost.verdict).toBe('lower');                // mini cheaper on both-solve tasks
    expect(rep.comparisons.mini.bothSolveTasks).toBeGreaterThan(0);
    expect(rep.comparisons.mini.cost.n).toBe(5);                            // 5 both-solve non-zero cost diffs surfaced
    expect(rep.comparisons.mini.cost.underpowered).toBe(false);             // n=5 meets the Wilcoxon minimum
    expect(rep.comparisons.gpt55.quality.nonInferior).toBe(true);
  });
  it('flags the cost verdict underpowered when the both-solve n is below the Wilcoxon minimum (~5)', () => {
    // 3 both-solve tasks → 3 non-zero cost diffs → below the n the one-sided
    // Wilcoxon needs to possibly reject; the verdict must not be presented as powered.
    const out: SolveOutcome[] = [];
    for (let i = 0; i < 3; i++) for (const r of [0, 1]) {
      out.push({ instance_id: `t${i}`, arm: 'stock', repeat: r, passed: true, costUsd: 0.03 });
      out.push({ instance_id: `t${i}`, arm: 'mini', repeat: r, passed: true, costUsd: 0.02 });
    }
    const rep = tallyPilot(out, { rng: lcg(3), baselineArm: 'stock' });
    expect(rep.comparisons.mini.cost.n).toBe(3);
    expect(rep.comparisons.mini.cost.underpowered).toBe(true);
  });
  it('computes comparison deltas from the paired task subset, not pooled per-arm rates', () => {
    const out: SolveOutcome[] = [];
    // 3 paired tasks: stock and mini each pass exactly the same one → paired Δ = 0.
    for (let i = 0; i < 3; i++) {
      out.push({ instance_id: `p${i}`, arm: 'stock', repeat: 0, passed: i === 0, costUsd: 0.03 });
      out.push({ instance_id: `p${i}`, arm: 'mini', repeat: 0, passed: i === 0, costUsd: 0.02 });
    }
    // 2 extra tasks gradeable ONLY in mini (stock ungradeable), both passing:
    // pooled rates diverge (mini 3/5 vs stock 1/3) but the paired subset is unchanged.
    for (let i = 0; i < 2; i++) {
      out.push({ instance_id: `x${i}`, arm: 'stock', repeat: 0, passed: null, costUsd: 0 });
      out.push({ instance_id: `x${i}`, arm: 'mini', repeat: 0, passed: true, costUsd: 0.02 });
    }
    const rep = tallyPilot(out, { rng: lcg(7), baselineArm: 'stock' });
    expect(rep.comparisons.mini.excluded).toBe(2);
    expect(rep.comparisons.mini.quality.deltaPP).toBeCloseTo(0, 5);
    // Pooled per-arm rates stay available for display and must still differ.
    expect(rep.arms.mini.resolveRate).toBeCloseTo(0.6, 5);
    expect(rep.arms.stock.resolveRate).toBeCloseTo(1 / 3, 5);
  });
  it('excludes a task with a fully-ungradeable arm; keeps a partially-null but still-scorable task', () => {
    const o = mk(4);
    // t0: arm B fully ungradeable → the whole task is excluded (out of n, counted in excluded)
    for (const x of o) if (x.instance_id === 't0' && x.arm === 'mini') x.passed = null;
    // t1: one arm-A repeat null but a gradeable repeat remains → still scored, NOT excluded
    const t1a0 = o.find((x) => x.instance_id === 't1' && x.arm === 'stock' && x.repeat === 0)!;
    t1a0.passed = null;
    const rep = tallyPilot(o, { rng: lcg(2), baselineArm: 'stock' });
    expect(rep.comparisons.mini.excluded).toBe(1);   // only t0 for mini
    expect(rep.n).toBe(4);                            // task universe size
  });
});
