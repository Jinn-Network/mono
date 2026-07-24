import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  AutopilotAdoptionReceiptSchema,
  AutopilotMutationResultSchema,
  AutopilotReviewResultSchema,
  AutopilotSessionCapsuleSchema,
  formatAutopilotAdoptionReceiptComment,
  type AutopilotAdoptionReceipt,
  type AutopilotMutationResult,
  type AutopilotReviewResult,
  type AutopilotSessionCapsule,
  type JinnRepoAutopilotSessionTask,
} from '@jinn-network/sdk/solvernets/jinn-repo';

import {
  createAutopilotEvaluationContextResolver,
} from '../../src/autopilot/autopilot-evaluation-context-resolver.js';
import {
  createAutopilotGitHubAdoptionReceiptObserver,
  observeExactAutopilotAdoptionReceipt,
  type AutopilotGitHubReadPort,
  type GitHubIssueCommentPage,
  type GitHubNativeReview,
} from '../../src/autopilot/github-adoption-receipt-observer.js';
import type { PersistedTaskRun } from '../../src/types/task-run.js';

const FIXTURES = new URL(
  '../../../packages/sdk/test/fixtures/autopilot-session/',
  import.meta.url,
);

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'),
  ) as unknown;
}

const session = AutopilotSessionCapsuleSchema.parse(
  fixture('session-implement'),
);
const mutation = AutopilotMutationResultSchema.parse(
  fixture('mutation-complete'),
);
const mutationHuman = AutopilotMutationResultSchema.parse(
  fixture('mutation-human'),
);
const acceptedSolution = AutopilotAdoptionReceiptSchema.parse(
  fixture('receipt-solution-accepted'),
);
const rejectedSolution = AutopilotAdoptionReceiptSchema.parse(
  fixture('receipt-solution-rejected'),
);
const reviewApprove = AutopilotReviewResultSchema.parse(
  fixture('review-approve'),
);
const acceptedVerdict = AutopilotAdoptionReceiptSchema.parse(
  fixture('receipt-verdict-accepted'),
);

function comment(
  receipt: AutopilotAdoptionReceipt,
  override: Partial<{
    id: number;
    authorLogin: string;
    body: string;
  }> = {},
) {
  return {
    id: override.id ?? 1,
    authorLogin: override.authorLogin ?? 'jinn-autopilot',
    body: override.body ?? formatAutopilotAdoptionReceiptComment(receipt),
    createdAt: '2026-07-23T22:00:00.000Z',
    updatedAt: '2026-07-23T22:00:00.000Z',
  };
}

function githubPort(input: {
  pages?: Readonly<Record<string, GitHubIssueCommentPage>>;
  head?: string;
  labels?: readonly string[];
  reviews?: readonly GitHubNativeReview[];
} = {}): AutopilotGitHubReadPort & {
  listPrIssueComments: ReturnType<typeof vi.fn>;
} {
  const pages = input.pages ?? {
    first: { comments: [comment(acceptedSolution)] },
  };
  return {
    listPrIssueComments: vi.fn(async ({ cursor }) => (
      pages[cursor ?? 'first'] ?? { comments: [] }
    )),
    readPullRequest: async () => ({
      headSha: input.head ?? acceptedSolution.resultingHead!,
      labels: input.labels ?? [],
    }),
    listPullRequestReviews: async ({ cursor }) => ({
      reviews: cursor === undefined ? input.reviews ?? [] : [],
    }),
  };
}

function taskSpec(
  value: AutopilotSessionCapsule = session,
): JinnRepoAutopilotSessionTask {
  return {
    schemaVersion: 'jinn-repo.v1',
    source: 'autopilot-session',
    instance_id: `autopilot:${value.v2AttemptId}`,
    repo: 'Jinn-Network/mono',
    base_commit: value.expectedHead,
    language: 'typescript',
    problem_statement: value.taskSnapshot.body,
    session: value,
  };
}

