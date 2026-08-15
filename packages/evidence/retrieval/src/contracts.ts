import type {
  ConformanceDiagnostic,
  ExecutionEvidenceDocument,
  ExecutionVerificationEvidence,
  ResultEvaluationEvidence,
} from "@jinn-network/evidence-protocol";
import type {
  EvidenceArtifactReference,
  EvidenceRecordReference,
  Sha256Digest,
} from "@jinn-network/evidence-repository";
import type {
  EvidenceRepositoryResolver,
  JsonValue,
  PublishedEvidenceLocation,
} from "@jinn-network/evidence-discovery";

export type { EvidenceRecordReference, JsonValue, Sha256Digest };

export type ValidatedRecord =
  | {
      readonly family: "execution-evidence";
      readonly value: ExecutionEvidenceDocument;
    }
  | {
      readonly family: "result-evaluation";
      readonly value: ResultEvaluationEvidence;
    }
  | {
      readonly family: "execution-verification";
      readonly value: ExecutionVerificationEvidence;
    };

export interface CandidateSourceIdentity {
  readonly id: string;
  readonly version: string;
}

export interface CandidateCursor {
  readonly source: CandidateSourceIdentity;
  readonly value: JsonValue;
}

export interface CandidateCheckpoint {
  readonly source: CandidateSourceIdentity;
  readonly value: JsonValue;
  readonly replayable: boolean;
}

export interface RetrievalLocationHint {
  readonly sourceId: string;
  readonly repositoryId: string;
  readonly publishedLocation?: PublishedEvidenceLocation;
}

export interface RetrievalLocationObservation {
  readonly observationId: string;
  readonly sourceId: string;
  readonly status: "available" | "withdrawn";
  readonly repositoryId?: string;
  readonly publishedLocation?: PublishedEvidenceLocation;
}

export interface RetrievalLocationAttempt {
  readonly repositoryId: string;
  readonly observation: RetrievalLocationObservation;
}

export interface CandidateObservation<ProviderData = unknown> {
  readonly source: CandidateSourceIdentity;
  readonly ordinal: number;
  readonly providerData?: ProviderData;
  readonly locationHints: readonly RetrievalLocationHint[];
}

export interface EvidenceCandidate<ProviderData = unknown> {
  readonly reference: EvidenceRecordReference;
  readonly providerData?: ProviderData;
  readonly locationHints?: readonly RetrievalLocationHint[];
}

export interface CandidateSourceIssue {
  readonly code: string;
  readonly message: string;
}

export interface CandidateSourceDiagnostics {
  readonly issues: readonly CandidateSourceIssue[];
}

export interface CandidateSourceReport {
  readonly source: CandidateSourceIdentity;
  readonly status: "complete" | "partial" | "failed";
  readonly candidatesReturned: number;
  readonly checkpoint?: CandidateCheckpoint;
  readonly failure?: EvidenceRetrievalFailure;
}

export interface CandidatePage<ProviderData = unknown> {
  readonly source: CandidateSourceIdentity;
  readonly candidates: readonly EvidenceCandidate<ProviderData>[];
  readonly nextCursor?: CandidateCursor;
  readonly checkpoint?: CandidateCheckpoint;
  readonly sourceReports?: readonly CandidateSourceReport[];
  readonly diagnostics?: CandidateSourceDiagnostics;
}

export interface CandidateSourceOperationOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maximumCandidates: number;
  readonly cursor?: CandidateCursor;
  readonly checkpoint?: CandidateCheckpoint;
}

export interface CandidateSource<Query, ProviderData = unknown> {
  readonly identity: CandidateSourceIdentity;
  find(
    query: Query,
    options: CandidateSourceOperationOptions,
  ): Promise<CandidatePage<ProviderData>>;
}

export interface EvidenceRecordLocator {
  locate(
    reference: EvidenceRecordReference,
    hints: readonly RetrievalLocationHint[],
    options: RetrievalPortOperationOptions,
  ): Promise<readonly RetrievalLocationObservation[]>;
}

export interface EvidenceLocationPolicy {
  select(
    reference: EvidenceRecordReference,
    locations: readonly RetrievalLocationObservation[],
  ): readonly RetrievalLocationAttempt[];
}

