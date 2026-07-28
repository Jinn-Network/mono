// SPDX-License-Identifier: Apache-2.0
import { EvidenceContributionError } from "./errors.js";
import {
  createContributionProposalFingerprint,
  normalizeCreateContributionRequestInput,
} from "./request.js";
import {
  createProposedContributionRequestState,
  deriveContributionAggregateStatus,
  type ContributionDestinationState,
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
