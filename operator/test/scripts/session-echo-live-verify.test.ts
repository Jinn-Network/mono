import { describe, expect, it } from 'vitest';
import {
  requireCurrentEvaluatorEnableContract,
} from '../../scripts/session-echo-live-verify.js';

describe('session-echo live verifier evaluator contract gate', () => {
  it('surfaces the production re-enable instruction on a stale contract', () => {
    expect(() => requireCurrentEvaluatorEnableContract({
      ok: false,
      reason: 'swe-rebench-v2 evaluator enable state requires durable bundle repair',
      nextStep: 'Run `jinn harnesses enable swe-rebench-v2-evaluator`.',
    })).toThrow(/jinn harnesses enable swe-rebench-v2-evaluator/);
  });

  it('returns only the validated managed checkout for a current contract', () => {
    expect(requireCurrentEvaluatorEnableContract({
      ok: true,
      upstreamRepoDir: '/managed/impl-state/upstream',
    })).toBe('/managed/impl-state/upstream');
  });
});
