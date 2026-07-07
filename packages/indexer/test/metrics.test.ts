/**
 * Tests for src/api/metrics.ts — pure aggregation/shaper helpers for the
 * /explorer/* routes. These functions have no I/O dependencies; all inputs
 * are synthetic.
 */
import { describe, it, expect } from 'vitest';
import {
  verdictResolvedRate,
  resolvedRateFromCounts,
  attemptFinalization,
  bucketResolvedRate,
  rollingResolvedRate,
  rankLeaderboard,
  compareByResolvedRateAttempts,
  compareByJinnEarnedActive,
  freshness,
  composition,
  detectFreezeViolations,
  type LeaderboardRow,
} from '../src/api/metrics.js';
import { parseBoolParam, verdictTruth } from '../src/api/explorer.js';

// ── verdictResolvedRate ───────────────────────────────────────────────────────

describe('verdictResolvedRate', () => {
  it('returns null for an empty verdicts array', () => {
    expect(verdictResolvedRate([])).toBeNull();
  });

  it('returns 1 when all verdicts are Pass (code 1)', () => {
    expect(verdictResolvedRate([{ verdictCode: 1 }, { verdictCode: 1 }])).toBe(1);
  });

  it('returns 0 when no verdicts are Pass', () => {
    expect(verdictResolvedRate([{ verdictCode: 0 }, { verdictCode: 2 }])).toBe(0);
  });

  it('returns 0.5 for half Pass, half non-Pass', () => {
    expect(
      verdictResolvedRate([
        { verdictCode: 1 },
        { verdictCode: 0 },
        { verdictCode: 1 },
        { verdictCode: 2 },
      ]),
    ).toBe(0.5);
  });

  it('returns the correct rate for a single Pass verdict', () => {
    expect(verdictResolvedRate([{ verdictCode: 1 }])).toBe(1);
  });

  it('returns the correct rate for a single non-Pass verdict', () => {
    expect(verdictResolvedRate([{ verdictCode: 2 }])).toBe(0);
  });

  it('only code 1 is treated as Pass — all other codes count as non-Pass', () => {
    // codes 0, 2, 3, 4 are all non-Pass
    expect(
      verdictResolvedRate([
        { verdictCode: 0 },
        { verdictCode: 2 },
        { verdictCode: 3 },
        { verdictCode: 4 },
        { verdictCode: 1 },
      ]),
    ).toBe(1 / 5);
  });
});

// ── resolvedRateFromCounts ────────────────────────────────────────────────────

describe('resolvedRateFromCounts', () => {
  it('returns null when total is 0', () => {
    expect(resolvedRateFromCounts(0, 0)).toBeNull();
  });

  it('returns 0.75 for pass=3, total=4', () => {
    expect(resolvedRateFromCounts(3, 4)).toBe(0.75);
  });

  it('returns 0 when pass is 0 and total > 0', () => {
    expect(resolvedRateFromCounts(0, 5)).toBe(0);
  });

  it('returns 1 when pass equals total', () => {
    expect(resolvedRateFromCounts(5, 5)).toBe(1);
  });
});

// ── attemptFinalization ───────────────────────────────────────────────────────

