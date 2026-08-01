import { describe, it, expect } from 'vitest';
import { EVALUATION_TASK_PROFILE_URI } from '@jinn-network/task-execution-profiles';
import { buildEvaluationLauncher } from '../../src/evaluator/launcher.js';
import { evaluationHarnessDeployment } from '../../src/evaluator/deployment.js';

describe('evaluation launcher registration', () => {
  it('advertises the evaluation task profile once registrations are configured', () => {
    const launcher = buildEvaluationLauncher({
      deploymentModule: 'file:///dev/null',
      deployment: evaluationHarnessDeployment,
    });
    expect(launcher.capabilities().taskProfiles).toContain(EVALUATION_TASK_PROFILE_URI);
  });

  it('declares exactly one secret forward, for the evaluator signer handle', () => {
    const launcher = buildEvaluationLauncher({
      deploymentModule: 'file:///dev/null',
      deployment: evaluationHarnessDeployment,
    });
    const forwards = launcher.capabilities().secretForwards;
    expect(forwards).toHaveLength(1);
    expect(forwards[0]!.grantKey).toBe('evaluator-signer');
  });

  it('takes its registrations and parser allowlist from the adapters facade, not from local assembly', () => {
    expect(evaluationHarnessDeployment.parserAllowlist.size).toBeGreaterThan(0);
    expect(evaluationHarnessDeployment.registrations.length).toBeGreaterThan(0);
  });
});
