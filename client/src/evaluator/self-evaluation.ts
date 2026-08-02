export interface OperatorIdentity {
  readonly safeAddress: string;
  readonly agentEoa: string;
  readonly agentIri: string;
}

export type EvaluationSkipReason =
  | "own-solution-safe"
  | "own-solution-eoa"
  | "own-solution-agent-iri";

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Pure early refusal: an operator must not acquire material or initiate evaluator work for its
 * own solution. Chain enforcement remains independent of this local decision.
 */
export function selfEvaluationSkip(
  identity: OperatorIdentity,
  solution: { readonly operatorAddress: string; readonly executorAgentIri?: string },
): EvaluationSkipReason | undefined {
  if (sameAddress(solution.operatorAddress, identity.safeAddress)) return "own-solution-safe";
  if (sameAddress(solution.operatorAddress, identity.agentEoa)) return "own-solution-eoa";
  if (solution.executorAgentIri !== undefined && solution.executorAgentIri === identity.agentIri) {
    return "own-solution-agent-iri";
  }
  return undefined;
}