export interface RetrievalPortOperationOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maximumLocations: number;
}

export type ArtifactSelector =
  | { readonly kind: "entity-id"; readonly entityId: string }
  | { readonly kind: "digest"; readonly digest: Sha256Digest }
  | { readonly kind: "role"; readonly role: string };

export interface ArtifactSelection {
  readonly selector: ArtifactSelector;
  readonly requirement: "required" | "optional";
}

export interface ArtifactHydrationRequest {
  readonly selections: readonly ArtifactSelection[];
}

export type ArtifactRetrievalStatus =
  | "verified"
  | "not-requested"
  | "unavailable"
  | "access-denied"
  | "integrity-mismatch"
  | "too-large"
  | "timed-out";

export interface DeclaredArtifact {
  readonly entityId: string;
  readonly reference: EvidenceArtifactReference;
  readonly roles: readonly string[];
}

export interface ArtifactRetrievalResult {
  readonly declaration: DeclaredArtifact;
  readonly requirement?: "required" | "optional";
  readonly status: ArtifactRetrievalStatus;
  readonly bytes?: Uint8Array;
  readonly actualDigest?: Sha256Digest;
}

export interface RetrievalWarning {
  readonly code: string;
  readonly message: string;
}

export const EVIDENCE_RETRIEVAL_FAILURE_CODES = [
  "NO_LOCATION",
  "ACCESS_DENIED",
  "WITHDRAWN_OR_UNAVAILABLE",
  "SOURCE_FAILED",
  "REPOSITORY_UNRESOLVED",
  "TIMED_OUT",
  "OPERATION_ABORTED",
  "CANDIDATE_BUDGET_EXCEEDED",
  "BYTE_BUDGET_EXCEEDED",
  "RECORD_TOO_LARGE",
  "ARTIFACT_TOO_LARGE",
  "RECORD_DIGEST_MISMATCH",
  "PROTOCOL_NONCONFORMING",
  "ACCEPTANCE_REJECTED",
  "REQUIRED_ARTIFACT_UNAVAILABLE",
  "ARTIFACT_INTEGRITY_MISMATCH",
  "PROVIDER_CONTRACT_VIOLATION",
] as const;

export type EvidenceRetrievalFailureCode =
  (typeof EVIDENCE_RETRIEVAL_FAILURE_CODES)[number];

export type EvidenceRetrievalFailureStage =
  | "source"
  | "candidate"
  | "location"
  | "record"
  | "validation"
  | "acceptance"
  | "artifact";

export interface EvidenceRetrievalFailure {
  readonly code: EvidenceRetrievalFailureCode;
  readonly stage: EvidenceRetrievalFailureStage;
  readonly message: string;
  readonly retryable: boolean;
  readonly reference?: EvidenceRecordReference;
  readonly source?: CandidateSourceIdentity;
  readonly repositoryId?: string;
  readonly conformanceDiagnostics?: readonly ConformanceDiagnostic[];
}

export interface ValidatedEvidenceResult<ProviderData = unknown> {
  readonly reference: EvidenceRecordReference;
  readonly canonicalBytes: Uint8Array;
  readonly validatedRecord: ValidatedRecord;
  readonly discoveryProvenance:
    readonly CandidateObservation<ProviderData>[];
  readonly availability: readonly RetrievalLocationObservation[];
  readonly selectedLocation?: RetrievalLocationObservation;
  readonly artifacts: readonly ArtifactRetrievalResult[];
  readonly completeness: "complete" | "artifact-incomplete";
  readonly warnings: readonly RetrievalWarning[];
}

export interface EvidenceAcceptanceDecisionAccepted {
  readonly status: "accepted";
}

export interface EvidenceAcceptanceDecisionRejected {
  readonly status: "rejected";
  readonly reasonCode: string;
}

export type EvidenceAcceptanceDecision =
  | EvidenceAcceptanceDecisionAccepted
  | EvidenceAcceptanceDecisionRejected;

export interface ValidatedEvidenceAcceptance {
  readonly id: string;
  readonly version: string;
  evaluate(
    evidence: ValidatedRecord,
  ): EvidenceAcceptanceDecision | Promise<EvidenceAcceptanceDecision>;
}

