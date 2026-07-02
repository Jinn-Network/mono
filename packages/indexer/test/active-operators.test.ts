/**
 * Tests for the shared active-operator OLAS reward window.
 *
 * Window convention: anchor `endTs` to the most-recent completed UTC 6h
 * boundary; `startTs = endTs - 8 x 6h`.
 */
import { describe, it, expect } from 'vitest';
import {
  BLOCK_SECONDS,
  BLOCK_COUNT,
  REQUIRED_OLAS_PER_BLOCK,
  MILESTONE_3_OLAS_FLOOR,
  computeActiveWindow,
  computeActiveOperators,
  countOperatorsAtMilestone3,
  selectRewardActivityRows,
} from '../src/api/active-operators.js';

const HOUR = 3600;
const SIX_H = 6 * HOUR;
const T0 = 1_700_000_000;
const OLAS = 10n ** 18n;

function alignedNow(seconds: number): number {
  return Math.floor(seconds / SIX_H) * SIX_H + 7;
}

function mkReward(multisig: string, operatorRewarded: bigint, ts: number) {
  return {
    multisig: multisig as `0x${string}`,
    operatorRewarded,
    claimedAtTimestamp: BigInt(ts),
  };
}

const OP_A = '0xaaaa000000000000000000000000000000000001' as const;
const OP_B = '0xbbbb000000000000000000000000000000000002' as const;

describe('computeActiveWindow', () => {
  it('exposes the OLAS protocol constants', () => {
    expect(BLOCK_SECONDS).toBe(6 * HOUR);
    expect(BLOCK_COUNT).toBe(8);
    expect(REQUIRED_OLAS_PER_BLOCK).toBe(3n * OLAS);
  });

  it('anchors endTs to the most-recent completed UTC 6h boundary', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    expect(w.endTs).toBe(Math.floor(now / SIX_H) * SIX_H);
    expect(w.startTs).toBe(w.endTs - SIX_H * BLOCK_COUNT);
    expect(w.blockSeconds).toBe(SIX_H);
    expect(w.blockCount).toBe(BLOCK_COUNT);
    expect(w.requiredOlasPerBlock).toBe(REQUIRED_OLAS_PER_BLOCK);
  });
});

