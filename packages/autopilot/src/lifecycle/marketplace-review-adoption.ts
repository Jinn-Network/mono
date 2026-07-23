import {
  AutopilotCorrelationSchema,
  AutopilotReviewResultSchema,
  autopilotCorrelationMatches,
  type AutopilotAdoptionReceipt,
  type AutopilotAdoptionRejectionReason,
  type AutopilotCorrelation,
  type AutopilotReviewResult,
} from '../../../sdk/src/autopilot-session.js';
import type { AttemptManifest } from './attempt-workspace.js';
import type {
  PublishAdoptionReceiptInput,
  PublishAdoptionReceiptResult,
} from './marketplace-adoption-receipt.js';
import type { ReviewSessionProtocol } from './review-session.js';

export interface MarketplaceReviewAuthority {
  readonly claimOid: string;
  readonly head: string;
  readonly reviewGeneration: string;
  readonly reviewRefOid: string;
}

export interface MarketplaceReviewAdoptionPorts {
  readAuthority(
    manifest: AttemptManifest,
  ): Promise<MarketplaceReviewAuthority>;
  readonly protocol: ReviewSessionProtocol;
  publishReceipt(
    input: PublishAdoptionReceiptInput,
  ): Promise<PublishAdoptionReceiptResult>;
  readonly now: () => Date;
}

export interface AdoptMarketplaceReviewInput {
  readonly manifest: AttemptManifest;
  readonly expectedCorrelation: AutopilotCorrelation;
  readonly solverOperator: string;
  readonly evaluatorOperator: string;
  readonly result: unknown;
  readonly receiptAuthors: readonly string[];
  readonly publisherLogin: string;
}

export type MarketplaceReviewAdoptionErrorCode =
  | 'invalid-expected-correlation'
  | 'invalid-review-manifest'
  | 'retryable-github-state'
  | 'protocol-unavailable'
  | 'unexpected-protocol-outcome';

export class MarketplaceReviewAdoptionError extends Error {
  constructor(
    readonly code: MarketplaceReviewAdoptionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MarketplaceReviewAdoptionError';
  }
}

export type MarketplaceReviewAdoptionResult =
  | {
      readonly status: 'adopted';
      readonly operation: 'review-verdict' | 'review-findings' | 'human';
      readonly head: string;
      readonly childNumber?: number;
      readonly childCreated?: boolean;
    }
  | {
      readonly status: 'rejected';
      readonly reason: AutopilotAdoptionRejectionReason;
      readonly head: string;
    };

type ReviewCorrelation = AutopilotCorrelation & {
  readonly resultingHead: string;
  readonly reviewedHead: string;
  readonly reviewGeneration: string;
  readonly reviewRefOid: string;
};

function requireExpectedCorrelation(
  input: AdoptMarketplaceReviewInput,
): ReviewCorrelation {
  const parsed = AutopilotCorrelationSchema.safeParse(input.expectedCorrelation);
  if (
    !parsed.success
    || parsed.data.resultingHead === undefined
    || parsed.data.reviewedHead === undefined
    || parsed.data.reviewGeneration === undefined
    || parsed.data.reviewRefOid === undefined
    || parsed.data.resultingHead !== parsed.data.reviewedHead
  ) {
    throw new MarketplaceReviewAdoptionError(
      'invalid-expected-correlation',
      'Verdict adoption requires the complete exact-head review correlation',
    );
  }
  return parsed.data as ReviewCorrelation;
}

function requireManifest(
  manifest: AttemptManifest,
  correlation: ReviewCorrelation,
): void {
  if (
    manifest.phase !== 'review'
    || manifest.prNumber !== correlation.prNumber
    || manifest.expectedHead !== correlation.reviewedHead
    || manifest.reviewGeneration !== correlation.reviewGeneration
    || manifest.reviewRefOid !== correlation.reviewRefOid
  ) {
    throw new MarketplaceReviewAdoptionError(
      'invalid-review-manifest',
      'The local review manifest does not match the expected marketplace correlation',
    );
  }
}

function normalizeOperator(operator: string): string {
  return operator.trim().toLowerCase();
}

function correlationFailure(
  expected: ReviewCorrelation,
  actual: AutopilotCorrelation,
): AutopilotAdoptionRejectionReason | undefined {
  if (actual.claimOid !== expected.claimOid) return 'stale-claim';
  if (
    actual.expectedHead !== expected.expectedHead
    || actual.reviewedHead !== expected.reviewedHead
  ) {
    return 'stale-head';
  }
  if (
    actual.reviewGeneration !== expected.reviewGeneration
    || actual.reviewRefOid !== expected.reviewRefOid
  ) {
    return 'stale-review-generation';
  }
  return autopilotCorrelationMatches(expected, actual)
    ? undefined
    : 'correlation-mismatch';
}