describe('attemptFinalization', () => {
  it('not finalized when verdicts array is empty', () => {
    expect(attemptFinalization([], 2)).toEqual({ finalized: false, passed: false });
  });

  it('issue #1304: treats persisted requiredVerdicts 0 as first-verdict finalization', () => {
    expect(attemptFinalization([{ verdictCode: 1 }], 0)).toEqual({ finalized: true, passed: true });
  });

  it('not finalized when count is less than requiredVerdicts', () => {
    expect(
      attemptFinalization([{ verdictCode: 1 }], 2),
    ).toEqual({ finalized: false, passed: false });
  });

  it('finalized and passed when all verdicts are Pass and count == requiredVerdicts', () => {
    expect(
      attemptFinalization([{ verdictCode: 1 }, { verdictCode: 1 }], 2),
    ).toEqual({ finalized: true, passed: true });
  });

  it('finalized and passed when strict majority pass (3 of 5)', () => {
    expect(
      attemptFinalization(
        [{ verdictCode: 1 }, { verdictCode: 1 }, { verdictCode: 1 }, { verdictCode: 0 }, { verdictCode: 0 }],
        5,
      ),
    ).toEqual({ finalized: true, passed: true });
  });

  it('finalized but NOT passed when exactly half are Pass (not strict majority)', () => {
    // 2 pass out of 4 — pass * 2 = 4 is NOT > 4, so not passed
    expect(
      attemptFinalization(
        [{ verdictCode: 1 }, { verdictCode: 1 }, { verdictCode: 0 }, { verdictCode: 0 }],
        4,
      ),
    ).toEqual({ finalized: true, passed: false });
  });

  it('finalized but NOT passed when minority are Pass (1 of 3)', () => {
    expect(
      attemptFinalization([{ verdictCode: 1 }, { verdictCode: 0 }, { verdictCode: 0 }], 3),
    ).toEqual({ finalized: true, passed: false });
  });

  it('finalized when verdicts count exceeds requiredVerdicts', () => {
    // 3 verdicts but only 2 required — still finalized
    const result = attemptFinalization(
      [{ verdictCode: 1 }, { verdictCode: 1 }, { verdictCode: 0 }],
      2,
    );
    expect(result.finalized).toBe(true);
  });

  it('finalized and passed when single Pass verdict and requiredVerdicts is 1', () => {
    expect(attemptFinalization([{ verdictCode: 1 }], 1)).toEqual({ finalized: true, passed: true });
  });

  it('finalized but NOT passed when single non-Pass verdict and requiredVerdicts is 1', () => {
    expect(attemptFinalization([{ verdictCode: 0 }], 1)).toEqual({ finalized: true, passed: false });
  });
});

// ── bucketResolvedRate ────────────────────────────────────────────────────────

describe('bucketResolvedRate', () => {
  it('returns [] for empty samples', () => {
    expect(bucketResolvedRate([], 100n)).toEqual([]);
  });

  it('throws if bucketBlocks <= 0', () => {
    expect(() => bucketResolvedRate([], 0n)).toThrow();
    expect(() => bucketResolvedRate([], -1n)).toThrow();
  });

  it('groups a single sample into one bucket', () => {
    const result = bucketResolvedRate([{ block: 150n, pass: true }], 100n);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ bucketStartBlock: '100', total: 1, pass: 1, rate: 1 });
  });

  it('groups samples within the same bucket correctly', () => {
    const samples = [
      { block: 100n, pass: true },
      { block: 150n, pass: false },
      { block: 199n, pass: true },
    ];
    const result = bucketResolvedRate(samples, 100n);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ bucketStartBlock: '100', total: 3, pass: 2, rate: 2 / 3 });
  });

  it('splits samples across two buckets', () => {
    const samples = [
      { block: 50n, pass: true },
      { block: 150n, pass: false },
    ];
    const result = bucketResolvedRate(samples, 100n);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ bucketStartBlock: '0', total: 1, pass: 1, rate: 1 });
    expect(result[1]).toEqual({ bucketStartBlock: '100', total: 1, pass: 0, rate: 0 });
  });

  it('sorts buckets ascending by bucketStartBlock', () => {
    const samples = [
      { block: 250n, pass: true },
      { block: 50n, pass: true },
      { block: 150n, pass: false },
    ];
    const result = bucketResolvedRate(samples, 100n);
    expect(result.map((r) => r.bucketStartBlock)).toEqual(['0', '100', '200']);
  });

  it('rate is pass/total — never null for a non-empty bucket', () => {
    const samples = [{ block: 0n, pass: false }];
    const result = bucketResolvedRate(samples, 50n);
    expect(result[0].rate).toBe(0);
  });

  it('handles large bigint blocks correctly', () => {
    const bigBlock = 10_000_000n;
    const bucket = 1_000_000n;
    const expected = String((bigBlock / bucket) * bucket); // '10000000'
    const result = bucketResolvedRate([{ block: bigBlock, pass: true }], bucket);
    expect(result[0].bucketStartBlock).toBe(expected);
  });

  it('samples whose block is exactly a bucket boundary fall in that bucket', () => {
    // block 200n with bucketBlocks 100n → bucket start = 200
    const result = bucketResolvedRate([{ block: 200n, pass: true }], 100n);
    expect(result[0].bucketStartBlock).toBe('200');
  });
});

