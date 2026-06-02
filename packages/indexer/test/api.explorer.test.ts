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
import {
  verdictTruth,
  filterFrozenVerdictsToSlate,
  computeHeldOutDelta,
} from '../src/api/explorer.js';
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

// ── #820 AC#1 — slate-scoped frozen verdicts ───────────────────────────────────
//
// frozenResolvedRate must score a checkpoint against a NAMED slate version, not
// "whatever frozen attempts matched its codeDigest" (task-selection confounded).
// filterFrozenVerdictsToSlate is the pure chokepoint: for swe-rebench-v2 it keeps
// only verdicts whose instanceId is in the slate; for other solverTypes it is a
// pass-through (they have no instance_id / slate concept).

describe('filterFrozenVerdictsToSlate (#820 AC#1)', () => {
  const slate = { instanceIds: new Set(['pandas-dev__pandas-60736', 'lmfit__lmfit-py-989']) };

  const verdicts = [
    { instanceId: 'pandas-dev__pandas-60736', verdictCode: 1, actualPassed: true, enrichmentStatus: 'ok' },
    { instanceId: 'not-in-slate__foo-1', verdictCode: 1, actualPassed: true, enrichmentStatus: 'ok' },
    { instanceId: 'lmfit__lmfit-py-989', verdictCode: 0, actualPassed: false, enrichmentStatus: 'ok' },
  ];

  it('keeps only slate instanceIds for swe-rebench-v2 (excludes non-slate)', () => {
    const kept = filterFrozenVerdictsToSlate(verdicts, slate, 'swe-rebench-v2.v1');
    const ids = kept.map((v) => v.instanceId);
    expect(ids).toContain('pandas-dev__pandas-60736');
    expect(ids).toContain('lmfit__lmfit-py-989');
    expect(ids).not.toContain('not-in-slate__foo-1');
    expect(kept).toHaveLength(2);
  });

  it('drops verdicts with an empty/missing instanceId for swe-rebench-v2', () => {
    const withEmpty = [...verdicts, { instanceId: '', verdictCode: 1, actualPassed: true, enrichmentStatus: 'ok' }];
    const kept = filterFrozenVerdictsToSlate(withEmpty, slate, 'swe-rebench-v2.v1');
    expect(kept).toHaveLength(2);
  });

  it('passes through unchanged for a non-swe-rebench solverType', () => {
    const kept = filterFrozenVerdictsToSlate(verdicts, slate, 'prediction.v1');
    expect(kept).toBe(verdicts);
    expect(kept).toHaveLength(3);
  });

  it('passes through unchanged when solverType is unknown/empty', () => {
    expect(filterFrozenVerdictsToSlate(verdicts, slate, '')).toBe(verdicts);
  });
});

// ── #820 AC#2 — held-out delta vs parent ────────────────────────────────────────

describe('computeHeldOutDelta (#820 AC#2)', () => {
  it('positive delta when self improves on parent', () => {
    expect(computeHeldOutDelta({ frozenResolvedRate: 0.8 }, { frozenResolvedRate: 0.5 })).toBeCloseTo(0.3);
  });

  it('negative delta when self regresses from parent', () => {
    expect(computeHeldOutDelta({ frozenResolvedRate: 0.4 }, { frozenResolvedRate: 0.6 })).toBeCloseTo(-0.2);
  });

  it('null when self has no frozen rate', () => {
    expect(computeHeldOutDelta({ frozenResolvedRate: null }, { frozenResolvedRate: 0.6 })).toBeNull();
  });

  it('null when parent has no frozen rate', () => {
    expect(computeHeldOutDelta({ frozenResolvedRate: 0.6 }, { frozenResolvedRate: null })).toBeNull();
  });

  it('null when there is no parent', () => {
    expect(computeHeldOutDelta({ frozenResolvedRate: 0.6 }, undefined)).toBeNull();
  });
});
