import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  IssueRelayEvaluationContextV1Schema,
  JinnRepoLegacySolutionPayloadSchema,
  JinnRepoLiveIssueTaskSchema,
  type IssueRelayEvaluationContextV1,
  type IssueRelayRoundV1,
  type JinnRepoLiveIssueTask,
} from '@jinn-network/sdk/solvernets/jinn-repo';

export type IssueRelayEvaluationContextObservation =
  | {
      readonly state: 'accepted';
      readonly context: unknown;
    }
  | {
      readonly state: 'pending' | 'rejected' | 'contradictory';
      readonly detail?: string;
    };

export type IssueRelayEvaluationAdmission =
  | {
      readonly kind: 'accepted';
      readonly context: IssueRelayEvaluationContextV1;
    }
  | {
      readonly kind: 'pending';
      readonly reason: string;
    };

export interface IssueRelayEvaluationOpportunityInput {
  readonly task: JinnRepoLiveIssueTask & { readonly relay: IssueRelayRoundV1 };
  readonly solution: {
    readonly schemaVersion: 'jinn-repo-solution.v1';
    readonly patch: string;
  };
  readonly taskId: string;
  readonly attemptIndex: number;
  readonly requestId: string;
  readonly solutionEnvelopeCid: string;
  readonly solutionOperatorSafe: string;
  readonly evaluatorOperatorSafe: string;
  readonly observation?: IssueRelayEvaluationContextObservation;
}

function sameSafe(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function patchDigest(patch: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(patch, 'utf8').digest('hex')}`;
}

function pending(reason: string): IssueRelayEvaluationAdmission {
  return { kind: 'pending', reason };
}

/**
 * Product-neutral harness admission for one host-authorized Relay evaluation.
 * A non-accepted observation is pending work, never a negative candidate grade.
 */
export function admitIssueRelayEvaluationOpportunity(
  input: IssueRelayEvaluationOpportunityInput,
): IssueRelayEvaluationAdmission {
  if (sameSafe(input.solutionOperatorSafe, input.evaluatorOperatorSafe)) {
    return pending('Relay self-evaluation is not permitted');
  }
  if (input.observation?.state !== 'accepted') {
    return pending(
      input.observation?.detail
        ? `Relay Solution adoption is not accepted: ${input.observation.detail}`
        : 'Relay Solution adoption is not accepted',
    );
  }

  const parsedTask = JinnRepoLiveIssueTaskSchema.safeParse(input.task);
  const parsedSolution = JinnRepoLegacySolutionPayloadSchema.safeParse(
    input.solution,
  );
  const parsedContext = IssueRelayEvaluationContextV1Schema.safeParse(
    input.observation.context,
  );
  if (
    !parsedTask.success
    || parsedTask.data.relay === undefined
    || !parsedSolution.success
    || !parsedContext.success
  ) {
    return pending('Relay Task, Solution, or evaluation context is malformed');
  }
  const task = parsedTask.data as JinnRepoLiveIssueTask & {
    readonly relay: IssueRelayRoundV1;
  };
  const context = parsedContext.data as IssueRelayEvaluationContextV1;

  if (
    !sameSafe(input.solutionOperatorSafe, context.operators.solutionSafe)
    || !sameSafe(input.evaluatorOperatorSafe, context.operators.evaluatorSafe)
  ) {
    return pending('Relay evaluation Safe identity mismatch');
  }
  if (!isDeepStrictEqual(task.relay, context.round)) {
    return pending('Relay evaluation round does not match the source Task');
  }
  const expectedCorrelation = {
    generation: task.relay.generation,
    round: task.relay.round,
    snapshotDigest: task.relay.snapshotDigest,
    taskId: input.taskId,
    attemptIndex: input.attemptIndex,
    requestId: input.requestId,
    deliveryEnvelopeCid: input.solutionEnvelopeCid,
  };
  if (!isDeepStrictEqual(context.correlation, expectedCorrelation)) {
    return pending('Relay evaluation correlation is stale or mismatched');
  }
  if (
    context.reviewTarget.issueNumber !== task.issue_number
    || context.reviewTarget.targetRepository !== task.repo
    || context.goal.problemStatement !== task.problem_statement
    || context.goal.snapshotDigest !== task.relay.snapshotDigest
  ) {
    return pending('Relay frozen goal or review target does not match the source Task');
  }
  if (
    context.adoptionReceipt.patchDigest !== patchDigest(parsedSolution.data.patch)
    || !sameSafe(
      context.adoptionReceipt.solutionSafe,
      input.solutionOperatorSafe,
    )
  ) {
    return pending('Relay adopted Solution does not match the delivered patch');
  }
  return { kind: 'accepted', context };
}