// ── rollingResolvedRate ───────────────────────────────────────────────────────

describe('rollingResolvedRate', () => {
  it('returns [] for empty passes', () => {
    expect(rollingResolvedRate([], 3)).toEqual([]);
  });

  it('throws if k < 1', () => {
    expect(() => rollingResolvedRate([true], 0)).toThrow();
    expect(() => rollingResolvedRate([true], -1)).toThrow();
  });

  it('k=1: each element is exactly 0 or 1', () => {
    expect(rollingResolvedRate([true, false, true], 1)).toEqual([1, 0, 1]);
  });

  it('window is capped at the start of the array', () => {
    // k=3, 5 elements — first element window is size 1, second is size 2, etc.
    const result = rollingResolvedRate([true, true, false, false, true], 3);
    expect(result[0]).toBe(1); // only [true]
    expect(result[1]).toBe(1); // [true, true]
    expect(result[2]).toBeCloseTo(2 / 3); // [true, true, false]
    expect(result[3]).toBeCloseTo(1 / 3); // [true, false, false]
    expect(result[4]).toBeCloseTo(1 / 3); // [false, false, true]
  });

  it('k larger than array length: window is always the whole prefix', () => {
    const result = rollingResolvedRate([true, false, true], 100);
    expect(result[0]).toBe(1); // 1/1
    expect(result[1]).toBe(0.5); // 1/2
    expect(result[2]).toBeCloseTo(2 / 3); // 2/3
  });

  it('all false: output is all zeros', () => {
    expect(rollingResolvedRate([false, false, false], 2)).toEqual([0, 0, 0]);
  });

  it('all true: output is all ones', () => {
    expect(rollingResolvedRate([true, true, true], 2)).toEqual([1, 1, 1]);
  });

  it('single element array', () => {
    expect(rollingResolvedRate([false], 5)).toEqual([0]);
    expect(rollingResolvedRate([true], 5)).toEqual([1]);
  });
});

// ── rankLeaderboard ───────────────────────────────────────────────────────────

