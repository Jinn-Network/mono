/**
 * Tests for the shared active-operator window / qualification util.
 *
 * Window convention: anchor `endTs` to the most-recent COMPLETED UTC 6h
 * boundary; `startTs = endTs - 8 × 6h`.
 *
 * Two distinct signals (issue #926):
 *   - `active` (liveness) — earned ≥ REQUIRED_TJINN_PER_BLOCK in the NEWEST
 *     completed block (index BLOCK_COUNT-1). This is what the `Active?` column
 *     means: "earning right now."
 *   - `sustained` (Milestone-1) — earned ≥ REQUIRED_TJINN_PER_BLOCK in EVERY
 *     one of the 8 buckets. The 48h-sustained gate.
 */
import { describe, it, expect } from 'vitest';
import {
  BLOCK_SECONDS,
  BLOCK_COUNT,
  REQUIRED_TJINN_PER_BLOCK,
  computeActiveWindow,
  computeActiveOperators,
} from '../src/api/active-operators.js';

const HOUR = 3600;
const SIX_H = 6 * HOUR;
const T0 = 1_700_000_000; // arbitrary anchor; the maths is timezone-agnostic.

function alignedNow(seconds: number): number {
  // Pick a `nowSec` strictly past a 6h boundary so endTs lands on that boundary.
  return Math.floor(seconds / SIX_H) * SIX_H + 7;
}

function mkReward(multisig: string, operatorMinted: bigint, ts: number) {
  return {
    multisig: multisig as `0x${string}`,
    operatorMinted,
    claimedAtTimestamp: BigInt(ts),
  };
}

const OP_A = '0xaaaa000000000000000000000000000000000001' as const;
const OP_B = '0xbbbb000000000000000000000000000000000002' as const;

describe('computeActiveWindow', () => {
  it('exposes the protocol constants', () => {
    expect(BLOCK_SECONDS).toBe(6 * HOUR);
    expect(BLOCK_COUNT).toBe(8);
    expect(REQUIRED_TJINN_PER_BLOCK).toBe(3n * 10n ** 18n);
  });

  it('anchors endTs to the most-recent completed UTC 6h boundary', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    expect(w.endTs).toBe(Math.floor(now / SIX_H) * SIX_H);
    expect(w.startTs).toBe(w.endTs - SIX_H * BLOCK_COUNT);
    expect(w.blockSeconds).toBe(SIX_H);
    expect(w.blockCount).toBe(BLOCK_COUNT);
    expect(w.requiredTjinnPerBlock).toBe(REQUIRED_TJINN_PER_BLOCK);
  });

  it('when nowSec sits exactly on a boundary, that boundary belongs to the next (in-progress) block', () => {
    // `nowSec === boundary` — the floor produces the same boundary, so endTs ===
    // boundary. The "in-progress" block is [boundary, boundary + 6h); the just-
    // completed window stays [boundary - 8*6h, boundary).
    const boundary = Math.floor(T0 / SIX_H) * SIX_H;
    const w = computeActiveWindow(boundary);
    expect(w.endTs).toBe(boundary);
    expect(w.startTs).toBe(boundary - SIX_H * BLOCK_COUNT);
  });
});

