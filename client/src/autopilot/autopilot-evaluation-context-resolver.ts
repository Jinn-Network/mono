import {
  AutopilotMutationResultSchema,
  JinnRepoAutopilotSessionTaskSchema,
  type AutopilotAdoptionReceipt,
  type AutopilotCorrelation,
  type AutopilotMutationResult,
  type AutopilotSessionCapsule,
  type JinnRepoAutopilotSessionTask,
} from '@jinn-network/sdk/solvernets/jinn-repo';

import {
  observeExactAutopilotAdoptionReceipt,
  type AutopilotGitHubReadPort,
} from './github-adoption-receipt-observer.js';

type AcceptedSolutionReceipt = Extract<
  AutopilotAdoptionReceipt,
  { disposition: 'accepted'; role: 'solution' }
>;

export interface AutopilotEvaluationContextValue {
  readonly schemaVersion: 'jinn-autopilot-evaluation-context.v1';
  readonly operators: {
    readonly solutionSafe: string;
    readonly evaluatorSafe: string;
  };
  readonly reviewTarget: {
    readonly repository: AutopilotSessionCapsule['repository'];
    readonly issueNumber: number;
    readonly childIssueNumber?: number;
    readonly prNumber: number;
    readonly targetBase: string;
    readonly baseOid: string;
    readonly headRef: string;
    readonly resultingHead: string;
    readonly reviewGeneration: string;
    readonly reviewRefOid: string;
  };
  readonly session: AutopilotSessionCapsule;
  readonly correlation: AutopilotCorrelation & {
    readonly resultingHead: string;
    readonly reviewedHead: string;
    readonly reviewGeneration: string;
    readonly reviewRefOid: string;
  };
  readonly solution: {
    readonly summary: string;
    readonly evidence: Extract<
      AutopilotMutationResult,
      { outcome: 'mutation-complete' }
    >['evidence'];
    readonly adoptionReceipt: AcceptedSolutionReceipt;
  };
}

export type AutopilotEvaluationContextObservation =
  | {
      readonly state: 'accepted';
      readonly context: AutopilotEvaluationContextValue;
    }
  | {
      readonly state: 'pending' | 'rejected' | 'contradictory';
      readonly detail?: string;
    };

export interface AutopilotEvaluationContextResolverInput {
  readonly task: JinnRepoAutopilotSessionTask;
  readonly solution: AutopilotMutationResult;
  readonly taskId: string;
  readonly attemptIndex: number;
  readonly requestId: string;
  readonly solutionEnvelopeCid: string;
  readonly solutionOperatorSafe: string;
  readonly evaluatorOperatorSafe: string;
}

export interface AutopilotEvaluationContextResolver {
  resolve(
    input: AutopilotEvaluationContextResolverInput,
  ): Promise<AutopilotEvaluationContextObservation | undefined>;
}

