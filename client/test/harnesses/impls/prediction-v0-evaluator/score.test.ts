import { describe, it, expect } from 'vitest';
import { computeScore, SCORE_BASIS, SCORE_VERSION } from '../../../../src/harnesses/impls/prediction-v0-evaluator/score.js';

describe('computeScore', () => {
  it('PASS with correct prediction scores 0.7975 × 1e18 for p=0.55 YES', () => {
    const { score, scoreBasis, scoreVersion } = computeScore('PASS', '0.55', 'YES');
    expect(score).toBe('797500000000000000');
    expect(scoreBasis).toBe(SCORE_BASIS);
    expect(scoreVersion).toBe(SCORE_VERSION);
  });
  it('non-PASS verdicts score 0', () => {
    expect(computeScore('FAIL', '0.55', 'YES').score).toBe('0');
    expect(computeScore('REJECTED', '0.55', 'YES').score).toBe('0');
    expect(computeScore('INDETERMINATE', '0.55', 'YES').score).toBe('0');
  });
});
