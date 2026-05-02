import { describe, it, expect } from 'vitest';
import { checkQuestionKindSupported } from '../../../../../src/harnesses/impls/prediction-v0-evaluator/checks/spec.js';

describe('spec.question_kind_supported', () => {
  it('PASS on threshold with GT/GTE/LT/LTE', () => {
    for (const op of ['GT', 'GTE', 'LT', 'LTE'] as const) {
      expect(checkQuestionKindSupported({ kind: 'threshold', operator: op, threshold: '1', resolveTs: 0 }).status).toBe('PASS');
    }
  });
  it('PASS on range', () => {
    expect(checkQuestionKindSupported({ kind: 'range', lowerBound: '0', upperBound: '1', resolveTs: 0 }).status).toBe('PASS');
  });
  it('FAIL on unknown kind', () => {
    expect(checkQuestionKindSupported({ kind: 'unknown', resolveTs: 0 } as any).status).toBe('FAIL');
  });
});
