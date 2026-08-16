import { describe, it, expect } from 'vitest';
import {
  checkMinClosedTrades,
  checkMinTradedNotional,
} from '../../../../../src/harnesses/impls/portfolio-v0-evaluator/checks/eligibility.js';

// ── checkMinClosedTrades ──────────────────────────────────────────────────────

describe('checkMinClosedTrades', () => {
  it('returns PASS when count >= required', () => {
    const check = checkMinClosedTrades(20, 20);
    expect(check.name).toBe('eligibility.min_closed_trades');
    expect(check.status).toBe('PASS');
  });

  it('returns PASS when count exceeds required', () => {
    const check = checkMinClosedTrades(50, 20);
    expect(check.status).toBe('PASS');
  });

  it('returns FAIL when count < required', () => {
    const check = checkMinClosedTrades(15, 20);
    expect(check.name).toBe('eligibility.min_closed_trades');
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatchObject({ required: 20, actual: 15 });
  });

  it('returns FAIL when count is 0', () => {
    const check = checkMinClosedTrades(0, 20);
    expect(check.status).toBe('FAIL');
  });
});

// ── checkMinTradedNotional ────────────────────────────────────────────────────

describe('checkMinTradedNotional', () => {
  it('returns PASS when multiple >= required', () => {
    const check = checkMinTradedNotional(5.0, 5.0);
    expect(check.name).toBe('eligibility.min_traded_notional');
    expect(check.status).toBe('PASS');
  });

  it('returns PASS when multiple exceeds required', () => {
    const check = checkMinTradedNotional(7.5, 5.0);
    expect(check.status).toBe('PASS');
  });

  it('returns FAIL when multiple < required', () => {
    const check = checkMinTradedNotional(3.0, 5.0);
    expect(check.name).toBe('eligibility.min_traded_notional');
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatchObject({ required: 5.0, actual: 3.0 });
  });

  it('returns FAIL when multiple is 0', () => {
    const check = checkMinTradedNotional(0, 5.0);
    expect(check.status).toBe('FAIL');
  });
});
