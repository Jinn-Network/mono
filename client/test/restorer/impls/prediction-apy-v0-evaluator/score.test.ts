import { describe, expect, it } from 'vitest';
import { computeScore } from '../../../../src/restorer/impls/prediction-apy-v0-evaluator/score.js';

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
});
