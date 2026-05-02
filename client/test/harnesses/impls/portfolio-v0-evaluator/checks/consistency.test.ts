import { describe, it, expect } from 'vitest';
import {
  checkPreSnapshot,
  checkPostSnapshot,
  checkFills,
  checkGatingEquityReturn,
  checkGatingMaxDrawdown,
  checkGatingClosedTrades,
  checkGatingTradedNotional,
} from '../../../../../src/harnesses/impls/portfolio-v0-evaluator/checks/consistency.js';
import { makeFill, makePayload, makeUnifiedPayload } from '../test-helpers.js';

// ── checkPreSnapshot ──────────────────────────────────────────────────────────

describe('checkPreSnapshot', () => {
  it('returns PASS when accountValues match within tolerance (exact)', () => {
    const check = checkPreSnapshot(
      makePayload('10000'),
      { capturedAt: 1000, payload: makePayload('10000') },
    );
    expect(check.name).toBe('consistency.pre_snapshot');
    expect(check.status).toBe('PASS');
  });

  it('returns PASS when within 0.01% relative tolerance', () => {
    // 0.01% of 10000 = 1 → diff of 0.5 is within tolerance
    const check = checkPreSnapshot(
      makePayload('10000'),
      { capturedAt: 1000, payload: makePayload('10000.5') },
    );
    expect(check.status).toBe('PASS');
  });

  it('returns FAIL when difference exceeds tolerance', () => {
    // 0.01% of 10000 = 1; diff = 5 → FAIL
    const check = checkPreSnapshot(
      makePayload('10000'),
      { capturedAt: 1000, payload: makePayload('10005') },
    );
    expect(check.name).toBe('consistency.pre_snapshot');
    expect(check.status).toBe('FAIL');
  });

  it('returns SKIP when rederived is null', () => {
    const check = checkPreSnapshot(makePayload('10000'), null);
    expect(check.status).toBe('SKIP');
  });

  it('returns SKIP when payload lacks accountValue', () => {
    const check = checkPreSnapshot(
      { other: 'data' },
      { capturedAt: 1000, payload: makePayload('10000') },
    );
    expect(check.status).toBe('SKIP');
  });

  it('uses 0.0001 absolute floor for small values', () => {
    // For value=0.001, 0.01% = 0.0000001, floor=0.0001
    // diff=0.00005 → within 0.0001 → PASS
    const check = checkPreSnapshot(
      makePayload('0.001'),
      { capturedAt: 1000, payload: makePayload('0.00105') },
    );
    // absDiff = 0.00005, effectiveTol = max(0.001*0.0001, 0.0001) = 0.0001
    // 0.00005 <= 0.0001 → PASS
    expect(check.status).toBe('PASS');
  });

  it('extracts the unified accountValue from the new snapshot payload shape', () => {
    // Claimed (from harness): new unified shape, accountValue='1012.11' while
    // perps=0 and spot USDC=1012.11. Rederived (from HL portfolio grid): legacy
    // { marginSummary: { accountValue } } shape with the same unified value.
    const check = checkPreSnapshot(
      makeUnifiedPayload('1012.11', { perps: '0', spotUsdc: '1012.11' }),
      { capturedAt: 1000, payload: makePayload('1012.11') },
    );
    expect(check.status).toBe('PASS');
  });
});

// ── checkPostSnapshot ─────────────────────────────────────────────────────────

describe('checkPostSnapshot', () => {
  it('returns PASS when values match', () => {
    const check = checkPostSnapshot(
      makePayload('11000'),
      { capturedAt: 2000, payload: makePayload('11000') },
    );
    expect(check.name).toBe('consistency.post_snapshot');
    expect(check.status).toBe('PASS');
  });

  it('returns SKIP when rederived is null', () => {
    const check = checkPostSnapshot(makePayload('11000'), null);
    expect(check.status).toBe('SKIP');
  });

  it('returns FAIL when values diverge beyond tolerance', () => {
    const check = checkPostSnapshot(
      makePayload('11000'),
      { capturedAt: 2000, payload: makePayload('11100') },
    );
    // diff=100, 0.01% of 11000=1.1, max(1.1,0.0001)=1.1; 100 > 1.1 → FAIL
    expect(check.status).toBe('FAIL');
  });
});

// ── checkFills ────────────────────────────────────────────────────────────────

