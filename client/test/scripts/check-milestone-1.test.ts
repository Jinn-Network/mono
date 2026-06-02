/**
 * Regression test for the recalibrated two-gate Milestone 1 criterion
 * (issue #927). The pre-2026-05-28 rule was a single per-block gate
 * (≥3 tJINN/operator/block, all 8 blocks pass). The criterion is now the AND
 * of two gates:
 *
 *   Gate 1 — per-block floor: every one of 8 UTC-aligned 6h blocks has ≥2
 *            distinct operators each earning ≥2 tJINN in that block.
 *   Gate 2 — 48h aggregate: ≥2 distinct operators each earning ≥30 tJINN
 *            across the full 48h window.
 *   MILESTONE HIT = Gate 1 AND Gate 2.
 *
 * Pure-function test: imports gate predicates + constants from the script.
 * No network, no indexer, no RPC. Importing the module must not run main()
 * (guaranteed by the entry-module guard).
 */

import { describe, expect, it } from 'vitest';
import {
  buildBlocks,
  evaluatePerBlockFloor,
  evaluateAggregate,
  PER_BLOCK_FLOOR_TJINN,
  PER_BLOCK_MIN_OPERATORS,
  AGGREGATE_TJINN,
  AGGREGATE_MIN_OPERATORS,
  type Distribution,
} from '../../scripts/check-milestone-1.js';

// 6h in seconds — must match BLOCK_SECONDS in the script.
const BLOCK_SECONDS = 6 * 3600;
const NUM_BLOCKS = 8;

// A `nowSec` pinned exactly to a 6h UTC boundary so buildBlocks produces a
// deterministic 8-block window [windowStart, windowStart + 8*BLOCK_SECONDS).
// 2026-06-01T00:00:00Z = 1780272000, which is a multiple of BLOCK_SECONDS.
const NOW_SEC = 1780272000;
const WINDOW_START = NOW_SEC - NUM_BLOCKS * BLOCK_SECONDS;

/** Timestamp inside block k (0 = oldest, 7 = newest completed). */
function tsInBlock(k: number): number {
  return WINDOW_START + k * BLOCK_SECONDS + 1;
}

let _dist = 0;
function dist(multisig: string, amount: bigint, blockIndex: number): Distribution & { tsSec: number } {
  _dist += 1;
  return {
    serviceId: `svc-${_dist}`,
    multisig: multisig.toLowerCase(),
    operatorMinted: amount,
    claimedAtBlock: BigInt(_dist),
    claimedAtTx: `0x${_dist.toString(16).padStart(64, '0')}`,
    tsSec: tsInBlock(blockIndex),
  };
}

const T2 = 2n * 10n ** 18n; // 2 tJINN
const T30 = 30n * 10n ** 18n; // 30 tJINN

/** Two distinct operators each earning `amt` in every one of the 8 blocks. */
function allBlocksTwoOps(amt: bigint, a = '0xaaa', b = '0xbbb'): Array<Distribution & { tsSec: number }> {
  const rows: Array<Distribution & { tsSec: number }> = [];
  for (let k = 0; k < NUM_BLOCKS; k++) {
    rows.push(dist(a, amt, k));
    rows.push(dist(b, amt, k));
  }
  return rows;
}

describe('constants reflect the recalibrated two-gate criterion', () => {
  it('per-block floor is 2 tJINN over ≥2 operators', () => {
    expect(PER_BLOCK_FLOOR_TJINN).toBe(2n * 10n ** 18n);
    expect(PER_BLOCK_MIN_OPERATORS).toBe(2);
  });
  it('48h aggregate is 30 tJINN over ≥2 operators', () => {
    expect(AGGREGATE_TJINN).toBe(30n * 10n ** 18n);
    expect(AGGREGATE_MIN_OPERATORS).toBe(2);
  });
});

