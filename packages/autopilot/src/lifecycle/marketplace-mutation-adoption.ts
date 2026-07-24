import {
  AutopilotAdoptionReceiptSchema,
  AutopilotCorrelationSchema,
  AutopilotMutationResultSchema,
  AutopilotSessionCapsuleSchema,
  autopilotCorrelationMatches,
  type AutopilotAdoptionReceipt,
  type AutopilotAdoptionRejectionReason,
  type AutopilotCorrelation,
  type AutopilotMutationResult,
  type AutopilotSessionCapsule,
  type AutopilotWorkflow,
} from '../../../sdk/src/autopilot-session.js';
import type {
  AttemptManifest,
  MarketplaceTaskProvenance,
} from './attempt-workspace.js';
import type { ImplementationSessionProtocol } from './implementation-session.js';
import {
  AdoptionReceiptPublicationError,
  publishAdoptionReceipt,
  readAdoptionReceiptState,
  type AdoptionReceiptExactFacts,
  type AdoptionReceiptPorts,
  type PublishAdoptionReceiptResult,
} from './marketplace-adoption-receipt.js';
import {
  MarketplacePatchApplicationError,
  MarketplacePatchCheckError,
  MarketplacePatchValidationError,
  MarketplacePatchWorktreeValidationError,
  applyMarketplacePatchToWorktree,
  validateMarketplacePatch,
  type ApplyMarketplacePatchInput,
  type ValidatedMarketplacePatch,
} from './marketplace-patch.js';
import type {
  MarketplaceMutationCommitIdentity,
  MarketplaceMutationGitPort,
} from './marketplace-mutation-git.js';
import {
  JINN_MONO_VERIFICATION_PROFILE,
  MarketplaceVerificationPlanError,
  type MarketplaceMutationVerificationPort,
  type MarketplaceMutationVerificationResult,
} from './marketplace-mutation-verification.js';
import type { BranchClaim, GitOid } from './types.js';

export interface MarketplaceMutationDeliveryReference {
  readonly taskId: string;
  readonly attemptIndex: number;
  readonly requestId: string;
  readonly deliveryEnvelopeCid: string;
}

export type { MarketplaceTaskProvenance } from './attempt-workspace.js';

export interface VerifiedMarketplaceSolutionDelivery {
  readonly schemaVersion: 'jinn-autopilot-verified-solution-delivery.v1';
  readonly task: {
    readonly id: string;
  } & MarketplaceTaskProvenance;
  readonly attempt: {
    readonly index: number;
    readonly v2AttemptId: string;
    readonly manifestPath: string;
  };
  readonly request: {
    readonly id: string;
  };
  readonly operator: {
    readonly id: string;
    readonly address: string;
    readonly role: 'solver';
  };
  readonly envelope: {
    readonly cid: string;
    readonly author: string;
  };
  readonly transaction: {
    readonly hash: string;
    readonly blockNumber: number;
  };
  readonly result: AutopilotMutationResult;
  readonly session: AutopilotSessionCapsule;
}

export interface VerifiedMarketplaceSolutionDeliveryPort {
  readVerifiedSolutionDelivery(
    reference: MarketplaceMutationDeliveryReference,
  ): Promise<VerifiedMarketplaceSolutionDelivery>;
}

export interface MarketplaceMutationChildFacts {
  readonly number: number;
  readonly parentPrNumber: number;
  readonly kind: 'review-finding' | 'reconcile' | 'ci-failure';
  readonly open: boolean;
}

export interface MarketplaceMutationPullRequestFacts {
  readonly number: number;
  readonly head: GitOid;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly open: boolean;
  readonly draft: boolean;
  readonly labels: readonly string[];
  readonly body: string;
  readonly implementationSummary?: string;
  readonly human: {
    readonly active: boolean;
    readonly draft: boolean;
    readonly label: boolean;
    readonly comment: boolean;
  };
  readonly codeOwner: {
    readonly required: boolean;
    readonly paths: readonly string[];
  };
}

export interface ConfirmedMarketplaceReviewClaim {
  readonly head: GitOid;
  readonly generation: string;
  readonly refOid: GitOid;
  readonly attemptId: string;
  readonly manifest: AttemptManifest;
  readonly reviewer: string;
  readonly approvalPolicy: 'approve-eligible' | 'human-codeowner';
  readonly state: 'active';
}

export interface MarketplaceMutationAuthority {
  readonly manifest: AttemptManifest;
  readonly latestClaimOid: GitOid;
  readonly latestClaim: BranchClaim;
  readonly remoteHead: GitOid;
  readonly pullRequest: MarketplaceMutationPullRequestFacts;
  readonly child?: MarketplaceMutationChildFacts;
  readonly reviewClaim?: ConfirmedMarketplaceReviewClaim;
  readonly trustedOperatorIds: readonly string[];
  readonly receiptAuthors: readonly string[];
  readonly publisherLogin: string;
}

export interface MarketplaceMutationAuthorityPort {
  readExactAuthority(input: {
    readonly originManifestPath: string;
    readonly reviewManifestPath?: string;
  }): Promise<MarketplaceMutationAuthority>;
}

export type MarketplaceReviewClaimAcquisition =
  | {
      readonly status: 'confirmed';
      readonly claim: ConfirmedMarketplaceReviewClaim;
    }
  | {
      readonly status: 'lost' | 'ambiguous' | 'human' | 'ineligible';
      readonly detail?: string;
    };

