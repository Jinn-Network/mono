// SPDX-License-Identifier: Apache-2.0
import type { AuthorizationAuthority } from "./authorization.js";
import { EvidenceContributionError } from "./errors.js";
import type { PublicationResolver } from "./publication.js";
import type { DisclosurePolicyAuthority, DerivationResolver, ReviewReferenceStore } from
  "./policy.js";
import { resolveDisclosureRoute } from "./policy.js";
import { prepareExecutionDisclosure } from "./prepare-execution.js";
import { prepareReusableDisclosure } from "./prepare-reuse.js";
import { prepareSignedDisclosure } from "./prepare-signed.js";
import {
  createContributionProposalFingerprint,
  normalizeCreateContributionRequestInput,
  sealContributionIntent,
} from "./request.js";
import { loadAndValidateEvidenceSource } from "./source.js";
import type { RepositoryResolver } from "./source.js";
import {
  acquireContributionWorkClaim,
  createDefaultContributionDestinationStates,
  createProposedContributionRequestState,
  deriveContributionAggregateStatus,
  releaseContributionWorkClaim,
  type ContributionAuditEvent,
  type ContributionDestinationState,
  type ContributionRequestState,
} from "./state.js";
import type { ContributionStore, VersionedContributionRequest } from "./store.js";
import type {
  ContributionDecisionId,
  ContributionDestinationOutcome,
  ContributionDestinationOutcomeStatus,
  ContributionGrantId,
  ContributionOperationOptions,
  ContributionReadModel,
  ContributionRequestId,
  CreateContributionRequestInput,
  PreparationResult,
} from "./types.js";

export interface ContributionClock {
  now(): string;
}

export interface ContributionIdentifierSource {
  nextRequestId(): ContributionRequestId;
  nextDecisionId(): ContributionDecisionId;
  nextGrantId(): ContributionGrantId;
  nextWorkerId(): string;
}

export interface ContributionCommandBaseDependencies {
  readonly store: ContributionStore;
  readonly clock: ContributionClock;
  readonly identifiers: ContributionIdentifierSource;
}

function publicDestinationOutcomeStatus(
  destination: ContributionDestinationState,
): ContributionDestinationOutcomeStatus {
  if (destination.publication.status === "published") return "published";
  if (destination.publication.status === "retryable-failure") return "retryable-failure";
  if (destination.publication.status === "terminal-failure") return "terminal-failure";
  if (destination.publication.status === "publishing") return "publishing";
  if (
    destination.authorization.status === "denied" ||
    destination.authorization.status === "expired" ||
    destination.authorization.status === "revoked"
  ) {
    return "denied";
  }
  if (destination.authorization.status === "authorized") return "authorized";
  return "awaiting-authorization";
}

function toDestinationOutcome(
  destination: ContributionDestinationState,
): ContributionDestinationOutcome {
  return {
    destination: destination.destination,
    status: publicDestinationOutcomeStatus(destination),
    deactivated: destination.deactivation.requested,
    ...(destination.authorization.status === "denied"
      ? { reasonCode: destination.authorization.reasonCode }
      : destination.publication.status === "retryable-failure" ||
          destination.publication.status === "terminal-failure"
        ? { reasonCode: destination.publication.reasonCode }
        : {}),
    ...(destination.publication.status === "published"
      ? { publishedAt: destination.publication.publishedAt }
      : {}),
  };
}

/**
 * Project durable request state into the safe, immutable read model. This
 * is a minimal projection sufficient for the commands implemented through
 * Task 6; Task 9 owns the full `read-model.ts` projection (receipts,
 * warnings, and richer facet detail) and is expected to supersede this
 * helper.
 */
