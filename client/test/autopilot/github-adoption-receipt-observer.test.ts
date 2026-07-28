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
  type GitHubReviewAuthority,
  type GitHubIssueCommentPage,
  type GitHubNativeReview,
} from '../../src/autopilot/github-adoption-receipt-observer.js';
import type { PersistedTaskRun } from '../../src/types/task-run.js';

const FIXTURES = new URL(
  '../../../packages/sdk/fixtures/autopilot/',
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
  reviewAuthority?: GitHubReviewAuthority;
  child?: {
    number: number;
    state: 'OPEN' | 'CLOSED';
    body: string;
    labels: readonly string[];
    isPullRequest: boolean;
  };
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
    readIssue: async (issueNumber) => input.child ?? ({
      number: issueNumber,
      state: 'OPEN',
      body: '<!-- jinn-autopilot:child pr=2101 kind=review-finding -->',
      labels: ['review-finding', 'effort:medium', 'priority:p1'],
      isPullRequest: false,
    }),
    listPullRequestReviews: async ({ cursor }) => ({
      reviews: cursor === undefined ? input.reviews ?? [] : [],
    }),
    readReviewAuthority: async () => input.reviewAuthority ?? {
      oid: acceptedSolution.reviewRefOid!,
      history: [{
        oid: acceptedSolution.reviewRefOid!,
        record: {
          protocolVersion: 2,
          prNumber: acceptedSolution.prNumber,
          generation: acceptedSolution.reviewGeneration!,
          attempt: '123e4567-e89b-42d3-a456-426614174099',
          reviewer: 'jinn-autopilot',
          head: acceptedSolution.resultingHead!,
          state: 'active',
          recordedAt: '2026-07-23T22:00:00.000Z',
        },
      }],
    },
  };
}

function verdictAuthority(
  operation: 'review-verdict' | 'review-findings' | 'human',
): {
  authority: GitHubReviewAuthority;
  marker?: string;
} {
  const attempt = '123e4567-e89b-42d3-a456-426614174099';
  const intent = '123e4567-e89b-42d3-a456-426614174098';
  const reviewer = 'jinn-autopilot';
  const head = acceptedVerdict.reviewedHead!;
  const common = {
    protocolVersion: 2 as const,
    prNumber: acceptedVerdict.prNumber,
    generation: acceptedVerdict.reviewGeneration!,
    attempt,
    reviewer,
    head,
    recordedAt: '2026-07-23T22:00:00.000Z',
  };
  const root = {
    oid: acceptedVerdict.reviewRefOid!,
    record: { ...common, state: 'active' as const },
  };
  if (operation === 'human') {
    return {
      authority: {
        oid: '6'.repeat(40),
        history: [{
          oid: '6'.repeat(40),
          record: { ...common, state: 'human' as const },
        }, root],
      },
    };
  }
  const verdict = {
    state: operation === 'review-verdict'
      ? 'APPROVE' as const
      : 'REQUEST_CHANGES' as const,
    marker: intent,
  };
  const intentRecord = {
    oid: '7'.repeat(40),
    record: { ...common, state: 'verdict-intent' as const, verdict },
  };
  const current = {
    oid: '6'.repeat(40),
    record: {
      ...common,
      state: operation === 'review-verdict'
        ? 'terminal-approved' as const
        : 'stale' as const,
      ...(operation === 'review-verdict' ? { verdict } : {}),
    },
  };
  return {
    authority: {
      oid: current.oid,
      history: [current, intentRecord, root],
    },
    marker:
      `<!-- jinn-autopilot-review:v2 generation=${common.generation} `
      + `attempt=${attempt} intent=${intent} reviewer=${reviewer} `
      + `head=${head} verdict=${verdict.state} -->`,
  };
}