describe('Gate 1 — per-block floor (evaluatePerBlockFloor via buildBlocks)', () => {
  it('passes when all 8 blocks have 2 operators each ≥2 tJINN', () => {
    const blocks = buildBlocks(NOW_SEC, allBlocksTwoOps(T2));
    const g1 = evaluatePerBlockFloor(blocks);
    expect(g1.passed).toBe(true);
    expect(g1.failingBlocks).toEqual([]);
  });

  it('passes when the qualifying pair differs between blocks', () => {
    const rows: Array<Distribution & { tsSec: number }> = [];
    for (let k = 0; k < NUM_BLOCKS; k++) {
      // Even blocks: a+b. Odd blocks: c+d. Each block still has 2 ops ≥2 tJINN.
      if (k % 2 === 0) {
        rows.push(dist('0xaaa', T2, k), dist('0xbbb', T2, k));
      } else {
        rows.push(dist('0xccc', T2, k), dist('0xddd', T2, k));
      }
    }
    const blocks = buildBlocks(NOW_SEC, rows);
    expect(evaluatePerBlockFloor(blocks).passed).toBe(true);
  });

  it('fails when one block has only 1 qualifying operator', () => {
    const rows = allBlocksTwoOps(T2);
    // Drop operator B's row from block 3 → only 1 qualifying op there.
    const filtered = rows.filter((r) => !(r.multisig === '0xbbb' && r.tsSec === tsInBlock(3)));
    const blocks = buildBlocks(NOW_SEC, filtered);
    const g1 = evaluatePerBlockFloor(blocks);
    expect(g1.passed).toBe(false);
    expect(g1.failingBlocks.map((b) => b.startTs)).toContain(WINDOW_START + 3 * BLOCK_SECONDS);
    expect(g1.failingBlocks).toHaveLength(1);
  });

  it('treats exactly 2 tJINN as qualified (>= boundary) — regression anchor vs old 3-tJINN floor', () => {
    // Every operator earns exactly 2 tJINN. Under the OLD 3-tJINN floor these
    // would NOT qualify and Gate 1 would fail. Under the new floor it passes.
    const blocks = buildBlocks(NOW_SEC, allBlocksTwoOps(T2));
    expect(evaluatePerBlockFloor(blocks).passed).toBe(true);
  });

  it('treats 2 tJINN − 1 wei as NOT qualified', () => {
    // Operator B earns 1 wei below the floor in block 5 → that block drops to
    // 1 qualifying operator → Gate 1 fails.
    const rows = allBlocksTwoOps(T2);
    const blocks = buildBlocks(
      NOW_SEC,
      rows.map((r) =>
        r.multisig === '0xbbb' && r.tsSec === tsInBlock(5)
          ? { ...r, operatorMinted: T2 - 1n }
          : r,
      ),
    );
    const g1 = evaluatePerBlockFloor(blocks);
    expect(g1.passed).toBe(false);
    expect(g1.failingBlocks.map((b) => b.startTs)).toContain(WINDOW_START + 5 * BLOCK_SECONDS);
  });

  it('operator-count boundary: exactly 2 passes, exactly 1 fails', () => {
    const rows: Array<Distribution & { tsSec: number }> = [];
    for (let k = 0; k < NUM_BLOCKS; k++) {
      if (k === 4) {
        // exactly 1 qualifying op
        rows.push(dist('0xaaa', T2, k));
      } else {
        // exactly 2 qualifying ops
        rows.push(dist('0xaaa', T2, k), dist('0xbbb', T2, k));
      }
    }
    const blocks = buildBlocks(NOW_SEC, rows);
    const g1 = evaluatePerBlockFloor(blocks);
    expect(g1.passed).toBe(false);
    expect(g1.failingBlocks.map((b) => b.startTs)).toEqual([WINDOW_START + 4 * BLOCK_SECONDS]);
    // every other block passed
    expect(g1.failingBlocks).toHaveLength(1);
  });
});

