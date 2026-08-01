import type { VerdictObservationGateInput } from '@jinn-network/marketplace-binding';
import { buildNamedCheckFixture } from '@jinn-network/marketplace-testing/named-check-fixtures';
import type { VerdictGateDeps } from '../../src/evaluator/verdict-gate.js';

/** Kit-built gate input + deps for a passing decision-grade verdict observation. */
export async function buildDecisionGradeGateInvocation(): Promise<{
  readonly input: VerdictObservationGateInput;
  readonly deps: VerdictGateDeps;
}> {
  const fixture = await buildNamedCheckFixture();
  const deps: VerdictGateDeps = {
    policies: {
      admissionAgentPolicy: fixture.ports.admissionAgentPolicy,
      ...(fixture.ports.evaluatorPolicy === undefined
        ? {}
        : { evaluatorPolicy: fixture.ports.evaluatorPolicy }),
      ...(fixture.ports.requesterPolicy === undefined
        ? {}
        : { requesterPolicy: fixture.ports.requesterPolicy }),
    },
    bindingResolver: fixture.ports.bindingResolver,
    witnessVerifier: fixture.ports.witnessVerifier,
    dsseVerifier: fixture.ports.dsseVerifier,
  };
  return { input: fixture.input, deps };
}

export function withEvaluatorEqualsSolver(
  input: VerdictObservationGateInput,
): VerdictObservationGateInput {
  return {
    ...input,
    verdict: {
      ...input.verdict,
      evaluatorAddress: input.verdict.solver.address.toUpperCase(),
    },
  };
}