describe('rankLeaderboard', () => {
  const makeRow = (
    overrides: Partial<LeaderboardRow> & Pick<LeaderboardRow, 'operator'>,
  ): LeaderboardRow => ({
    attempts: 10,
    settledContribution: 8,
    verdictsTotal: 5,
    verdictsPass: 4,
    resolvedRate: 0.8,
    jinnEarned: 0n,
    active: false,
    ...overrides,
  });

  it('partitions rows into ranked (>= minVerdicts) and lowVolume (< min)', () => {
    const rows = [
      makeRow({ operator: '0xAAA' as `0x${string}`, verdictsTotal: 5 }),
      makeRow({ operator: '0xBBB' as `0x${string}`, verdictsTotal: 2 }),
    ];
    const { ranked, lowVolume } = rankLeaderboard(rows, 5);
    expect(ranked).toHaveLength(1);
    expect(lowVolume).toHaveLength(1);
    expect(ranked[0].operator).toBe('0xAAA');
    expect(lowVolume[0].operator).toBe('0xBBB');
  });

  it('assigns rank 1..N to the ranked group (resolvedRate desc)', () => {
    const rows = [
      makeRow({ operator: '0xAAA' as `0x${string}`, verdictsTotal: 10, resolvedRate: 0.9 }),
      makeRow({ operator: '0xBBB' as `0x${string}`, verdictsTotal: 10, resolvedRate: 0.7 }),
      makeRow({ operator: '0xCCC' as `0x${string}`, verdictsTotal: 10, resolvedRate: 0.5 }),
    ];
    const { ranked } = rankLeaderboard(rows, 5);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(ranked.map((r) => r.operator)).toEqual(['0xAAA', '0xBBB', '0xCCC']);
  });

  it('lowVolume group is sorted by the same comparator (no rank field)', () => {
    const rows = [
      makeRow({ operator: '0xBBB' as `0x${string}`, verdictsTotal: 1, resolvedRate: 0.2 }),
      makeRow({ operator: '0xAAA' as `0x${string}`, verdictsTotal: 1, resolvedRate: 0.9 }),
    ];
    const { lowVolume } = rankLeaderboard(rows, 5);
    expect(lowVolume[0].operator).toBe('0xAAA');
    expect(lowVolume[1].operator).toBe('0xBBB');
    expect((lowVolume[0] as unknown as Record<string, unknown>)['rank']).toBeUndefined();
  });

  // ── default comparator (used by /operators + per-SolverNet train/frozen boards) ─

  it('DEFAULT comparator sorts by (resolvedRate desc, attempts desc, operator asc) — locks train/frozen call sites', () => {
    // 0xAAA: rate 0.9, attempts 10
    // 0xBBB: rate 0.9, attempts 20  → wins on attempts tie-break
    // 0xCCC: rate 0.5, attempts 100 → loses on rate to both above
    // 0xDDD: rate 0.9, attempts 10  → loses to 0xAAA on operator asc
    const rows = [
      makeRow({ operator: '0xCCC' as `0x${string}`, verdictsTotal: 10, resolvedRate: 0.5, attempts: 100 }),
      makeRow({ operator: '0xAAA' as `0x${string}`, verdictsTotal: 10, resolvedRate: 0.9, attempts: 10 }),
      makeRow({ operator: '0xDDD' as `0x${string}`, verdictsTotal: 10, resolvedRate: 0.9, attempts: 10 }),
      makeRow({ operator: '0xBBB' as `0x${string}`, verdictsTotal: 10, resolvedRate: 0.9, attempts: 20 }),
    ];
    const { ranked } = rankLeaderboard(rows, 5);
    expect(ranked.map((r) => r.operator)).toEqual(['0xBBB', '0xAAA', '0xDDD', '0xCCC']);
  });

  it('DEFAULT comparator sorts null resolvedRate last', () => {
    const rows = [
      makeRow({ operator: '0xAAA' as `0x${string}`, verdictsTotal: 0, resolvedRate: null, attempts: 5 }),
      makeRow({ operator: '0xBBB' as `0x${string}`, verdictsTotal: 0, resolvedRate: 0.1, attempts: 1 }),
    ];
    // Use lowVolume so we don't depend on minVerdicts here; the same comparator
    // sorts both groups.
    const { lowVolume } = rankLeaderboard(rows, 5);
    expect(lowVolume.map((r) => r.operator)).toEqual(['0xBBB', '0xAAA']);
  });

  // Reference compareByResolvedRateAttempts so unused-import lint stays quiet
  // even if the exports drift; the import doubles as a smoke check that the
  // symbol is exported.
  it('exports compareByResolvedRateAttempts as a named symbol', () => {
    expect(typeof compareByResolvedRateAttempts).toBe('function');
  });

  it('compareByJinnEarnedActive sorts by earned OLAS desc, active desc, operator asc', () => {
    const rows = [
      makeRow({ operator: '0xCCC' as `0x${string}`, jinnEarned: 5n, active: false }),
      makeRow({ operator: '0xBBB' as `0x${string}`, jinnEarned: 10n, active: false }),
      makeRow({ operator: '0xAAA' as `0x${string}`, jinnEarned: 10n, active: true }),
    ];
    const { lowVolume } = rankLeaderboard(rows, 100, compareByJinnEarnedActive);
    expect(lowVolume.map((r) => r.operator)).toEqual(['0xAAA', '0xBBB', '0xCCC']);
  });

  it('empty input returns empty ranked and lowVolume', () => {
    const { ranked, lowVolume } = rankLeaderboard([], 5);
    expect(ranked).toHaveLength(0);
    expect(lowVolume).toHaveLength(0);
  });

  it('all rows below minimum go to lowVolume', () => {
    const rows = [
      makeRow({ operator: '0xAAA' as `0x${string}`, verdictsTotal: 1 }),
    ];
    const { ranked, lowVolume } = rankLeaderboard(rows, 5);
    expect(ranked).toHaveLength(0);
    expect(lowVolume).toHaveLength(1);
  });

  it('minVerdicts = 0 puts all rows in ranked', () => {
    const rows = [
      makeRow({ operator: '0xAAA' as `0x${string}`, verdictsTotal: 0 }),
    ];
    const { ranked, lowVolume } = rankLeaderboard(rows, 0);
    expect(ranked).toHaveLength(1);
    expect(lowVolume).toHaveLength(0);
  });
});

