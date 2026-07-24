import { describe, expect, it, vi } from 'vitest';
import type {
  AutopilotAdoptionReceipt,
  AutopilotCorrelation,
  AutopilotReviewResult,
} from '../../../sdk/src/autopilot-session.js';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import {
  MarketplaceReviewAdoptionError,
  adoptMarketplaceReview,
  formatMarketplaceReviewFindings,
  type MarketplaceReviewAdoptionPorts,
} from '../../src/lifecycle/marketplace-review-adoption.js';
import {
  makeReviewSessionProtocol,
  type ReviewSessionAuthority,
  type ReviewSessionPort,
  type ReviewSessionProtocol,
} from '../../src/lifecycle/review-session.js';
import type {
  AdoptionReceiptComment,
  AdoptionReceiptPorts,
  PublishAdoptionReceiptInput,
  PublishAdoptionReceiptResult,
} from '../../src/lifecycle/marketplace-adoption-receipt.js';
import {
  parseAdoptionReceiptComment,
  publishAdoptionReceipt,
  readAdoptionReceiptState,
} from '../../src/lifecycle/marketplace-adoption-receipt.js';
import {
  gitOid,
  type GitOid,
  type ReviewClaimRecord,
} from '../../src/lifecycle/types.js';

const CLAIM = '1111111111111111111111111111111111111111';
const ORIGINAL_HEAD = '1111111111111111111111111111111111111112';
const HEAD = '2222222222222222222222222222222222222222';
const REVIEW_REF = '3333333333333333333333333333333333333333';
const ATTEMPT = '123e4567-e89b-42d3-a456-426614174000';
const REVIEW_ATTEMPT = '123e4567-e89b-42d3-a456-426614174002';
const GENERATION = '123e4567-e89b-42d3-a456-426614174001';

const correlation = {
  taskId: 'task-91',
  attemptIndex: 0,
  requestId: 'request-91',
  deliveryEnvelopeCid: 'bafyreview91',
  v2AttemptId: ATTEMPT,
  claimOid: CLAIM,
  prNumber: 91,
  expectedHead: ORIGINAL_HEAD,
  resultingHead: HEAD,
  reviewedHead: HEAD,
  reviewGeneration: GENERATION,
  reviewRefOid: REVIEW_REF,
} satisfies AutopilotCorrelation;

const manifest = {
  phase: 'review',
  attemptId: REVIEW_ATTEMPT,
  claimOid: REVIEW_REF,
  prNumber: 91,
  expectedHead: HEAD,
  reviewGeneration: GENERATION,
  reviewRefOid: REVIEW_REF,
} as AttemptManifest;

function approve(
  patch: Partial<
    Extract<AutopilotReviewResult, { outcome: 'approve' }>
  > = {},
): Extract<AutopilotReviewResult, { outcome: 'approve' }> {
  return {
    schemaVersion: 'jinn-autopilot-review-result.v1',
    outcome: 'approve',
    correlation,
    body: 'The full adopted head is correct.',
    followUps: [{
      type: 'chore',
      title: 'Later cleanup',
      body: 'Keep this out of the fix.',
      effort: 'low',
      priority: 'p3',
    }],
    ...patch,
  } as Extract<AutopilotReviewResult, { outcome: 'approve' }>;
}

function makePorts() {
  const receipts: PublishAdoptionReceiptInput[] = [];
  const reviewVerdict = vi.fn<ReviewSessionProtocol['reviewVerdict']>(async () => ({
    status: 'approved' as const,
    head: gitOid(HEAD),
  }));
  const reviewFindings = vi.fn<
    NonNullable<ReviewSessionProtocol['reviewFindings']>
  >(async () => ({
    status: 'filed' as const,
    head: gitOid(HEAD),
    childNumber: 190,
    created: true,
  }));
  const human = vi.fn<ReviewSessionProtocol['human']>(async () => ({
    status: 'human' as const,
    head: gitOid(HEAD),
  }));
  const publishReceipt = vi.fn(async (
    input: PublishAdoptionReceiptInput,
  ): Promise<PublishAdoptionReceiptResult> => {
    receipts.push(input);
    return {
      status: 'already-published',
      receipt: input.receipt,
      comments: [],
    };
  });
  const ports: MarketplaceReviewAdoptionPorts = {
    readAuthority: async () => ({
      claimOid: REVIEW_REF,
      head: HEAD,
      reviewGeneration: GENERATION,
      reviewRefOid: REVIEW_REF,
      reviewState: 'active',
    }),
    protocol: {
      reviewVerdict,
      reviewFindings,
      human,
    },
    publishReceipt,
    readReceiptState: async () => ({
      status: 'pending',
      reason: 'not-found',
    }),
    now: () => new Date('2026-07-24T16:00:00.000Z'),
  };
  return {
    ports,
    receipts,
    reviewVerdict,
    reviewFindings,
    human,
    publishReceipt,
  };
}

