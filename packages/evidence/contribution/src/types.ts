// SPDX-License-Identifier: Apache-2.0
import type { DerivationBindingImpact } from "@jinn-network/evidence-derivation";
import type {
  EvidenceArtifactReference,
  EvidenceRecordReference,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

export type ContributionRequestId = string;
export type ContributionGrantId = string;
export type ContributionDecisionId = string;

export type ContributionAggregateStatus =
  | "proposed"
  | "preparing"
  | "review-required"
  | "withheld"
  | "awaiting-authorization"
  | "publishing"
  | "attention-required"
  | "completed"
  | "declined"
  | "deactivated";

// ---------------------------------------------------------------------------
// Schema versions
// ---------------------------------------------------------------------------

export const CONTRIBUTION_PROPOSAL_SCHEMA_VERSION = 1 as const;
export const CONTRIBUTION_SEALED_INTENT_SCHEMA_VERSION = 1 as const;
export const CONTRIBUTION_MANIFEST_SCHEMA_VERSION = 1 as const;
export const CONTRIBUTION_EXACT_AUTHORIZATION_SCHEMA_VERSION = 1 as const;
export const CONTRIBUTION_GRANT_SCHEMA_VERSION = 1 as const;
export const CONTRIBUTION_REVOCATION_SCHEMA_VERSION = 1 as const;
export const CONTRIBUTION_REQUEST_STATE_SCHEMA_VERSION = 1 as const;
export const CONTRIBUTION_SAFE_AUDIT_EVENT_SCHEMA_VERSION = 1 as const;
export const CONTRIBUTION_READ_MODEL_SCHEMA_VERSION = 1 as const;
export const CONTRIBUTION_RECEIPT_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Request input
// ---------------------------------------------------------------------------

export interface EvidenceSourceSelection {
  readonly repositoryBindingId: string;
  readonly record: EvidenceRecordReference;
}

export interface DisclosurePolicyDecisionReference {
  readonly authorityId: string;
  readonly decisionId: string;
  readonly digest: Sha256Digest;
}

export interface ContributionDestination {
  readonly destination: string;
  readonly medium: string;
  readonly profile: string;
  readonly configurationDigest: Sha256Digest;
  readonly label: string;
  readonly irreversible: boolean;
  readonly deactivation: "supported" | "unsupported";
}

export interface ContributionResourceLimits {
  readonly maxDestinations: number;
  readonly maxArtifacts: number;
  readonly maxArtifactBytes: number;
  readonly maxTotalArtifactBytes: number;
  readonly maxManifestBytes: number;
  readonly maxConcurrentDestinations: number;
}

export interface CreateContributionRequestInput {
  readonly idempotencyKey?: string;
  readonly source: EvidenceSourceSelection;
  readonly stagingRepositoryBindingId: string;
  readonly policyDecision: DisclosurePolicyDecisionReference;
  readonly destinations: readonly ContributionDestination[];
  readonly limits: ContributionResourceLimits;
  readonly hostContext?: Readonly<Record<string, string>>;
  readonly supersedes?: ContributionRequestId;
}

export interface ContributionOperationOptions {
  readonly signal?: AbortSignal;
  readonly expectedRequestRevision?: number;
  readonly expectedGrantRevision?: number;
}

// ---------------------------------------------------------------------------
// Safe reason vocabulary
// ---------------------------------------------------------------------------

export const CONTRIBUTION_SAFE_REASON_CODES = [
  "POLICY_WITHHELD",
  "SENSITIVE_REVIEW_REQUIRED",
  "DESTINATION_DENIED",
  "GRANT_SCOPE_MISMATCH",
  "AUTHORIZATION_EXPIRED",
  "AUTHORIZATION_REVOKED",
  "ACCESS_DENIED",
  "BINDING_LIMIT_EXCEEDED",
  "WITHDRAWAL_UNSUPPORTED",
  "OPERATOR_ATTENTION_REQUIRED",
] as const;

export type ContributionSafeReasonCode =
  (typeof CONTRIBUTION_SAFE_REASON_CODES)[number];

// ---------------------------------------------------------------------------
// Verified source-bound disclosure-policy routes
//
// Every member carries the verified policy-decision reference it was
// resolved from, the exact source record it is bound to, the decision's
// issue/expiry times, and a family-compatible discriminant `kind`. Members
// never carry credentials or secret detector configuration -- those stay
// behind the host's DerivationResolver, represented only by digest.
// ---------------------------------------------------------------------------

export interface VerifiedDisclosurePolicyDecisionBase {
  readonly decision: DisclosurePolicyDecisionReference;
  readonly source: EvidenceRecordReference;
  readonly issuedAt: string;
  readonly expiresAt?: string;
}

export interface VerifiedDeriveExecutionDecision
  extends VerifiedDisclosurePolicyDecisionBase {
  readonly kind: "derive-execution";
  readonly policyInput: EvidenceArtifactReference;
  readonly implementationDescriptor: EvidenceArtifactReference;
  readonly sourceArtifacts: readonly {
    readonly entityId: string;
    readonly reference: EvidenceArtifactReference;
  }[];
  readonly policyDigest: Sha256Digest;
  readonly implementationDigest: Sha256Digest;
  readonly configurationDigest?: Sha256Digest;
  /** Identity of the Derivation scrubbing agent, required by
   * `EvidenceDeriver.derive`'s `scrubber.agentId`. */
  readonly scrubberAgentId: string;
  readonly completedAt: string;
  readonly risk: PreparedDisclosureRisk;
}

export interface VerifiedSignedUnchangedDecision
  extends VerifiedDisclosurePolicyDecisionBase {
  readonly kind: "disclose-signed-unchanged";
  readonly allowedCompanionArtifacts: readonly EvidenceArtifactReference[];
}

export interface VerifiedReuseDecision
  extends VerifiedDisclosurePolicyDecisionBase {
  readonly kind: "reuse-prepared";
  readonly priorManifest: EvidenceArtifactReference;
  readonly expectedPriorPreviewFingerprint: Sha256Digest;
  readonly preparedRecord: EvidenceRecordReference;
  readonly preparedArtifacts: readonly EvidenceArtifactReference[];
  readonly policyDigest: Sha256Digest;
  readonly implementationDigest: Sha256Digest;
}

export interface VerifiedWithholdDecision
  extends VerifiedDisclosurePolicyDecisionBase {
  readonly kind: "withhold";
  readonly reasons: readonly { readonly code: ContributionSafeReasonCode }[];
}

export type VerifiedDisclosurePolicyDecision =
  | VerifiedDeriveExecutionDecision
  | VerifiedSignedUnchangedDecision
  | VerifiedReuseDecision
  | VerifiedWithholdDecision;

// ---------------------------------------------------------------------------
// Prepared disclosure manifest
// ---------------------------------------------------------------------------

export interface PreparedUnavailableArtifact {
  readonly entityId: string;
  readonly reasonCode: string;
  readonly sourceCommitment?: Sha256Digest;
}

export interface PreparedDisclosureRisk {
  readonly irreversibility: "mutable-location" | "immutable-or-replicable";
  readonly sourceCommitmentCorrelation:
    | "none-declared"
    | "low"
    | "elevated"
    | "unknown";
}

export interface PreparedContributionDestination {
  readonly descriptor: ContributionDestination;
  readonly bundleKey: string;
  readonly payloadFingerprint: Sha256Digest;
}

export type PreparedDisclosurePreparation =
  | {
      readonly kind: "publishable-unchanged";
      readonly policyInput: EvidenceArtifactReference;
      readonly implementationDescriptor: EvidenceArtifactReference;
      readonly policyDigest: Sha256Digest;
      readonly implementationDigest: Sha256Digest;
      readonly configurationDigest?: Sha256Digest;
    }
  | {
      readonly kind: "derived";
      readonly derivationReceipt: EvidenceArtifactReference;
      readonly policyInput: EvidenceArtifactReference;
      readonly implementationDescriptor: EvidenceArtifactReference;
      readonly policyDigest: Sha256Digest;
      readonly implementationDigest: Sha256Digest;
      readonly configurationDigest?: Sha256Digest;
    }
  | { readonly kind: "signed-unchanged" }
  | {
      readonly kind: "verified-reuse";
      readonly priorPreviewFingerprint: Sha256Digest;
    };

export interface PreparedDisclosureManifest {
  readonly schemaVersion: 1;
  readonly requestId: ContributionRequestId;
  readonly intentFingerprint: Sha256Digest;
  readonly source: EvidenceRecordReference;
  readonly preparedRecord: EvidenceRecordReference;
  readonly artifacts: readonly EvidenceArtifactReference[];
  readonly preparation: PreparedDisclosurePreparation;
  readonly policyDecision: DisclosurePolicyDecisionReference;
  readonly bindingImpact?: DerivationBindingImpact;
  readonly unavailableArtifacts: readonly PreparedUnavailableArtifact[];
  readonly risk: PreparedDisclosureRisk;
  readonly destinations: readonly PreparedContributionDestination[];
}

export interface PreparedDisclosure {
  readonly manifest: PreparedDisclosureManifest;
  readonly manifestBytes: Uint8Array;
  readonly previewFingerprint: Sha256Digest;
}

export interface PreviewReadyPreparation {
  readonly status: "preview-ready";
  readonly disclosure: PreparedDisclosure;
}

export type PreparationResult =
  | PreviewReadyPreparation
  | {
      readonly status: "review-required";
      readonly reviewReference: string;
    }
  | {
      readonly status: "withheld";
      readonly reasons: readonly {
        readonly code: ContributionSafeReasonCode;
      }[];
    };

// ---------------------------------------------------------------------------
// Safe audit events (public projection carried by the read model / receipt)
// ---------------------------------------------------------------------------

export type ContributionSafeAuditEventKind =
  | "proposed"
  | "preparation-started"
  | "preview-ready"
  | "review-required"
  | "withheld"
  | "declined"
  | "authorized"
  | "authorization-denied"
  | "publication-started"
  | "published"
  | "publication-failed"
  | "deactivated";

export interface ContributionSafeAuditEvent {
  readonly schemaVersion: 1;
  readonly kind: ContributionSafeAuditEventKind;
  readonly at: string;
  readonly destination?: string;
  readonly reasonCode?: ContributionSafeReasonCode;
}

// ---------------------------------------------------------------------------
// Destination outcome (public projection)
// ---------------------------------------------------------------------------

export type ContributionDestinationOutcomeStatus =
  | "awaiting-authorization"
  | "denied"
  | "authorized"
  | "publishing"
  | "published"
  | "retryable-failure"
  | "terminal-failure";

export interface ContributionDestinationOutcome {
  readonly destination: string;
  readonly status: ContributionDestinationOutcomeStatus;
  readonly deactivated: boolean;
  readonly reasonCode?: ContributionSafeReasonCode;
  readonly publishedAt?: string;
}

// ---------------------------------------------------------------------------
// Read model and receipt
// ---------------------------------------------------------------------------

export interface ContributionReadModel {
  readonly schemaVersion: 1;
  readonly requestId: ContributionRequestId;
  readonly revision: number;
  readonly status: ContributionAggregateStatus;
  readonly source: EvidenceRecordReference;
  readonly policyDecision: DisclosurePolicyDecisionReference;
  readonly previewFingerprint?: Sha256Digest;
  readonly manifestBytes?: Uint8Array;
  readonly reviewReference?: string;
  readonly withheldReasons?: readonly { readonly code: ContributionSafeReasonCode }[];
  readonly destinations: readonly ContributionDestinationOutcome[];
  readonly warnings: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContributionReceipt {
  readonly schemaVersion: 1;
  readonly requestId: ContributionRequestId;
  readonly status: ContributionAggregateStatus;
  readonly previewFingerprint?: Sha256Digest;
  readonly destinations: readonly ContributionDestinationOutcome[];
  readonly generatedAt: string;
}

// ---------------------------------------------------------------------------
// Authorization submissions and verified results (design §9.3)
//
// `proofBytes` is transient authority input: core verifies
// `hashExactBytes(proofBytes) === proofDigest`, forwards a snapshot to the
// `AuthorizationAuthority` port, then discards it. No verified result,
// state, event, receipt, read model, or error retains it.
// ---------------------------------------------------------------------------

export interface ExactAuthorizationSubmission {
  readonly mode: "interactive-exact" | "organization-exact";
  readonly authorityId: string;
  readonly actorId: string;
  readonly previewFingerprint: Sha256Digest;
  readonly allowedDestinationConfigurationDigests: readonly Sha256Digest[];
  readonly decidedAt: string;
  readonly expiresAt?: string;
  readonly proofDigest: Sha256Digest;
  readonly proofBytes: Uint8Array;
  readonly exactPreviewPresented: boolean;
}

export interface VerifiedExactAuthorization
  extends Omit<ExactAuthorizationSubmission, "proofBytes"> {
  readonly deniedDestinations: readonly {
    readonly configurationDigest: Sha256Digest;
    readonly reasonCode: ContributionSafeReasonCode;
  }[];
}

export type StandingGrantSourceScope =
  | { readonly kind: "exact-source"; readonly source: EvidenceRecordReference }
  | { readonly kind: "host-scope"; readonly scopeDigest: Sha256Digest };

export interface StandingGrantSubmission {
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
  readonly limits: ContributionResourceLimits;
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly proofDigest: Sha256Digest;
  readonly proofBytes: Uint8Array;
}

export interface VerifiedStandingGrant
  extends Omit<StandingGrantSubmission, "proofBytes"> {}

export interface StandingGrantRevocationSubmission {
  readonly authorityId: string;
  readonly actorId: string;
  readonly grantId: ContributionGrantId;
  readonly expectedGrantVersion: number;
  readonly revokedAt: string;
  readonly reasonCode: ContributionSafeReasonCode;
  readonly proofDigest: Sha256Digest;
  readonly proofBytes: Uint8Array;
}

export interface VerifiedStandingGrantRevocation
  extends Omit<StandingGrantRevocationSubmission, "proofBytes"> {}

export interface StandingAuthorizationGrantReadModel {
  readonly schemaVersion: 1;
  readonly grantId: ContributionGrantId;
  readonly revision: number;
  readonly authorityId: string;
  readonly sourceScope: StandingGrantSourceScope;
  readonly allowedFamilies: readonly EvidenceRecordReference["family"][];
  readonly destinationConfigurationDigests: readonly Sha256Digest[];
  readonly limits?: ContributionResourceLimits;
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly revoked: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}
