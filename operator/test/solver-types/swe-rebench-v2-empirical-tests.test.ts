import { describe, expect, it, vi } from 'vitest';
import {
  runEmpiricalTestDerivation,
  runTargetedEmpiricalTestDerivation,
} from '../../src/solver-types/_swe-rebench-v2-empirical-tests.js';
import type { EvalRunner } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';

const input = {
  instance_id: 'acme__widget__echo-bbbbbbbbbbbb',
  repo: 'acme/widget',
  image: 'ghcr.io/acme/widget@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  test_patch: 'test patch',
  test_cmd: 'yarn vitest run test/widget.test.ts',
  log_parser: 'vitest-json.v1',
  gold_patch: 'gold patch',
  broken_patch: '',
};

function runner(): EvalRunner {
  return {
    runEval: vi.fn(async ({ patch }: { patch: string }) => patch === ''
      ? { passed_match: false, passed: ['unaffected'], failed: ['regression'], log: '', exitCode: 1 }
      : { passed_match: true, passed: ['regression', 'unaffected'], failed: [], log: '', exitCode: 0 }),
  } as unknown as EvalRunner;
}

describe('empirical test derivation', () => {
  it('keeps the legacy v1 path at one broken and one fixed execution', async () => {
    const evalRunner = runner();
    await expect(runEmpiricalTestDerivation(input, evalRunner)).resolves.toMatchObject({
      FAIL_TO_PASS: ['regression'],
      PASS_TO_PASS: ['unaffected'],
    });
    expect(evalRunner.runEval).toHaveBeenCalledTimes(2);
  });

  it('runs a normalized target path twice broken and twice fixed while retaining raw observations', async () => {
    const evalRunner = runner();
    const result = await runTargetedEmpiricalTestDerivation({
      ...input,
      normalizedTestPath: 'operator/test/widget.test.ts',
    }, evalRunner);

    expect(result).toEqual({
      testPath: 'operator/test/widget.test.ts',
      broken: [
        { passed: ['unaffected'], failed: ['regression'], passed_match: false },
        { passed: ['unaffected'], failed: ['regression'], passed_match: false },
      ],
      fixed: [
        { passed: ['regression', 'unaffected'], failed: [], passed_match: true },
        { passed: ['regression', 'unaffected'], failed: [], passed_match: true },
      ],
    });
    expect(evalRunner.runEval).toHaveBeenCalledTimes(4);
    expect(evalRunner.runEval).toHaveBeenCalledWith(expect.objectContaining({
      patch: '', test_cmd: 'yarn vitest run test/widget.test.ts',
    }));
    expect(evalRunner.runEval).toHaveBeenCalledWith(expect.objectContaining({
      patch: 'gold patch', test_cmd: 'yarn vitest run test/widget.test.ts',
    }));
  });
});
