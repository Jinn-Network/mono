import { describe, it, expect } from 'vitest';
import {
  deriveSolveOutcome,
  deriveEvaluateOutcome,
  SOLVE_OUTCOME_QUORUM,
  type VerdictTally,
} from '../../src/api/run-outcome.js';

const tally = (pass: number, fail: number): VerdictTally => ({ pass, fail });

describe('SOLVE_OUTCOME_QUORUM', () => {
  it('is a strict-majority 0.5', () => {
    expect(SOLVE_OUTCOME_QUORUM).toBe(0.5);
  });
});

describe('deriveSolveOutcome', () => {
  it('returns null for a non-COMPLETE run', () => {
    expect(deriveSolveOutcome('RUNNING', tally(2, 0))).toBeNull();
    expect(deriveSolveOutcome('FAILED', tally(2, 0))).toBeNull();
    expect(deriveSolveOutcome('RACE_LOST', tally(2, 0))).toBeNull();
  });

  it('returns awaiting for a COMPLETE run with no verdicts', () => {
    expect(deriveSolveOutcome('COMPLETE', undefined)).toBe('awaiting');
    expect(deriveSolveOutcome('COMPLETE', tally(0, 0))).toBe('awaiting');
  });

  it('returns pass when passes strictly exceed half the resolved verdicts', () => {
    expect(deriveSolveOutcome('COMPLETE', tally(2, 1))).toBe('pass');
  });

  it('returns fail when fails strictly exceed half the resolved verdicts', () => {
    expect(deriveSolveOutcome('COMPLETE', tally(1, 2))).toBe('fail');
  });

  it('returns awaiting on a tie', () => {
    expect(deriveSolveOutcome('COMPLETE', tally(1, 1))).toBe('awaiting');
  });
});

describe('deriveEvaluateOutcome', () => {
  it('returns null for a non-COMPLETE run', () => {
    expect(deriveEvaluateOutcome('RUNNING', true, tally(2, 0))).toBeNull();
    expect(deriveEvaluateOutcome('RACE_LOST', false, tally(0, 2))).toBeNull();
  });

  it('returns awaiting before consensus, on unknown operator verdict, or on a tie', () => {
    expect(deriveEvaluateOutcome('COMPLETE', true, undefined)).toBe('awaiting');
    expect(deriveEvaluateOutcome('COMPLETE', true, tally(0, 0))).toBe('awaiting');
    expect(deriveEvaluateOutcome('COMPLETE', undefined, tally(2, 0))).toBe('awaiting');
    expect(deriveEvaluateOutcome('COMPLETE', true, tally(1, 1))).toBe('awaiting');
  });

  it('returns accepted when the operator agrees with the majority pole', () => {
    // majority PASS pole, operator passed → agrees
    expect(deriveEvaluateOutcome('COMPLETE', true, tally(2, 0))).toBe('accepted');
    // majority FAIL pole, operator failed → agrees
    expect(deriveEvaluateOutcome('COMPLETE', false, tally(0, 2))).toBe('accepted');
  });

  it('returns rejected when the operator disagrees with the majority pole', () => {
    // majority PASS pole, operator failed → outlier
    expect(deriveEvaluateOutcome('COMPLETE', false, tally(2, 0))).toBe('rejected');
    // majority FAIL pole, operator passed → outlier
    expect(deriveEvaluateOutcome('COMPLETE', true, tally(0, 2))).toBe('rejected');
  });
});