export interface RetrievalDiagnostics {
  readonly examinedCandidates: number;
  readonly uniqueReferences: number;
  readonly failures: readonly EvidenceRetrievalFailure[];
  readonly providerIssues: readonly CandidateSourceIssue[];
}

export interface RetrievalOperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRecordBytes?: number;
  readonly maxTotalRecordBytes?: number;
  readonly maxArtifactBytes?: number;
  readonly maxTotalArtifactBytes?: number;
  readonly maxProviderMetadataBytes?: number;
}

export interface RetrieveEvidenceInput {
  readonly reference: EvidenceRecordReference;
  readonly locationHints?: readonly RetrievalLocationHint[];
  readonly artifacts?: ArtifactHydrationRequest;
}

export type RetrieveEvidenceOutcome =
  | {
      readonly status: "validated";
      readonly result: ValidatedEvidenceResult;
    }
  | {
      readonly status: "failed";
      readonly failure: EvidenceRetrievalFailure;
    };

export interface SavedEvidenceQuery {
  readonly retrievalSchemaVersion: "1.0.0";
  readonly candidateSourceSet: CandidateSourceIdentity;
  readonly providerQuery: {
    readonly kind: string;
    readonly schemaVersion: string;
    readonly value: JsonValue;
  };
  readonly resultLimit: number;
  readonly candidateBudget: number;
  readonly acceptancePolicy?: {
    readonly id: string;
    readonly version: string;
    readonly configuration?: JsonValue;
  };
}

export interface QuerySnapshotReceipt {
  readonly savedQueryDigest: Sha256Digest;
  readonly sourceSet: CandidateSourceIdentity;
  readonly sources: readonly {
    readonly source: CandidateSourceIdentity;
    readonly checkpoint: CandidateCheckpoint;
  }[];
  readonly evaluatedAt: string;
  readonly reproducibility: "replayable" | "not-replayable";
}

export interface QueryEvidenceInput<Query, ProviderData = unknown> {
  readonly candidateSource: CandidateSource<Query, ProviderData>;
  readonly sourceQuery: Query;
  readonly resultLimit: number;
  readonly candidateBudget: number;
  readonly cursor?: CandidateCursor;
  readonly checkpoint?: CandidateCheckpoint;
  readonly acceptance?: ValidatedEvidenceAcceptance;
  readonly artifacts?: ArtifactHydrationRequest;
  readonly diagnostics?: "summary" | "detailed";
  readonly savedQuery?: SavedEvidenceQuery;
}

export interface QueryEvidenceOutcome<ProviderData = unknown> {
  readonly status: "complete" | "partial" | "failed";
  readonly results: readonly ValidatedEvidenceResult<ProviderData>[];
  readonly sourceReports: readonly CandidateSourceReport[];
  readonly nextCursor?: CandidateCursor;
  readonly snapshotReceipt?: QuerySnapshotReceipt;
  readonly diagnostics?: RetrievalDiagnostics;
}

export interface RetrievalHardLimits {
  readonly timeoutMs: number;
  readonly maxResultLimit: number;
  readonly maxCandidateBudget: number;
  readonly maxCandidatePageSize: number;
  readonly maxProviderMetadataBytes: number;
  readonly maxCursorBytes: number;
  readonly maxLocationObservations: number;
  readonly maxLocationAttempts: number;
  readonly maxRecordBytes: number;
  readonly maxTotalRecordBytes: number;
  readonly maxArtifactCount: number;
  readonly maxArtifactBytes: number;
  readonly maxTotalArtifactBytes: number;
  readonly maxRecordConcurrency: number;
  readonly maxArtifactConcurrency: number;
  readonly maxDiagnostics: number;
}

export interface RetrievalTelemetryEvent {
  readonly operationId: string;
  readonly operation: "retrieve" | "query";
  readonly stage:
    | "started"
    | "source"
    | "record"
    | "artifact"
    | "completed";
  readonly source?: CandidateSourceIdentity;
  readonly bindingProfile?: string;
  readonly durationMs?: number;
  readonly candidateCount?: number;
  readonly resultCount?: number;
  readonly failureCode?: EvidenceRetrievalFailureCode;
  readonly bytes?: number;
}