function persistedRun(
  role: 'solution' | 'verdict' = 'solution',
  output: AutopilotMutationResult | AutopilotReviewResult = (
    role === 'solution' ? mutation : reviewApprove
  ),
): PersistedTaskRun {
  const correlation = output.correlation;
  return {
    requestId: correlation.requestId,
    taskId: correlation.taskId,
    attemptIndex: correlation.attemptIndex,
    manifestCid: correlation.deliveryEnvelopeCid,
    solverType: 'jinn-repo.v1',
    taskRole: role === 'solution' ? 'restoration' : 'evaluation',
    task: {
      id: correlation.taskId,
      description: 'Autopilot marketplace session',
      solverType: 'jinn-repo.v1',
      contractId: 'jinn-repo',
      contractVersion: 'v1',
      role: role === 'solution' ? 'restoration' : 'evaluation',
      spec: taskSpec(),
    },
    adoptionReceiptLocation: {
      repository: 'Jinn-Network/mono',
      prNumber: session.prNumber,
    },
    adoptionReceiptAuthors: [...session.receiptAuthors],
    solutionOutputsJson: JSON.stringify(
      role === 'solution'
        ? { solutionPayload: output }
        : { verdictPayload: output },
    ),
  } as PersistedTaskRun;
}

describe('observeExactAutopilotAdoptionReceipt', () => {
  it('ignores a forged author and non-canonical lookalike comments', async () => {
    const port = githubPort({
      pages: {
        first: {
          comments: [
            comment(acceptedSolution, { authorLogin: 'attacker' }),
            comment(acceptedSolution, {
              id: 2,
              body: `prefix\n${formatAutopilotAdoptionReceiptComment(acceptedSolution)}`,
            }),
            comment(acceptedSolution, {
              id: 3,
              body: '<!-- jinn-autopilot:marketplace-adoption-receipt:v10 -->',
            }),
          ],
        },
      },
    });

    await expect(observeExactAutopilotAdoptionReceipt({
      expectedRole: 'solution',
      expectedCorrelation: mutation.correlation,
      receiptAuthors: session.receiptAuthors,
      github: port,
    })).resolves.toMatchObject({
      state: 'pending',
    });
  });

  it('paginates every comment page and accepts an exact verified receipt', async () => {
    const port = githubPort({
      pages: {
        first: { comments: [], nextCursor: 'second' },
        second: { comments: [comment(acceptedSolution)] },
      },
    });

    await expect(observeExactAutopilotAdoptionReceipt({
      expectedRole: 'solution',
      expectedCorrelation: mutation.correlation,
      receiptAuthors: session.receiptAuthors,
      github: port,
    })).resolves.toEqual({
      state: 'accepted',
      receipt: acceptedSolution,
    });
    expect(port.listPrIssueComments).toHaveBeenCalledTimes(2);
  });

  it('fails closed on accepted/rejected and different exact receipts', async () => {
    const differentAccepted = AutopilotAdoptionReceiptSchema.parse({
      ...acceptedSolution,
      recordedAt: '2026-07-23T22:01:00.000Z',
    });

    for (const comments of [
      [comment(acceptedSolution), comment(rejectedSolution, { id: 2 })],
      [comment(acceptedSolution), comment(differentAccepted, { id: 2 })],
    ]) {
      const port = githubPort({ pages: { first: { comments } } });
      await expect(observeExactAutopilotAdoptionReceipt({
        expectedRole: 'solution',
        expectedCorrelation: mutation.correlation,
        receiptAuthors: session.receiptAuthors,
        github: port,
      })).resolves.toMatchObject({
        state: 'contradictory',
      });
    }
  });

  it('fails closed when a stable-delivery receipt changes correlation', async () => {
    const mismatched = AutopilotAdoptionReceiptSchema.parse({
      ...acceptedSolution,
      claimOid: '9'.repeat(40),
    });
    const port = githubPort({
      pages: { first: { comments: [comment(mismatched)] } },
    });

    await expect(observeExactAutopilotAdoptionReceipt({
      expectedRole: 'solution',
      expectedCorrelation: mutation.correlation,
      receiptAuthors: session.receiptAuthors,
      github: port,
    })).resolves.toMatchObject({
      state: 'contradictory',
      detail: expect.stringMatching(/correlation/i),
    });
  });

  it('keeps an accepted receipt pending until the authoritative head matches', async () => {
    const port = githubPort({ head: '9'.repeat(40) });
    await expect(observeExactAutopilotAdoptionReceipt({
      expectedRole: 'solution',
      expectedCorrelation: mutation.correlation,
      receiptAuthors: session.receiptAuthors,
      github: port,
    })).resolves.toMatchObject({
      state: 'pending',
      detail: expect.stringMatching(/head/i),
    });
  });

  it('accepts a stale-head rejection even after the live PR head advances', async () => {
    const port = githubPort({
      head: '9'.repeat(40),
      pages: { first: { comments: [comment(rejectedSolution)] } },
    });
    await expect(observeExactAutopilotAdoptionReceipt({
      expectedRole: 'solution',
      expectedCorrelation: mutation.correlation,
      receiptAuthors: session.receiptAuthors,
      github: port,
    })).resolves.toEqual({
      state: 'rejected',
      receipt: rejectedSolution,
    });
  });

  it.each([
    {
      operation: 'review-verdict',
      labels: ['review:approved'],
      reviewState: 'APPROVED',
    },
    {
      operation: 'review-findings',
      labels: ['review:changes-requested'],
      reviewState: 'CHANGES_REQUESTED',
    },
    {
      operation: 'human',
      labels: ['review:needs-human'],
      reviewState: undefined,
    },
  ] as const)(
    'verifies the $operation native GitHub outcome',
    async ({ operation, labels, reviewState }) => {
      const receipt = AutopilotAdoptionReceiptSchema.parse({
        ...acceptedVerdict,
        operation,
      });
      const reviews: GitHubNativeReview[] = reviewState === undefined ? [] : [{
        id: 91,
        authorLogin: 'jinn-autopilot',
        state: reviewState,
        commitId: acceptedVerdict.reviewedHead!,
        body: 'Exact Autopilot review.',
        submittedAt: '2026-07-23T22:09:00.000Z',
      }];
      const port = githubPort({
        head: acceptedVerdict.reviewedHead!,
        labels,
        reviews,
        pages: { first: { comments: [comment(receipt)] } },
      });

      await expect(observeExactAutopilotAdoptionReceipt({
        expectedRole: 'verdict',
        expectedCorrelation: reviewApprove.correlation,
        receiptAuthors: session.receiptAuthors,
        github: port,
      })).resolves.toEqual({
        state: 'accepted',
        receipt,
      });
    },
  );

  it('keeps an accepted Verdict pending when native review authority is not observable', async () => {
    const port = githubPort({
      head: acceptedVerdict.reviewedHead!,
      labels: ['review:approved'],
      reviews: [{
        id: 91,
        authorLogin: 'attacker',
        state: 'APPROVED',
        commitId: acceptedVerdict.reviewedHead!,
        body: 'Forged approval.',
        submittedAt: '2026-07-23T22:09:00.000Z',
      }],
      pages: { first: { comments: [comment(acceptedVerdict)] } },
    });

    await expect(observeExactAutopilotAdoptionReceipt({
      expectedRole: 'verdict',
      expectedCorrelation: reviewApprove.correlation,
      receiptAuthors: session.receiptAuthors,
      github: port,
    })).resolves.toMatchObject({
      state: 'pending',
      detail: expect.stringMatching(/APPROVED/),
    });
  });
});

