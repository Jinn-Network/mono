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
  it('computes per-arm resolve rate and the both-solve cost delta', () => {
    const rep = tallyPilot(mk(10), { rng: lcg(1) });
    expect(rep.n).toBe(10);
    expect(rep.armA.resolveRate).toBeCloseTo(0.5, 5);
    expect(rep.armB.resolveRate).toBeCloseTo(0.5, 5);
    expect(rep.quality.lowerBound).toBeGreaterThan(-0.05); // non-inferior
    expect(rep.cost.verdict).toBe('lower');                // B cheaper on both-solve tasks
    expect(rep.bothSolveTasks).toBeGreaterThan(0);
  });
  it('excludes ungradeable (passed:null) task-repeats from the pairing, never scores them as fail', () => {
    const o = mk(4);
    o[0]!.passed = null; // one ungradeable arm-A repeat
    const rep = tallyPilot(o, { rng: lcg(2) });
    expect(rep.excluded).toBeGreaterThan(0);
  });
});
