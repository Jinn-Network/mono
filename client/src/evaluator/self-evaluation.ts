export interface OperatorIdentity {
  readonly safeAddress: string;
  readonly agentEoa: string;
  readonly agentIri: string;
}

export type EvaluationSkipReason =
  | 'own-solution-safe'
  | 'own-solution-eoa'
  | 'own-solution-agent-iri';

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * The operator never evaluates its own solutions (design §4). Checked before any material is
 * fetched or any transaction is simulated. The on-chain `evaluator != solver` rule and the
 * gate's `evaluator-distinctness` check remain in force; this is the local refusal that keeps
 * the fleet from spending on a claim the venue would reject anyway.
 */
export function selfEvaluationSkip(
  identity: OperatorIdentity,
  solution: { readonly operatorAddress: string; readonly executorAgentIri?: string },
): EvaluationSkipReason | undefined {
  if (sameAddress(solution.operatorAddress, identity.safeAddress)) return 'own-solution-safe';
  if (sameAddress(solution.operatorAddress, identity.agentEoa)) return 'own-solution-eoa';
  if (solution.executorAgentIri !== undefined && solution.executorAgentIri === identity.agentIri) {
    return 'own-solution-agent-iri';
  }
  return undefined;
}
