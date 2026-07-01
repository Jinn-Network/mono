import { describe, it, expect } from 'vitest';
import {
  computeMilestone2Gate,
  MILESTONE2_FLOOR,
  MILESTONE2_GATE_PP,
} from './milestone2';

// The #647 condition: on the swe-rebench-v2 SolverNet at harness=codex,
// model=gpt-5.4-mini, the trailing-30 envelope verdict-success rate over the
// most recent 30 verdicts must be >= 10pp above its value over the 30 verdicts
// ending 99 verdicts earlier, with >= 130 envelope-enriched verdicts.
//
// `rolling` is the per-verdict trailing-window resolved-rate series from the
// slice engine (rollingResolvedRate: element i = trailing-k mean ending at
// verdict i). So current = rolling[n-1], baseline (t-99) = rolling[n-100].

/** Build a rolling series of length `n` with pinned current/baseline values. */
function series(n: number, baseline: number, current: number): number[] {
  const r = new Array(n).fill(0.42); // sentinel — must not be read
  if (n >= MILESTONE2_FLOOR) {
    r[n - 100] = baseline;
    r[n - 1] = current;
  }
  return r;
}

describe('computeMilestone2Gate', () => {
  it('is ineligible below the 130-verdict floor', () => {
    const gate = computeMilestone2Gate(new Array(129).fill(0.5));
    expect(gate.status).toBe('ineligible');
    expect(gate.eligible).toBe(false);
    expect(gate.verdicts).toBe(129);
    expect(gate.floor).toBe(130);
    expect(gate.current).toBeNull();
    expect(gate.baseline).toBeNull();
    expect(gate.deltaPp).toBeNull();
  });

  it('passes when the trailing-30 delta clears the 10pp gate', () => {
    const gate = computeMilestone2Gate(series(130, 0.5, 0.65));
    expect(gate.status).toBe('pass');
    expect(gate.eligible).toBe(true);
    expect(gate.current).toBeCloseTo(0.65, 10);
    expect(gate.baseline).toBeCloseTo(0.5, 10);
    expect(gate.deltaPp).toBeCloseTo(15, 6);
  });

  it('is below-gate when improvement is positive but under 10pp', () => {
    const gate = computeMilestone2Gate(series(150, 0.5, 0.55));
    expect(gate.status).toBe('below');
    expect(gate.deltaPp).toBeCloseTo(5, 6);
  });

  it('is below-gate when the trailing rate regressed', () => {
    const gate = computeMilestone2Gate(series(200, 0.6, 0.45));
    expect(gate.status).toBe('below');
    expect(gate.deltaPp).toBeCloseTo(-15, 6);
  });

  it('reads baseline at index n-100 and current at index n-1', () => {
    const r = series(140, 0.31, 0.77);
    const gate = computeMilestone2Gate(r);
    expect(gate.baseline).toBeCloseTo(0.31, 10); // r[40]
    expect(gate.current).toBeCloseTo(0.77, 10); // r[139]
  });

  it('brackets the gate: +10.5pp passes, +9.5pp fails', () => {
    expect(computeMilestone2Gate(series(130, 0.5, 0.605)).status).toBe('pass');
    expect(computeMilestone2Gate(series(130, 0.5, 0.595)).status).toBe('below');
  });

  it('exposes the milestone constants', () => {
    expect(MILESTONE2_FLOOR).toBe(130);
    expect(MILESTONE2_GATE_PP).toBe(10);
  });
});