const commonInput = {
  manifest,
  expectedCorrelation: correlation,
  solverOperator: '0xsolver',
  evaluatorOperator: '0xevaluator',
  result: approve(),
  receiptAuthors: ['jinn-autopilot'],
  publisherLogin: 'jinn-autopilot',
} as const;

function realManifest(reviewRefOid: GitOid = gitOid(REVIEW_REF)): AttemptManifest {
  return {
    version: 2,
    attemptId: REVIEW_ATTEMPT,
    runnerId: 'runner-review',
    host: 'host-review',
    phase: 'review',
    subject: 'pr-91',
    issueNumber: 90,
    prNumber: 91,
    branch: 'autopilot/90',
    targetBase: 'next',
    expectedHead: HEAD,
    claimOid: REVIEW_REF,
    reviewGeneration: GENERATION,
    reviewRefOid,
    reviewApprovalPolicy: 'approve-eligible',
    selectedLogin: 'review-bot',
    repository: {
      root: '/repo',
      gitCommonDir: '/repo/.git',
      remoteName: 'jinn-autopilot-v2',
      remoteUrlHash: 'a'.repeat(64),
    },
    execution: {
      backend: 'marketplace',
      taskId: 'task-91',
      attemptIndex: 0,
      requestId: 'request-91',
      deliveryEnvelopeCid: 'bafyreview91',
    },
    processState: 'running',
    pid: 91,
    paths: {
      attemptDir: '/attempt',
      worktree: '/attempt/worktree',
      manifest: '/attempt/manifest.json',
      log: '/attempt/session.log',
      ghConfigDir: '/attempt/gh',
      askpass: '/attempt/askpass',
      tokenFile: '/attempt/gh-token',
    },
    timestamps: {
      createdAt: '2026-07-24T15:00:00.000Z',
      updatedAt: '2026-07-24T15:00:00.000Z',
      childStartedAt: '2026-07-24T15:00:00.000Z',
    },
  };
}

function reviewRecord(
  state: ReviewClaimRecord['state'],
  verdict?: { readonly state: 'APPROVE'; readonly marker: string },
): ReviewClaimRecord {
  const common = {
    kind: 'review-claim' as const,
    protocolVersion: 2 as const,
    prNumber: 91,
    generation: GENERATION,
    attempt: REVIEW_ATTEMPT,
    reviewer: 'review-bot',
    head: gitOid(HEAD),
    recordedAt: '2026-07-24T15:00:00.000Z',
  };
  if (state === 'terminal-approved') {
    return {
      ...common,
      state,
      verdict: verdict ?? {
        state: 'APPROVE',
        marker: '123e4567-e89b-42d3-a456-426614174009',
      },
    };
  }
  if (state === 'verdict-intent') {
    return {
      ...common,
      state,
      verdict: verdict ?? {
        state: 'APPROVE',
        marker: '123e4567-e89b-42d3-a456-426614174009',
      },
    };
  }
  return { ...common, state };
}