describe('TaskEngine AdoptionReceiptObserver', () => {
  it('derives the exact role, correlation, location, and authors from a persisted run', async () => {
    const observer = createAutopilotGitHubAdoptionReceiptObserver({
      github: githubPort(),
    });
    await expect(observer.observe(persistedRun())).resolves.toEqual({
      state: 'accepted',
      receipt: acceptedSolution,
    });
  });

  it('returns a contradiction for malformed persisted Autopilot facts', async () => {
    const observer = createAutopilotGitHubAdoptionReceiptObserver({
      github: githubPort(),
    });
    await expect(observer.observe({
      ...persistedRun(),
      adoptionReceiptAuthors: null,
    })).resolves.toMatchObject({
      state: 'contradictory',
    });
  });

  it('derives Verdict operation and exact full correlation from the delivered review', async () => {
    const port = githubPort({
      head: acceptedVerdict.reviewedHead!,
      labels: ['review:approved'],
      reviews: [{
        id: 91,
        authorLogin: 'jinn-autopilot',
        state: 'APPROVED',
        commitId: acceptedVerdict.reviewedHead!,
        body: 'Approved.',
        submittedAt: '2026-07-23T22:09:00.000Z',
      }],
      pages: { first: { comments: [comment(acceptedVerdict)] } },
    });
    const observer = createAutopilotGitHubAdoptionReceiptObserver({
      github: port,
    });

    await expect(observer.observe(
      persistedRun('verdict', reviewApprove),
    )).resolves.toEqual({
      state: 'accepted',
      receipt: acceptedVerdict,
    });
  });

  it('requires a policy-human rejection for a Human mutation outcome', async () => {
    const acceptedObserver = createAutopilotGitHubAdoptionReceiptObserver({
      github: githubPort(),
    });
    await expect(acceptedObserver.observe(
      persistedRun('solution', mutationHuman),
    )).resolves.toMatchObject({
      state: 'pending',
      detail: expect.stringMatching(/cannot be accepted/i),
    });

    const policyHuman = AutopilotAdoptionReceiptSchema.parse({
      ...rejectedSolution,
      reason: 'policy-human',
      detail: 'The solver returned a Human outcome.',
    });
    const rejectedObserver = createAutopilotGitHubAdoptionReceiptObserver({
      github: githubPort({
        pages: { first: { comments: [comment(policyHuman)] } },
      }),
    });
    await expect(rejectedObserver.observe(
      persistedRun('solution', mutationHuman),
    )).resolves.toEqual({
      state: 'rejected',
      receipt: policyHuman,
    });
  });
});