export interface MarketplaceReviewClaimPort {
  acquireOrRecover(input: {
    readonly prNumber: number;
    readonly expectedHead: GitOid;
    readonly origin: {
      readonly v2AttemptId: string;
      readonly manifestPath: string;
      readonly correlation: AutopilotCorrelation;
    };
    readonly priorReviewRefOid?: GitOid;
  }): Promise<MarketplaceReviewClaimAcquisition>;
}

export interface MarketplaceMutationManifestReceiptPort {
  record(input: {
    readonly manifestPath: string;
    readonly receipt: AutopilotAdoptionReceipt;
    readonly commentId: number;
    readonly taskProvenance: MarketplaceTaskProvenance;
    readonly reviewClaim?: ConfirmedMarketplaceReviewClaim;
  }): Promise<void> | void;
}

export type MarketplaceMutationAdoptionBoundary =
  | 'validated'
  | 'patch-applied'
  | 'verified'
  | 'committed'
  | 'checkpointed'
  | 'completed'
  | 'review-claimed'
  | 'receipt-published';

export type MarketplaceMutationAdoptionOperation =
  | 'implementation-complete'
  | 'child-complete';

export type MarketplaceMutationAdoptionResult =
  | {
      readonly status: 'accepted';
      readonly operation: MarketplaceMutationAdoptionOperation;
      readonly origin: {
        readonly v2AttemptId: string;
        readonly manifestPath: string;
        readonly correlation: AutopilotCorrelation;
      };
      readonly taskProvenance: MarketplaceTaskProvenance;
      readonly hostCommit: {
        readonly head: GitOid;
        readonly tree: GitOid;
      };
      readonly resultingHead: GitOid;
      readonly reviewClaim: ConfirmedMarketplaceReviewClaim;
      readonly receipt: AutopilotAdoptionReceipt;
      readonly publication: 'published' | 'already-published';
    }
  | {
      readonly status: 'rejected';
      readonly reason: AutopilotAdoptionRejectionReason;
      readonly detail: string;
      readonly receipt: AutopilotAdoptionReceipt;
      readonly publication: 'published' | 'already-published' | 'not-published';
    }
  | {
      readonly status: 'recoverable';
      readonly stage: string;
      readonly detail: string;
    };

export interface MarketplaceMutationAdoptionCoordinator {
  adopt(
    reference: MarketplaceMutationDeliveryReference,
  ): Promise<MarketplaceMutationAdoptionResult>;
}

export interface MarketplaceMutationAdoptionDependencies {
  readonly deliveries: VerifiedMarketplaceSolutionDeliveryPort;
  readonly authority: MarketplaceMutationAuthorityPort;
  readonly git: MarketplaceMutationGitPort;
  readonly verification: MarketplaceMutationVerificationPort;
  readonly implementation: ImplementationSessionProtocol;
  readonly reviewClaims: MarketplaceReviewClaimPort;
  readonly receipts: AdoptionReceiptPorts;
  readonly manifestReceipts: MarketplaceMutationManifestReceiptPort;
  readonly applyPatch?: (
    input: ApplyMarketplacePatchInput,
  ) => Promise<ValidatedMarketplacePatch>;
  readonly now?: () => Date;
  readonly onBoundary?: (
    boundary: MarketplaceMutationAdoptionBoundary,
  ) => Promise<void> | void;
}

interface ParsedDelivery {
  readonly delivery: VerifiedMarketplaceSolutionDelivery;
  readonly session: AutopilotSessionCapsule;
  readonly result: AutopilotMutationResult;
  readonly correlation: AutopilotCorrelation;
  readonly patch?: ValidatedMarketplacePatch;
  readonly artifact?: Uint8Array;
}

interface StableFailure {
  readonly reason: AutopilotAdoptionRejectionReason;
  readonly detail: string;
}