function sameSafe(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function validSafe(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function contradictory(detail: string): AutopilotEvaluationContextObservation {
  return { state: 'contradictory', detail };
}

function expectedMutationOperation(
  session: AutopilotSessionCapsule,
): 'implementation-complete' | 'child-complete' {
  return session.workflow === 'implement'
    ? 'implementation-complete'
    : 'child-complete';
}

function sourceFactsMatch(
  task: JinnRepoAutopilotSessionTask,
  solution: Extract<
    AutopilotMutationResult,
    { outcome: 'mutation-complete' }
  >,
  input: AutopilotEvaluationContextResolverInput,
): string | null {
  const correlation = solution.correlation;
  const expectedBindings: Array<[unknown, unknown, string]> = [
    [input.taskId, correlation.taskId, 'taskId'],
    [input.attemptIndex, correlation.attemptIndex, 'attemptIndex'],
    [input.requestId, correlation.requestId, 'requestId'],
    [input.solutionEnvelopeCid, correlation.deliveryEnvelopeCid, 'deliveryEnvelopeCid'],
    [task.session.v2AttemptId, correlation.v2AttemptId, 'v2AttemptId'],
    [task.session.claimOid, correlation.claimOid, 'claimOid'],
    [task.session.prNumber, correlation.prNumber, 'prNumber'],
    [task.session.expectedHead, correlation.expectedHead, 'expectedHead'],
    [task.repo, task.session.repository, 'repository'],
    [task.instance_id, `autopilot:${task.session.v2AttemptId}`, 'instance_id'],
  ];
  return expectedBindings.find(([left, right]) => left !== right)?.[2] ?? null;
}

function buildContext(
  task: JinnRepoAutopilotSessionTask,
  solution: Extract<
    AutopilotMutationResult,
    { outcome: 'mutation-complete' }
  >,
  receipt: AcceptedSolutionReceipt,
  input: AutopilotEvaluationContextResolverInput,
): AutopilotEvaluationContextValue {
  const session = task.session;
  const correlation: AutopilotEvaluationContextValue['correlation'] = {
    taskId: receipt.taskId,
    attemptIndex: receipt.attemptIndex,
    requestId: receipt.requestId,
    deliveryEnvelopeCid: receipt.deliveryEnvelopeCid,
    v2AttemptId: receipt.v2AttemptId,
    claimOid: receipt.claimOid,
    prNumber: receipt.prNumber,
    expectedHead: receipt.expectedHead,
    resultingHead: receipt.resultingHead,
    reviewedHead: receipt.resultingHead,
    reviewGeneration: receipt.reviewGeneration,
    reviewRefOid: receipt.reviewRefOid,
  };
  return {
    schemaVersion: 'jinn-autopilot-evaluation-context.v1',
    operators: {
      solutionSafe: input.solutionOperatorSafe,
      evaluatorSafe: input.evaluatorOperatorSafe,
    },
    reviewTarget: {
      repository: session.repository,
      issueNumber: session.issueNumber,
      ...(session.childIssueNumber === undefined
        ? {}
        : { childIssueNumber: session.childIssueNumber }),
      prNumber: session.prNumber,
      targetBase: session.targetBase,
      baseOid: session.taskSnapshot.targetBaseOid,
      headRef: session.branch,
      resultingHead: receipt.resultingHead,
      reviewGeneration: receipt.reviewGeneration,
      reviewRefOid: receipt.reviewRefOid,
    },
    session,
    correlation,
    solution: {
      summary: solution.summary,
      evidence: solution.evidence,
      adoptionReceipt: receipt,
    },
  };
}

/**
 * Read-only lifecycle resolver used by the semantic evaluator admission seam.
 * It never invents context: only an exact, accepted, GitHub-verified Solution
 * adoption can produce `state: accepted`.
 */
export function createAutopilotEvaluationContextResolver(options: {
  readonly github: AutopilotGitHubReadPort;
  readonly maxPages?: number;
  /** Test/canary-only opt-in; default keeps independent-Safe admission. */
  readonly allowSelfEvaluation?: boolean;
}): AutopilotEvaluationContextResolver {
  return {
    async resolve(
      input: AutopilotEvaluationContextResolverInput,
    ): Promise<AutopilotEvaluationContextObservation> {
      if (
        !validSafe(input.solutionOperatorSafe)
        || !validSafe(input.evaluatorOperatorSafe)
      ) {
        return contradictory('Solution and evaluator Safe identities must be valid');
      }
      if (
        sameSafe(input.solutionOperatorSafe, input.evaluatorOperatorSafe)
        && options.allowSelfEvaluation !== true
      ) {
        return contradictory('Solution and evaluator Safes must be distinct');
      }

      const parsedTask = JinnRepoAutopilotSessionTaskSchema.safeParse(input.task);
      const parsedSolution = AutopilotMutationResultSchema.safeParse(input.solution);
      if (!parsedTask.success || !parsedSolution.success) {
        return contradictory('source Autopilot Task or Solution is malformed');
      }
      if (parsedSolution.data.outcome !== 'mutation-complete') {
        return {
          state: 'rejected',
          detail: 'Human mutation outcomes cannot create an evaluation context',
        };
      }
      const task = parsedTask.data;
      const solution = parsedSolution.data;
      const mismatch = sourceFactsMatch(task, solution, input);
      if (mismatch !== null) {
        return contradictory(`source Autopilot correlation mismatch: ${mismatch}`);
      }

      const receipt = await observeExactAutopilotAdoptionReceipt({
        expectedRole: 'solution',
        expectedCorrelation: solution.correlation,
        expectedAcceptedOperation: expectedMutationOperation(task.session),
        receiptAuthors: task.session.receiptAuthors,
        github: options.github,
        ...(options.maxPages === undefined
          ? {}
          : { maxPages: options.maxPages }),
      });
      if (receipt.state !== 'accepted') {
        if (receipt.state === 'rejected') {
          if (receipt.receipt.disposition !== 'rejected') {
            return contradictory(
              'rejected observation did not carry a rejected receipt',
            );
          }
          return {
            state: 'rejected',
            detail: `Solution adoption was rejected: ${receipt.receipt.reason}`,
          };
        }
        return {
          state: receipt.state,
          ...(receipt.detail === undefined ? {} : { detail: receipt.detail }),
        };
      }
      if (
        receipt.receipt.role !== 'solution'
        || receipt.receipt.disposition !== 'accepted'
      ) {
        return contradictory('accepted observation did not carry a Solution receipt');
      }
      return {
        state: 'accepted',
        context: buildContext(
          task,
          solution,
          receipt.receipt,
          input,
        ),
      };
    },
  };
}
