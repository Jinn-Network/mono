import { describe, expect, it } from 'vitest';
import { buildHarnesses } from '../../../src/harnesses/impls/index.js';
import { SweRebenchV2EvaluatorHarness } from '../../../src/harnesses/impls/swe-rebench-v2-evaluator/harness.js';
import { sweRebenchV2StateDirFromEnv } from '../../e2e/_daemon-harness-helpers.js';

describe('startDaemon sweRebenchV2StateDir wiring (#2097)', () => {
  it('sweRebenchV2StateDirFromEnv reads JINN_SWE_REBENCH_V2_STATE_DIR', () => {
    expect(sweRebenchV2StateDirFromEnv({})).toBeUndefined();
    expect(sweRebenchV2StateDirFromEnv({ JINN_SWE_REBENCH_V2_STATE_DIR: '' })).toBeUndefined();
    expect(
      sweRebenchV2StateDirFromEnv({ JINN_SWE_REBENCH_V2_STATE_DIR: '/tmp/swe' }),
    ).toBe('/tmp/swe');
  });

  it('buildHarnesses forwards sweRebenchV2StateDir into SweRebenchV2EvaluatorHarness', () => {
    const stateDir = '/tmp/t2.4-eval-state';
    const harnesses = buildHarnesses({
      stub: true,
      rpcUrl: 'http://stub',
      claudePath: 'claude',
      claudeModel: 'claude-haiku-4-5-20251001',
      sweRebenchV2StateDir: stateDir,
    });
    const swe = harnesses.find((h) => h.name === 'swe-rebench-v2-evaluator');
    expect(swe).toBeInstanceOf(SweRebenchV2EvaluatorHarness);
    expect((swe as SweRebenchV2EvaluatorHarness & { stateDir?: string }).stateDir).toBe(
      stateDir,
    );
  });
});