// ── freshness ─────────────────────────────────────────────────────────────────

describe('freshness', () => {
  it('returns lastIndexedBlock as decimal string', () => {
    const result = freshness(12345n, '2026-01-01T00:00:00Z');
    expect(result.lastIndexedBlock).toBe('12345');
  });

  it('passes lastIndexedAt through unchanged', () => {
    const iso = '2026-05-12T10:00:00.000Z';
    const result = freshness(100n, iso);
    expect(result.lastIndexedAt).toBe(iso);
  });

  it('returns behindHead = null when headBlock is not provided', () => {
    const result = freshness(100n, '2026-01-01T00:00:00Z');
    expect(result.behindHead).toBeNull();
  });

  it('returns behindHead as a number when headBlock is provided', () => {
    const result = freshness(100n, '2026-01-01T00:00:00Z', 200n);
    expect(result.behindHead).toBe(100);
  });

  it('behindHead is 0 when lastIndexedBlock === headBlock', () => {
    const result = freshness(500n, '2026-01-01T00:00:00Z', 500n);
    expect(result.behindHead).toBe(0);
  });

  it('handles large bigint blocks without precision loss for reasonable values', () => {
    const last = 40_000_000n;
    const head = 40_000_050n;
    const result = freshness(last, '2026-01-01T00:00:00Z', head);
    expect(result.lastIndexedBlock).toBe('40000000');
    expect(result.behindHead).toBe(50);
  });
});

// ── composition ───────────────────────────────────────────────────────────────

describe('composition', () => {
  it('returns [] for an empty items array', () => {
    expect(composition([], (x: { m: string }) => x.m)).toEqual([]);
  });

  it('groups and counts correctly, sorts by count desc then value asc', () => {
    const items = [{ m: 'a' }, { m: 'a' }, { m: 'b' }];
    const result = composition(items, (x) => x.m);
    expect(result).toEqual([
      { value: 'a', count: 2, share: 2 / 3 },
      { value: 'b', count: 1, share: 1 / 3 },
    ]);
  });

  it('tie on count sorts by value asc', () => {
    const items = [{ m: 'z' }, { m: 'a' }, { m: 'z' }, { m: 'a' }];
    const result = composition(items, (x) => x.m);
    expect(result[0].value).toBe('a');
    expect(result[1].value).toBe('z');
    expect(result[0].count).toBe(2);
    expect(result[1].count).toBe(2);
    expect(result[0].share).toBeCloseTo(0.5);
  });

  it('single item: count=1, share=1', () => {
    const result = composition([{ m: 'x' }], (x) => x.m);
    expect(result).toEqual([{ value: 'x', count: 1, share: 1 }]);
  });

  it('all items have the same key: one entry with count=N, share=1', () => {
    const items = [{ m: 'b' }, { m: 'b' }, { m: 'b' }];
    const result = composition(items, (x) => x.m);
    expect(result).toEqual([{ value: 'b', count: 3, share: 1 }]);
  });

  it('works with a key extractor on a different property', () => {
    const items = [{ mode: 'train' }, { mode: 'frozen' }, { mode: 'train' }];
    const result = composition(items, (x) => x.mode);
    expect(result[0]).toEqual({ value: 'train', count: 2, share: 2 / 3 });
    expect(result[1]).toEqual({ value: 'frozen', count: 1, share: 1 / 3 });
  });
});

