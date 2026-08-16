import { describe, it, expect, vi, beforeEach } from 'vitest';

// The evaluator-enabled check must fire before any inference. Force it absent.
vi.mock('../../src/harnesses/impls/swe-rebench-v2-evaluator/harness.js', () => ({
  readEnabledState: () => null,
  defaultSweRebenchV2EvaluatorImplStateDir: () => '/tmp/nope',
}));

describe('runScreenHeldOut preconditions', () => {
  beforeEach(() => vi.resetModules());
  it('fails loud with an actionable message when the evaluator is not enabled', async () => {
    const { runScreenHeldOut } = await import('../../src/eval/screen-runner.js');
    await expect(
      runScreenHeldOut({ R: 3, heldOutCount: 10, maxCandidates: 60, perRepoCap: 3 }),
    ).rejects.toThrow(/jinn harnesses enable swe-rebench-v2-evaluator/);
  });
});
