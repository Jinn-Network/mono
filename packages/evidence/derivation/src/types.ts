// SPDX-License-Identifier: Apache-2.0

export type ConfidenceBand =
  | "VERY_LOW"
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "VERY_HIGH";

export type DerivationDisposition =
  | "retain"
  | "redact"
  | "withhold-artifact"
  | "withhold-record"
  | "review";

export const PROTECTED_VALUE_CLASSES = [
  "jsonld-keyword",
  "relationship-reference",
  "digest-reference",
  "historical-role-identity",
  "execution-iri",
  "agent-iri",
  "profile-media-schema-identifier",
  "protocol-scalar",
  "signed-material",
  "content-identifier",
  "version-model-identifier",
  "derivation-commitment",
  "policy-protected-property",
] as const;

export type ProtectedValueClass = (typeof PROTECTED_VALUE_CLASSES)[number];
export type ProtectedValueDisposition = "retain" | "withhold-record";
export type DerivationSha256Digest = `sha256:${string}`;

export interface DerivationRecordReference {
  readonly family: "execution-evidence";
  readonly digest: DerivationSha256Digest;
}

export interface DerivationArtifactReference {
  readonly digest: DerivationSha256Digest;
}

export type DerivationRole =
  | "task"
  | "result"
  | "runtime-specification"
  | "runtime-component"
  | "native-trace"
  | "input"
  | "evidence"
  | "other";

export type ArtifactCodec = "text" | "json" | "jsonl" | "signed" | "binary";

export interface DerivationDetectorDescriptor {
  readonly id: string;
  readonly version: string;
  readonly implementationDigest: DerivationSha256Digest;
  readonly reproducibility: "byte-stable" | "best-effort";
  readonly configurationDigest?: DerivationSha256Digest;
}

export interface DerivationSurface {
  readonly surfaceId: string;
  readonly sourceEntityId: string;
  readonly role: DerivationRole;
  readonly mediaType: string;
  readonly codec: "text" | "json" | "jsonl";
  readonly location: string;
  readonly text: string;
}

export interface DerivationFinding {
  readonly class: string;
  readonly confidence: ConfidenceBand;
  readonly surfaceId: string;
  /** Zero-based inclusive UTF-16 code-unit index into the exact surface text. */
  readonly start: number;
  /** Zero-based exclusive UTF-16 code-unit index into the exact surface text. */
  readonly end: number;
  readonly evidence: readonly string[];
  readonly detector: DerivationDetectorDescriptor;
}

export interface DerivationOperationOptions {
  readonly signal?: AbortSignal;
}

export interface DerivationDetector {
  readonly descriptor: DerivationDetectorDescriptor;
  detect(
    surface: DerivationSurface,
    options?: DerivationOperationOptions,
  ): Promise<readonly DerivationFinding[]>;
}

export interface RequiredDetector extends DerivationDetectorDescriptor {}

export interface DerivationArtifactRule {
  readonly mediaType: string;
  readonly roles: readonly DerivationRole[];
  readonly codec: ArtifactCodec;
  readonly unavailable: "retain-commitment" | "withhold-record";
}

export interface DerivationDispositionRule {
  readonly class: string;
  readonly minimumConfidence: ConfidenceBand;
  readonly disposition: DerivationDisposition;
}

export interface DerivationPolicy {
  readonly schemaVersion: "jinn.evidence-derivation-policy.v1";
  readonly name: string;
  readonly version: string;
  readonly reproducibility: "byte-stable" | "content-addressed";
  readonly requiredDetectors: readonly RequiredDetector[];
  readonly transformableMetadata: readonly string[];
  readonly protectedMetadata: readonly string[];
  readonly protectedValueDispositions: Readonly<
    Record<ProtectedValueClass, ProtectedValueDisposition>
  >;
  readonly artifactRules: readonly DerivationArtifactRule[];
  readonly defaultArtifactDisposition: "withhold-artifact" | "withhold-record";
  readonly dispositions: readonly DerivationDispositionRule[];
  readonly unmatchedFindingDisposition: "review" | "withhold-record";
  readonly stubs: Readonly<Record<string, string>>;
  readonly technicalAllowlist: readonly string[];
  readonly privateAllowlistConfigurationDigest?: DerivationSha256Digest;
  readonly resultTransform: "derive-unassessed" | "withhold-record";
}

export interface ParsedDerivationPolicy {
  readonly value: DerivationPolicy;
  readonly bytes: Uint8Array;
  readonly digest: DerivationSha256Digest;
}

export interface DeriveExecutionEvidenceInput {
  readonly sourceRecord: {
    readonly reference: DerivationRecordReference;
    readonly bytes: Uint8Array;
  };
  readonly sourceArtifacts: readonly {
    readonly entityId: string;
    readonly bytes: Uint8Array;
  }[];
  readonly policyBytes: Uint8Array;
  readonly scrubber: {
    readonly agentId: string;
    readonly implementationDescriptorBytes: Uint8Array;
  };
  readonly completedAt: string;
}

export interface PublishableArtifact {
  readonly entityId: string;
  readonly digest: DerivationSha256Digest;
  readonly bytes: Uint8Array;
  readonly kind:
    | "retained"
    | "derived"
    | "policy"
    | "implementation"
    | "receipt";
}

export interface DerivationBindingImpact {
  readonly executionVerification:
    | "existing-verification-applicable"
    | "not-transferred-to-derived-record";
  readonly resultEvaluation:
    | "preserved-for-exact-subjects"
    | "not-transferable-to-derived-subject";
  readonly taskDerived: boolean;
  readonly resultDerived: boolean;
}

export interface DerivationHoldReason {
  readonly code: string;
  readonly protectedClass?: ProtectedValueClass;
}

export interface PublishableUnchangedOutcome {
  readonly status: "publishable-unchanged";
  readonly record: {
    readonly reference: DerivationRecordReference;
    readonly bytes: Uint8Array;
  };
  readonly artifacts: readonly PublishableArtifact[];
  readonly bindingImpact: DerivationBindingImpact;
}

export interface DerivedExecutionEvidenceOutcome {
  readonly status: "derived";
  readonly record: {
    readonly reference: DerivationRecordReference;
    readonly bytes: Uint8Array;
  };
  readonly artifacts: readonly PublishableArtifact[];
  readonly bindingImpact: DerivationBindingImpact;
  readonly receipt: {
    readonly digest: DerivationSha256Digest;
    readonly bytes: Uint8Array;
  };
}

export interface ReviewRequiredOutcome {
  readonly status: "review-required";
  readonly findings: readonly DerivationFinding[];
}

export interface WithheldOutcome {
  readonly status: "withheld";
  readonly reasons: readonly DerivationHoldReason[];
}

export type EvidenceDerivationOutcome =
  | PublishableUnchangedOutcome
  | DerivedExecutionEvidenceOutcome
  | ReviewRequiredOutcome
  | WithheldOutcome;

export interface EvidenceDeriver {
  derive(
    input: DeriveExecutionEvidenceInput,
    options?: DerivationOperationOptions,
  ): Promise<EvidenceDerivationOutcome>;
}

export interface CreateEvidenceDeriverOptions {
  readonly detectors: readonly DerivationDetector[];
}

export interface DispositionCount {
  readonly class: string;
  readonly disposition: Exclude<DerivationDisposition, "retain">;
  readonly count: number;
}