// ── detectFreezeViolations ────────────────────────────────────────────────────

describe('detectFreezeViolations', () => {
  it('returns [] for empty input', () => {
    expect(detectFreezeViolations([])).toEqual([]);
  });

  it('one operator all same digest — violatingCount is 0', () => {
    const rows = [
      { operator: '0xAAA', codeDigest: 'sha256:abc' },
      { operator: '0xAAA', codeDigest: 'sha256:abc' },
    ];
    const result = detectFreezeViolations(rows);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      operator: '0xAAA',
      modalCodeDigest: 'sha256:abc',
      total: 2,
      violatingCount: 0,
    });
  });

  it('one operator 3×digestA + 1×digestB — modal is digestA, violatingCount=1', () => {
    const rows = [
      { operator: '0xAAA', codeDigest: 'digestA' },
      { operator: '0xAAA', codeDigest: 'digestA' },
      { operator: '0xAAA', codeDigest: 'digestA' },
      { operator: '0xAAA', codeDigest: 'digestB' },
    ];
    const result = detectFreezeViolations(rows);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      operator: '0xAAA',
      modalCodeDigest: 'digestA',
      total: 4,
      violatingCount: 1,
    });
  });

  it('tie on modal frequency picks lexicographically smallest digest', () => {
    const rows = [
      { operator: '0xAAA', codeDigest: 'digestZ' },
      { operator: '0xAAA', codeDigest: 'digestA' },
    ];
    const result = detectFreezeViolations(rows);
    expect(result[0].modalCodeDigest).toBe('digestA');
    // The OTHER digest is the violation
    expect(result[0].violatingCount).toBe(1);
  });

  it('two operators, sorted by violatingCount desc then operator asc', () => {
    const rows = [
      // 0xBBB: digestA×1, digestB×2 → modal=digestB, violatingCount=1
      { operator: '0xBBB', codeDigest: 'digestA' },
      { operator: '0xBBB', codeDigest: 'digestB' },
      { operator: '0xBBB', codeDigest: 'digestB' },
      // 0xAAA: digestA×3, digestB×1 → modal=digestA, violatingCount=1
      { operator: '0xAAA', codeDigest: 'digestA' },
      { operator: '0xAAA', codeDigest: 'digestA' },
      { operator: '0xAAA', codeDigest: 'digestA' },
      { operator: '0xAAA', codeDigest: 'digestB' },
    ];
    const result = detectFreezeViolations(rows);
    // Both have violatingCount=1 → tie → sort by operator asc
    expect(result[0].operator).toBe('0xAAA');
    expect(result[1].operator).toBe('0xBBB');
  });

  it('two operators, higher violatingCount comes first', () => {
    const rows = [
      // 0xAAA: 1×digestA, 3×digestB → modal=digestB, violatingCount=1
      { operator: '0xAAA', codeDigest: 'digestA' },
      { operator: '0xAAA', codeDigest: 'digestB' },
      { operator: '0xAAA', codeDigest: 'digestB' },
      { operator: '0xAAA', codeDigest: 'digestB' },
      // 0xBBB: 2×digestA, 2×digestB → tie → modal=digestA, violatingCount=2
      { operator: '0xBBB', codeDigest: 'digestA' },
      { operator: '0xBBB', codeDigest: 'digestA' },
      { operator: '0xBBB', codeDigest: 'digestB' },
      { operator: '0xBBB', codeDigest: 'digestB' },
    ];
    const result = detectFreezeViolations(rows);
    // 0xBBB has violatingCount=2, 0xAAA has violatingCount=1 → 0xBBB first
    expect(result[0].operator).toBe('0xBBB');
    expect(result[0].violatingCount).toBe(2);
    expect(result[1].operator).toBe('0xAAA');
    expect(result[1].violatingCount).toBe(1);
  });
});