describe('checkFills', () => {
  const fill1 = makeFill({ tid: 1, px: '50000', sz: '0.01' });
  const fill2 = makeFill({ tid: 2, px: '51000', sz: '0.02' });

  it('returns PASS when fills match exactly by tid and fields', () => {
    const check = checkFills([fill1, fill2], [fill1, fill2]);
    expect(check.name).toBe('consistency.fills');
    expect(check.status).toBe('PASS');
  });

  it('returns PASS with reordered fills (set match)', () => {
    const check = checkFills([fill1, fill2], [fill2, fill1]);
    expect(check.status).toBe('PASS');
  });

  it('returns FAIL when claimed has extra tid not in rederived', () => {
    const fill3 = makeFill({ tid: 3 });
    const check = checkFills([fill1, fill2, fill3], [fill1, fill2]);
    expect(check.status).toBe('FAIL');
    const detail = check.detail as Record<string, unknown>;
    expect((detail.missingInRederived as number[]).includes(3)).toBe(true);
  });

  it('returns FAIL when rederived has extra tid not in claimed', () => {
    const fill3 = makeFill({ tid: 3 });
    const check = checkFills([fill1], [fill1, fill3]);
    expect(check.status).toBe('FAIL');
    const detail = check.detail as Record<string, unknown>;
    expect((detail.extraInRederived as number[]).includes(3)).toBe(true);
  });

  it('returns FAIL when per-fill field differs', () => {
    const fill1Modified = makeFill({ tid: 1, px: '49999' }); // different px
    const check = checkFills([fill1], [fill1Modified]);
    expect(check.status).toBe('FAIL');
    const detail = check.detail as Record<string, unknown>;
    const mismatches = detail.fieldMismatches as Array<{ field: string }>;
    expect(mismatches.some((m) => m.field === 'px')).toBe(true);
  });

  it('returns PASS for empty fills on both sides', () => {
    const check = checkFills([], []);
    expect(check.status).toBe('PASS');
  });
});

// ── checkGatingEquityReturn ───────────────────────────────────────────────────

describe('checkGatingEquityReturn', () => {
  it('returns PASS when within 0.05% absolute tolerance', () => {
    // claimed=5.0, rederived=5.03 → diff=0.03 <= 0.05
    const check = checkGatingEquityReturn('5.0', 5.03);
    expect(check.name).toBe('consistency.gating.equity_return');
    expect(check.status).toBe('PASS');
  });

  it('returns FAIL when difference exceeds 0.05% absolute', () => {
    // claimed=5.0, rederived=5.1 → diff=0.1 > 0.05
    const check = checkGatingEquityReturn('5.0', 5.1);
    expect(check.status).toBe('FAIL');
  });

  it('returns FAIL when claimed is not a number', () => {
    const check = checkGatingEquityReturn('NaN', 5.0);
    expect(check.status).toBe('FAIL');
  });

  it('returns PASS for exact match', () => {
    const check = checkGatingEquityReturn('10.0', 10.0);
    expect(check.status).toBe('PASS');
  });
});

// ── checkGatingMaxDrawdown ────────────────────────────────────────────────────

describe('checkGatingMaxDrawdown', () => {
  it('returns PASS within 0.05% absolute tolerance', () => {
    const check = checkGatingMaxDrawdown('3.0', 3.04);
    expect(check.name).toBe('consistency.gating.max_drawdown');
    expect(check.status).toBe('PASS');
  });

  it('returns FAIL when difference exceeds tolerance', () => {
    const check = checkGatingMaxDrawdown('3.0', 3.1);
    expect(check.status).toBe('FAIL');
  });

  it('returns FAIL for non-numeric claimed', () => {
    const check = checkGatingMaxDrawdown('invalid', 3.0);
    expect(check.status).toBe('FAIL');
  });
});

// ── checkGatingClosedTrades ───────────────────────────────────────────────────

describe('checkGatingClosedTrades', () => {
  it('returns PASS when exact match', () => {
    const check = checkGatingClosedTrades(25, 25);
    expect(check.name).toBe('consistency.gating.closed_trades');
    expect(check.status).toBe('PASS');
  });

  it('returns FAIL when counts differ by 1', () => {
    const check = checkGatingClosedTrades(25, 26);
    expect(check.status).toBe('FAIL');
  });

  it('returns FAIL when counts differ (any amount)', () => {
    const check = checkGatingClosedTrades(0, 5);
    expect(check.status).toBe('FAIL');
  });
});

// ── checkGatingTradedNotional ─────────────────────────────────────────────────

describe('checkGatingTradedNotional', () => {
  it('returns PASS within 0.05% relative tolerance', () => {
    // claimed=5.0, rederived=5.002 → diff=0.002, rel_tol=5.0*0.0005=0.0025
    // 0.002 <= 0.0025 → PASS
    const check = checkGatingTradedNotional('5.0', 5.002);
    expect(check.name).toBe('consistency.gating.traded_notional');
    expect(check.status).toBe('PASS');
  });

  it('returns FAIL when difference exceeds 0.05% relative tolerance', () => {
    // claimed=5.0, rederived=5.1 → diff=0.1, rel_tol=5.0*0.0005=0.0025
    // 0.1 > 0.0025 → FAIL
    const check = checkGatingTradedNotional('5.0', 5.1);
    expect(check.status).toBe('FAIL');
  });

  it('returns FAIL for non-numeric claimed', () => {
    const check = checkGatingTradedNotional('abc', 5.0);
    expect(check.status).toBe('FAIL');
  });

  it('returns PASS for exact match', () => {
    const check = checkGatingTradedNotional('7.5', 7.5);
    expect(check.status).toBe('PASS');
  });
});
