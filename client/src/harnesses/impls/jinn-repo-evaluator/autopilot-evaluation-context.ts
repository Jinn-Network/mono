import {
  AutopilotEvaluationContextSchema,
  type AutopilotEvaluationContext,
  type AutopilotMutationResult,
  type JinnRepoAutopilotSessionTask,
} from '@jinn-network/sdk/solvernets/jinn-repo';
import { isDeepStrictEqual } from 'node:util';

export type AutopilotEvaluationContextObservation =
  | {
      state: 'accepted';
      context: unknown;
    }
  | {
      state: 'pending' | 'rejected' | 'contradictory';
      detail?: string;
    };

export type AutopilotEvaluationAdmission =
  | {
      kind: 'accepted';
      context: AutopilotEvaluationContext;
    }
  | {
      kind: 'pending';
      reason: string;
    };

export interface AutopilotEvaluationOpportunityInput {
  task: JinnRepoAutopilotSessionTask;
  solution: AutopilotMutationResult;
  taskId: string;
  attemptIndex: number;
  requestId: string;
  solutionEnvelopeCid: string;
  solutionOperatorSafe: string;
  evaluatorOperatorSafe: string;
  observation?: AutopilotEvaluationContextObservation;
}

function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function sameSafe(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Fail-closed lifecycle admission for an Autopilot semantic evaluation.
 *
 * A missing, rejected, contradictory, malformed, or stale observation is not a
 * negative grade. It simply cannot create a gradeable evaluation opportunity.
 */
export function admitAutopilotEvaluationOpportunity(
  input: AutopilotEvaluationOpportunityInput,
): AutopilotEvaluationAdmission {
  if (sameSafe(input.solutionOperatorSafe, input.evaluatorOperatorSafe)) {
    return {
      kind: 'pending',
      reason: 'Autopilot self-evaluation is not permitted',
    };
  }

  if (input.observation?.state !== 'accepted') {
    const detail = input.observation?.detail;
    return {
      kind: 'pending',
      reason: detail
        ? `Autopilot Solution adoption is not accepted: ${detail}`
        : 'Autopilot Solution adoption is not accepted',
    };
  }

  const parsed = AutopilotEvaluationContextSchema.safeParse(
    input.observation.context,
  );
  if (!parsed.success) {
    return {
      kind: 'pending',
      reason: 'Autopilot evaluation context is malformed or contradictory',
    };
  }
  const context = parsed.data;

  if (
    !sameSafe(input.solutionOperatorSafe, context.operators.solutionSafe)
    || !sameSafe(input.evaluatorOperatorSafe, context.operators.evaluatorSafe)
  ) {
    return {
      kind: 'pending',
      reason: 'Autopilot evaluation Safe identity mismatch',
    };
  }

  if (input.solution.outcome !== 'mutation-complete') {
    return {
      kind: 'pending',
      reason: 'Autopilot Solution did not produce an adopted mutation',
    };
  }

  if (!sameJson(input.task.session, context.session)) {
    return {
      kind: 'pending',
      reason: 'Autopilot evaluation session does not match the source Task',
    };
  }

  const sourceCorrelation = input.solution.correlation;
  const correlationMatches = (
    [
      ['taskId', input.taskId],
      ['attemptIndex', input.attemptIndex],
      ['requestId', input.requestId],
      ['deliveryEnvelopeCid', input.solutionEnvelopeCid],
      ['v2AttemptId', sourceCorrelation.v2AttemptId],
      ['claimOid', sourceCorrelation.claimOid],
      ['prNumber', sourceCorrelation.prNumber],
      ['expectedHead', sourceCorrelation.expectedHead],
    ] as const
  ).every(([key, expected]) => context.correlation[key] === expected);

  if (
    !correlationMatches
    || sourceCorrelation.taskId !== input.taskId
    || sourceCorrelation.attemptIndex !== input.attemptIndex
    || sourceCorrelation.requestId !== input.requestId
    || sourceCorrelation.deliveryEnvelopeCid !== input.solutionEnvelopeCid
  ) {
    return {
      kind: 'pending',
      reason: 'Autopilot evaluation correlation is stale or mismatched',
    };
  }

  if (
    context.solution.summary !== input.solution.summary
    || !sameJson(context.solution.evidence, input.solution.evidence)
  ) {
    return {
      kind: 'pending',
      reason: 'Autopilot evaluation summary/evidence does not match the adopted Solution',
    };
  }

  return {
    kind: 'accepted',
    context,
  };
}