describe('Gate 2 — 48h aggregate (evaluateAggregate)', () => {
  const perOp = (...entries: Array<[string, bigint]>) =>
    new Map(entries.map(([m, total]) => [m.toLowerCase(), { total }]));

  it('passes with 2 operators each ≥30 tJINN', () => {
    const g2 = evaluateAggregate(perOp(['0xaaa', T30], ['0xbbb', T30 * 2n]));
    expect(g2.passed).toBe(true);
    expect(g2.qualifyingOperators).toHaveLength(2);
    const map = new Map(g2.qualifyingOperators);
    expect(map.get('0xaaa')).toBe(T30);
    expect(map.get('0xbbb')).toBe(T30 * 2n);
  });

  it('fails with only 1 operator ≥30 tJINN', () => {
    const g2 = evaluateAggregate(perOp(['0xaaa', T30], ['0xbbb', T30 - 1n]));
    expect(g2.passed).toBe(false);
    expect(g2.qualifyingOperators.map(([m]) => m)).toEqual(['0xaaa']);
  });

  it('treats exactly 30 tJINN as qualified (>= boundary)', () => {
    const g2 = evaluateAggregate(perOp(['0xaaa', T30], ['0xbbb', T30]));
    expect(g2.passed).toBe(true);
    expect(g2.qualifyingOperators).toHaveLength(2);
  });

  it('treats 30 tJINN − 1 wei as NOT qualified', () => {
    const g2 = evaluateAggregate(perOp(['0xaaa', T30 - 1n], ['0xbbb', T30 - 1n]));
    expect(g2.passed).toBe(false);
    expect(g2.qualifyingOperators).toEqual([]);
  });

  it('operator-count boundary: exactly 2 passes, exactly 1 fails', () => {
    expect(evaluateAggregate(perOp(['0xaaa', T30], ['0xbbb', T30])).passed).toBe(true);
    expect(evaluateAggregate(perOp(['0xaaa', T30], ['0xbbb', 0n])).passed).toBe(false);
  });
});

describe('MILESTONE HIT = Gate 1 AND Gate 2', () => {
  it('Gate 1 pass + Gate 2 pass → milestone hit', () => {
    // Each op earns 4 tJINN/block × 8 blocks = 32 tJINN aggregate (≥30), and
    // every block has 2 ops ≥2 tJINN.
    const amt = 4n * 10n ** 18n;
    const rows = allBlocksTwoOps(amt);
    const blocks = buildBlocks(NOW_SEC, rows);
    const perOp = new Map<string, { total: bigint }>();
    for (const b of blocks) for (const [m, a] of b.earnings) {
      perOp.set(m, { total: (perOp.get(m)?.total ?? 0n) + a });
    }
    const g1 = evaluatePerBlockFloor(blocks);
    const g2 = evaluateAggregate(perOp);
    expect(g1.passed).toBe(true);
    expect(g2.passed).toBe(true);
    expect(g1.passed && g2.passed).toBe(true);
  });

  it('Gate 1 pass + Gate 2 fail → milestone NOT hit (verdict is AND, not Gate-1-only)', () => {
    // Each op earns exactly 2 tJINN/block × 8 = 16 tJINN aggregate (<30).
    // Gate 1 passes (every block 2 ops ≥2 tJINN) but Gate 2 fails.
    const rows = allBlocksTwoOps(T2);
    const blocks = buildBlocks(NOW_SEC, rows);
    const perOp = new Map<string, { total: bigint }>();
    for (const b of blocks) for (const [m, a] of b.earnings) {
      perOp.set(m, { total: (perOp.get(m)?.total ?? 0n) + a });
    }
    const g1 = evaluatePerBlockFloor(blocks);
    const g2 = evaluateAggregate(perOp);
    expect(g1.passed).toBe(true);
    expect(g2.passed).toBe(false);
    expect(g1.passed && g2.passed).toBe(false);
  });

  it('Gate 1 fail + Gate 2 pass → milestone NOT hit', () => {
    // Two ops each earn 30 tJINN, but all in a single block → Gate 2 passes,
    // Gate 1 fails (7 of 8 blocks empty).
    const rows = [dist('0xaaa', T30, 0), dist('0xbbb', T30, 0)];
    const blocks = buildBlocks(NOW_SEC, rows);
    const perOp = new Map<string, { total: bigint }>();
    for (const b of blocks) for (const [m, a] of b.earnings) {
      perOp.set(m, { total: (perOp.get(m)?.total ?? 0n) + a });
    }
    const g1 = evaluatePerBlockFloor(blocks);
    const g2 = evaluateAggregate(perOp);
    expect(g1.passed).toBe(false);
    expect(g2.passed).toBe(true);
    expect(g1.passed && g2.passed).toBe(false);
  });
});
