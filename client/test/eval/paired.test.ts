import { describe, expect, it } from 'vitest';
import { mcnemarExact, comparePaired, type PairedInput } from '@/eval/paired.js';

/** Build a per-instance result set: pass[] ids, fail[] ids, unscorable[] ids. */
function results(pass: string[], fail: string[], unscorable: string[] = []): PairedInput[] {
  return [
    ...pass.map((instance_id) => ({ instance_id, passed: true, unscorable: false })),
    ...fail.map((instance_id) => ({ instance_id, passed: false, unscorable: false })),
    ...unscorable.map((instance_id) => ({ instance_id, passed: null, unscorable: true })),
  ];
}

const ids = (n: number, prefix = 'i'): string[] => Array.from({ length: n }, (_, k) => `${prefix}${k}`);

describe('mcnemarExact', () => {
  it('no discordant pairs → p = 1 (no evidence)', () => {
    expect(mcnemarExact(0, 0)).toBe(1);
  });
  it('one-directional flips: exact two-sided binomial p', () => {
    expect(mcnemarExact(3, 0)).toBeCloseTo(0.25, 10); // 2 * 0.5^3
    expect(mcnemarExact(5, 0)).toBeCloseTo(0.0625, 10); // 2 * 0.5^5
    expect(mcnemarExact(6, 0)).toBeCloseTo(0.03125, 10); // 2 * 0.5^6 < 0.05
  });
  it('symmetric flips → p capped at 1', () => {
    expect(mcnemarExact(3, 3)).toBe(1);
  });
  it('is symmetric in its arguments', () => {
    expect(mcnemarExact(6, 0)).toBeCloseTo(mcnemarExact(0, 6), 12);
    expect(mcnemarExact(10, 2)).toBeCloseTo(mcnemarExact(2, 10), 12);
  });
  it('10 vs 2 discordant → significant', () => {
    expect(mcnemarExact(10, 2)).toBeCloseTo(0.0385742, 5); // 2*(1+12+66)/4096
  });
});

describe('comparePaired', () => {
  it('the matched-design win: a consistent improvement the marginal test would miss becomes significant once large enough', () => {
    // 6 hard instances flip fail→pass, none regress, plus shared concordant ones.
    const flip = ids(6, 'hard');
    const before = results([], flip); // all 6 fail at baseline
    const after = results(flip, []); // all 6 pass after
    const r = comparePaired(before, after);
    expect(r.improved).toBe(6);
    expect(r.regressed).toBe(0);
    expect(r.pairs).toBe(6);
    expect(r.pValue).toBeCloseTo(0.03125, 6);
    expect(r.verdict).toBe('trustworthy');
  });

  it('a small consistent improvement (3 flips) is correctly NOT trustworthy at R=1 (honest: too few flips)', () => {
    const flip = ids(3, 'h');
    const conc = ids(4, 'easy'); // pass in both arms
    const before = results(conc, flip);
    const after = results([...conc, ...flip], []);
    const r = comparePaired(before, after);
    expect(r.improved).toBe(3);
    expect(r.regressed).toBe(0);
    expect(r.concordantPass).toBe(4);
    expect(r.pValue).toBeCloseTo(0.25, 6);
    expect(r.verdict).toBe('within-noise');
  });

  it('symmetric flips (equal improve/regress) → within-noise', () => {
    const up = ids(6, 'up');
    const down = ids(6, 'down');
    const before = results(down, up); // up fails, down passes
    const after = results(up, down); // up passes, down fails
    const r = comparePaired(before, after);
    expect(r.improved).toBe(6);
    expect(r.regressed).toBe(6);
    expect(r.verdict).toBe('within-noise');
  });

  it('direction guard: a SIGNIFICANT regression is never "trustworthy" (positive only)', () => {
    const flip = ids(6, 'reg');
    const before = results(flip, []); // all pass at baseline
    const after = results([], flip); // all regress
    const r = comparePaired(before, after);
    expect(r.improved).toBe(0);
    expect(r.regressed).toBe(6);
    expect(r.pValue).toBeCloseTo(0.03125, 6);
    expect(r.verdict).toBe('within-noise'); // significant but wrong direction
  });

  it('identical arms (self-parent / baseline) → no flips → within-noise', () => {
    const before = results(['a', 'b'], ['c', 'd']);
    const after = results(['a', 'b'], ['c', 'd']);
    const r = comparePaired(before, after);
    expect(r.improved).toBe(0);
    expect(r.regressed).toBe(0);
    expect(r.pairs).toBe(4);
    expect(r.verdict).toBe('within-noise');
  });

  it('unscorable in either arm is EXCLUDED from the paired test (never coerced to a flip)', () => {
    // i0 improves; i1 is unscorable after (disk-skip) — excluded; i2 unscorable before.
    const before = results([], ['i0', 'i1'], ['i2']);
    const after = results(['i0'], [], ['i1']).concat(results(['i2'], [])); // i2 now scorable-pass, i1 unscorable
    const r = comparePaired(before, after);
    expect(r.improved).toBe(1); // only i0 counts (scorable both sides)
    expect(r.excluded).toBe(2); // i1 (unscorable after), i2 (unscorable before)
    expect(r.pairs).toBe(1);
  });

  it('10 improve vs 2 regress → trustworthy (asymmetric beyond chance)', () => {
    const up = ids(10, 'up');
    const down = ids(2, 'down');
    const before = results(down, up);
    const after = results(up, down);
    const r = comparePaired(before, after);
    expect(r.improved).toBe(10);
    expect(r.regressed).toBe(2);
    expect(r.pValue).toBeLessThan(0.05);
    expect(r.verdict).toBe('trustworthy');
  });
});