export interface RetrievalTelemetry {
  emit(event: RetrievalTelemetryEvent): void | Promise<void>;
}

export interface CreateEvidenceRetrievalOptions {
  readonly locator: EvidenceRecordLocator;
  readonly locationPolicy: EvidenceLocationPolicy;
  readonly repositoryResolver: EvidenceRepositoryResolver;
  readonly hardLimits?: Partial<RetrievalHardLimits>;
  readonly telemetry?: RetrievalTelemetry;
}

export interface EvidenceRetrieval {
  retrieve(
    input: RetrieveEvidenceInput,
    options?: RetrievalOperationOptions,
  ): Promise<RetrieveEvidenceOutcome>;
  query<Query, ProviderData = unknown>(
    input: QueryEvidenceInput<Query, ProviderData>,
    options?: RetrievalOperationOptions,
  ): Promise<QueryEvidenceOutcome<ProviderData>>;
}

export const DEFAULT_RETRIEVAL_HARD_LIMITS: RetrievalHardLimits =
  Object.freeze({
    timeoutMs: 30_000,
    maxResultLimit: 50,
    maxCandidateBudget: 500,
    maxCandidatePageSize: 100,
    maxProviderMetadataBytes: 64 * 1024,
    maxCursorBytes: 16 * 1024,
    maxLocationObservations: 64,
    maxLocationAttempts: 8,
    maxRecordBytes: 16 * 1024 * 1024,
    maxTotalRecordBytes: 128 * 1024 * 1024,
    maxArtifactCount: 32,
    maxArtifactBytes: 64 * 1024 * 1024,
    maxTotalArtifactBytes: 128 * 1024 * 1024,
    maxRecordConcurrency: 8,
    maxArtifactConcurrency: 4,
    maxDiagnostics: 100,
  });

export interface ProviderQueryCodec<Query> {
  readonly kind: string;
  readonly schemaVersion: string;
  encode(query: Query): JsonValue;
  decode(value: JsonValue): Query;
}

export interface FederatedCandidateContribution<ChildData> {
  readonly source: CandidateSourceIdentity;
  readonly ordinal: number;
  readonly providerData?: ChildData;
  readonly locationHints: readonly RetrievalLocationHint[];
}

export interface FederatedCandidateGroup<ChildData> {
  readonly reference: EvidenceRecordReference;
  readonly contributions:
    readonly FederatedCandidateContribution<ChildData>[];
}

export interface FederatedOrderedCandidate<CombinedData> {
  readonly reference: EvidenceRecordReference;
  readonly combinedData?: CombinedData;
}

export type FederatedOrdering<Query, ChildData, CombinedData> = (
  groups: readonly FederatedCandidateGroup<ChildData>[],
  query: Query,
) => readonly FederatedOrderedCandidate<CombinedData>[];

export type FederatedCandidateAllocation<Query> = (
  maximumCandidates: number,
  sources: readonly CandidateSourceIdentity[],
  query: Query,
) => readonly number[];

export interface FederatedProviderData<ChildData, CombinedData> {
  readonly contributions:
    readonly FederatedCandidateContribution<ChildData>[];
  readonly combinedData?: CombinedData;
}

export interface CreateFederatedCandidateSourceOptions<
  Query,
  ChildData,
  CombinedData,
> {
  readonly identity: CandidateSourceIdentity;
  readonly sources: readonly CandidateSource<Query, ChildData>[];
  readonly allocate: FederatedCandidateAllocation<Query>;
  readonly order: FederatedOrdering<Query, ChildData, CombinedData>;
  readonly maximumConcurrency?: number;
}

export interface CreateSavedEvidenceQueryInput<Query> {
  readonly candidateSourceSet: CandidateSourceIdentity;
  readonly sourceQuery: Query;
  readonly codec: ProviderQueryCodec<Query>;
  readonly resultLimit: number;
  readonly candidateBudget: number;
  readonly acceptancePolicy?: SavedEvidenceQuery["acceptancePolicy"];
}
