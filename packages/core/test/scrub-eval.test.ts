import { describe, expect, it } from 'vitest';
import {
  allCiFixtures,
  metricsFromCounts,
  runBench,
  scoreClass,
  syntheticFixtures,
} from '../src/scrub/eval/index.js';

describe('scrub eval metrics (#1968)', () => {
  it('computes Fβ=2 recall-weighted', () => {
    const m = metricsFromCounts({ tp: 8, fp: 2, fn: 2 });
    expect(m.recall).toBeCloseTo(0.8, 5);
    expect(m.precision).toBeCloseTo(0.8, 5);
    // F2 = 5*p*r / (4*p + r) = 5*0.64 / (3.2+0.8) = 3.2/4 = 0.8
    expect(m.fBeta2).toBeCloseTo(0.8, 5);
  });

  it('scores overlap with distinct-source dedupe', () => {
    const counts = scoreClass(
      [
        { start: 0, end: 5, sourceId: 'replay' },
        { start: 10, end: 15, sourceId: 'replay' },
        { start: 20, end: 25 },
      ],
      [{ start: 0, end: 5 }],
    );
    // deduped gold: 2 (replay once + unique); 1 TP, 1 FN, 0 FP
    expect(counts).toEqual({ tp: 1, fp: 0, fn: 1 });
  });
});

describe('scrub eval CI fixtures (#1968)', () => {
  it('runs synthetic + corruption corpus without throwing', async () => {
    const report = await runBench(allCiFixtures());
    expect(report.schemaVersion).toBe(1);
    expect(report.corruption.fixtures).toBeGreaterThan(0);
    // Corruption corpus must stay byte-identical on seed profile
    expect(report.corruption.failures).toBe(0);
    // Metrics-only: no text fields
    expect(JSON.stringify(report)).not.toMatch(/@example\.com/);
    expect(JSON.stringify(report)).not.toMatch(/0x1111/);
  });

  it('baseline: seed profile catches B1 email and D1 home-path and C1 wallet', async () => {
    const report = await runBench(syntheticFixtures());
    expect(report.classes.B1?.recall).toBeGreaterThanOrEqual(0.99);
    expect(report.classes.D1?.recall).toBeGreaterThanOrEqual(0.99);
    expect(report.classes.C1?.recall).toBeGreaterThanOrEqual(0.99);
  });

  it('baseline records B2 carrier miss until #1970 (FN expected)', async () => {
    const report = await runBench(syntheticFixtures().filter((f) => f.id === 'B2-git-author'));
    // Name "Synth Operator" survives; email may be redacted separately
    expect(report.classes.B2?.fn).toBeGreaterThanOrEqual(1);
  });
});
