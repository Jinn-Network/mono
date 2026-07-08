import { describe, it, expect } from 'vitest';
import { tallyPilot, type SolveOutcome } from '../../src/pilot/tally.js';

function lcg(seed: number): () => number { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; }; }

// Build R=2 outcomes for N tasks where arm B matches A's quality and is cheaper.
function mk(n: number): SolveOutcome[] {
  const out: SolveOutcome[] = [];
  for (let i = 0; i < n; i++) for (const r of [0, 1]) {
    out.push({ instance_id: `t${i}`, arm: 'A', repeat: r, passed: i % 2 === 0, costUsd: 0.03 });
    out.push({ instance_id: `t${i}`, arm: 'B', repeat: r, passed: i % 2 === 0, costUsd: 0.02 });
  }
  return out;
}

describe('pilot tally', () => {
  it('computes per-arm resolve rate and the both-solve cost delta, surfacing the cost n', () => {
    const rep = tallyPilot(mk(10), { rng: lcg(1) });
    expect(rep.n).toBe(10);
    expect(rep.armA.resolveRate).toBeCloseTo(0.5, 5);
    expect(rep.armB.resolveRate).toBeCloseTo(0.5, 5);
    expect(rep.quality.lowerBound).toBeGreaterThan(-0.05); // non-inferior
    expect(rep.cost.verdict).toBe('lower');                // B cheaper on both-solve tasks
    expect(rep.bothSolveTasks).toBeGreaterThan(0);
    expect(rep.cost.n).toBe(5);                            // 5 both-solve non-zero cost diffs surfaced
    expect(rep.cost.underpowered).toBe(false);             // n=5 meets the Wilcoxon minimum
  });
  it('flags the cost verdict underpowered when the both-solve n is below the Wilcoxon minimum (~5)', () => {
    // 3 both-solve tasks → 3 non-zero cost diffs → below the n the one-sided
    // Wilcoxon needs to possibly reject; the verdict must not be presented as powered.
    const out: SolveOutcome[] = [];
    for (let i = 0; i < 3; i++) for (const r of [0, 1]) {
      out.push({ instance_id: `t${i}`, arm: 'A', repeat: r, passed: true, costUsd: 0.03 });
      out.push({ instance_id: `t${i}`, arm: 'B', repeat: r, passed: true, costUsd: 0.02 });
    }
    const rep = tallyPilot(out, { rng: lcg(3) });
    expect(rep.cost.n).toBe(3);
    expect(rep.cost.underpowered).toBe(true);
  });
  it('excludes a task with a fully-ungradeable arm; keeps a partially-null but still-scorable task', () => {
    const o = mk(4);
    // t0: arm B fully ungradeable → the whole task is excluded (out of n, counted in excluded)
    for (const x of o) if (x.instance_id === 't0' && x.arm === 'B') x.passed = null;
    // t1: one arm-A repeat null but a gradeable repeat remains → still scored, NOT excluded
    const t1a0 = o.find((x) => x.instance_id === 't1' && x.arm === 'A' && x.repeat === 0)!;
    t1a0.passed = null;
    const rep = tallyPilot(o, { rng: lcg(2) });
    expect(rep.excluded).toBe(1);   // only t0
    expect(rep.n).toBe(4);          // 3 scored (t1,t2,t3) + 1 excluded (t0)
  });
});
