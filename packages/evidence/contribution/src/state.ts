// SPDX-License-Identifier: Apache-2.0
import type { EvidenceRecordReference, Sha256Digest } from
  "@jinn-network/evidence-repository";

import { EvidenceContributionError } from "./errors.js";
import type {
  ContributionAggregateStatus,
  ContributionDecisionId,
  ContributionGrantId,
  ContributionReceipt,
  ContributionRequestId,
  ContributionResourceLimits,
  ContributionSafeAuditEventKind,
  ContributionSafeReasonCode,
  CreateContributionRequestInput,
  PreparedDisclosure,
  StandingGrantSourceScope,
  VerifiedDisclosurePolicyDecision,
  VerifiedExactAuthorization,
} from "./types.js";

export type { StandingGrantSourceScope } from "./types.js";

// Schema-version constants for these durable shapes are owned by
// `types.ts` (`CONTRIBUTION_REQUEST_STATE_SCHEMA_VERSION`,
// `CONTRIBUTION_SAFE_AUDIT_EVENT_SCHEMA_VERSION`,
// `CONTRIBUTION_GRANT_SCHEMA_VERSION`); this module only uses their fixed
// literal value (`1`) in the shapes below.

// ---------------------------------------------------------------------------
// Durable audit events
// ---------------------------------------------------------------------------

export interface ContributionAuditEvent {
  readonly schemaVersion: 1;
  readonly kind: ContributionSafeAuditEventKind;
  readonly at: string;
  readonly destination?: string;
  readonly reasonCode?: ContributionSafeReasonCode;
}

// ---------------------------------------------------------------------------
// Work claim
// ---------------------------------------------------------------------------