export function toContributionReadModel(
  versioned: VersionedContributionRequest,
): ContributionReadModel {
  const state = versioned.value;
  const preparation = state.preparation;
  return {
    schemaVersion: 1,
    requestId: state.requestId,
    revision: versioned.revision,
    status: deriveContributionAggregateStatus(state),
    source: state.proposal.source.record,
    policyDecision: state.proposal.policyDecision,
    ...(preparation.status === "preview-ready"
      ? {
        previewFingerprint: preparation.disclosure.previewFingerprint,
        manifestBytes: preparation.disclosure.manifestBytes,
      }
      : {}),
    ...(preparation.status === "review-required"
      ? { reviewReference: preparation.reviewReference }
      : {}),
    ...(preparation.status === "withheld"
      ? { withheldReasons: preparation.reasons }
      : {}),
    destinations: state.destinations.map(toDestinationOutcome),
    warnings: [],
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

/**
 * Create a new Contribution request from a caller-supplied proposal.
 *
 * If `idempotencyKey` matches an existing request with the same normalized
 * proposal fingerprint, that existing request is returned unchanged. A
 * reused key with a *different* proposal fingerprint is `STORE_CONFLICT`.
 */
export async function createContributionRequest(
  input: CreateContributionRequestInput,
  dependencies: ContributionCommandBaseDependencies,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel> {
  const proposalFingerprint = createContributionProposalFingerprint(input);
  const normalized = normalizeCreateContributionRequestInput(input);

  if (normalized.idempotencyKey !== undefined) {
    const existing = await dependencies.store.findRequestByIdempotencyKey(
      normalized.idempotencyKey,
      options,
    );
    if (existing !== null) {
      if (existing.value.proposalFingerprint !== proposalFingerprint) {
        throw new EvidenceContributionError("STORE_CONFLICT");
      }
      return toContributionReadModel(existing);
    }
  }

  const requestId = dependencies.identifiers.nextRequestId();
  const now = dependencies.clock.now();
  const state = createProposedContributionRequestState({
    requestId,
    proposal: normalized,
    proposalFingerprint,
    createdAt: now,
  });
  const created = await dependencies.store.createRequest(state, options);
  return toContributionReadModel(created);
}

/**
 * Load the current safe read model for a request. There is no dedicated
 * "request not found" error code in the closed Contribution vocabulary;
 * an unknown `requestId` is reported as `INVALID_INPUT`.
 */
export async function inspectContribution(
  requestId: ContributionRequestId,
  dependencies: Pick<ContributionCommandBaseDependencies, "store">,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel> {
  const versioned = await dependencies.store.loadRequest(requestId, options);
  if (versioned === null) {
    throw new EvidenceContributionError("INVALID_INPUT");
  }
  return toContributionReadModel(versioned);
}

export interface ContributionPreparationDependencies
  extends ContributionCommandBaseDependencies {
  readonly repositories: RepositoryResolver;
  readonly policies: DisclosurePolicyAuthority;
  readonly derivations: DerivationResolver;
  readonly reviews: ReviewReferenceStore;
}

/**
 * Dependency aggregate for exact-authorization commands
 * (`authorizeContribution`). The exact intersection of ports that command
 * uses -- never a generic service locator.
 */
export interface ContributionAuthorizationDependencies
  extends ContributionCommandBaseDependencies {
  readonly authorization: AuthorizationAuthority;
}

/**
 * Dependency aggregate for standing-grant commands
 * (`createStandingAuthorizationGrant`, `revokeStandingAuthorizationGrant`,
 * `applyStandingAuthorization`).
 */
export interface ContributionGrantDependencies
  extends ContributionCommandBaseDependencies {
  readonly authorization: AuthorizationAuthority;
}

/**
 * Dependency aggregate for per-destination Publication commands
 * (`publishContributionDestination`, `resumeContribution`,
 * `retryContributionDestination`).
 */
export interface ContributionPublicationDependencies
  extends ContributionCommandBaseDependencies {
  readonly repositories: RepositoryResolver;
  readonly publications: PublicationResolver;
}

const PREPARATION_CLAIM_MINUTES = 5;

function addMinutesToIsoTimestamp(at: string, minutes: number): string {
  return new Date(new Date(at).getTime() + minutes * 60_000).toISOString();
}

function buildPreparedRequestState(
  state: ContributionRequestState,
  result: PreparationResult,
  now: string,
): ContributionRequestState {
  if (result.status === "preview-ready") {
    const event: ContributionAuditEvent = {
      schemaVersion: 1,
      kind: "preview-ready",
      at: now,
    };
    return {
      ...state,
      preparation: { status: "preview-ready", disclosure: result.disclosure },
      destinations: createDefaultContributionDestinationStates(result.disclosure),
      auditEvents: [...state.auditEvents, event],
      updatedAt: now,
    };
  }
  if (result.status === "review-required") {
    const event: ContributionAuditEvent = {
      schemaVersion: 1,
      kind: "review-required",
      at: now,
    };
    return {
      ...state,
      preparation: { status: "review-required", reviewReference: result.reviewReference },
      auditEvents: [...state.auditEvents, event],
      updatedAt: now,
    };
  }
  const event: ContributionAuditEvent = { schemaVersion: 1, kind: "withheld", at: now };
  return {
    ...state,
    preparation: { status: "withheld", reasons: result.reasons },
    auditEvents: [...state.auditEvents, event],
    updatedAt: now,
  };
}

function preparationIdentitiesMatch(
  left: PreparationResult,
  right: PreparationResult,
): boolean {
  if (left.status !== right.status) return false;
  if (left.status === "preview-ready" && right.status === "preview-ready") {
    return left.disclosure.previewFingerprint === right.disclosure.previewFingerprint;
  }
  if (left.status === "review-required" && right.status === "review-required") {
    return left.reviewReference === right.reviewReference;
  }
  if (left.status === "withheld" && right.status === "withheld") {
    return JSON.stringify(left.reasons) === JSON.stringify(right.reasons);
  }
  return false;
}

/**
 * Prepare a Contribution request's disclosure: claim it, load and validate
 * the exact source, verify its source-bound policy route, seal the intent
 * exactly once, dispatch the route, and persist the immutable preparation
 * result. Idempotent: a request whose preparation is already resolved is
 * returned unchanged, and a concurrent CAS loss on the final write is
 * reconciled against whatever another worker already stored -- matching
 * identities are accepted, differing identities under the same sealed
 * intent are `STORE_CORRUPT`.
 *
 * Only the `derive-execution` route is dispatched here; Task 6 completes
 * `disclose-signed-unchanged`, `reuse-prepared`, and `withhold`.
 */
export async function prepareContribution(
  requestId: ContributionRequestId,
  dependencies: ContributionPreparationDependencies,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel> {
  let versioned = await dependencies.store.loadRequest(requestId, options);
  if (versioned === null) throw new EvidenceContributionError("INVALID_INPUT");
  if (
    options?.expectedRequestRevision !== undefined &&
    options.expectedRequestRevision !== versioned.revision
  ) {
    throw new EvidenceContributionError("STORE_CONFLICT");
  }
  if (versioned.value.preparation.status !== "proposed") {
    return toContributionReadModel(versioned);
  }

  const now = dependencies.clock.now();
  const ownerId = dependencies.identifiers.nextWorkerId();
  const claimExpiresAt = addMinutesToIsoTimestamp(now, PREPARATION_CLAIM_MINUTES);
  const claimedState = acquireContributionWorkClaim(
    versioned.value,
    ownerId,
    now,
    claimExpiresAt,
  );
  versioned = await dependencies.store.compareAndSwapRequest(
    versioned,
    claimedState,
    options,
  );

  const loadedSource = await loadAndValidateEvidenceSource(
    versioned.value.proposal.source,
    dependencies.repositories,
    options,
  );
  const route = await resolveDisclosureRoute(
    versioned.value.proposal.policyDecision,
    loadedSource.reference,
    dependencies.policies,
    now,
    options,
  );
  const sealed = sealContributionIntent({
    request: versioned.value.proposal,
    disclosureIntent: route,
  });

  const sealedState: ContributionRequestState = {
    ...versioned.value,
    preparation: { status: "preparing" },
    sealedIntent: {
      disclosureIntent: sealed.disclosureIntent,
      intentFingerprint: sealed.intentFingerprint,
    },
    updatedAt: now,
  };
  versioned = await dependencies.store.compareAndSwapRequest(
    versioned,
    sealedState,
    options,
  );

  let result: PreparationResult;
  switch (route.kind) {
    case "derive-execution":
      result = await prepareExecutionDisclosure(
        {
          requestId,
          intentFingerprint: sealed.intentFingerprint,
          source: loadedSource,
          sourceRepositoryBindingId: versioned.value.proposal.source.repositoryBindingId,
          stagingRepositoryBindingId: versioned.value.proposal.stagingRepositoryBindingId,
          route,
          destinations: versioned.value.proposal.destinations,
        },
        dependencies,
        options,
      );
      break;
    case "disclose-signed-unchanged":
      result = await prepareSignedDisclosure(
        {
          requestId,
          intentFingerprint: sealed.intentFingerprint,
          source: loadedSource,
          route,
          sourceRepositoryBindingId: versioned.value.proposal.source.repositoryBindingId,
          stagingRepositoryBindingId: versioned.value.proposal.stagingRepositoryBindingId,
          destinations: versioned.value.proposal.destinations,
        },
        dependencies.repositories,
        options,
      );
      break;
    case "reuse-prepared":
      result = await prepareReusableDisclosure(
        {
          requestId,
          intentFingerprint: sealed.intentFingerprint,
          source: loadedSource,
          route,
          sourceRepositoryBindingId: versioned.value.proposal.source.repositoryBindingId,
          stagingRepositoryBindingId: versioned.value.proposal.stagingRepositoryBindingId,
          destinations: versioned.value.proposal.destinations,
        },
        dependencies.repositories,
        options,
      );
      break;
    case "withhold":
      result = { status: "withheld", reasons: route.reasons };
      break;
  }

  const preparedState = buildPreparedRequestState(versioned.value, result, now);
  try {
    versioned = await dependencies.store.compareAndSwapRequest(
      versioned,
      preparedState,
      options,
    );
  } catch (cause) {
    if (!(cause instanceof EvidenceContributionError) || cause.code !== "STORE_CONFLICT") {
      throw cause;
    }
    const reloaded = await dependencies.store.loadRequest(requestId, options);
    if (
      reloaded === null ||
      reloaded.value.sealedIntent?.intentFingerprint !== sealed.intentFingerprint ||
      reloaded.value.preparation.status === "proposed" ||
      reloaded.value.preparation.status === "preparing"
    ) {
      throw cause;
    }
    const storedResult: PreparationResult = reloaded.value.preparation.status === "preview-ready"
      ? { status: "preview-ready", disclosure: reloaded.value.preparation.disclosure }
      : reloaded.value.preparation.status === "review-required"
        ? { status: "review-required", reviewReference: reloaded.value.preparation.reviewReference }
        : reloaded.value.preparation.status === "withheld"
          ? { status: "withheld", reasons: reloaded.value.preparation.reasons }
          : undefined as never;
    if (!preparationIdentitiesMatch(result, storedResult)) {
      throw new EvidenceContributionError("STORE_CORRUPT");
    }
    versioned = reloaded;
  }

  if (versioned.value.workClaim?.ownerId === ownerId) {
    const releasedState = releaseContributionWorkClaim(
      versioned.value,
      ownerId,
      versioned.value.workClaim.generation,
    );
    versioned = await dependencies.store.compareAndSwapRequest(
      versioned,
      releasedState,
      options,
    );
  }

  return toContributionReadModel(versioned);
}
