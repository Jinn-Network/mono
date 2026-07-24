import {
  AutopilotAdoptionReceiptSchema,
  AutopilotCorrelationSchema,
  AutopilotReviewResultSchema,
  autopilotCorrelationMatches,
  type AutopilotAdoptionReceipt,
  type AutopilotAdoptionRejectionReason,
  type AutopilotCorrelation,
  type AutopilotReviewResult,
} from '@jinn-network/sdk/autopilot';
import type { AttemptManifest } from './attempt-workspace.js';
import type {
  AdoptionReceiptExactFacts,
  AdoptionReceiptState,
  PublishAdoptionReceiptInput,
  PublishAdoptionReceiptResult,
} from './marketplace-adoption-receipt.js';
import type { ReviewSessionProtocol } from './review-session.js';
import type { ReviewClaimRecord } from './types.js';

export interface MarketplaceReviewAuthority {
  /** Immutable review-claim root captured by the attempt manifest. */
  readonly claimOid: string;
  readonly head: string;
  readonly reviewGeneration: string;
  /** Current descendant review record; advances through intent and terminal states. */
  readonly reviewRefOid: string;
  readonly reviewState: ReviewClaimRecord['state'];
}

export interface MarketplaceReviewAdoptionPorts {
  readAuthority(
    manifest: AttemptManifest,
  ): Promise<MarketplaceReviewAuthority>;
  readonly protocol: ReviewSessionProtocol;
  publishReceipt(
    input: PublishAdoptionReceiptInput,
  ): Promise<PublishAdoptionReceiptResult>;
  readReceiptState(
    exactFacts: AdoptionReceiptExactFacts,
    allowedAuthors: readonly string[],
  ): Promise<AdoptionReceiptState>;
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
    || manifest.claimOid !== correlation.reviewRefOid
    || manifest.reviewGeneration !== correlation.reviewGeneration
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
    || authority.reviewRefOid !== manifest.reviewRefOid
  ) {
    return 'stale-review-generation';
  }
  return undefined;
}

