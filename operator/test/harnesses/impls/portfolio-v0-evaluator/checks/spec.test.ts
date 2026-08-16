import { describe, it, expect } from 'vitest';
import {
  checkEquityReturnTarget,
  checkMaxDrawdownConstraint,
} from '../../../../../src/harnesses/impls/portfolio-v0-evaluator/checks/spec.js';

// ── checkEquityReturnTarget ───────────────────────────────────────────────────

describe('checkEquityReturnTarget', () => {
  it('returns PASS when return >= minReturnPct', () => {
    const check = checkEquityReturnTarget(5.0, 5.0);
    expect(check.name).toBe('spec.equity_return_target');
    expect(check.status).toBe('PASS');
  });

  it('returns PASS when return exceeds target', () => {
    const check = checkEquityReturnTarget(10.0, 5.0);
    expect(check.status).toBe('PASS');
  });

  it('returns FAIL when return < minReturnPct', () => {
    const check = checkEquityReturnTarget(4.9, 5.0);
    expect(check.name).toBe('spec.equity_return_target');
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatchObject({ required: 5.0, actual: 4.9 });
  });

  it('returns FAIL for negative return with positive target', () => {
    const check = checkEquityReturnTarget(-1.0, 5.0);
    expect(check.status).toBe('FAIL');
  });

  it('returns PASS for zero return with zero target', () => {
    const check = checkEquityReturnTarget(0, 0);
    expect(check.status).toBe('PASS');
  });
});

// ── checkMaxDrawdownConstraint ────────────────────────────────────────────────

describe('checkMaxDrawdownConstraint', () => {
  it('returns PASS when drawdown <= maxAllowed', () => {
    const check = checkMaxDrawdownConstraint(3.0, 5.0);
    expect(check.name).toBe('spec.max_drawdown_constraint');
    expect(check.status).toBe('PASS');
  });

  it('returns PASS when drawdown equals maxAllowed', () => {
    const check = checkMaxDrawdownConstraint(5.0, 5.0);
    expect(check.status).toBe('PASS');
  });

  it('returns FAIL when drawdown exceeds maxAllowed', () => {
    const check = checkMaxDrawdownConstraint(6.0, 5.0);
    expect(check.name).toBe('spec.max_drawdown_constraint');
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatchObject({ limit: 5.0, actual: 6.0 });
  });

  it('returns PASS for zero drawdown', () => {
    const check = checkMaxDrawdownConstraint(0, 5.0);
    expect(check.status).toBe('PASS');
  });
});
