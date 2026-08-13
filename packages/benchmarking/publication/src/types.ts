import type {
  AccountingScopeStream,
  BenchmarkAccountingDispatch,
  DigestBearingResourceDescriptor,
  ObservationArchive,
  PublisherAuthority,
  TypedRecordReference,
} from "@jinn-network/benchmarking-records";
import type { OriginReference, PublicationArtifact, PublicationRecord, Sha256Digest } from "@jinn-network/record-publication";
import type { ProtocolObservation, SubmissionRecord } from "@jinn-network/task-execution-protocol";

export type TriState = "pass" | "fail" | "indeterminate";
export interface PublicationCheck { readonly name: string; readonly status: TriState; readonly detail?: string; }
export interface NamedPublicationVerification { readonly checks: readonly PublicationCheck[]; readonly status: TriState; }

export interface AcceptedObservationSnapshot {
  readonly observation: ProtocolObservation;
  /** Descriptor for immutable original signed/transport bytes, where the adapter received them. */
  readonly exactEnvelope?: DigestBearingResourceDescriptor;
  /** The publisher accepted the snapshot after its protocol validation. */
  readonly accepted?: true;
}
export interface ObservationArchiveBuildInput {
  readonly submission: DigestBearingResourceDescriptor;
  readonly capturedThrough: { readonly at: string; readonly cursor?: string };
  readonly snapshots: readonly AcceptedObservationSnapshot[];
}

export interface AccountingDispatchInput {
  readonly cellKey: string;
  readonly index: number;
  readonly submission: TypedRecordReference;
  readonly submissionBytes: Uint8Array;
  readonly observations?: DigestBearingResourceDescriptor;
  readonly attempt?: string;
  readonly delivery?: TypedRecordReference;
  readonly evidence?: readonly TypedRecordReference[];
  readonly evaluations?: readonly TypedRecordReference[];
  readonly correlations?: readonly { readonly role: string; readonly artifact: DigestBearingResourceDescriptor }[];
  readonly nativeArtifacts?: BenchmarkAccountingDispatch["nativeArtifacts"];
}
export interface BenchmarkAccountingBuildInput {
  readonly run: DigestBearingResourceDescriptor;
  readonly runOwner: string;
  readonly publisher: string;
  readonly publisherAuthority: PublisherAuthority;
  readonly scope: readonly AccountingScopeStream[];
  readonly publicRegistration: Record<string, unknown>;
  readonly closeBoundary: { readonly at: string; readonly anchor?: { readonly chain: string; readonly blockNumber: number; readonly blockHash: string } };
  /** Expected Run cells. Their full set, rather than an outcome, fixes accounting cell coverage. */
  readonly expectedCellKeys: readonly string[];
  readonly dispatches: readonly AccountingDispatchInput[];
}

export interface ReferenceBytesResolver {
  getExact(input: { readonly digest: Sha256Digest }): Promise<Uint8Array | undefined>;
}
export interface ScopeEnumerationResult {
  readonly status: "complete" | "unavailable" | "incomplete";
  readonly dispatches?: readonly { readonly cellKey: string; readonly submissionDigest: Sha256Digest }[];
  readonly detail?: string;
}
/** Discovery/substrate adapters own enumeration and finality; this package never calls a network. */
export interface AccountingScopeVerifier {
  enumerate(input: { readonly stream: AccountingScopeStream; readonly through: AccountingScopeStream["through"] }): Promise<ScopeEnumerationResult>;
}
export interface PublisherAuthorityVerifier {
  verify(input: { readonly publisher: string; readonly runOwner: string; readonly authority: PublisherAuthority; readonly closeAt: string }): Promise<PublicationCheck>;
}
export interface BenchmarkAccountingVerificationInput {
  readonly runOwner: string;
  readonly expectedCellKeys: readonly string[];
  readonly accounting: import("@jinn-network/benchmarking-records").BenchmarkAccountingRecord;
  readonly submissions?: ReadonlyMap<Sha256Digest, { readonly bytes: Uint8Array; readonly record?: SubmissionRecord }>;
  readonly scope?: AccountingScopeVerifier;
  readonly authority?: PublisherAuthorityVerifier;
  readonly references?: ReferenceBytesResolver;
}

/** Runtime adapters contribute opaque, role-namespaced evidence; PUB-08 owns adapter migration. */
export interface RuntimeEvidenceContributor {
  readonly profile: string;
  registration(input: { readonly runDigest: Sha256Digest }): Promise<readonly PublicationArtifact[]>;
  dispatch(input: { readonly submission: TypedRecordReference; readonly attempt?: string }): Promise<{
    readonly correlations: readonly { readonly role: string; readonly artifact: DigestBearingResourceDescriptor }[];
    readonly nativeArtifacts: BenchmarkAccountingDispatch["nativeArtifacts"];
  }>;
}
export interface RuntimeEvidenceVerifier {
  readonly profile: string;
  verify(input: { readonly dispatch: BenchmarkAccountingDispatch; readonly references?: ReferenceBytesResolver }): Promise<readonly PublicationCheck[]>;
}

export type PublicationAuthorityInput =
  | { readonly mode: "owner" | "delegate" }
  | { readonly mode: "origin-reference"; readonly origin: OriginReference; readonly mirror?: boolean };
export interface PublicationRecordInput {
  readonly id: string;
  readonly kind: string;
  readonly digest: Sha256Digest;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly authority: PublicationAuthorityInput;
  readonly dependsOn?: readonly string[];
  readonly announcementTimestamp?: string;
}
export interface PublicationArtifactInput {
  readonly id: string;
  readonly role: string;
  readonly digest: Sha256Digest;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly mirror?: boolean;
  readonly dependsOn?: readonly string[];
}
export interface BenchmarkPublicationPlanInput {
  readonly id: string;
  readonly registration: readonly (PublicationRecordInput | PublicationArtifactInput)[];
  readonly runId: string;
  readonly accounting: { readonly accounting: PublicationRecordInput; readonly matrix: PublicationRecordInput; readonly members?: readonly (PublicationRecordInput | PublicationArtifactInput)[] };
  readonly report?: { readonly record: PublicationRecordInput; readonly members?: readonly (PublicationRecordInput | PublicationArtifactInput)[] };
}
export type NeutralPublicationMember = PublicationRecord | PublicationArtifact;