// ── parseBoolParam ────────────────────────────────────────────────────────────

describe('parseBoolParam', () => {
  it('returns the default when raw is undefined', () => {
    expect(parseBoolParam(undefined, true)).toBe(true);
    expect(parseBoolParam(undefined, false)).toBe(false);
  });

  it('parses truthy strings (true/1/yes) case-insensitively', () => {
    expect(parseBoolParam('true', false)).toBe(true);
    expect(parseBoolParam('TRUE', false)).toBe(true);
    expect(parseBoolParam('1', false)).toBe(true);
    expect(parseBoolParam('yes', false)).toBe(true);
    expect(parseBoolParam('YES', false)).toBe(true);
  });

  it('parses falsy strings (false/0/no) case-insensitively', () => {
    expect(parseBoolParam('false', true)).toBe(false);
    expect(parseBoolParam('FALSE', true)).toBe(false);
    expect(parseBoolParam('0', true)).toBe(false);
    expect(parseBoolParam('no', true)).toBe(false);
    expect(parseBoolParam('NO', true)).toBe(false);
  });

  it('returns the default when raw is unparseable', () => {
    expect(parseBoolParam('maybe', true)).toBe(true);
    expect(parseBoolParam('maybe', false)).toBe(false);
    expect(parseBoolParam('', true)).toBe(true);
    expect(parseBoolParam('2', false)).toBe(false);
  });
});

// ── verdictTruth strict mode ──────────────────────────────────────────────────

describe('verdictTruth strict mode', () => {
  it('strict=true returns null when enrichmentStatus is not "ok" (pending)', () => {
    expect(
      verdictTruth(
        { verdictCode: 1, actualPassed: null, enrichmentStatus: 'pending' },
        true,
      ),
    ).toBeNull();
  });

  it('strict=true returns null when enrichmentStatus is "failed" regardless of verdictCode', () => {
    expect(
      verdictTruth(
        { verdictCode: 1, actualPassed: null, enrichmentStatus: 'failed' },
        true,
      ),
    ).toBeNull();
  });

  it('strict=true returns actualPassed for enriched rows', () => {
    expect(
      verdictTruth(
        { verdictCode: 0, actualPassed: true, enrichmentStatus: 'ok' },
        true,
      ),
    ).toBe(true);
    expect(
      verdictTruth(
        { verdictCode: 1, actualPassed: false, enrichmentStatus: 'ok' },
        true,
      ),
    ).toBe(false);
  });

  it('strict=false (default) falls back to verdictCode===1 for unenriched rows', () => {
    expect(
      verdictTruth({
        verdictCode: 1,
        actualPassed: null,
        enrichmentStatus: 'pending',
      }),
    ).toBe(true);
    expect(
      verdictTruth(
        { verdictCode: 0, actualPassed: null, enrichmentStatus: 'failed' },
        false,
      ),
    ).toBe(false);
  });

  it('strict=false returns actualPassed for enriched rows (back-compat)', () => {
    expect(
      verdictTruth(
        { verdictCode: 1, actualPassed: false, enrichmentStatus: 'ok' },
        false,
      ),
    ).toBe(false);
    expect(
      verdictTruth({
        verdictCode: 0,
        actualPassed: true,
        enrichmentStatus: 'ok',
      }),
    ).toBe(true);
  });
});
