// SPDX-License-Identifier: Apache-2.0
import { deriveContributionAggregateStatus, type ContributionDestinationState } from "./state.js";
import type { VersionedContributionRequest } from "./store.js";
import type {
  ContributionDestinationOutcome,
  ContributionDestinationOutcomeStatus,
  ContributionReadModel,
} from "./types.js";

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

/**
 * Project one durable destination facet set into its safe public outcome.
 * Shared by the read model and the receipt so both surfaces agree exactly
 * on per-destination status, reason, and Publication identity.
 */
export function toDestinationOutcome(
  destination: ContributionDestinationState,
): ContributionDestinationOutcome {
  const failureReasonCode =
    destination.publication.status === "retryable-failure" ||
    destination.publication.status === "terminal-failure"
      ? destination.publication.reasonCode
      : undefined;
  return {
    destination: destination.destination,
    status: publicDestinationOutcomeStatus(destination),
    deactivated: destination.deactivation.requested,
    ...(destination.authorization.status === "denied"
      ? { reasonCode: destination.authorization.reasonCode }
      : failureReasonCode !== undefined
        ? { reasonCode: failureReasonCode }
        : {}),
    ...(destination.publication.status === "published"
      ? {
        publishedAt: destination.publication.publishedAt,
        bundleKey: destination.publication.bundleKey,
        payloadFingerprint: destination.publication.payloadFingerprint,
        locations: destination.publication.locations,
      }
      : {}),
  };
}

export function toDestinationOutcomes(
  destinations: readonly ContributionDestinationState[],
): readonly ContributionDestinationOutcome[] {
  return destinations.map(toDestinationOutcome);
}

/**
 * Project durable request state (with its store revision) into the safe,
 * immutable `ContributionReadModel`. Never includes Evidence payload
 * bytes, credentials, secret detector configuration, private findings,
 * paths, or opaque sink state -- only exact references/digests and the
 * closed safe vocabularies.
 */
export function createContributionReadModel(
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
    ...(preparation.status === "declined"
      ? { declinedReasonCode: preparation.reasonCode }
      : {}),
    destinations: toDestinationOutcomes(state.destinations),
    warnings: [],
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}
