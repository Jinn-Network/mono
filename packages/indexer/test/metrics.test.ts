/**
 * Tests for src/api/metrics.ts — pure aggregation/shaper helpers for the
 * /explorer/* routes. These functions have no I/O dependencies; all inputs
 * are synthetic.
 */
import { describe, it, expect } from 'vitest';
import {
  verdictResolvedRate,
  attemptFinalization,
  bucketResolvedRate,
  rollingResolvedRate,
  rankLeaderboard,
  freshness,
  type LeaderboardRow,
} from '../src/api/metrics.js';

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

// ── attemptFinalization ───────────────────────────────────────────────────────

describe('attemptFinalization', () => {
  it('not finalized when verdicts array is empty', () => {
    expect(attemptFinalization([], 2)).toEqual({ finalized: false, passed: false });
  });

  it('not finalized when requiredVerdicts is 0', () => {
    expect(attemptFinalization([{ verdictCode: 1 }], 0)).toEqual({ finalized: false, passed: false });
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
    settledContribution: 0.8,
    verdictsTotal: 5,
    verdictsPass: 4,
    resolvedRate: 0.8,
    jinnEarned: 1000n,
    ...overrides,
  });

  it('partitions rows into ranked (>= minResolvedAttempts) and lowVolume (< min)', () => {
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

  it('assigns rank 1..N to the ranked group', () => {
    const rows = [
      makeRow({ operator: '0xAAA' as `0x${string}`, verdictsTotal: 10, resolvedRate: 0.9 }),
      makeRow({ operator: '0xBBB' as `0x${string}`, verdictsTotal: 10, resolvedRate: 0.7 }),
      makeRow({ operator: '0xCCC' as `0x${string}`, verdictsTotal: 10, resolvedRate: 0.5 }),
    ];
    const { ranked } = rankLeaderboard(rows, 5);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('sorts ranked by resolvedRate desc', () => {
    const rows = [
      makeRow({ operator: '0xAAA' as `0x${string}`, verdictsTotal: 10, resolvedRate: 0.5 }),
      makeRow({ operator: '0xBBB' as `0x${string}`, verdictsTotal: 10, resolvedRate: 0.9 }),
    ];
    const { ranked } = rankLeaderboard(rows, 5);
    expect(ranked[0].operator).toBe('0xBBB');
    expect(ranked[1].operator).toBe('0xAAA');
  });

  it('null resolvedRate sorts after any numeric rate', () => {
    const rows = [
      makeRow({ operator: '0xAAA' as `0x${string}`, verdictsTotal: 10, resolvedRate: null }),
      makeRow({ operator: '0xBBB' as `0x${string}`, verdictsTotal: 10, resolvedRate: 0.1 }),
    ];
    const { ranked } = rankLeaderboard(rows, 5);
    expect(ranked[0].operator).toBe('0xBBB');
    expect(ranked[1].operator).toBe('0xAAA');
  });

  it('ties in resolvedRate are broken by attempts desc', () => {
    const rows = [
      makeRow({ operator: '0xAAA' as `0x${string}`, verdictsTotal: 10, resolvedRate: 0.8, attempts: 5 }),
      makeRow({ operator: '0xBBB' as `0x${string}`, verdictsTotal: 10, resolvedRate: 0.8, attempts: 10 }),
    ];
    const { ranked } = rankLeaderboard(rows, 5);
    expect(ranked[0].operator).toBe('0xBBB');
    expect(ranked[1].operator).toBe('0xAAA');
  });

  it('ties in attempts are broken by operator asc (lexicographic)', () => {
    const rows = [
      makeRow({ operator: '0xBBB' as `0x${string}`, verdictsTotal: 10, resolvedRate: 0.8, attempts: 5 }),
      makeRow({ operator: '0xAAA' as `0x${string}`, verdictsTotal: 10, resolvedRate: 0.8, attempts: 5 }),
    ];
    const { ranked } = rankLeaderboard(rows, 5);
    expect(ranked[0].operator).toBe('0xAAA');
    expect(ranked[1].operator).toBe('0xBBB');
  });

  it('lowVolume group is also sorted by the same criteria (no rank field)', () => {
    const rows = [
      makeRow({ operator: '0xBBB' as `0x${string}`, verdictsTotal: 1, resolvedRate: 0.9 }),
      makeRow({ operator: '0xAAA' as `0x${string}`, verdictsTotal: 1, resolvedRate: 0.9, attempts: 20 }),
    ];
    const { lowVolume } = rankLeaderboard(rows, 5);
    // Both null/< min, sorted by attempts desc then operator asc
    expect(lowVolume[0].operator).toBe('0xAAA');
    expect(lowVolume[1].operator).toBe('0xBBB');
    // No rank property on lowVolume entries
    expect((lowVolume[0] as unknown as Record<string, unknown>)['rank']).toBeUndefined();
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

  it('minResolvedAttempts = 0 puts all rows in ranked', () => {
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
