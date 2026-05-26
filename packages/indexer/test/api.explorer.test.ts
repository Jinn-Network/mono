/**
 * Rate-math invariants for the envelope-only filter (#610, spec §4).
 *
 * These tests don't boot Ponder or Hono — they exercise `verdictTruth` against
 * a synthetic fixture and assert the pass/total counts that the /network and
 * /solvernet/:cid routes will compute when filtering rows through the helper.
 *
 * The fixture mirrors the verdict-row shape `verdictRows` produces after a
 * LEFT JOIN to verdictEnvelopeMeta: each row carries `verdictCode`,
 * `actualPassed`, `enrichmentStatus`. The strict filter is applied two ways:
 *   - Default (?include=raw): legacy path, `verdictTruth(v)` falls back to
 *     verdictCode === 1 for unenriched rows, so all 10 rows count.
 *   - Strict (default, no ?include=raw): `verdictTruth(v, true) === true` /
 *     `!== null`, so unenriched rows drop from both numerator and denominator.
 */
import { describe, it, expect } from 'vitest';
import { verdictTruth } from '../src/api/explorer.js';
import { resolvedRateFromCounts } from '../src/api/metrics.js';

type Row = {
  verdictCode: number;
  actualPassed: boolean | null;
  enrichmentStatus: string | null;
};

// Fixture: 10 rows
//   - 4 enriched + actualPassed=true              → strict-pass
//   - 2 enriched + actualPassed=false             → strict-fail
//   - 3 unenriched (pending) verdictCode=1        → legacy-pass, strict-drop
//   - 1 unenriched (failed)  verdictCode=0        → legacy-fail, strict-drop
const FIXTURE: Row[] = [
  { verdictCode: 1, actualPassed: true, enrichmentStatus: 'ok' },
  { verdictCode: 1, actualPassed: true, enrichmentStatus: 'ok' },
  { verdictCode: 0, actualPassed: true, enrichmentStatus: 'ok' },
  { verdictCode: 1, actualPassed: true, enrichmentStatus: 'ok' },
  { verdictCode: 1, actualPassed: false, enrichmentStatus: 'ok' },
  { verdictCode: 0, actualPassed: false, enrichmentStatus: 'ok' },
  { verdictCode: 1, actualPassed: null, enrichmentStatus: 'pending' },
  { verdictCode: 1, actualPassed: null, enrichmentStatus: 'pending' },
  { verdictCode: 1, actualPassed: null, enrichmentStatus: 'pending' },
  { verdictCode: 0, actualPassed: null, enrichmentStatus: 'failed' },
];

describe('verdict rate-math invariant', () => {
  it('permissive mode (legacy default) — pass=7, total=10, resolvedRate=0.7', () => {
    const total = FIXTURE.length;
    const pass = FIXTURE.filter((v) => verdictTruth(v) === true).length;
    expect(pass).toBe(7);
    expect(total).toBe(10);
    expect(resolvedRateFromCounts(pass, total)).toBeCloseTo(0.7);
  });

  it('strict mode (envelope-only) — pass=4, total=6, resolvedRate=0.6666…', () => {
    const kept = FIXTURE.filter((v) => verdictTruth(v, true) !== null);
    const total = kept.length;
    const pass = kept.filter((v) => verdictTruth(v, true) === true).length;
    expect(pass).toBe(4);
    expect(total).toBe(6);
    expect(resolvedRateFromCounts(pass, total)).toBeCloseTo(4 / 6);
  });

  it('strict mode with no enriched rows — resolvedRate is null', () => {
    const onlyUnenriched: Row[] = [
      { verdictCode: 1, actualPassed: null, enrichmentStatus: 'pending' },
      { verdictCode: 1, actualPassed: null, enrichmentStatus: 'pending' },
      { verdictCode: 0, actualPassed: null, enrichmentStatus: 'failed' },
    ];
    const kept = onlyUnenriched.filter((v) => verdictTruth(v, true) !== null);
    const total = kept.length;
    const pass = kept.filter((v) => verdictTruth(v, true) === true).length;
    expect(total).toBe(0);
    expect(pass).toBe(0);
    expect(resolvedRateFromCounts(pass, total)).toBeNull();
  });
});