export interface ContributionWorkClaim {
  readonly ownerId: string;
  readonly generation: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

// ---------------------------------------------------------------------------
// Preparation facet
// ---------------------------------------------------------------------------

export type ContributionPreparationFacet =
  | { readonly status: "proposed" }
  | { readonly status: "preparing" }
  | {
      readonly status: "review-required";
      readonly reviewReference: string;
    }
  | {
      readonly status: "withheld";
      readonly reasons: readonly { readonly code: ContributionSafeReasonCode }[];
    }
  | {
      readonly status: "preview-ready";
      readonly disclosure: PreparedDisclosure;
    }
  | { readonly status: "declined"; readonly declinedAt: string };

export type ContributionPreparationStatus =
  ContributionPreparationFacet["status"];

// ---------------------------------------------------------------------------
// Destination facets
// ---------------------------------------------------------------------------

export type ContributionDestinationAuthorizationFacet =
  | { readonly status: "awaiting-authorization" }
  | { readonly status: "denied"; readonly reasonCode: ContributionSafeReasonCode }
  | { readonly status: "expired" }
  | { readonly status: "revoked" }
  | {
      readonly status: "authorized";
      readonly decisionId?: ContributionDecisionId;
      readonly grantId?: ContributionGrantId;
    };

export type ContributionDestinationPublicationFacet =
  | { readonly status: "not-started" }
  | { readonly status: "publishing" }
  | { readonly status: "published"; readonly publishedAt: string }
  | { readonly status: "retryable-failure" }
  | { readonly status: "terminal-failure" };

export interface ContributionDestinationDeactivationFacet {
  readonly requested: boolean;
  readonly requestedAt?: string;
}

export interface ContributionDestinationState {
  readonly destination: string;
  readonly authorization: ContributionDestinationAuthorizationFacet;
  readonly publication: ContributionDestinationPublicationFacet;
  readonly deactivation: ContributionDestinationDeactivationFacet;
}

function defaultDestinationState(destination: string): ContributionDestinationState {
  return {
    destination,
    authorization: { status: "awaiting-authorization" },
    publication: { status: "not-started" },
    deactivation: { requested: false },
  };
}

export function createDefaultContributionDestinationStates(
  disclosure: PreparedDisclosure,
): readonly ContributionDestinationState[] {
  return disclosure.manifest.destinations
    .map((prepared) => defaultDestinationState(prepared.descriptor.destination));
}

/**
 * Replace one destination's state by destination IRI, leaving every other
 * destination and field untouched. Unknown destinations are a no-op --
 * callers that must distinguish "unknown destination" fail closed
 * themselves before calling this.
 */
export function updateContributionDestinationState(
  destinations: readonly ContributionDestinationState[],
  destination: string,
  updater: (current: ContributionDestinationState) => ContributionDestinationState,
): readonly ContributionDestinationState[] {
  return destinations.map((current) =>
    current.destination === destination ? updater(current) : current);
}

// ---------------------------------------------------------------------------
// Contribution request state
// ---------------------------------------------------------------------------

export interface ContributionRequestState {
  readonly schemaVersion: 1;
  readonly requestId: ContributionRequestId;
  readonly idempotencyKey?: string;
  readonly proposal: CreateContributionRequestInput;
  readonly proposalFingerprint: Sha256Digest;
  readonly sealedIntent?: {
    readonly disclosureIntent: VerifiedDisclosurePolicyDecision;
    readonly intentFingerprint: Sha256Digest;
  };
  readonly preparation: ContributionPreparationFacet;
  readonly destinations: readonly ContributionDestinationState[];
  /**
   * Append-only history of verified exact-authorization decisions bound to
   * this request, keyed by `decisionId`. A destination's authorization
   * facet stores only the `decisionId`; the full verified decision (mode,
   * authority/actor, preview fingerprint, expiry) lives here so the read
   * model and receipt can project it without re-deriving trust.
   */
  readonly authorizationDecisions: readonly {
    readonly decisionId: ContributionDecisionId;
    readonly decision: VerifiedExactAuthorization;
  }[];
  readonly auditEvents: readonly ContributionAuditEvent[];
  readonly receipts: readonly {
    readonly receipt: ContributionReceipt;
    readonly receiptFingerprint: Sha256Digest;
  }[];
  readonly workClaim?: ContributionWorkClaim;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function createProposedContributionRequestState(input: {
  readonly requestId: ContributionRequestId;
  readonly proposal: CreateContributionRequestInput;
  readonly proposalFingerprint: Sha256Digest;
  readonly createdAt: string;
}): ContributionRequestState {
  return {
    schemaVersion: 1,
    requestId: input.requestId,
    ...(input.proposal.idempotencyKey !== undefined
      ? { idempotencyKey: input.proposal.idempotencyKey }
      : {}),
    proposal: input.proposal,
    proposalFingerprint: input.proposalFingerprint,
    preparation: { status: "proposed" },
    destinations: [],
    authorizationDecisions: [],
    auditEvents: [
      {
        schemaVersion: 1,
        kind: "proposed",
        at: input.createdAt,
      },
    ],
    receipts: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Standing authorization grant state
// ---------------------------------------------------------------------------

export interface StandingAuthorizationGrantState {
  readonly schemaVersion: 1;
  readonly grantId: ContributionGrantId;
  readonly authorityId: string;
  readonly actorId: string;
  readonly sourceScope: StandingGrantSourceScope;
  readonly allowedFamilies: readonly EvidenceRecordReference["family"][];
  readonly policyAuthorityIds: readonly string[];
  readonly policyProfiles: readonly string[];
  readonly policyDigests: readonly Sha256Digest[];
  readonly implementationDigests: readonly Sha256Digest[];
  readonly derivationConfigurationDigests: readonly Sha256Digest[];
  readonly destinationConfigurationDigests: readonly Sha256Digest[];
  readonly limits?: ContributionResourceLimits;
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly revocations: readonly {
    readonly at: string;
    readonly reasonCode: ContributionSafeReasonCode;
  }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Transition validation
// ---------------------------------------------------------------------------

const ALLOWED_PREPARATION_TRANSITIONS: ReadonlySet<string> = new Set([
  "proposed->declined",
  "proposed->preparing",
  "preparing->review-required",
  "preparing->withheld",
  "preparing->preview-ready",
  "preview-ready->declined",
]);

/**
 * Validate a preparation-facet transition against the fixed state machine
 * (design §12.1). Throws `STORE_CORRUPT` on any edge that is not
 * explicitly allowed, including a no-op "transition" to the same status.
 */
export function assertValidPreparationTransition(
  from: ContributionPreparationStatus,
  to: ContributionPreparationStatus,
): void {
  if (!ALLOWED_PREPARATION_TRANSITIONS.has(`${from}->${to}`)) {
    throw new EvidenceContributionError("STORE_CORRUPT");
  }
}

// ---------------------------------------------------------------------------
// Aggregate status derivation
// ---------------------------------------------------------------------------

type DestinationOutcomeClass =
  | "settled-published"
  | "settled-denied"
  | "settled-deactivated"
  | "failed-retryable"
  | "failed-terminal"
  | "active-publishing"
  | "active-authorized"
  | "awaiting-authorization";

function classifyDestinationState(
  destination: ContributionDestinationState,
): DestinationOutcomeClass {
  if (destination.publication.status === "published") {
    return "settled-published";
  }
  if (
    destination.deactivation.requested &&
    destination.publication.status !== "publishing"
  ) {
    return "settled-deactivated";
  }
  if (
    destination.authorization.status === "denied" ||
    destination.authorization.status === "expired" ||
    destination.authorization.status === "revoked"
  ) {
    return "settled-denied";
  }
  if (destination.publication.status === "retryable-failure") {
    return "failed-retryable";
  }
  if (destination.publication.status === "terminal-failure") {
    return "failed-terminal";
  }
  if (destination.publication.status === "publishing") {
    return "active-publishing";
  }
  if (destination.authorization.status === "authorized") {
    return "active-authorized";
  }
  return "awaiting-authorization";
}

/**
 * Derive the aggregate read status from durable facets (design §12.3).
 *
 * The preparation facet dominates until it reaches `preview-ready`; from
 * there the aggregate is derived from every destination's independent
 * authorization/publication/deactivation facets. Precedence among the
 * destination-driven aggregates: an all-deactivated or all-denied set
 * settles first; a completed set (at least one `published`, every other
 * destination `published`/`denied`/deactivated) settles next; any
 * remaining failure or denial mixed with other outcomes is
 * `attention-required`; an active destination without a mixed failure is
 * `publishing`; otherwise `awaiting-authorization`.
 */
export function deriveContributionAggregateStatus(
  state: ContributionRequestState,
): ContributionAggregateStatus {
  if (state.preparation.status !== "preview-ready") {
    return state.preparation.status;
  }
  const outcomes = state.destinations.map(classifyDestinationState);
  if (outcomes.length > 0 && outcomes.every((outcome) => outcome === "settled-deactivated")) {
    return "deactivated";
  }
  if (outcomes.length > 0 && outcomes.every((outcome) => outcome === "settled-denied")) {
    return "declined";
  }
  const completedCount = outcomes.filter((outcome) => outcome === "settled-published").length;
  const allOthersSettled = outcomes.every((outcome) =>
    outcome === "settled-published" ||
    outcome === "settled-denied" ||
    outcome === "settled-deactivated");
  if (completedCount > 0 && allOthersSettled) {
    return "completed";
  }
  const hasFailureOrDenial = outcomes.some((outcome) =>
    outcome === "failed-retryable" ||
    outcome === "failed-terminal" ||
    outcome === "settled-denied");
  if (hasFailureOrDenial) {
    return "attention-required";
  }
  if (outcomes.some((outcome) =>
    outcome === "active-publishing" || outcome === "active-authorized")) {
    return "publishing";
  }
  return "awaiting-authorization";
}

// ---------------------------------------------------------------------------
// Work claims
// ---------------------------------------------------------------------------

/**
 * Acquire the work claim for `state`, bumping its generation. A live
 * (unexpired) claim held by another owner is rejected with
 * `WORK_CLAIM_HELD`; an expired claim may be replaced.
 */
export function acquireContributionWorkClaim(
  state: ContributionRequestState,
  ownerId: string,
  now: string,
  expiresAt: string,
): ContributionRequestState {
  if (
    state.workClaim !== undefined &&
    state.workClaim.ownerId !== ownerId &&
    state.workClaim.expiresAt > now
  ) {
    throw new EvidenceContributionError("WORK_CLAIM_HELD");
  }
  const generation = (state.workClaim?.generation ?? 0) + 1;
  return {
    ...state,
    workClaim: { ownerId, generation, acquiredAt: now, expiresAt },
    updatedAt: now,
  };
}

/**
 * Release a work claim previously acquired by `ownerId` at exactly
 * `generation`. Releasing a stale or foreign claim is `STORE_CONFLICT`;
 * the claim is a contention optimization, not an authority boundary.
 */
export function releaseContributionWorkClaim(
  state: ContributionRequestState,
  ownerId: string,
  generation: number,
): ContributionRequestState {
  if (
    state.workClaim === undefined ||
    state.workClaim.ownerId !== ownerId ||
    state.workClaim.generation !== generation
  ) {
    throw new EvidenceContributionError("STORE_CONFLICT");
  }
  const { workClaim: _workClaim, ...rest } = state;
  return { ...rest };
}