type PureValidation =
  | { readonly ok: true; readonly parsed: ParsedDelivery }
  | {
      readonly ok: false;
      readonly failure: StableFailure;
      readonly parsed: Omit<ParsedDelivery, 'patch' | 'artifact'>;
    };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRANSACTION_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const normalized = (values: readonly string[]) =>
    [...new Set(values.map((value) => value.trim().toLowerCase()))].sort();
  const a = normalized(left);
  const b = normalized(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function expectedCorrelation(
  delivery: VerifiedMarketplaceSolutionDelivery,
  session: AutopilotSessionCapsule,
): AutopilotCorrelation {
  return AutopilotCorrelationSchema.parse({
    taskId: delivery.task.id,
    attemptIndex: delivery.attempt.index,
    requestId: delivery.request.id,
    deliveryEnvelopeCid: delivery.envelope.cid,
    v2AttemptId: delivery.attempt.v2AttemptId,
    claimOid: session.claimOid,
    prNumber: session.prNumber,
    expectedHead: session.expectedHead,
  });
}

function baseParsedDelivery(
  delivery: VerifiedMarketplaceSolutionDelivery,
): Omit<ParsedDelivery, 'patch' | 'artifact'> {
  const session = AutopilotSessionCapsuleSchema.parse(delivery.session);
  const result = AutopilotMutationResultSchema.parse(delivery.result);
  return {
    delivery,
    session,
    result,
    correlation: expectedCorrelation(delivery, session),
  };
}

function pureValidateDelivery(
  delivery: VerifiedMarketplaceSolutionDelivery,
): PureValidation {
  let parsed: Omit<ParsedDelivery, 'patch' | 'artifact'>;
  try {
    parsed = baseParsedDelivery(delivery);
  } catch {
    // A verified-delivery port promises these shapes. If it violates that
    // contract, retain the typed input's stable correlation for a rejection.
    try {
      const session = delivery.session;
      parsed = {
        delivery,
        session,
        result: delivery.result,
        correlation: expectedCorrelation(delivery, session),
      };
    } catch {
      throw new Error('Verified Solution delivery violated its typed contract');
    }
    return {
      ok: false,
      parsed,
      failure: {
        reason: 'invalid-artifact',
        detail: 'Mutation result or session capsule failed its strict schema',
      },
    };
  }
  const { session, result, correlation } = parsed;
  if (
    delivery.schemaVersion !== 'jinn-autopilot-verified-solution-delivery.v1'
    || delivery.attempt.v2AttemptId !== session.v2AttemptId
    || delivery.attempt.manifestPath.length === 0
    || delivery.operator.role !== 'solver'
    || delivery.operator.id === ''
    || delivery.envelope.author !== delivery.operator.id
    || !ADDRESS_PATTERN.test(delivery.operator.address)
    || !TRANSACTION_PATTERN.test(delivery.transaction.hash)
    || !Number.isSafeInteger(delivery.transaction.blockNumber)
    || delivery.transaction.blockNumber < 0
    || !TRANSACTION_PATTERN.test(delivery.task.creationTransactionHash)
    || !Number.isSafeInteger(delivery.task.creationBlockNumber)
    || delivery.task.creationBlockNumber < 0
  ) {
    return {
      ok: false,
      parsed,
      failure: {
        reason: 'untrusted-operator',
        detail: 'Verified delivery provenance or operator authorship is invalid',
      },
    };
  }
  if (!autopilotCorrelationMatches(correlation, result.correlation)) {
    return {
      ok: false,
      parsed,
      failure: {
        reason: 'correlation-mismatch',
        detail: 'Mutation result does not match the exact delivery/session tuple',
      },
    };
  }
  if (result.outcome === 'human') return { ok: true, parsed };

  const artifact = new TextEncoder().encode(result.patch);
  try {
    return {
      ok: true,
      parsed: {
        ...parsed,
        artifact,
        patch: validateMarketplacePatch(artifact),
      },
    };
  } catch (error) {
    if (error instanceof MarketplacePatchValidationError) {
      return {
        ok: false,
        parsed,
        failure: {
          reason: 'invalid-artifact',
          detail: `Marketplace patch is invalid: ${error.reason}`,
        },
      };
    }
    throw error;
  }
}

function deliveryMatchesReference(
  reference: MarketplaceMutationDeliveryReference,
  delivery: VerifiedMarketplaceSolutionDelivery,
): boolean {
  return reference.taskId === delivery.task.id
    && reference.attemptIndex === delivery.attempt.index
    && reference.requestId === delivery.request.id
    && reference.deliveryEnvelopeCid === delivery.envelope.cid;
}

function workflowClaimPhase(
  workflow: AutopilotWorkflow,
): BranchClaim['phase'] {
  if (workflow === 'implement') return 'implement';
  if (workflow === 'reconcile') return 'reconcile';
  return 'fix';
}

function childKind(
  workflow: AutopilotWorkflow,
): MarketplaceMutationChildFacts['kind'] | undefined {
  if (workflow === 'implement') return undefined;
  if (workflow === 'reconcile') return 'reconcile';
  if (workflow === 'ci-failure') return 'ci-failure';
  return 'review-finding';
}

function authorityFailure(
  parsed: ParsedDelivery | Omit<ParsedDelivery, 'patch' | 'artifact'>,
  authority: MarketplaceMutationAuthority,
  options: {
    readonly allowHuman: boolean;
    readonly allowClosedChild?: boolean;
  },
): StableFailure | null {
  const { delivery, session } = parsed;
  const manifest = authority.manifest;
  const execution = manifest.execution;
  const expectedIssue = session.workflow === 'implement'
    ? session.issueNumber
    : session.childIssueNumber;
  if (
    manifest.phase !== 'implement'
    || manifest.attemptId !== session.v2AttemptId
    || manifest.paths.manifest !== delivery.attempt.manifestPath
    || manifest.paths.worktree.length === 0
    || manifest.issueNumber !== expectedIssue
    || manifest.prNumber !== session.prNumber
    || manifest.branch !== session.branch
    || manifest.targetBase !== session.targetBase
    || manifest.claimOid !== session.claimOid
    || execution.backend !== 'marketplace'
    || execution.taskId !== delivery.task.id
    || execution.attemptIndex !== delivery.attempt.index
    || execution.requestId !== delivery.request.id
    || execution.deliveryEnvelopeCid !== delivery.envelope.cid
  ) {
    return {
      reason: 'correlation-mismatch',
      detail: 'Attempt manifest no longer matches the exact delivered session',
    };
  }
  if (manifest.processState !== 'running') {
    return {
      reason: 'stale-claim',
      detail: 'Marketplace attempt is no longer running',
    };
  }
  if (
    (
      authority.trustedOperatorIds.length > 0
      && !authority.trustedOperatorIds.includes(delivery.operator.id)
    )
    || !sameStrings(authority.receiptAuthors, session.receiptAuthors)
    || !session.receiptAuthors.some(
      (author) => author.toLowerCase() === authority.publisherLogin.toLowerCase(),
    )
  ) {
    return {
      reason: 'untrusted-operator',
      detail: 'Operator or receipt-author policy does not authorize this delivery',
    };
  }
  const claim = authority.latestClaim;
  if (
    claim.phase !== workflowClaimPhase(session.workflow)
    || claim.issueNumber !== manifest.issueNumber
    || claim.prNumber !== session.prNumber
    || claim.attempt !== session.v2AttemptId
    || claim.runner !== session.runnerId
    || claim.login.toLowerCase() !== manifest.selectedLogin.toLowerCase()
    || claim.targetBase !== session.targetBase
    || (
      claim.phaseComplete === true
        ? authority.latestClaimOid !== authority.remoteHead
        : authority.latestClaimOid !== manifest.claimOid
    )
  ) {
    return {
      reason: 'stale-claim',
      detail: 'Implementation attempt no longer owns the exact claim',
    };
  }
  const pullRequest = authority.pullRequest;
  if (
    authority.remoteHead !== manifest.expectedHead
    || pullRequest.head !== authority.remoteHead
  ) {
    return {
      reason: 'stale-head',
      detail: 'Current branch or pull request head changed',
    };
  }
  const lifecycleMarker =
    `<!-- jinn-autopilot:v2 issue=${session.issueNumber} branch=${session.branch} -->`;
  if (
    !pullRequest.open
    || pullRequest.number !== session.prNumber
    || pullRequest.headRefName !== session.branch
    || pullRequest.baseRefName !== session.targetBase
    || !pullRequest.body.includes(lifecycleMarker)
  ) {
    return {
      reason: 'correlation-mismatch',
      detail: 'Pull request mapping no longer matches the session capsule',
    };
  }
  const expectedChildKind = childKind(session.workflow);
  if (
    expectedChildKind === undefined
      ? authority.child !== undefined
      : authority.child === undefined
        || authority.child.number !== session.childIssueNumber
        || authority.child.parentPrNumber !== session.parentPrNumber
        || authority.child.kind !== expectedChildKind
        || (!options.allowClosedChild && !authority.child.open)
  ) {
    return {
      reason: 'correlation-mismatch',
      detail: 'Child/parent workflow facts no longer match the session capsule',
    };
  }
  if (
    authority.pullRequest.codeOwner.required
    || authority.pullRequest.codeOwner.paths.length > 0
    || (!options.allowHuman && authority.pullRequest.human.active)
  ) {
    return {
      reason: 'policy-human',
      detail: 'Marketplace v1 excludes Human and CODEOWNER surfaces',
    };
  }
  return null;
}

function receiptCorrelation(receipt: AutopilotAdoptionReceipt): AutopilotCorrelation {
  return AutopilotCorrelationSchema.parse({
    taskId: receipt.taskId,
    attemptIndex: receipt.attemptIndex,
    requestId: receipt.requestId,
    deliveryEnvelopeCid: receipt.deliveryEnvelopeCid,
    v2AttemptId: receipt.v2AttemptId,
    claimOid: receipt.claimOid,
    prNumber: receipt.prNumber,
    expectedHead: receipt.expectedHead,
    ...(receipt.resultingHead === undefined
      ? {}
      : { resultingHead: receipt.resultingHead }),
    ...(receipt.reviewGeneration === undefined
      ? {}
      : { reviewGeneration: receipt.reviewGeneration }),
    ...(receipt.reviewRefOid === undefined
      ? {}
      : { reviewRefOid: receipt.reviewRefOid }),
  });
}

function commentId(publication: PublishAdoptionReceiptResult): number {
  if (publication.status === 'published') return publication.comment.id;
  const ids = publication.comments.map(({ id }) => id).sort((a, b) => a - b);
  if (ids[0] === undefined) {
    throw new Error('Existing adoption receipt has no durable comment ID');
  }
  return ids[0];
}

function publicationStatus(
  publication: PublishAdoptionReceiptResult,
): 'published' | 'already-published' {
  return publication.status;
}

function rejectedReceipt(
  parsed: ParsedDelivery | Omit<ParsedDelivery, 'patch' | 'artifact'>,
  failure: StableFailure,
  now: () => Date,
  extras: {
    readonly resultingHead?: GitOid;
    readonly reviewClaim?: ConfirmedMarketplaceReviewClaim;
  } = {},
): AutopilotAdoptionReceipt {
  return AutopilotAdoptionReceiptSchema.parse({
    schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
    disposition: 'rejected',
    role: 'solution',
    reason: failure.reason,
    detail: failure.detail,
    ...parsed.correlation,
    ...(extras.resultingHead === undefined
      ? {}
      : { resultingHead: extras.resultingHead }),
    ...(extras.reviewClaim === undefined
      ? {}
      : {
          reviewGeneration: extras.reviewClaim.generation,
          reviewRefOid: extras.reviewClaim.refOid,
        }),
    recordedAt: now().toISOString(),
  });
}

async function publishReceipt(
  receipt: AutopilotAdoptionReceipt,
  authority: MarketplaceMutationAuthority,
  session: AutopilotSessionCapsule,
  ports: AdoptionReceiptPorts,
): Promise<PublishAdoptionReceiptResult> {
  const exactFacts = receiptExactFacts(receipt);
  return publishAdoptionReceipt({
    receipt,
    exactFacts,
    expectedPublicationHead: authority.pullRequest.head,
    allowedAuthors: session.receiptAuthors,
    publisherLogin: authority.publisherLogin,
  }, ports);
}

function receiptExactFacts(
  receipt: AutopilotAdoptionReceipt,
): AdoptionReceiptExactFacts {
  return {
    role: 'solution',
    correlation: receiptCorrelation(receipt),
    prHead: receipt.resultingHead ?? receipt.expectedHead,
  };
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
  session: AutopilotSessionCapsule,
  ports: AdoptionReceiptPorts,
): Promise<AutopilotAdoptionReceipt> {
  const state = await readAdoptionReceiptState(
    receiptExactFacts(candidate),
    session.receiptAuthors,
    ports,
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

async function persistReceipt(
  publication: PublishAdoptionReceiptResult,
  parsed: ParsedDelivery | Omit<ParsedDelivery, 'patch' | 'artifact'>,
  reviewClaim: ConfirmedMarketplaceReviewClaim | undefined,
  deps: MarketplaceMutationAdoptionDependencies,
): Promise<void> {
  await deps.manifestReceipts.record({
    manifestPath: parsed.delivery.attempt.manifestPath,
    receipt: publication.receipt,
    commentId: commentId(publication),
    taskProvenance: {
      creationTransactionHash: parsed.delivery.task.creationTransactionHash,
      creationBlockNumber: parsed.delivery.task.creationBlockNumber,
      ...(parsed.delivery.task.solverNetManifestCid === undefined
        ? {}
        : { solverNetManifestCid: parsed.delivery.task.solverNetManifestCid }),
    },
    ...(reviewClaim === undefined ? {} : { reviewClaim }),
  });
}

async function requireHumanAuthority(
  parsed: ParsedDelivery | Omit<ParsedDelivery, 'patch' | 'artifact'>,
  authority: MarketplaceMutationAuthority,
  detail: string,
  deps: MarketplaceMutationAdoptionDependencies,
): Promise<MarketplaceMutationAuthority> {
  await deps.implementation.human(authority.manifest, detail);
  const readback = await readAuthority(parsed, deps);
  const human = readback.pullRequest.human;
  if (!human.active || !human.draft || !human.label || !human.comment) {
    throw new Error('Human hold did not read back durably');
  }
  return readback;
}

async function stableReject(
  parsed: ParsedDelivery | Omit<ParsedDelivery, 'patch' | 'artifact'>,
  failure: StableFailure,
  authority: MarketplaceMutationAuthority,
  deps: MarketplaceMutationAdoptionDependencies,
  extras?: {
    readonly resultingHead?: GitOid;
    readonly reviewClaim?: ConfirmedMarketplaceReviewClaim;
  },
): Promise<MarketplaceMutationAdoptionResult> {
  let publicationAuthority = authority;
  if (failure.reason === 'receipt-contradiction') {
    publicationAuthority = await requireHumanAuthority(
      parsed,
      authority,
      failure.detail,
      deps,
    );
  }
  const receipt = await recoverDurableReceipt(rejectedReceipt(
    parsed,
    failure,
    deps.now ?? (() => new Date()),
    extras,
  ), parsed.session, deps.receipts);
  try {
    const publication = await publishReceipt(
      receipt,
      publicationAuthority,
      parsed.session,
      deps.receipts,
    );
    await deps.onBoundary?.('receipt-published');
    await persistReceipt(publication, parsed, extras?.reviewClaim, deps);
    return {
      status: 'rejected',
      reason: failure.reason,
      detail: failure.detail,
      receipt: publication.receipt,
      publication: publicationStatus(publication),
    };
  } catch (error) {
    if (
      error instanceof AdoptionReceiptPublicationError
      && (
        error.code === 'receipt-contradiction'
        || error.code === 'different-disposition'
        || error.code === 'different-receipt'
      )
    ) {
      if (failure.reason !== 'receipt-contradiction') {
        await requireHumanAuthority(parsed, authority, error.message, deps);
      }
      return {
        status: 'rejected',
        reason: 'receipt-contradiction',
        detail: error.message,
        receipt: rejectedReceipt(parsed, {
          reason: 'receipt-contradiction',
          detail: error.message,
        }, deps.now ?? (() => new Date()), extras),
        publication: 'not-published',
      };
    }
    throw error;
  }
}

function validReviewClaim(
  claim: ConfirmedMarketplaceReviewClaim,
  parsed: ParsedDelivery,
  resultingHead: GitOid,
): boolean {
  const manifest = claim.manifest;
  return claim.head === resultingHead
    && claim.state === 'active'
    && claim.attemptId !== parsed.session.v2AttemptId
    && UUID_PATTERN.test(claim.attemptId)
    && UUID_PATTERN.test(claim.generation)
    && claim.approvalPolicy === 'approve-eligible'
    && manifest.phase === 'review'
    && manifest.attemptId === claim.attemptId
    && manifest.prNumber === parsed.session.prNumber
    && manifest.expectedHead === resultingHead
    && manifest.claimOid === claim.refOid
    && manifest.reviewGeneration === claim.generation
    && manifest.reviewRefOid === claim.refOid
    && manifest.reviewApprovalPolicy === claim.approvalPolicy
    && manifest.paths.manifest.length > 0;
}

function completionReadbackFailure(
  parsed: ParsedDelivery,
  authority: MarketplaceMutationAuthority,
  resultingHead: GitOid,
): StableFailure | null {
  if (
    authority.remoteHead !== resultingHead
    || authority.pullRequest.head !== resultingHead
  ) {
    return {
      reason: 'stale-head',
      detail: 'Completion did not read back on the exact resulting head',
    };
  }
  if (parsed.session.workflow === 'implement') {
    if (
      authority.latestClaim.phaseComplete !== true
      || authority.latestClaimOid !== resultingHead
      || authority.pullRequest.draft
      || !authority.pullRequest.labels.includes('engine:review')
      || authority.pullRequest.implementationSummary?.trim()
        !== (parsed.result.outcome === 'mutation-complete'
          ? parsed.result.summary.trim()
          : '')
    ) {
      return {
        reason: 'receipt-contradiction',
        detail: 'Implementation completion did not converge durably',
      };
    }
  } else if (authority.child?.open !== false) {
    return {
      reason: 'receipt-contradiction',
      detail: 'Child completion did not close the exact child',
    };
  }
  return null;
}

async function readAuthority(
  parsed: ParsedDelivery | Omit<ParsedDelivery, 'patch' | 'artifact'>,
  deps: MarketplaceMutationAdoptionDependencies,
  reviewManifestPath?: string,
): Promise<MarketplaceMutationAuthority> {
  return deps.authority.readExactAuthority({
    originManifestPath: parsed.delivery.attempt.manifestPath,
    ...(reviewManifestPath === undefined ? {} : { reviewManifestPath }),
  });
}

function currentProtocolCompletion(
  authority: MarketplaceMutationAuthority,
): MarketplaceMutationCommitIdentity['protocolCompletion'] {
  const claim = authority.latestClaim;
  if (claim.phase !== 'implement' || claim.phaseComplete !== true) {
    return undefined;
  }
  return {
    head: authority.latestClaimOid,
    claim: {
      ...claim,
      phaseComplete: true,
    },
  };
}

async function adoptParsed(
  validation: PureValidation,
  deps: MarketplaceMutationAdoptionDependencies,
): Promise<MarketplaceMutationAdoptionResult> {
  let authority = await readAuthority(validation.parsed, deps);
  if (!validation.ok) {
    return stableReject(
      validation.parsed,
      validation.failure,
      authority,
      deps,
    );
  }
  const parsed = validation.parsed;
  const allowHuman = parsed.result.outcome === 'human';
  let failure = authorityFailure(parsed, authority, {
    allowHuman,
    allowClosedChild: true,
  });
  if (failure !== null) {
    return stableReject(parsed, failure, authority, deps);
  }
  await deps.onBoundary?.('validated');

  if (parsed.result.outcome === 'human') {
    authority = await requireHumanAuthority(
      parsed,
      authority,
      `${parsed.result.reason.code}: ${parsed.result.reason.detail}`,
      deps,
    );
    return stableReject(parsed, {
      reason: 'policy-human',
      detail: parsed.result.reason.detail,
    }, authority, deps);
  }

  const patch = parsed.patch!;
  const artifact = parsed.artifact!;
  const childIssueNumber = parsed.session.workflow === 'implement'
    ? undefined
    : parsed.session.childIssueNumber;
  const protocolCompletion = currentProtocolCompletion(authority);
  const commitIdentity: MarketplaceMutationCommitIdentity = {
    worktreePath: authority.manifest.paths.worktree,
    expectedHead: parsed.session.expectedHead as GitOid,
    artifact,
    workflow: parsed.session.workflow,
    touchedPaths: patch.touchedPaths,
    summary: parsed.result.summary,
    taskId: parsed.delivery.task.id,
    requestId: parsed.delivery.request.id,
    deliveryEnvelopeCid: parsed.delivery.envelope.cid,
    v2AttemptId: parsed.session.v2AttemptId,
    ...(childIssueNumber === undefined ? {} : { childIssueNumber }),
    ...(parsed.session.workflow === 'reconcile'
      ? { reconcileBase: parsed.session.taskSnapshot.baseSha as GitOid }
      : {}),
    ...(protocolCompletion === undefined
      ? {}
      : { protocolCompletion }),
  };

  let gitState = await deps.git.readState(commitIdentity);
  if (gitState.status === 'contradiction') {
    return stableReject(parsed, {
      reason: 'receipt-contradiction',
      detail: gitState.detail,
    }, authority, deps);
  }
  if (
    parsed.session.workflow !== 'implement'
    && authority.child?.open === false
    && gitState.status !== 'committed'
  ) {
    return stableReject(parsed, {
      reason: 'stale-claim',
      detail:
        'Child is already closed without an exact recoverable marketplace host commit',
    }, authority, deps);
  }
  if (gitState.status === 'clean') {
    try {
      const applied = await (deps.applyPatch ?? applyMarketplacePatchToWorktree)({
        artifact,
        worktreePath: authority.manifest.paths.worktree,
      });
      if (
        applied.byteLength !== patch.byteLength
        || applied.touchedPaths.length !== patch.touchedPaths.length
        || applied.touchedPaths.some(
          (path, index) => path !== patch.touchedPaths[index],
        )
      ) {
        return stableReject(parsed, {
          reason: 'receipt-contradiction',
          detail: 'Applied patch readback differs from pure validation',
        }, authority, deps);
      }
    } catch (error) {
      if (
        error instanceof MarketplacePatchValidationError
        || error instanceof MarketplacePatchWorktreeValidationError
        || (
          error instanceof MarketplacePatchApplicationError
          && error.reason === 'invalid-worktree-path'
        )
      ) {
        return stableReject(parsed, {
          reason: 'invalid-artifact',
          detail: error.message,
        }, authority, deps);
      }
      if (error instanceof MarketplacePatchCheckError) {
        return stableReject(parsed, {
          reason: 'patch-does-not-apply',
          detail: error.message,
        }, authority, deps);
      }
      throw error;
    }
    await deps.onBoundary?.('patch-applied');
    gitState = await deps.git.readState(commitIdentity);
  }
  if (gitState.status === 'clean') {
    return stableReject(parsed, {
      reason: 'invalid-artifact',
      detail: 'Marketplace patch produced no real tree change',
    }, authority, deps);
  }
  if (gitState.status === 'contradiction') {
    return stableReject(parsed, {
      reason: 'receipt-contradiction',
      detail: gitState.detail,
    }, authority, deps);
  }
  if (gitState.status === 'pending-change') {
    let verification: MarketplaceMutationVerificationResult;
    try {
      verification = await deps.verification.verify({
        profile: JINN_MONO_VERIFICATION_PROFILE,
        repositoryPath: authority.manifest.paths.worktree,
        touchedPaths: patch.touchedPaths,
      });
    } catch (error) {
      if (
        error instanceof MarketplaceVerificationPlanError
        && (error.code === 'invalid-path' || error.code === 'unsupported-path')
      ) {
        return stableReject(parsed, {
          reason: 'invalid-artifact',
          detail: error.message,
        }, authority, deps);
      }
      throw error;
    }
    if (verification.status === 'failed') {
      return stableReject(parsed, {
        reason: 'verification-failed',
        detail: `${verification.failedCommand}: ${verification.detail}`,
      }, authority, deps);
    }
    await deps.onBoundary?.('verified');
    authority = await readAuthority(parsed, deps);
    failure = authorityFailure(parsed, authority, {
      allowHuman: false,
      allowClosedChild: true,
    });
    if (failure !== null) return stableReject(parsed, failure, authority, deps);
    gitState = await deps.git.commit(commitIdentity);
    await deps.onBoundary?.('committed');
  }
  const hostCommit = gitState;

  authority = await readAuthority(parsed, deps);
  if (parsed.session.workflow === 'implement') {
    if (authority.latestClaim.phaseComplete !== true) {
      const checkpoint = await deps.implementation.checkpoint(authority.manifest);
      if (checkpoint.status === 'stale') {
        return stableReject(parsed, {
          reason: 'stale-head',
          detail: 'Checkpoint lost the exact head fence',
        }, authority, deps);
      }
      if (checkpoint.status === 'ambiguous') {
        throw new Error('Checkpoint publication is ambiguous');
      }
    }
    await deps.onBoundary?.('checkpointed');
    authority = await readAuthority(parsed, deps);
  }

  let resultingHead: GitOid;
  let operation: MarketplaceMutationAdoptionOperation;
  if (parsed.session.workflow === 'implement') {
    operation = 'implementation-complete';
    if (authority.latestClaim.phaseComplete === true) {
      resultingHead = authority.remoteHead;
    } else {
      const completed = await deps.implementation.implementationComplete(
        authority.manifest,
        parsed.result.summary,
      );
      if (completed.status !== 'complete') {
        if (completed.pending === 'hold') {
          return stableReject(parsed, {
            reason: 'policy-human',
            detail: 'Implementation completion entered a Human hold',
          }, authority, deps);
        }
        throw new Error(
          `Implementation completion is recoverably pending: ${completed.pending}`,
        );
      }
      resultingHead = completed.head;
    }
  } else {
    operation = 'child-complete';
    resultingHead = hostCommit.head;
    if (authority.child?.open !== false) {
      if (deps.implementation.childComplete === undefined) {
        throw new Error('Existing child-complete protocol is unavailable');
      }
      const completed = await deps.implementation.childComplete(authority.manifest);
      if (completed.status !== 'closed') {
        return stableReject(parsed, {
          reason: 'receipt-contradiction',
          detail: completed.detail ?? 'Child completion was rejected',
        }, authority, deps, { resultingHead });
      }
    }
  }
  await deps.onBoundary?.('completed');
  authority = await readAuthority(parsed, deps);
  failure = authorityFailure(parsed, authority, {
    allowHuman: false,
    allowClosedChild: true,
  });
  if (failure !== null) {
    return stableReject(parsed, failure, authority, deps, { resultingHead });
  }
  failure = completionReadbackFailure(parsed, authority, resultingHead);
  if (failure !== null) {
    return stableReject(parsed, failure, authority, deps, { resultingHead });
  }

  const acquired = await deps.reviewClaims.acquireOrRecover({
    prNumber: parsed.session.prNumber,
    expectedHead: resultingHead,
    origin: {
      v2AttemptId: parsed.session.v2AttemptId,
      manifestPath: parsed.delivery.attempt.manifestPath,
      correlation: parsed.correlation,
    },
    ...(authority.reviewClaim === undefined
      ? {}
      : { priorReviewRefOid: authority.reviewClaim.refOid }),
  });
  if (acquired.status !== 'confirmed') {
    if (acquired.status === 'ambiguous') {
      throw new Error(
        acquired.detail ?? 'Review claim acquisition is ambiguous',
      );
    }
    if (acquired.status === 'human') {
      return stableReject(parsed, {
        reason: 'policy-human',
        detail:
          acquired.detail
          ?? 'Review claim acquisition requires Human authority',
      }, authority, deps, { resultingHead });
    }
    return stableReject(parsed, {
      reason: acquired.status === 'lost' ? 'stale-head' : 'stale-claim',
      detail: acquired.detail ?? 'Exact-head review claim was not acquired',
    }, authority, deps, { resultingHead });
  }
  const reviewClaim = acquired.claim;
  if (!validReviewClaim(reviewClaim, parsed, resultingHead)) {
    return stableReject(parsed, {
      reason: 'receipt-contradiction',
      detail: 'Review claim port returned a contradictory claim/manifest identity',
    }, authority, deps, { resultingHead });
  }
  await deps.onBoundary?.('review-claimed');
  authority = await readAuthority(
    parsed,
    deps,
    reviewClaim.manifest.paths.manifest,
  );
  const readbackReviewClaim = authority.reviewClaim;
  if (
    authority.pullRequest.head !== resultingHead
    || readbackReviewClaim === undefined
    || readbackReviewClaim.head !== reviewClaim.head
    || readbackReviewClaim.generation !== reviewClaim.generation
    || readbackReviewClaim.refOid !== reviewClaim.refOid
    || readbackReviewClaim.attemptId !== reviewClaim.attemptId
    || readbackReviewClaim.manifest.paths.manifest
      !== reviewClaim.manifest.paths.manifest
  ) {
    return stableReject(parsed, {
      reason: 'receipt-contradiction',
      detail: 'Review claim did not read back exactly',
    }, authority, deps, { resultingHead, reviewClaim });
  }

  const receipt = await recoverDurableReceipt(
    AutopilotAdoptionReceiptSchema.parse({
      schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
      disposition: 'accepted',
      role: 'solution',
      operation,
      ...parsed.correlation,
      resultingHead,
      reviewGeneration: reviewClaim.generation,
      reviewRefOid: reviewClaim.refOid,
      recordedAt: (deps.now ?? (() => new Date()))().toISOString(),
    }),
    parsed.session,
    deps.receipts,
  );
  let publication: PublishAdoptionReceiptResult;
  try {
    publication = await publishReceipt(
      receipt,
      authority,
      parsed.session,
      deps.receipts,
    );
  } catch (error) {
    if (
      error instanceof AdoptionReceiptPublicationError
      && (
        error.code === 'receipt-contradiction'
        || error.code === 'different-disposition'
        || error.code === 'different-receipt'
      )
    ) {
      await requireHumanAuthority(parsed, authority, error.message, deps);
      const failure = {
        reason: 'receipt-contradiction',
        detail: error.message,
      } as const;
      return {
        status: 'rejected',
        ...failure,
        receipt: rejectedReceipt(
          parsed,
          failure,
          deps.now ?? (() => new Date()),
          { resultingHead, reviewClaim },
        ),
        publication: 'not-published',
      };
    }
    throw error;
  }
  await deps.onBoundary?.('receipt-published');
  await persistReceipt(publication, parsed, reviewClaim, deps);
  return {
    status: 'accepted',
    operation,
    origin: {
      v2AttemptId: parsed.session.v2AttemptId,
      manifestPath: parsed.delivery.attempt.manifestPath,
      correlation: parsed.correlation,
    },
    taskProvenance: {
      creationTransactionHash: parsed.delivery.task.creationTransactionHash,
      creationBlockNumber: parsed.delivery.task.creationBlockNumber,
      ...(parsed.delivery.task.solverNetManifestCid === undefined
        ? {}
        : { solverNetManifestCid: parsed.delivery.task.solverNetManifestCid }),
    },
    hostCommit: {
      head: hostCommit.head,
      tree: hostCommit.tree,
    },
    resultingHead,
    reviewClaim,
    receipt,
    publication: publicationStatus(publication),
  };
}

export function makeMarketplaceMutationAdoptionCoordinator(
  deps: MarketplaceMutationAdoptionDependencies,
): MarketplaceMutationAdoptionCoordinator {
  return {
    async adopt(reference) {
      let stage = 'delivery-read';
      try {
        const delivery = await deps.deliveries.readVerifiedSolutionDelivery(reference);
        stage = 'delivery-fence';
        if (!deliveryMatchesReference(reference, delivery)) {
          throw new Error(
            'Verified delivery does not match the requested delivery tuple',
          );
        }
        stage = 'pure-validation';
        const validation = pureValidateDelivery(delivery);
        stage = 'adoption';
        return await adoptParsed(validation, deps);
      } catch (error) {
        return {
          status: 'recoverable',
          stage,
          detail: errorDetail(error),
        };
      }
    },
  };
}