function authorityFailure(
  manifest: AttemptManifest,
  expected: ReviewCorrelation,
  authority: MarketplaceReviewAuthority,
): AutopilotAdoptionRejectionReason | undefined {
  if (authority.claimOid !== manifest.claimOid) return 'stale-claim';
  if (authority.head !== expected.reviewedHead) return 'stale-head';
  if (
    authority.reviewGeneration !== expected.reviewGeneration
    || authority.reviewRefOid !== expected.reviewRefOid
  ) {
    return 'stale-review-generation';
  }
  return undefined;
}

function receiptCommon(
  correlation: ReviewCorrelation,
  recordedAt: string,
) {
  return {
    schemaVersion: 'jinn-autopilot-marketplace-adoption.v1' as const,
    taskId: correlation.taskId,
    attemptIndex: correlation.attemptIndex,
    requestId: correlation.requestId,
    deliveryEnvelopeCid: correlation.deliveryEnvelopeCid,
    v2AttemptId: correlation.v2AttemptId,
    claimOid: correlation.claimOid,
    prNumber: correlation.prNumber,
    expectedHead: correlation.expectedHead,
    resultingHead: correlation.resultingHead,
    reviewedHead: correlation.reviewedHead,
    reviewGeneration: correlation.reviewGeneration,
    reviewRefOid: correlation.reviewRefOid,
    recordedAt,
  };
}

function rejectionDetail(reason: AutopilotAdoptionRejectionReason): string {
  const details: Record<AutopilotAdoptionRejectionReason, string> = {
    'correlation-mismatch': 'The delivered review does not match the exact marketplace attempt.',
    'untrusted-operator': 'The evaluator is not independent from the Solution operator.',
    'stale-claim': 'The V2 claim is no longer current.',
    'stale-head': 'The pull request head is no longer the reviewed head.',
    'stale-review-generation': 'The exact review generation or review ref is no longer current.',
    'invalid-artifact': 'The delivered semantic review failed the SDK schema.',
    'patch-does-not-apply': 'Patch rejection is not applicable to a Verdict.',
    'verification-failed': 'Mutation verification rejection is not applicable to a Verdict.',
    'policy-human': 'Policy requires a Human outcome.',
    'receipt-contradiction': 'Authorized adoption receipts contradict one another.',
    'internal-adoption-failure': 'The deterministic review adoption protocol failed.',
  };
  return details[reason];
}

async function publishRejected(
  input: AdoptMarketplaceReviewInput,
  correlation: ReviewCorrelation,
  authority: MarketplaceReviewAuthority,
  reason: AutopilotAdoptionRejectionReason,
  ports: MarketplaceReviewAdoptionPorts,
): Promise<MarketplaceReviewAdoptionResult> {
  const receipt: AutopilotAdoptionReceipt = {
    ...receiptCommon(correlation, ports.now().toISOString()),
    disposition: 'rejected',
    role: 'verdict',
    reason,
    detail: rejectionDetail(reason),
  };
  await ports.publishReceipt({
    receipt,
    exactFacts: {
      role: 'verdict',
      correlation,
      prHead: correlation.reviewedHead,
    },
    expectedPublicationHead: authority.head,
    allowedAuthors: input.receiptAuthors,
    publisherLogin: input.publisherLogin,
  });
  return { status: 'rejected', reason, head: authority.head };
}

async function publishAccepted(
  input: AdoptMarketplaceReviewInput,
  correlation: ReviewCorrelation,
  authority: MarketplaceReviewAuthority,
  operation: 'review-verdict' | 'review-findings' | 'human',
  ports: MarketplaceReviewAdoptionPorts,
): Promise<void> {
  const receipt: AutopilotAdoptionReceipt = {
    ...receiptCommon(correlation, ports.now().toISOString()),
    disposition: 'accepted',
    role: 'verdict',
    operation,
  };
  await ports.publishReceipt({
    receipt,
    exactFacts: {
      role: 'verdict',
      correlation,
      prHead: correlation.reviewedHead,
    },
    expectedPublicationHead: authority.head,
    allowedAuthors: input.receiptAuthors,
    publisherLogin: input.publisherLogin,
  });
}