function advanceFindingsAuthority(
  base: GitHubReviewAuthority,
  completedGenerations: number,
): GitHubReviewAuthority {
  let history = [...base.history];
  for (let index = 0; index < completedGenerations; index += 1) {
    const suffix = String(20 + index).padStart(2, '0');
    const common = {
      protocolVersion: 2 as const,
      prNumber: acceptedVerdict.prNumber,
      generation: `123e4567-e89b-42d3-a456-4266141740${suffix}`,
      attempt: `123e4567-e89b-42d3-a456-4266141741${suffix}`,
      reviewer: 'jinn-autopilot',
      head: String(index + 8).repeat(40),
      recordedAt: `2026-07-23T23:0${index}:00.000Z`,
    };
    const intent = {
      state: 'REQUEST_CHANGES' as const,
      marker: `123e4567-e89b-42d3-a456-4266141742${suffix}`,
    };
    history = [
      {
        oid: String(100 + (index * 3) + 2).padStart(40, '0'),
        record: { ...common, state: 'stale' as const },
      },
      {
        oid: String(100 + (index * 3) + 1).padStart(40, '0'),
        record: {
          ...common,
          state: 'verdict-intent' as const,
          verdict: intent,
        },
      },
      {
        oid: String(100 + (index * 3)).padStart(40, '0'),
        record: { ...common, state: 'active' as const },
      },
      ...history,
    ];
  }
  const current = {
    protocolVersion: 2 as const,
    prNumber: acceptedVerdict.prNumber,
    generation: '123e4567-e89b-42d3-a456-426614174090',
    attempt: '123e4567-e89b-42d3-a456-426614174091',
    reviewer: 'jinn-autopilot',
    head: 'e'.repeat(40),
    state: 'active' as const,
    recordedAt: '2026-07-23T23:59:00.000Z',
  };
  const currentEntry = {
    oid: 'f'.repeat(40),
    record: current,
  };
  return {
    oid: currentEntry.oid,
    history: [currentEntry, ...history],
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
    verificationProfile: value.verificationProfile,
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
  const producerResult = structuredClone(output);
  if (role === 'solution') {
    delete (
      producerResult.correlation as Record<string, unknown>
    ).deliveryEnvelopeCid;
  }
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
        ? { solutionPayload: producerResult }
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
        ...(operation === 'review-findings'
          ? { childIssueNumber: 2201 }
          : {}),
      });
      const exactAuthority = verdictAuthority(operation);
      const reviews: GitHubNativeReview[] = reviewState === undefined ? [] : [{
        id: 91,
        authorLogin: 'jinn-autopilot',
        state: reviewState,
        commitId: acceptedVerdict.reviewedHead!,
        body: `Exact Autopilot review.\n\n${exactAuthority.marker}`,
        submittedAt: '2026-07-23T22:09:00.000Z',
      }];
      const port = githubPort({
        head: acceptedVerdict.reviewedHead!,
        labels,
        reviews,
        reviewAuthority: exactAuthority.authority,
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
    const exactAuthority = verdictAuthority('review-verdict');
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
      reviewAuthority: exactAuthority.authority,
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

  it('keeps approval pending when an ambiguous same-login change request exists', async () => {
    const exactAuthority = verdictAuthority('review-verdict');
    const port = githubPort({
      head: acceptedVerdict.reviewedHead!,
      labels: ['review:approved'],
      reviews: [
        {
          id: 91,
          authorLogin: 'jinn-autopilot',
          state: 'APPROVED',
          commitId: acceptedVerdict.reviewedHead!,
          body: `Approved.\n\n${exactAuthority.marker}`,
          submittedAt: '2026-07-23T22:09:00.000Z',
        },
        {
          id: 92,
          authorLogin: '@unattributed-review:92',
          state: 'CHANGES_REQUESTED',
          commitId: '0'.repeat(40),
          body: '',
          submittedAt: '0001-01-01T00:00:00.000Z',
        },
      ],
      pages: { first: { comments: [comment(acceptedVerdict)] } },
      reviewAuthority: exactAuthority.authority,
    });

    await expect(observeExactAutopilotAdoptionReceipt({
      expectedRole: 'verdict',
      expectedCorrelation: reviewApprove.correlation,
      receiptAuthors: session.receiptAuthors,
      github: port,
    })).resolves.toMatchObject({
      state: 'pending',
      detail: expect.stringMatching(/requested-changes/i),
    });
  });

  it('uses the unique intent marker and rejects terminal marker substitution', async () => {
    const exactAuthority = verdictAuthority('review-verdict');
    const substituted = '123e4567-e89b-42d3-a456-426614174097';
    const history = exactAuthority.authority.history.map((entry, index) => (
      index === 0
        ? {
            ...entry,
            record: {
              ...entry.record,
              verdict: { state: 'APPROVE' as const, marker: substituted },
            },
          }
        : entry
    ));
    const port = githubPort({
      head: acceptedVerdict.reviewedHead!,
      labels: ['review:approved'],
      reviews: [{
        id: 91,
        authorLogin: 'jinn-autopilot',
        state: 'APPROVED',
        commitId: acceptedVerdict.reviewedHead!,
        body:
          `<!-- jinn-autopilot-review:v2 generation=${acceptedVerdict.reviewGeneration} `
          + 'attempt=123e4567-e89b-42d3-a456-426614174099 '
          + `intent=${substituted} reviewer=jinn-autopilot `
          + `head=${acceptedVerdict.reviewedHead} verdict=APPROVE -->`,
        submittedAt: '2026-07-23T22:09:00.000Z',
      }],
      pages: { first: { comments: [comment(acceptedVerdict)] } },
      reviewAuthority: {
        oid: exactAuthority.authority.oid,
        history,
      },
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

  it('recovers accepted findings after the child closes and several later generations advance', async () => {
    const receipt = AutopilotAdoptionReceiptSchema.parse({
      ...acceptedVerdict,
      operation: 'review-findings',
      childIssueNumber: 2201,
    });
    const original = verdictAuthority('review-findings');
    const advanced = advanceFindingsAuthority(original.authority, 3);
    expect(advanced.history.length).toBeGreaterThan(8);
    const port = githubPort({
      head: advanced.history[0]!.record.head,
      labels: [],
      reviews: [{
        id: 93,
        authorLogin: 'jinn-autopilot',
        state: 'CHANGES_REQUESTED',
        commitId: acceptedVerdict.reviewedHead!,
        body: `Findings.\n\n${original.marker}`,
        submittedAt: '2026-07-23T22:09:00.000Z',
      }],
      child: {
        number: 2201,
        state: 'CLOSED',
        body: '<!-- jinn-autopilot:child pr=2101 kind=review-finding -->',
        labels: ['review-finding', 'effort:medium', 'priority:p1'],
        isPullRequest: false,
      },
      pages: { first: { comments: [comment(receipt)] } },
      reviewAuthority: advanced,
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
  });

  it('requires the exact intent reviewer when multiple receipt authors are allowed', async () => {
    const exactAuthority = verdictAuthority('review-verdict');
    const port = githubPort({
      head: acceptedVerdict.reviewedHead!,
      labels: ['review:approved'],
      reviews: [{
        id: 92,
        authorLogin: 'other-authorized-bot',
        state: 'APPROVED',
        commitId: acceptedVerdict.reviewedHead!,
        body: `Copied marker.\n\n${exactAuthority.marker}`,
        submittedAt: '2026-07-23T22:09:00.000Z',
      }],
      pages: { first: { comments: [comment(acceptedVerdict)] } },
      reviewAuthority: exactAuthority.authority,
    });

    await expect(observeExactAutopilotAdoptionReceipt({
      expectedRole: 'verdict',
      expectedCorrelation: reviewApprove.correlation,
      receiptAuthors: ['jinn-autopilot', 'other-authorized-bot'],
      github: port,
    })).resolves.toMatchObject({
      state: 'pending',
      detail: expect.stringMatching(/APPROVED/),
    });
  });

  it.each([
    ['closed', {
      state: 'CLOSED' as const,
      body: '<!-- jinn-autopilot:child pr=2101 kind=review-finding -->',
    }],
    ['wrong parent', {
      state: 'OPEN' as const,
      body: '<!-- jinn-autopilot:child pr=9999 kind=review-finding -->',
    }],
    ['injected marker before the canonical marker', {
      state: 'OPEN' as const,
      body: [
        '<!-- jinn-autopilot:child pr=9999 kind=reconcile -->',
        '<!-- jinn-autopilot:child pr=2101 kind=review-finding -->',
      ].join('\n'),
    }],
  ])('does not claim review findings with a %s child', async (_name, child) => {
    const receipt = AutopilotAdoptionReceiptSchema.parse({
      ...acceptedVerdict,
      operation: 'review-findings',
      childIssueNumber: 2201,
    });
    const exactAuthority = verdictAuthority('review-findings');
    const port = githubPort({
      head: acceptedVerdict.reviewedHead!,
      labels: ['review:changes-requested'],
      reviews: [{
        id: 93,
        authorLogin: 'jinn-autopilot',
        state: 'CHANGES_REQUESTED',
        commitId: acceptedVerdict.reviewedHead!,
        body: `Findings.\n\n${exactAuthority.marker}`,
        submittedAt: '2026-07-23T22:09:00.000Z',
      }],
      child: {
        number: 2201,
        ...child,
        labels: ['review-finding', 'effort:medium', 'priority:p1'],
        isPullRequest: false,
      },
      pages: { first: { comments: [comment(receipt)] } },
      reviewAuthority: exactAuthority.authority,
    });

    await expect(observeExactAutopilotAdoptionReceipt({
      expectedRole: 'verdict',
      expectedCorrelation: reviewApprove.correlation,
      receiptAuthors: session.receiptAuthors,
      github: port,
    })).resolves.toMatchObject({
      state: 'pending',
      detail: expect.stringMatching(/child/i),
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
    const exactAuthority = verdictAuthority('review-verdict');
    const port = githubPort({
      head: acceptedVerdict.reviewedHead!,
      labels: ['review:approved'],
      reviews: [{
        id: 91,
        authorLogin: 'jinn-autopilot',
        state: 'APPROVED',
        commitId: acceptedVerdict.reviewedHead!,
        body: `Approved.\n\n${exactAuthority.marker}`,
        submittedAt: '2026-07-23T22:09:00.000Z',
      }],
      pages: { first: { comments: [comment(acceptedVerdict)] } },
      reviewAuthority: exactAuthority.authority,
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
    const fullHeadSession = AutopilotSessionCapsuleSchema.parse({
      ...session,
      taskSnapshot: {
        ...session.taskSnapshot,
        baseSha: '7'.repeat(40),
        targetBaseOid: '8'.repeat(40),
      },
    });
    const resolver = createAutopilotEvaluationContextResolver({
      github: githubPort(),
    });
    const observation = await resolver.resolve({
      task: taskSpec(fullHeadSession),
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
          baseOid: fullHeadSession.taskSnapshot.targetBaseOid,
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
