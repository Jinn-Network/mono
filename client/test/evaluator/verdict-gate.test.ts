import { describe, it, expect } from 'vitest';
import {
  createFakeResolvers,
  runTwoSafeEvaluatorDistinctnessWalkthrough,
  runOldVerdictAfterKeyRotationWalkthrough,
} from '@jinn-network/trust-testing';
import {
  buildDecisionGradeGateInvocation,
  withEvaluatorEqualsSolver,
} from '@test/evaluation-fixtures.js';
import { createVerdictGate } from '../../src/evaluator/verdict-gate.js';

describe('createVerdictGate — §7.5a settlement join wiring', () => {
  it('carries the trust kit\'s rotated-key walkthrough through to a decision-grade result', async () => {
    const fakes = createFakeResolvers();
    const walkthrough = await runOldVerdictAfterKeyRotationWalkthrough(fakes);
    expect(walkthrough.settlementJoin.ok).toBe(true);

    const gate = createVerdictGate({
      policies: {
        admissionAgentPolicy: { accepted: [], requiredStrength: 'weak' },
        evaluatorPolicy: { accepted: [], requiredStrength: 'weak' },
      },
      bindingResolver: fakes.bindingResolver,
      witnessVerifier: fakes.witnessVerifier,
      dsseVerifier: fakes.dsseVerifier,
    });
    expect(typeof gate.gate).toBe('function');

    const { input, deps } = await buildDecisionGradeGateInvocation();
    const result = await createVerdictGate(deps).gate(input);
    expect(result.decisionGrade).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('reports a not-decision-grade result with named failures when the evaluator is the solver', async () => {
    const fakes = createFakeResolvers();
    const walkthrough = await runTwoSafeEvaluatorDistinctnessWalkthrough(fakes);
    expect(walkthrough).toBeDefined();
    expect(walkthrough.distinctEvaluatorSatisfied).toBe(false);

    const { input, deps } = await buildDecisionGradeGateInvocation();
    const result = await createVerdictGate(deps).gate(withEvaluatorEqualsSolver(input));
    expect(result.decisionGrade).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: 'evaluator-distinctness' })]),
    );
  });
});
