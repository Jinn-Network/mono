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
import type { ReviewSessionProtocol } from '../../src/lifecycle/review-session.js';
import type {
  PublishAdoptionReceiptInput,
  PublishAdoptionReceiptResult,
} from '../../src/lifecycle/marketplace-adoption-receipt.js';
import { gitOid } from '../../src/lifecycle/types.js';

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
    }),
    protocol: {
      reviewVerdict,
      reviewFindings,
      human,
    },
    publishReceipt,
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

describe('adoptMarketplaceReview', () => {
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
});