function makeRealReviewHarness() {
  const intentOid = gitOid('4'.repeat(40));
  const terminalOid = gitOid('5'.repeat(40));
  let currentManifest = realManifest();
  let authority: ReviewSessionAuthority = {
    reviewRefOid: gitOid(REVIEW_REF),
    record: reviewRecord('active'),
  };
  let nativeReviews: Awaited<
    ReturnType<ReviewSessionPort['readNativeReviews']>
  > = [];
  let labels = new Set(['engine:review']);
  let draft = true;
  let receiptAttempts = 0;
  const submitNativeReview = vi.fn<ReviewSessionPort['submitNativeReview']>(
    async ({ state, commitId, body }) => {
      nativeReviews = [...nativeReviews, {
        reviewer: 'review-bot',
        state: state === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED',
        commitId,
        body,
        submittedAt: '2026-07-24T15:01:00.000Z',
      }];
    },
  );
  const fileFindingChild = vi.fn<
    NonNullable<ReviewSessionPort['fileFindingChild']>
  >(async () => ({ number: 190, created: true }));
  const reviewPort: ReviewSessionPort = {
    readManifest: () => currentManifest,
    readAuthority: async () => authority,
    readPullRequest: async () => ({
      number: 91,
      issueNumber: 90,
      open: true,
      head: gitOid(HEAD),
      headRefName: 'autopilot/90',
      baseRefName: 'next',
      draft,
      author: 'implementation-bot',
      labels: [...labels],
      body: 'Closes #90\n\n<!-- jinn-autopilot:v2 issue=90 branch=autopilot/90 -->',
      approvalPolicy: 'approve-eligible',
    }),
    readNativeReviews: async () => nativeReviews,
    hasHumanHold: async () => false,
    createReviewRecord: async ({ record }) => (
      record.state === 'verdict-intent' ? intentOid : terminalOid
    ),
    publishReviewClaim: async ({
      expectedRemoteRecordOid,
      recordOid,
      record,
    }) => {
      if (authority.reviewRefOid !== expectedRemoteRecordOid) {
        return {
          status: 'lost',
          expected: expectedRemoteRecordOid,
          published: recordOid,
          observed: authority.reviewRefOid,
        };
      }
      authority = { reviewRefOid: recordOid, record };
      currentManifest = { ...currentManifest, reviewRefOid: recordOid };
      return {
        status: 'won',
        expected: expectedRemoteRecordOid,
        published: recordOid,
        observed: recordOid,
      };
    },
    submitNativeReview,
    fileFindingChild,
    setPullRequestLabel: async (_pr, _head, label, present) => {
      if (present) labels.add(label);
      else labels.delete(label);
    },
    setPullRequestDraft: async (_pr, _head, present) => {
      draft = present;
    },
    hasHumanComment: async () => false,
    ensureHumanComment: async () => {},
    nextMarker: () => '123e4567-e89b-42d3-a456-426614174009',
    now: () => new Date('2026-07-24T15:00:00.000Z'),
  };
  const publishReceipt = vi.fn(async (
    input: PublishAdoptionReceiptInput,
  ): Promise<PublishAdoptionReceiptResult> => {
    receiptAttempts += 1;
    if (receiptAttempts === 1) throw new Error('crash before receipt storage');
    return {
      status: 'already-published',
      receipt: input.receipt,
      comments: [],
    };
  });
  const ports: MarketplaceReviewAdoptionPorts = {
    readAuthority: async () => ({
      claimOid: REVIEW_REF,
      head: HEAD,
      reviewGeneration: GENERATION,
      reviewRefOid: authority.reviewRefOid,
      reviewState: authority.record.state,
    }),
    protocol: makeReviewSessionProtocol(reviewPort),
    publishReceipt,
    readReceiptState: async () => ({
      status: 'pending',
      reason: 'not-found',
    }),
    now: () => new Date('2026-07-24T16:00:00.000Z'),
  };
  return {
    currentManifest: () => currentManifest,
    ports,
    publishReceipt,
    fileFindingChild,
    submitNativeReview,
  };
}