describe('autopilotEvaluationContextResolver', () => {
  const solutionSafe = `0x${'11'.repeat(20)}`;
  const evaluatorSafe = `0x${'22'.repeat(20)}`;

  it('builds the strict full-head context only from an exact accepted Solution', async () => {
    const resolver = createAutopilotEvaluationContextResolver({
      github: githubPort(),
    });
    const observation = await resolver.resolve({
      task: taskSpec(),
      solution: mutation,
      taskId: mutation.correlation.taskId,
      attemptIndex: mutation.correlation.attemptIndex,
      requestId: mutation.correlation.requestId,
      solutionEnvelopeCid: mutation.correlation.deliveryEnvelopeCid,
      solutionOperatorSafe: solutionSafe,
      evaluatorOperatorSafe: evaluatorSafe,
    });

    expect(observation).toMatchObject({
      state: 'accepted',
      context: {
        schemaVersion: 'jinn-autopilot-evaluation-context.v1',
        operators: { solutionSafe, evaluatorSafe },
        reviewTarget: {
          repository: 'Jinn-Network/mono',
          prNumber: session.prNumber,
          resultingHead: acceptedSolution.resultingHead,
        },
        solution: {
          summary: mutation.summary,
          evidence: mutation.evidence,
          adoptionReceipt: acceptedSolution,
        },
      },
    });
    if (observation?.state === 'accepted') {
      expect(observation.context.correlation.resultingHead)
        .toBe(observation.context.correlation.reviewedHead);
    }
  });

  it.each([
    ['rejected', rejectedSolution],
    ['missing', undefined],
  ] as const)('does not create context from a %s receipt', async (_name, receipt) => {
    const port = githubPort({
      pages: {
        first: {
          comments: receipt === undefined ? [] : [comment(receipt)],
        },
      },
    });
    const resolver = createAutopilotEvaluationContextResolver({ github: port });
    await expect(resolver.resolve({
      task: taskSpec(),
      solution: mutation,
      taskId: mutation.correlation.taskId,
      attemptIndex: mutation.correlation.attemptIndex,
      requestId: mutation.correlation.requestId,
      solutionEnvelopeCid: mutation.correlation.deliveryEnvelopeCid,
      solutionOperatorSafe: solutionSafe,
      evaluatorOperatorSafe: evaluatorSafe,
    })).resolves.not.toMatchObject({ state: 'accepted' });
  });

  it('fails closed when solver and evaluator Safes are the same', async () => {
    const resolver = createAutopilotEvaluationContextResolver({
      github: githubPort(),
    });
    await expect(resolver.resolve({
      task: taskSpec(),
      solution: mutation,
      taskId: mutation.correlation.taskId,
      attemptIndex: mutation.correlation.attemptIndex,
      requestId: mutation.correlation.requestId,
      solutionEnvelopeCid: mutation.correlation.deliveryEnvelopeCid,
      solutionOperatorSafe: solutionSafe,
      evaluatorOperatorSafe: `0x${solutionSafe.slice(2).toUpperCase()}`,
    })).resolves.toMatchObject({
      state: 'contradictory',
      detail: expect.stringMatching(/distinct/i),
    });
  });
});