describe('computeActiveOperators', () => {
  it('empty rewards produce no active operators and a valid window', () => {
    const now = alignedNow(T0);
    const r = computeActiveOperators([], now);
    expect(r.active.size).toBe(0);
    expect(r.sustained.size).toBe(0);
    expect(r.perOperator.size).toBe(0);
    expect(r.window.startTs).toBe(r.window.endTs - SIX_H * BLOCK_COUNT);
  });

  it('an operator with at least 3 OLAS in every block is active and sustained', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    const rewards = [];
    for (let i = 0; i < BLOCK_COUNT; i++) {
      rewards.push(mkReward(OP_A, 3n * OLAS, w.startTs + i * SIX_H + HOUR));
    }
    const r = computeActiveOperators(rewards, now);
    expect(r.active.has(OP_A)).toBe(true);
    expect(r.sustained.has(OP_A)).toBe(true);
    expect(r.perOperator.get(OP_A)?.blocks).toEqual(new Array(BLOCK_COUNT).fill(true));
    expect(r.perOperator.get(OP_A)?.blocksQualified).toBe(BLOCK_COUNT);
  });

  it('active is newest completed block liveness, not the full 48h sustained gate', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    const newestTs = w.startTs + (BLOCK_COUNT - 1) * SIX_H + HOUR;
    const r = computeActiveOperators([mkReward(OP_A, 50n * OLAS, newestTs)], now);
    expect(r.active.has(OP_A)).toBe(true);
    expect(r.sustained.has(OP_A)).toBe(false);
    expect(r.perOperator.get(OP_A)?.blocks).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it('blocks are oldest-first and reflect mixed qualifying buckets', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    const qualifying = new Set([0, 2, 4, 6, 7]);
    const rewards = [];
    for (let i = 0; i < BLOCK_COUNT; i++) {
      if (!qualifying.has(i)) continue;
      rewards.push(mkReward(OP_A, 3n * OLAS, w.startTs + i * SIX_H + HOUR));
    }
    const r = computeActiveOperators(rewards, now);
    expect(r.perOperator.get(OP_A)?.blocks).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      true,
    ]);
    expect(r.active.has(OP_A)).toBe(true);
    expect(r.sustained.has(OP_A)).toBe(false);
  });

  it('multiple reward events in one block sum to the 3 OLAS threshold', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    const rewards = [];
    for (let i = 0; i < BLOCK_COUNT; i++) {
      const ts = w.startTs + i * SIX_H + 100;
      rewards.push(mkReward(OP_A, 15n * 10n ** 17n, ts));
      rewards.push(mkReward(OP_A, 15n * 10n ** 17n, ts + 60));
    }
    const r = computeActiveOperators(rewards, now);
    expect(r.active.has(OP_A)).toBe(true);
    expect(r.sustained.has(OP_A)).toBe(true);
  });

  it('claims in the in-progress block are excluded', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    const rewards = [];
    for (let i = 0; i < BLOCK_COUNT - 1; i++) {
      rewards.push(mkReward(OP_A, 3n * OLAS, w.startTs + i * SIX_H + 100));
    }
    rewards.push(mkReward(OP_A, 100n * OLAS, w.endTs));
    const r = computeActiveOperators(rewards, now);
    expect(r.active.has(OP_A)).toBe(false);
    expect(r.sustained.has(OP_A)).toBe(false);
  });

  it('tracks distinct operators independently', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    const rewards = [];
    for (let i = 0; i < BLOCK_COUNT; i++) {
      const ts = w.startTs + i * SIX_H + 100;
      rewards.push(mkReward(OP_A, 3n * OLAS, ts));
      if (i < 5) rewards.push(mkReward(OP_B, 1n * OLAS, ts));
    }
    const r = computeActiveOperators(rewards, now);
    expect(r.active.has(OP_A)).toBe(true);
    expect(r.sustained.has(OP_A)).toBe(true);
    expect(r.active.has(OP_B)).toBe(false);
    expect(r.sustained.has(OP_B)).toBe(false);
  });
});

describe('selectRewardActivityRows', () => {
  it('uses checkpoint earned rewards once checkpoint history exists, ignoring claim-only rows', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    const claimOnlyReward = mkReward(
      OP_A,
      100n * OLAS,
      w.startTs + (BLOCK_COUNT - 1) * SIX_H + HOUR,
    );

    const selected = selectRewardActivityRows([], [claimOnlyReward], true);
    expect(selected.source).toBe('checkpoint');

    const active = computeActiveOperators(selected.rows, now);
    expect(active.active.has(OP_A)).toBe(false);
    expect(active.sustained.has(OP_A)).toBe(false);
  });

  it('falls back to claim rows only before checkpoint rows have been indexed', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    const fallbackReward = mkReward(
      OP_A,
      100n * OLAS,
      w.startTs + (BLOCK_COUNT - 1) * SIX_H + HOUR,
    );

    const selected = selectRewardActivityRows([], [fallbackReward], false);
    expect(selected.source).toBe('claim-fallback');
    expect(computeActiveOperators(selected.rows, now).active.has(OP_A)).toBe(true);
  });
});

describe('countOperatorsAtMilestone3', () => {
  it('exposes the 25 OLAS floor in wei', () => {
    expect(MILESTONE_3_OLAS_FLOOR).toBe(25n * OLAS);
  });

  it('counts distinct operators whose lifetime rewards reach at least 25 OLAS', () => {
    const n = countOperatorsAtMilestone3([
      { multisig: OP_A, operatorRewarded: 13n * OLAS },
      { multisig: OP_A, operatorRewarded: 12n * OLAS },
      { multisig: OP_B, operatorRewarded: 25n * OLAS - 1n },
    ]);
    expect(n).toBe(1);
  });
});