async function rejectLostProtocolAuthority(
  input: AdoptMarketplaceReviewInput,
  correlation: ReviewCorrelation,
  ports: MarketplaceReviewAdoptionPorts,
): Promise<MarketplaceReviewAdoptionResult> {
  const current = await ports.readAuthority(input.manifest);
  const failure = authorityFailure(input.manifest, correlation, current);
  if (failure === undefined) {
    throw new MarketplaceReviewAdoptionError(
      'retryable-github-state',
      'The review protocol reported lost authority, but fresh authority did not expose the loss',
    );
  }
  return publishRejected(input, correlation, current, failure, ports);
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

function receiptExactFacts(
  correlation: ReviewCorrelation,
): AdoptionReceiptExactFacts {
  return {
    role: 'verdict',
    correlation,
    prHead: correlation.reviewedHead,
  };
}

async function existingAdoptionResult(
  input: AdoptMarketplaceReviewInput,
  correlation: ReviewCorrelation,
  ports: MarketplaceReviewAdoptionPorts,
): Promise<MarketplaceReviewAdoptionResult | undefined> {
  const state = await ports.readReceiptState(
    receiptExactFacts(correlation),
    input.receiptAuthors,
  );
  if (state.status === 'contradiction') {
    const human = await ports.protocol.human(
      input.manifest,
      `Authorized marketplace Verdict receipts contradict: ${state.reason}`,
    );
    return {
      status: 'rejected',
      reason: 'receipt-contradiction',
      head: human.head,
    };
  }
  if (
    state.status === 'exact-accepted'
    && state.receipt.role === 'verdict'
    && state.receipt.disposition === 'accepted'
  ) {
    return {
      status: 'adopted',
      operation: state.receipt.operation,
      head: state.receipt.reviewedHead,
    };
  }
  if (
    state.status === 'exact-rejected'
    && state.receipt.role === 'verdict'
    && state.receipt.disposition === 'rejected'
  ) {
    const authority = await ports.readAuthority(input.manifest);
    const head = await settleRejectedAuthority(
      input,
      authority,
      state.receipt.reason,
      ports,
    );
    return {
      status: 'rejected',
      reason: state.receipt.reason,
      head,
    };
  }
  return undefined;
}

async function settleRejectedAuthority(
  input: AdoptMarketplaceReviewInput,
  authority: MarketplaceReviewAuthority,
  reason: AutopilotAdoptionRejectionReason,
  ports: MarketplaceReviewAdoptionPorts,
): Promise<string> {
  const manifest = input.manifest;
  const ownsExactReview =
    authority.claimOid === manifest.claimOid
    && authority.head === manifest.expectedHead
    && authority.reviewGeneration === manifest.reviewGeneration
    && authority.reviewRefOid === manifest.reviewRefOid;
  if (!ownsExactReview) return authority.head;

  const human = await ports.protocol.human(
    manifest,
    `Marketplace Verdict rejected (${reason}): ${rejectionDetail(reason)}`,
  );
  return human.head;
}

function sameReceiptWithoutTimestamp(
  left: AutopilotAdoptionReceipt,
  right: AutopilotAdoptionReceipt,
): boolean {
  const stable = (receipt: AutopilotAdoptionReceipt) =>
    Object.fromEntries(
      Object.entries(receipt).filter(([key]) => key !== 'recordedAt'),
    );
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

async function recoverDurableReceipt(
  candidate: AutopilotAdoptionReceipt,
  input: AdoptMarketplaceReviewInput,
  correlation: ReviewCorrelation,
  ports: MarketplaceReviewAdoptionPorts,
): Promise<AutopilotAdoptionReceipt> {
  const state = await ports.readReceiptState(
    receiptExactFacts(correlation),
    input.receiptAuthors,
  );
  if (
    (
      candidate.disposition === 'accepted'
        ? state.status === 'exact-accepted'
        : state.status === 'exact-rejected'
    )
    && 'receipt' in state
    && sameReceiptWithoutTimestamp(candidate, state.receipt)
  ) {
    return state.receipt;
  }
  return candidate;
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
  const receipt = await recoverDurableReceipt(AutopilotAdoptionReceiptSchema.parse({
    ...receiptCommon(correlation, ports.now().toISOString()),
    disposition: 'rejected',
    role: 'verdict',
    reason,
    detail: rejectionDetail(reason),
  }), input, correlation, ports);
  const settledHead = await settleRejectedAuthority(
    input,
    authority,
    reason,
    ports,
  );
  await ports.publishReceipt({
    receipt,
    exactFacts: receiptExactFacts(correlation),
    expectedPublicationHead: settledHead,
    allowedAuthors: input.receiptAuthors,
    publisherLogin: input.publisherLogin,
  });
  return { status: 'rejected', reason, head: settledHead };
}

async function publishAccepted(
  input: AdoptMarketplaceReviewInput,
  correlation: ReviewCorrelation,
  authority: MarketplaceReviewAuthority,
  operation: 'review-verdict' | 'review-findings' | 'human',
  ports: MarketplaceReviewAdoptionPorts,
  childIssueNumber?: number,
): Promise<void> {
  if (
    operation === 'review-findings'
    && (childIssueNumber === undefined
      || !Number.isSafeInteger(childIssueNumber)
      || childIssueNumber <= 0)
  ) {
    throw new MarketplaceReviewAdoptionError(
      'unexpected-protocol-outcome',
      'Review findings adoption requires the exact child issue identity',
    );
  }
  const receipt = await recoverDurableReceipt(AutopilotAdoptionReceiptSchema.parse({
    ...receiptCommon(correlation, ports.now().toISOString()),
    disposition: 'accepted',
    role: 'verdict',
    operation,
    ...(operation === 'review-findings'
      ? { childIssueNumber }
      : {}),
  }), input, correlation, ports);
  await ports.publishReceipt({
    receipt,
    exactFacts: receiptExactFacts(correlation),
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
    const findings = formatMarketplaceReviewFindings(result.findings);
    if (authority.reviewState === 'stale') {
      const recovered = await ports.protocol.reviewFindings(
        input.manifest,
        findings,
      );
      if (recovered.status === 'filed') {
        await publishAccepted(
          input,
          correlation,
          authority,
          'review-findings',
          ports,
          recovered.childNumber,
        );
        return {
          status: 'adopted',
          operation: 'review-findings',
          head: recovered.head,
          childNumber: recovered.childNumber,
          childCreated: recovered.created,
        };
      }
      if (recovered.status === 'human') {
        return publishRejected(
          input,
          correlation,
          authority,
          'policy-human',
          ports,
        );
      }
      if (recovered.status === 'ambiguous') {
        throw new MarketplaceReviewAdoptionError(
          'retryable-github-state',
          'The prior review findings have not converged yet',
        );
      }
      if (recovered.status === 'stale') {
        return rejectLostProtocolAuthority(input, correlation, ports);
      }
      throw new MarketplaceReviewAdoptionError(
        'unexpected-protocol-outcome',
        `REQUEST_CHANGES recovery unexpectedly produced ${recovered.status}`,
      );
    }
    const adopted = await ports.protocol.reviewFindings(
      input.manifest,
      findings,
    );
    if (adopted.status !== 'filed') {
      if (adopted.status === 'ambiguous') {
        throw new MarketplaceReviewAdoptionError(
          'retryable-github-state',
          'The review-finding GitHub write has not converged yet',
        );
      }
      if (adopted.status === 'stale') {
        return rejectLostProtocolAuthority(input, correlation, ports);
      }
      return publishRejected(
        input,
        correlation,
        authority,
        'policy-human',
        ports,
      );
    }
    await publishAccepted(
      input,
      correlation,
      authority,
      'review-findings',
      ports,
      adopted.childNumber,
    );
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
    return rejectLostProtocolAuthority(input, correlation, ports);
  }
  if (adopted.status === 'human') {
    return publishRejected(
      input,
      correlation,
      authority,
      'policy-human',
      ports,
    );
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
  const existing = await existingAdoptionResult(input, correlation, ports);
  if (existing !== undefined) return existing;
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
