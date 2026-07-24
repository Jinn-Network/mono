import { describe, expect, it } from 'vitest';
import {
  ciCheckFingerprint,
  classifyCiChecks,
  isCiGreen,
} from '../../src/lifecycle/ci-classifier.js';
import type { CheckSummary } from '../../src/lifecycle/types.js';

function check(over: Partial<CheckSummary> & Pick<CheckSummary, 'name'>): CheckSummary {
  return {
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    ...over,
  };
}

describe('classifyCiChecks', () => {
  it('classifies missing, pending, failed, and green', () => {
    expect(classifyCiChecks([])).toEqual({ state: 'missing' });
    expect(classifyCiChecks([
      check({ name: 'lint', status: 'IN_PROGRESS', conclusion: null }),
    ])).toMatchObject({ state: 'pending' });
    expect(classifyCiChecks([
      check({ name: 'test', conclusion: 'FAILURE' }),
    ])).toMatchObject({
      state: 'failed',
      rerunnableRunIds: [],
    });
    expect(classifyCiChecks([
      check({ name: 'test', conclusion: 'FAILURE', source: 'check-run', runId: 42 }),
    ])).toMatchObject({
      state: 'failed',
      rerunnableRunIds: [42],
    });
    expect(isCiGreen([
      check({ name: 'test' }),
      check({ name: 'lint', conclusion: 'NEUTRAL' }),
    ])).toBe(true);
  });

  it('dedupes rerunnable run ids', () => {
    const classification = classifyCiChecks([
      check({ name: 'a', conclusion: 'FAILURE', source: 'check-run', runId: 7 }),
      check({ name: 'b', conclusion: 'FAILURE', source: 'check-run', runId: 7 }),
    ]);
    expect(classification).toMatchObject({ state: 'failed', rerunnableRunIds: [7] });
  });

  it('builds a stable fingerprint', () => {
    const left = ciCheckFingerprint([
      check({ name: 'b', runId: 2 }),
      check({ name: 'a', runId: 1 }),
    ]);
    const right = ciCheckFingerprint([
      check({ name: 'a', runId: 1 }),
      check({ name: 'b', runId: 2 }),
    ]);
    expect(left).toBe(right);
  });
});