describe('adoptMarketplaceReview', () => {
  it('recovers a real native approval after the review ref advanced before receipt storage', async () => {
    const h = makeRealReviewHarness();
    const input = {
      ...commonInput,
      manifest: h.currentManifest(),
      result: approve({ followUps: undefined }),
    };

    await expect(adoptMarketplaceReview(input, h.ports)).rejects.toThrow(
      'crash before receipt storage',
    );
    expect(h.currentManifest().reviewRefOid).not.toBe(REVIEW_REF);

    await expect(adoptMarketplaceReview({
      ...input,
      manifest: h.currentManifest(),
    }, h.ports)).resolves.toEqual({
      status: 'adopted',
      operation: 'review-verdict',
      head: HEAD,
    });
    expect(h.submitNativeReview).toHaveBeenCalledTimes(1);
    expect(h.publishReceipt).toHaveBeenCalledTimes(2);
  });

  it('recovers real review findings after the review claim was released before receipt storage', async () => {
    const h = makeRealReviewHarness();
    const result: Extract<
      AutopilotReviewResult,
      { outcome: 'request-changes' }
    > = {
      schemaVersion: 'jinn-autopilot-review-result.v1',
      outcome: 'request-changes',
      correlation,
      findings: [{
        title: 'Lost update',
        body: 'Serialize the current-head publication.',
        path: 'src/review.ts',
        line: 12,
      }],
    };
    const input = {
      ...commonInput,
      manifest: h.currentManifest(),
      result,
    };

    await expect(adoptMarketplaceReview(input, h.ports)).rejects.toThrow(
      'crash before receipt storage',
    );
    expect(h.currentManifest().reviewRefOid).not.toBe(REVIEW_REF);

    await expect(adoptMarketplaceReview({
      ...input,
      manifest: h.currentManifest(),
    }, h.ports)).resolves.toMatchObject({
      status: 'adopted',
      operation: 'review-findings',
      head: HEAD,
    });
    expect(h.fileFindingChild).toHaveBeenCalledTimes(1);
    expect(h.submitNativeReview).toHaveBeenCalledTimes(1);
    expect(h.publishReceipt).toHaveBeenCalledTimes(2);
  });

  it('reuses the exact durable Verdict receipt when a retry observes a later clock', async () => {
    const h = makePorts();
    const comments: AdoptionReceiptComment[] = [];
    const receiptPorts: AdoptionReceiptPorts = {
      listPrIssueComments: async () => ({ comments }),
      verifyReceiptFacts: async () => true,
      readCurrentPrHead: async () => HEAD,
      createPrComment: async ({ body }) => {
        const comment: AdoptionReceiptComment = {
          id: comments.length + 1,
          authorLogin: 'jinn-autopilot',
          body,
          createdAt: '2026-07-24T16:00:00.000Z',
          updatedAt: '2026-07-24T16:00:00.000Z',
        };
        comments.push(comment);
        return { commentId: comment.id };
      },
    };
    let tick = 0;
    const ports = {
      ...h.ports,
      readReceiptState: (
        exactFacts: PublishAdoptionReceiptInput['exactFacts'],
        allowedAuthors: readonly string[],
      ) => readAdoptionReceiptState(exactFacts, allowedAuthors, receiptPorts),
      publishReceipt: (input: PublishAdoptionReceiptInput) =>
        publishAdoptionReceipt(input, receiptPorts),
      now: () => new Date(
        tick++ === 0
          ? '2026-07-24T16:00:00.000Z'
          : '2026-07-24T16:05:00.000Z',
      ),
    } satisfies MarketplaceReviewAdoptionPorts & {
      readReceiptState(
        exactFacts: PublishAdoptionReceiptInput['exactFacts'],
        allowedAuthors: readonly string[],
      ): ReturnType<typeof readAdoptionReceiptState>;
    };

    await expect(adoptMarketplaceReview(commonInput, ports)).resolves.toMatchObject({
      status: 'adopted',
      operation: 'review-verdict',
    });
    const durable = parseAdoptionReceiptComment(comments[0]!.body)!.receipt;
    await expect(ports.readReceiptState({
      role: 'verdict',
      correlation,
      prHead: HEAD,
    }, commonInput.receiptAuthors)).resolves.toMatchObject({
      status: 'exact-accepted',
      receipt: durable,
    });

    await expect(adoptMarketplaceReview(commonInput, ports)).resolves.toMatchObject({
      status: 'adopted',
      operation: 'review-verdict',
    });
    expect(comments).toHaveLength(1);
    expect(
      parseAdoptionReceiptComment(comments[0]!.body)!.receipt.recordedAt,
    ).toBe(durable.recordedAt);
    expect(h.reviewVerdict).toHaveBeenCalledTimes(1);
  });

  it('enters Human on a receipt contradiction before any native review mutation', async () => {
    const h = makePorts();
    h.ports.readReceiptState = async () => ({
      status: 'contradiction',
      reason: 'accepted-and-rejected',
      comments: [],
    });

    await expect(adoptMarketplaceReview(commonInput, h.ports)).resolves.toEqual({
      status: 'rejected',
      reason: 'receipt-contradiction',
      head: HEAD,
    });
    expect(h.human).toHaveBeenCalledWith(
      manifest,
      'Authorized marketplace Verdict receipts contradict: accepted-and-rejected',
    );
    expect(h.reviewVerdict).not.toHaveBeenCalled();
    expect(h.reviewFindings).not.toHaveBeenCalled();
    expect(h.publishReceipt).not.toHaveBeenCalled();
  });

  it('replays a durable stale rejection with the fresh publication head', async () => {
    const h = makePorts();
    const currentHead = '9999999999999999999999999999999999999994';
    h.ports.readAuthority = async () => ({
      claimOid: REVIEW_REF,
      head: currentHead,
      reviewGeneration: GENERATION,
      reviewRefOid: REVIEW_REF,
      reviewState: 'active',
    });

    await expect(adoptMarketplaceReview(commonInput, h.ports)).resolves.toEqual({
      status: 'rejected',
      reason: 'stale-head',
      head: currentHead,
    });
    const durable = h.receipts[0]!.receipt;
    h.ports.readReceiptState = async () => ({
      status: 'exact-rejected',
      receipt: durable,
      canonicalJson: JSON.stringify(durable),
      comments: [],
    });

    await expect(adoptMarketplaceReview(commonInput, h.ports)).resolves.toEqual({
      status: 'rejected',
      reason: 'stale-head',
      head: currentHead,
    });
    expect(h.reviewVerdict).not.toHaveBeenCalled();
    expect(h.publishReceipt).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      { claimOid: '9999999999999999999999999999999999999991' },
      'stale-claim',
    ],
    [
      { head: '9999999999999999999999999999999999999992' },
      'stale-head',
    ],
    [
      { reviewGeneration: '123e4567-e89b-42d3-a456-426614174099' },
      'stale-review-generation',
    ],
    [
      { reviewRefOid: '9999999999999999999999999999999999999993' },
      'stale-review-generation',
    ],
  ] as const)(
    're-reads and precisely classifies post-CAS authority loss %#',
    async (patch, expectedReason) => {
      const h = makePorts();
      const initial = {
        claimOid: REVIEW_REF,
        head: HEAD,
        reviewGeneration: GENERATION,
        reviewRefOid: REVIEW_REF,
        reviewState: 'active' as const,
      };
      const current = { ...initial, ...patch };
      const readAuthority = vi.fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValue(current);
      h.ports.readAuthority = readAuthority;
      h.reviewVerdict.mockResolvedValueOnce({
        status: 'stale',
        head: gitOid(HEAD),
      });

      await expect(adoptMarketplaceReview(commonInput, h.ports)).resolves.toEqual({
        status: 'rejected',
        reason: expectedReason,
        head: current.head,
      });
      expect(readAuthority).toHaveBeenCalledTimes(2);
      expect(h.receipts[0]?.receipt).toMatchObject({
        disposition: 'rejected',
        reason: expectedReason,
      });
      expect(h.receipts[0]?.expectedPublicationHead).toBe(current.head);
    },
  );

  it('adopts approval through the existing review protocol before accepting the Verdict', async () => {
    const h = makePorts();

    await expect(adoptMarketplaceReview(commonInput, h.ports)).resolves.toEqual({
      status: 'adopted',
      operation: 'review-verdict',
      head: HEAD,
    });

    expect(h.reviewVerdict).toHaveBeenCalledWith(
      manifest,
      'APPROVE',
      'The full adopted head is correct.',
      [{
        type: 'chore',
        title: 'Later cleanup',
        body: 'Keep this out of the fix.',
        effort: 'low',
        priority: 'p3',
      }],
    );
    expect(h.publishReceipt).toHaveBeenCalledTimes(1);
    expect(h.receipts[0]?.receipt).toMatchObject({
      disposition: 'accepted',
      role: 'verdict',
      operation: 'review-verdict',
      reviewedHead: HEAD,
      reviewGeneration: GENERATION,
      reviewRefOid: REVIEW_REF,
    } satisfies Partial<AutopilotAdoptionReceipt>);
  });

  it('aggregates all findings into one child through reviewFindings', async () => {
    const h = makePorts();
    const result: Extract<
      AutopilotReviewResult,
      { outcome: 'request-changes' }
    > = {
      schemaVersion: 'jinn-autopilot-review-result.v1',
      outcome: 'request-changes',
      correlation,
      findings: [
        { title: 'Race', body: 'Serialize the update.', path: 'src/a.ts', line: 7 },
        { title: 'Missing case', body: 'Cover restart recovery.' },
      ],
    };

    await expect(adoptMarketplaceReview({
      ...commonInput,
      result,
    }, h.ports)).resolves.toEqual({
      status: 'adopted',
      operation: 'review-findings',
      head: HEAD,
      childNumber: 190,
      childCreated: true,
    });

    expect(h.reviewFindings).toHaveBeenCalledOnce();
    expect(h.reviewFindings).toHaveBeenCalledWith(
      manifest,
      formatMarketplaceReviewFindings(result.findings),
    );
    expect(h.reviewVerdict).not.toHaveBeenCalled();
    expect(h.receipts[0]?.receipt).toMatchObject({
      disposition: 'accepted',
      role: 'verdict',
      operation: 'review-findings',
    });
  });

  it('applies the existing Human overlay and accepts the adopted Human verdict', async () => {
    const h = makePorts();
    const result: Extract<AutopilotReviewResult, { outcome: 'human' }> = {
      schemaVersion: 'jinn-autopilot-review-result.v1',
      outcome: 'human',
      correlation,
      reason: {
        code: 'semantic-uncertainty',
        detail: 'The public API intent is ambiguous.',
      },
    };

    await expect(adoptMarketplaceReview({
      ...commonInput,
      result,
    }, h.ports)).resolves.toEqual({
      status: 'adopted',
      operation: 'human',
      head: HEAD,
    });
    expect(h.human).toHaveBeenCalledWith(
      manifest,
      'semantic-uncertainty: The public API intent is ambiguous.',
    );
    expect(h.receipts[0]?.receipt).toMatchObject({
      disposition: 'accepted',
      role: 'verdict',
      operation: 'human',
    });
  });

  it('rejects a solver evaluating its own work before any review mutation', async () => {
    const h = makePorts();

    await expect(adoptMarketplaceReview({
      ...commonInput,
      evaluatorOperator: '0xSoLvEr',
    }, h.ports)).resolves.toEqual({
      status: 'rejected',
      reason: 'untrusted-operator',
      head: HEAD,
    });

    expect(h.reviewVerdict).not.toHaveBeenCalled();
    expect(h.receipts[0]?.receipt).toMatchObject({
      disposition: 'rejected',
      role: 'verdict',
      reason: 'untrusted-operator',
    });
  });

  it.each([
    ['claimOid', '9999999999999999999999999999999999999999', 'stale-claim'],
    ['reviewedHead', '9999999999999999999999999999999999999999', 'stale-head'],
    ['reviewGeneration', '123e4567-e89b-42d3-a456-426614174099', 'stale-review-generation'],
    ['requestId', 'other-request', 'correlation-mismatch'],
  ] as const)(
    'rejects a mismatched %s with a stable disposition',
    async (field, value, reason) => {
      const h = makePorts();
      const result = approve({
        correlation: { ...correlation, [field]: value },
      });

      await expect(adoptMarketplaceReview({
        ...commonInput,
        result,
      }, h.ports)).resolves.toMatchObject({
        status: 'rejected',
        reason,
      });
      expect(h.reviewVerdict).not.toHaveBeenCalled();
      expect(h.receipts[0]?.receipt).toMatchObject({
        disposition: 'rejected',
        reason,
      });
    },
  );

  it('rejects stale live authority using the current head as the guarded publication fence', async () => {
    const h = makePorts();
    const currentHead = '9999999999999999999999999999999999999999';
    h.ports.readAuthority = async () => ({
      claimOid: REVIEW_REF,
      head: currentHead,
      reviewGeneration: GENERATION,
      reviewRefOid: REVIEW_REF,
      reviewState: 'active',
    });

    await expect(adoptMarketplaceReview(commonInput, h.ports)).resolves.toEqual({
      status: 'rejected',
      reason: 'stale-head',
      head: currentHead,
    });
    expect(h.receipts[0]?.expectedPublicationHead).toBe(currentHead);
    expect(h.receipts[0]?.exactFacts.prHead).toBe(HEAD);
  });

  it('leaves ambiguous GitHub readback recoverable and publishes no receipt', async () => {
    const h = makePorts();
    h.reviewVerdict.mockImplementationOnce(async () => ({
      status: 'ambiguous',
      head: gitOid(HEAD),
    }));

    await expect(adoptMarketplaceReview(commonInput, h.ports)).rejects.toEqual(
      expect.objectContaining({
        name: 'MarketplaceReviewAdoptionError',
        code: 'retryable-github-state',
      }) satisfies Partial<MarketplaceReviewAdoptionError>,
    );
    expect(h.publishReceipt).not.toHaveBeenCalled();
  });

  it('rejects malformed semantic output without invoking the review protocol', async () => {
    const h = makePorts();

    await expect(adoptMarketplaceReview({
      ...commonInput,
      result: { outcome: 'approve' },
    }, h.ports)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'invalid-artifact',
    });
    expect(h.reviewVerdict).not.toHaveBeenCalled();
  });

  it('refuses configuration that does not review the exact adopted resulting head', async () => {
    const h = makePorts();

    await expect(adoptMarketplaceReview({
      ...commonInput,
      expectedCorrelation: {
        ...correlation,
        resultingHead: '9999999999999999999999999999999999999999',
      },
    }, h.ports)).rejects.toMatchObject({
      code: 'invalid-expected-correlation',
    });
    expect(h.reviewVerdict).not.toHaveBeenCalled();
    expect(h.publishReceipt).not.toHaveBeenCalled();
  });
});
