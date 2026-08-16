import { describe, it, expect } from 'vitest';
import { checkSubmissionWithinWindow } from '../../../../../src/harnesses/impls/prediction-v0-evaluator/checks/eligibility.js';

describe('eligibility.submission_within_window', () => {
  const window = { startTs: 1000, endTs: 4600 };
  it('PASS when submittedAt is within window', () => {
    expect(checkSubmissionWithinWindow(2000, window).status).toBe('PASS');
    expect(checkSubmissionWithinWindow(1000, window).status).toBe('PASS');
    expect(checkSubmissionWithinWindow(4600, window).status).toBe('PASS');
  });
  it('FAIL when submittedAt is outside window', () => {
    expect(checkSubmissionWithinWindow(999, window).status).toBe('FAIL');
    expect(checkSubmissionWithinWindow(4601, window).status).toBe('FAIL');
  });
});