describe('computeActiveOperators', () => {
  it('empty rewards → no active operators, valid window', () => {
    const now = alignedNow(T0);
    const r = computeActiveOperators([], now);
    expect(r.active.size).toBe(0);
    expect(r.sustained.size).toBe(0);
    expect(r.perOperator.size).toBe(0);
    expect(r.window.endTs).toBeGreaterThan(0);
    expect(r.window.startTs).toBe(r.window.endTs - SIX_H * BLOCK_COUNT);
  });

  it('an operator with ≥3 tJINN in each of the 8 blocks is active AND sustained', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    const rewards = [];
    for (let i = 0; i < BLOCK_COUNT; i++) {
      // Land each reward inside bucket i (mid-bucket for safety).
      const ts = Number(w.startTs) + i * SIX_H + HOUR;
      rewards.push(mkReward(OP_A, 3n * 10n ** 18n, ts));
    }
    const r = computeActiveOperators(rewards, now);
    expect(r.active.has(OP_A)).toBe(true);
    expect(r.sustained.has(OP_A)).toBe(true);
    expect(r.perOperator.get(OP_A)?.blocksQualified).toBe(BLOCK_COUNT);
  });

  it('exposes per-block `blocks: boolean[]` ordered oldest-first (length BLOCK_COUNT)', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    const rewards = [];
    for (let i = 0; i < BLOCK_COUNT; i++) {
      const ts = Number(w.startTs) + i * SIX_H + HOUR;
      rewards.push(mkReward(OP_A, 3n * 10n ** 18n, ts));
    }
    const r = computeActiveOperators(rewards, now);
    const entry = r.perOperator.get(OP_A);
    expect(entry?.blocks).toBeDefined();
    expect(entry?.blocks.length).toBe(BLOCK_COUNT);
    // All eight blocks qualified — every cell true. blocks[0] is OLDEST.
    expect(entry?.blocks).toEqual(new Array(BLOCK_COUNT).fill(true));
  });

  it('blocks[] reflects a mixed qualifying / non-qualifying pattern (oldest-left)', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    // Pattern: qualify buckets 0, 2, 4, 6, 7 only.
    const qualifying = new Set([0, 2, 4, 6, 7]);
    const rewards = [];
    for (let i = 0; i < BLOCK_COUNT; i++) {
      if (!qualifying.has(i)) continue;
      const ts = Number(w.startTs) + i * SIX_H + HOUR;
      rewards.push(mkReward(OP_A, 3n * 10n ** 18n, ts));
    }
    const r = computeActiveOperators(rewards, now);
    const blocks = r.perOperator.get(OP_A)?.blocks;
    // Index 0 = OLDEST, index BLOCK_COUNT-1 = NEWEST completed.
    expect(blocks).toEqual([true, false, true, false, true, false, true, true]);
    expect(r.perOperator.get(OP_A)?.blocksQualified).toBe(5);
    // Newest completed block (index 7) qualifies → active (liveness); the gaps
    // mean it is not sustained.
    expect(r.active.has(OP_A)).toBe(true);
    expect(r.sustained.has(OP_A)).toBe(false);
  });

  it('an operator that has no qualifying buckets reports blocks as all-false (still tracked)', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    // Below the floor in every block.
    const rewards = [];
    for (let i = 0; i < BLOCK_COUNT; i++) {
      const ts = Number(w.startTs) + i * SIX_H + HOUR;
      rewards.push(mkReward(OP_A, 1n * 10n ** 18n, ts));
    }
    const r = computeActiveOperators(rewards, now);
    expect(r.perOperator.get(OP_A)?.blocks).toEqual(new Array(BLOCK_COUNT).fill(false));
    expect(r.perOperator.get(OP_A)?.blocksQualified).toBe(0);
    expect(r.active.has(OP_A)).toBe(false);
    expect(r.sustained.has(OP_A)).toBe(false);
  });

  it('exactly 3 tJINN qualifies (>=, not >)', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    const rewards = [];
    for (let i = 0; i < BLOCK_COUNT; i++) {
      const ts = Number(w.startTs) + i * SIX_H + 100;
      rewards.push(mkReward(OP_A, REQUIRED_TJINN_PER_BLOCK, ts));
    }
    const r = computeActiveOperators(rewards, now);
    expect(r.active.has(OP_A)).toBe(true);
  });

  it('multiple claims summing within one block qualify that block', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    const rewards = [];
    for (let i = 0; i < BLOCK_COUNT; i++) {
      const ts = Number(w.startTs) + i * SIX_H + 100;
      // Two half-claims that sum to exactly 3 tJINN.
      rewards.push(mkReward(OP_A, 15n * 10n ** 17n, ts));
      rewards.push(mkReward(OP_A, 15n * 10n ** 17n, ts + 60));
    }
    const r = computeActiveOperators(rewards, now);
    expect(r.active.has(OP_A)).toBe(true);
    expect(r.perOperator.get(OP_A)?.blocksQualified).toBe(BLOCK_COUNT);
  });

  it('missing only the oldest block → active (newest present) but not sustained', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    const rewards = [];
    // Fill 7 blocks (indexes 1..7), skip 0.
    for (let i = 1; i < BLOCK_COUNT; i++) {
      const ts = Number(w.startTs) + i * SIX_H + 100;
      rewards.push(mkReward(OP_A, 3n * 10n ** 18n, ts));
    }
    const r = computeActiveOperators(rewards, now);
    expect(r.active.has(OP_A)).toBe(true);
    expect(r.sustained.has(OP_A)).toBe(false);
    expect(r.perOperator.get(OP_A)?.blocksQualified).toBe(BLOCK_COUNT - 1);
  });

  it('missing the newest completed block → neither active nor sustained', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    const rewards = [];
    // Fill 7 blocks (indexes 0..6), skip BLOCK_COUNT-1 (newest completed).
    for (let i = 0; i < BLOCK_COUNT - 1; i++) {
      const ts = Number(w.startTs) + i * SIX_H + 100;
      rewards.push(mkReward(OP_A, 3n * 10n ** 18n, ts));
    }
    const r = computeActiveOperators(rewards, now);
    expect(r.active.has(OP_A)).toBe(false);
    expect(r.sustained.has(OP_A)).toBe(false);
    expect(r.perOperator.get(OP_A)?.blocksQualified).toBe(BLOCK_COUNT - 1);
  });

  it('claims inside the in-progress block (>= endTs) are excluded', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    const rewards = [];
    // 8 qualifying blocks AND one extra claim at endTs (the in-progress block).
    for (let i = 0; i < BLOCK_COUNT; i++) {
      const ts = Number(w.startTs) + i * SIX_H + 100;
      rewards.push(mkReward(OP_A, 3n * 10n ** 18n, ts));
    }
    rewards.push(mkReward(OP_A, 100n * 10n ** 18n, Number(w.endTs)));
    rewards.push(mkReward(OP_A, 100n * 10n ** 18n, Number(w.endTs) + 500));
    const r = computeActiveOperators(rewards, now);
    // Still active off the 8 inside-window blocks; the in-progress ones don't
    // count toward a 9th block (no such block).
    expect(r.active.has(OP_A)).toBe(true);
    expect(r.sustained.has(OP_A)).toBe(true);
    expect(r.perOperator.get(OP_A)?.blocksQualified).toBe(BLOCK_COUNT);
  });

  it('claims older than the window are excluded', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    const rewards = [];
    // Blocks 0..6 in-window + a fat pre-window claim. Newest block (7) empty →
    // neither active nor sustained; the pre-window claim must not leak in.
    for (let i = 0; i < BLOCK_COUNT - 1; i++) {
      const ts = Number(w.startTs) + i * SIX_H + 100;
      rewards.push(mkReward(OP_A, 3n * 10n ** 18n, ts));
    }
    rewards.push(mkReward(OP_A, 1000n * 10n ** 18n, Number(w.startTs) - 1));
    const r = computeActiveOperators(rewards, now);
    expect(r.active.has(OP_A)).toBe(false);
    expect(r.sustained.has(OP_A)).toBe(false);
  });

  it('boundary case: nowSec exactly at a 6h boundary keeps the just-completed window', () => {
    const boundary = Math.floor(T0 / SIX_H) * SIX_H;
    const rewards = [];
    for (let i = 0; i < BLOCK_COUNT; i++) {
      const ts = boundary - SIX_H * BLOCK_COUNT + i * SIX_H + 100;
      rewards.push(mkReward(OP_A, 3n * 10n ** 18n, ts));
    }
    const r = computeActiveOperators(rewards, boundary);
    expect(r.window.endTs).toBe(boundary);
    expect(r.window.startTs).toBe(boundary - SIX_H * BLOCK_COUNT);
    expect(r.active.has(OP_A)).toBe(true);
    expect(r.sustained.has(OP_A)).toBe(true);
  });

  it('tracks distinct operators independently — only the qualifier is active', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    const rewards = [];
    for (let i = 0; i < BLOCK_COUNT; i++) {
      const ts = Number(w.startTs) + i * SIX_H + 100;
      rewards.push(mkReward(OP_A, 3n * 10n ** 18n, ts));
      // OP_B only fills 5 buckets, under-funded.
      if (i < 5) rewards.push(mkReward(OP_B, 1n * 10n ** 18n, ts));
    }
    const r = computeActiveOperators(rewards, now);
    expect(r.active.has(OP_A)).toBe(true);
    expect(r.sustained.has(OP_A)).toBe(true);
    expect(r.active.has(OP_B)).toBe(false);
    expect(r.sustained.has(OP_B)).toBe(false);
    expect(r.perOperator.get(OP_A)?.blocksQualified).toBe(BLOCK_COUNT);
    expect(r.perOperator.get(OP_B)?.blocksQualified).toBe(0);
  });

  // ── #926: `active` (liveness) vs `sustained` (M1) split ────────────────────

  it('active (liveness) = "newest completed block qualifies" — a single block lights it up', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    // Only the newest completed block (index BLOCK_COUNT-1) clears the floor —
    // the real-world "[. . . . . . . T]" case after a relayer backlog dump.
    const ts = Number(w.startTs) + (BLOCK_COUNT - 1) * SIX_H + HOUR;
    const r = computeActiveOperators([mkReward(OP_A, 50n * 10n ** 18n, ts)], now);
    expect(r.active.has(OP_A)).toBe(true);
    expect(r.sustained.has(OP_A)).toBe(false);
    expect(r.perOperator.get(OP_A)?.blocksQualified).toBe(1);
    expect(r.perOperator.get(OP_A)?.blocks[BLOCK_COUNT - 1]).toBe(true);
  });

  it('sustained requires every block; active does not (one mid-window gap)', () => {
    const now = alignedNow(T0);
    const w = computeActiveWindow(now);
    const rewards = [];
    // Fill all but one middle block (index 3); the newest block is present.
    for (let i = 0; i < BLOCK_COUNT; i++) {
      if (i === 3) continue;
      const ts = Number(w.startTs) + i * SIX_H + HOUR;
      rewards.push(mkReward(OP_A, 3n * 10n ** 18n, ts));
    }
    const r = computeActiveOperators(rewards, now);
    expect(r.active.has(OP_A)).toBe(true);
    expect(r.sustained.has(OP_A)).toBe(false);
    expect(r.perOperator.get(OP_A)?.blocksQualified).toBe(BLOCK_COUNT - 1);
  });
});