export function formatMarketplaceReviewFindings(
  findings: Extract<
    AutopilotReviewResult,
    { readonly outcome: 'request-changes' }
  >['findings'],
): string {
  return [
    '## Findings',
    ...findings.flatMap((finding, index) => {
      const location = finding.path === undefined
        ? []
        : [
            `Location: \`${finding.path}${finding.line === undefined
              ? ''
              : `:${finding.line}`}\``,
          ];
      return [
        '',
        `### ${index + 1}. ${finding.title}`,
        '',
        finding.body,
        ...location.flatMap((entry) => ['', entry]),
      ];
    }),
  ].join('\n');
}

async function adoptParsedResult(
  input: AdoptMarketplaceReviewInput,
  result: AutopilotReviewResult,
  correlation: ReviewCorrelation,
  authority: MarketplaceReviewAuthority,
  ports: MarketplaceReviewAdoptionPorts,
): Promise<MarketplaceReviewAdoptionResult> {
  if (result.outcome === 'human') {
    const adopted = await ports.protocol.human(
      input.manifest,
      `${result.reason.code}: ${result.reason.detail}`,
    );
    await publishAccepted(input, correlation, authority, 'human', ports);
    return { status: 'adopted', operation: 'human', head: adopted.head };
  }

  if (result.outcome === 'request-changes') {
    if (ports.protocol.reviewFindings === undefined) {
      throw new MarketplaceReviewAdoptionError(
        'protocol-unavailable',
        'The aggregated review-finding protocol is unavailable',
      );
    }
    const adopted = await ports.protocol.reviewFindings(
      input.manifest,
      formatMarketplaceReviewFindings(result.findings),
    );
    if (adopted.status !== 'filed') {
      if (adopted.status === 'ambiguous') {
        throw new MarketplaceReviewAdoptionError(
          'retryable-github-state',
          'The review-finding GitHub write has not converged yet',
        );
      }
      if (adopted.status === 'stale') {
        return publishRejected(input, correlation, authority, 'stale-head', ports);
      }
      await publishAccepted(input, correlation, authority, 'human', ports);
      return { status: 'adopted', operation: 'human', head: adopted.head };
    }
    await publishAccepted(input, correlation, authority, 'review-findings', ports);
    return {
      status: 'adopted',
      operation: 'review-findings',
      head: adopted.head,
      childNumber: adopted.childNumber,
      childCreated: adopted.created,
    };
  }

  const adopted = await ports.protocol.reviewVerdict(
    input.manifest,
    'APPROVE',
    result.body,
    result.followUps,
  );
  if (adopted.status === 'ambiguous') {
    throw new MarketplaceReviewAdoptionError(
      'retryable-github-state',
      'The native approval has not converged yet',
    );
  }
  if (adopted.status === 'stale') {
    return publishRejected(input, correlation, authority, 'stale-head', ports);
  }
  if (adopted.status === 'human') {
    await publishAccepted(input, correlation, authority, 'human', ports);
    return { status: 'adopted', operation: 'human', head: adopted.head };
  }
  if (adopted.status !== 'approved') {
    throw new MarketplaceReviewAdoptionError(
      'unexpected-protocol-outcome',
      `APPROVE unexpectedly produced ${adopted.status}`,
    );
  }
  await publishAccepted(input, correlation, authority, 'review-verdict', ports);
  return { status: 'adopted', operation: 'review-verdict', head: adopted.head };
}

export async function adoptMarketplaceReview(
  input: AdoptMarketplaceReviewInput,
  ports: MarketplaceReviewAdoptionPorts,
): Promise<MarketplaceReviewAdoptionResult> {
  const correlation = requireExpectedCorrelation(input);
  requireManifest(input.manifest, correlation);
  const authority = await ports.readAuthority(input.manifest);

  if (
    normalizeOperator(input.solverOperator) ===
    normalizeOperator(input.evaluatorOperator)
  ) {
    return publishRejected(
      input,
      correlation,
      authority,
      'untrusted-operator',
      ports,
    );
  }

  const parsed = AutopilotReviewResultSchema.safeParse(input.result);
  if (!parsed.success) {
    return publishRejected(
      input,
      correlation,
      authority,
      'invalid-artifact',
      ports,
    );
  }
  const mismatch = correlationFailure(correlation, parsed.data.correlation);
  if (mismatch !== undefined) {
    return publishRejected(input, correlation, authority, mismatch, ports);
  }
  const stale = authorityFailure(input.manifest, correlation, authority);
  if (stale !== undefined) {
    return publishRejected(input, correlation, authority, stale, ports);
  }
  return adoptParsedResult(
    input,
    parsed.data,
    correlation,
    authority,
    ports,
  );
}
