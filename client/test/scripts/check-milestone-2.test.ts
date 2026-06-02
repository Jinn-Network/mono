import { describe, it, expect } from 'vitest';
import { computeMilestone2, type SliceResponse } from '../../scripts/check-milestone-2';

/**
 * Build a minimal SliceResponse with a single group=none series whose `rolling`
 * array has the given length, optionally pinning controlled values at specific
 * indices (e.g. N-1 = "current", N-100 = "baseline 99 verdicts ago").
 */
function buildSlice(
  length: number,
  pins: Record<number, number> = {},
  overrides: Partial<SliceResponse> = {},
): SliceResponse {
  const rolling = new Array<number>(length).fill(0.5);
  for (const [idx, val] of Object.entries(pins)) {
    rolling[Number(idx)] = val;
  }
  return {
    params: {
      manifestDigest: 'bafkrei-test',
      window: 30,
      filter: { harness: ['codex'], model: ['gpt-5.4-mini'] },
      group: 'none',
      includeUnenriched: false,
    },
    enrichmentCoverage: 0.5,
    kpis: { attempts: length, verdicts: length, verdictsPass: 0, resolvedRate: null, jinnEarned: '0' },
    series: [{ groupValue: null, buckets: [], rolling }],
    ...overrides,
  };
}

describe('computeMilestone2', () => {
  it('live-shaped not-achieved case (N=310, current 0.4666…, baseline 0.7)', () => {
    const slice = buildSlice(310, { 309: 0.4666666666666667, 210: 0.7 });
    const r = computeMilestone2(slice);
    expect(r.verdicts).toBe(310);
    expect(r.floorMet).toBe(true);
    expect(r.current).toBeCloseTo(0.4666666666666667, 12);
    expect(r.baseline).toBeCloseTo(0.7, 12);
    expect(r.deltaPp).toBeCloseTo(-23.33, 2);
    expect(r.distanceToGatePp).toBeCloseTo(33.33, 2);
    expect(r.achieved).toBe(false);
  });

  it('floor not met (N=129) → not achieved, 1 verdict to go', () => {
    const slice = buildSlice(129);
    const r = computeMilestone2(slice);
    expect(r.verdicts).toBe(129);
    expect(r.floorMet).toBe(false);
    expect(r.verdictsToFloor).toBe(1);
    expect(r.achieved).toBe(false);
  });

  it('boundary: floor exactly met (N=130) with a clean ≥10pp delta → achieved', () => {
    // index N-1 = 129 is current, index N-100 = 30 is baseline.
    const slice = buildSlice(130, { 129: 0.85, 30: 0.7 });
    const r = computeMilestone2(slice);
    expect(r.verdicts).toBe(130);
    expect(r.floorMet).toBe(true);
    expect(r.deltaPp).toBeCloseTo(15, 6);
    expect(r.achieved).toBe(true);
  });

  it('achieved: delta of exactly +10pp at N≥130 → achieved, distance ≈ 0', () => {
    const slice = buildSlice(150, { 149: 0.8, 50: 0.7 });
    const r = computeMilestone2(slice);
    expect(r.floorMet).toBe(true);
    expect(r.deltaPp).toBeCloseTo(10, 6);
    expect(r.distanceToGatePp).toBeCloseTo(0, 6);
    expect(r.achieved).toBe(true);
  });

  it('just-below-gate: delta of +9.9pp at N≥130 → not achieved', () => {
    const slice = buildSlice(150, { 149: 0.799, 50: 0.7 });
    const r = computeMilestone2(slice);
    expect(r.floorMet).toBe(true);
    expect(r.deltaPp).toBeCloseTo(9.9, 6);
    expect(r.distanceToGatePp).toBeCloseTo(0.1, 6);
    expect(r.achieved).toBe(false);
  });

  it('below-floor climb (N=120): delta IS reported but achieved stays false', () => {
    // N-1 = 119 (current), N-100 = 20 (baseline). Baseline is computable at N≥100
    // even though the ≥130 floor is not yet met.
    const slice = buildSlice(120, { 119: 0.7, 20: 0.5 });
    const r = computeMilestone2(slice);
    expect(r.floorMet).toBe(false);
    expect(r.verdictsToFloor).toBe(10);
    expect(r.achieved).toBe(false);
    expect(r.deltaPp).toBeCloseTo(20, 6);
    expect(r.distanceToGatePp).toBeCloseTo(-10, 6);
  });

  it('empty series → verdicts 0, achieved false, does not throw', () => {
    const empty = buildSlice(0);
    empty.series = [];
    const r = computeMilestone2(empty);
    expect(r.verdicts).toBe(0);
    expect(r.floorMet).toBe(false);
    expect(r.achieved).toBe(false);
    expect(r.current).toBeNull();
    expect(r.baseline).toBeNull();
    expect(r.deltaPp).toBeNull();
  });
});
