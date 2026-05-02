import { describe, it, expect } from 'vitest';
import {
  checkHlReachable,
  checkPreSnapshotRederivable,
  checkFillsRederivable,
  checkPostSnapshotFundingAccrual,
} from '../../../../../src/harnesses/impls/portfolio-v0-evaluator/checks/availability.js';
import type { HlGridPoint } from '../../../../../src/venues/hyperliquid/types.js';

// ── checkHlReachable ──────────────────────────────────────────────────────────

describe('checkHlReachable', () => {
  it('returns PASS when reachable', () => {
    const check = checkHlReachable(true);
    expect(check.name).toBe('availability.hyperliquid_reachable');
    expect(check.status).toBe('PASS');
  });

  it('returns FAIL when not reachable', () => {
    const check = checkHlReachable(false, 'timeout');
    expect(check.name).toBe('availability.hyperliquid_reachable');
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('timeout');
  });

  it('uses default error message when none provided', () => {
    const check = checkHlReachable(false);
    expect(check.status).toBe('FAIL');
    expect(typeof check.detail).toBe('string');
  });
});

// ── checkPreSnapshotRederivable ───────────────────────────────────────────────

describe('checkPreSnapshotRederivable', () => {
  const grid: HlGridPoint[] = [
    [1000, '10000'],
    [2000, '10500'],
    [3000, '11000'],
  ];

  it('returns PASS when preTs is bracketed', () => {
    const check = checkPreSnapshotRederivable(grid, 1500);
    expect(check.name).toBe('availability.hl_pre_snapshot_rederivable');
    expect(check.status).toBe('PASS');
  });

  it('returns PASS when preTs equals a grid point (bracket: that point + next)', () => {
    const check = checkPreSnapshotRederivable(grid, 1000);
    expect(check.status).toBe('PASS');
  });

  it('returns FAIL when preTs is before all grid points', () => {
    const check = checkPreSnapshotRederivable(grid, 500);
    expect(check.name).toBe('availability.hl_pre_snapshot_rederivable');
    expect(check.status).toBe('FAIL');
  });

  it('returns FAIL when preTs is at or after the last grid point', () => {
    const check = checkPreSnapshotRederivable(grid, 3000);
    expect(check.status).toBe('FAIL');
  });

  it('returns FAIL for empty grid', () => {
    const check = checkPreSnapshotRederivable([], 1500);
    expect(check.status).toBe('FAIL');
  });
});

// ── checkFillsRederivable ─────────────────────────────────────────────────────

describe('checkFillsRederivable', () => {
  it('returns PASS when not clamped', () => {
    const check = checkFillsRederivable(false);
    expect(check.name).toBe('availability.hl_fills_rederivable');
    expect(check.status).toBe('PASS');
  });

  it('returns FAIL when clamped', () => {
    const check = checkFillsRederivable(true);
    expect(check.name).toBe('availability.hl_fills_rederivable');
    expect(check.status).toBe('FAIL');
    expect(typeof check.detail).toBe('string');
  });
});

// ── checkPostSnapshotFundingAccrual ───────────────────────────────────────────

describe('checkPostSnapshotFundingAccrual', () => {
  const endTs = 1_000_000;

  it('returns PASS when postCapturedAt <= endTs + 60s', () => {
    const check = checkPostSnapshotFundingAccrual(endTs + 30_000, endTs);
    expect(check.name).toBe('availability.hl_post_snapshot_rederivable');
    expect(check.status).toBe('PASS');
  });

  it('returns PASS when postCapturedAt exactly equals endTs + 60s', () => {
    const check = checkPostSnapshotFundingAccrual(endTs + 60_000, endTs);
    expect(check.status).toBe('PASS');
  });

  it('returns SKIP when postCapturedAt > endTs + 60s', () => {
    const check = checkPostSnapshotFundingAccrual(endTs + 61_000, endTs);
    expect(check.name).toBe('availability.hl_post_snapshot_rederivable');
    expect(check.status).toBe('SKIP');
    expect(typeof check.detail).toBe('string');
  });

  it('returns PASS when postCapturedAt is before endTs', () => {
    const check = checkPostSnapshotFundingAccrual(endTs - 100, endTs);
    expect(check.status).toBe('PASS');
  });
});
