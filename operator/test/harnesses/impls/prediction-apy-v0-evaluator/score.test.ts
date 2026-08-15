import { describe, expect, it } from 'vitest';
import { computeScore } from '../../../../src/harnesses/impls/prediction-apy-v0-evaluator/score.js';

describe('prediction-apy-v0 evaluator score', () => {
  it('returns max score for perfect match', () => {
    const out = computeScore('PASS', '450', '450', 50);
    expect(out.score).toBe('1000000000000000000');
    expect(out.errorBps).toBe('0');
  });

  it('returns zero for non-pass verdicts', () => {
    const out = computeScore('REJECTED', '450', '430', 50);
    expect(out.score).toBe('0');
  });

  it('returns zero when error meets tolerance (boundary)', () => {
    const out = computeScore('PASS', '500', '450', 50);
    expect(out.errorBps).toBe('50');
    expect(out.score).toBe('0');
  });

  it('returns partial score inside band', () => {
    const out = computeScore('PASS', '470', '450', 100);
    expect(out.errorBps).toBe('20');
    expect(out.score).toBe('800000000000000000');
  });

  it('returns zero for INDETERMINATE even with low error', () => {
    const out = computeScore('INDETERMINATE', '100', '100', 50);
    expect(out.score).toBe('0');
  });
});
