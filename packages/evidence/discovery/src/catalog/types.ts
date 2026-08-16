// SPDX-License-Identifier: MIT
import type {
  EvidenceRecordReference,
  EvidenceRepository,
  RepositoryOperationOptions,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

export type {
  EvidenceRecordFamily,
  EvidenceRecordReference,
  Sha256Digest,
} from "@jinn-network/evidence-repository";
export { EVIDENCE_RECORD_FAMILIES } from "@jinn-network/evidence-repository";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface CatalogOperationOptions {
  readonly signal?: AbortSignal;
}

export const CATALOG_SCHEMA_VERSION = "1.0.0" as const;

export interface CatalogGeneration {
  readonly catalogSchemaVersion: typeof CATALOG_SCHEMA_VERSION;
  readonly projectorVersion: string;
  readonly createdAt: string;
}

export interface DeclaredEntityOccurrence {
  readonly entityId: string;
  readonly types: readonly string[];
  readonly name?: string;
}

export interface DeclaredRelationshipOccurrence {
  readonly sourceEntityId: string;
  readonly predicate: string;
  readonly targetEntityId: string;
}

export interface CatalogArtifactProjection {
  readonly entityId: string;
  readonly digest: Sha256Digest;
  readonly name?: string;
  readonly mediaType?: string;
}

export interface CatalogIdentifierProjection {
  /** Graph entity carrying the identifier relationship. */
  readonly entityId: string;
  readonly scheme: string;
  readonly value: string;
}

export interface CatalogResourceSubject {
  readonly name: string;
  readonly digest: Sha256Digest;
  readonly uri?: string;
  readonly mediaType?: string;
}

export interface CatalogRecordBase {
  readonly reference: EvidenceRecordReference;
  readonly byteSize: number;
  readonly declaredEntities: readonly DeclaredEntityOccurrence[];
  readonly declaredRelationships: readonly DeclaredRelationshipOccurrence[];
}

export interface ExecutionEvidenceProjection extends CatalogRecordBase {
  readonly family: "execution-evidence";
  readonly executionId: string;
  readonly task: CatalogArtifactProjection;
  readonly executorId: string;
  readonly runtime: CatalogArtifactProjection;
  readonly identifiers?: readonly CatalogIdentifierProjection[];
  readonly results: readonly CatalogArtifactProjection[];
  readonly nativeTrace: CatalogArtifactProjection;
  readonly outcome: "completed" | "failed" | "abandoned";
  readonly startedAt: string;
  readonly endedAt: string;
  readonly publishedAt: string;
}

export interface ResultEvaluationProjection extends CatalogRecordBase {
  readonly family: "result-evaluation";
  readonly taskSubject: CatalogResourceSubject;
  readonly resultSubjects: readonly [
    CatalogResourceSubject,
    ...CatalogResourceSubject[],
  ];
  readonly evaluatorId: string;
  readonly verdict: "pass" | "fail" | "inconclusive";
  readonly evaluatedAt: string;
  readonly supersedes: readonly CatalogResourceSubject[];
  readonly disputes: readonly CatalogResourceSubject[];
}

export interface ExecutionVerificationProjection extends CatalogRecordBase {
  readonly family: "execution-verification";
  readonly subjectRecord: EvidenceRecordReference & {
    readonly family: "execution-evidence";
  };
  readonly executionId: string;
  readonly verifierId: string;
  readonly verdict: "verified" | "rejected" | "inconclusive";
  readonly verifiedAt: string;
  readonly supersedes: readonly CatalogResourceSubject[];
  readonly disputes: readonly CatalogResourceSubject[];
}

export type CatalogRecordProjection =
  | ExecutionEvidenceProjection
  | ResultEvaluationProjection
  | ExecutionVerificationProjection;

export interface CatalogPageQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly availability?: "available" | "any";
}

export interface ExecutionCatalogQuery extends CatalogPageQuery {
  readonly executionId?: string;
  readonly taskId?: string;
  readonly taskDigest?: Sha256Digest;
  readonly resultId?: string;
  readonly resultDigest?: Sha256Digest;
  /** Every supplied digest must occur in the same Execution Evidence record. */
  readonly resultDigestsAll?: readonly Sha256Digest[];
  readonly executorId?: string;
  readonly runtimeDigest?: Sha256Digest;
  /** Matches one identifier PropertyValue; when both are supplied they must match the same row. */
  readonly identifierScheme?: string;
  readonly identifierValue?: string;
  readonly outcome?: ExecutionEvidenceProjection["outcome"];
  readonly startedAfter?: string;
  readonly startedBefore?: string;
  readonly publishedAfter?: string;
  readonly publishedBefore?: string;
}

export interface EvaluationCatalogQuery extends CatalogPageQuery {
  readonly taskDigest?: Sha256Digest;
  readonly resultDigest?: Sha256Digest;
  /** Every supplied digest must be subject of the same Result Evaluation. */
  readonly resultDigestsAll?: readonly Sha256Digest[];
  readonly evaluatorId?: string;
  readonly verdict?: ResultEvaluationProjection["verdict"];
  readonly evaluatedAfter?: string;
  readonly evaluatedBefore?: string;
}

export interface CatalogSnapshotBoundary {
  /** Opaque finality/cursor token supplied by the catalog's source. */
  readonly sourceCursor: string;
  readonly cutoff: string;
}

export interface CatalogReferenceSnapshot<Query> {
  readonly family: EvidenceRecordReference["family"];
  readonly query: Query;
  readonly boundary: CatalogSnapshotBoundary;
  readonly references: readonly EvidenceRecordReference[];
}

export interface VerificationCatalogQuery extends CatalogPageQuery {
  readonly executionId?: string;
  readonly subjectRecordDigest?: Sha256Digest;
  readonly verifierId?: string;
  readonly verdict?: ExecutionVerificationProjection["verdict"];
  readonly verifiedAfter?: string;
  readonly verifiedBefore?: string;
}

export type EntityRecordQuery = CatalogPageQuery & {
  readonly family?: EvidenceRecordReference["family"];
};

export interface CatalogPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface PublishedEvidenceLocation {
  readonly bindingProfile: string;
  readonly locator: Readonly<Record<string, JsonValue>>;
}

export interface EvidenceRecordLocation {
  readonly repositoryId: string;
  readonly publishedLocation?: PublishedEvidenceLocation;
}

export interface RecordLocationObservation extends EvidenceRecordLocation {
  readonly sourceId: string;
  readonly announcementId: string;
}

export interface RecordLocationWithdrawal {
  readonly sourceId: string;
  readonly announcementId: string;
  readonly retractsAnnouncementId: string;
}

export type EvidenceRecordAnnouncement =
  | ({
      readonly kind: "available";
      readonly sourceId: string;
      readonly announcementId: string;
      readonly reference: EvidenceRecordReference;
    } & EvidenceRecordLocation)
  | ({
      readonly kind: "withdrawn";
    } & RecordLocationWithdrawal);

export interface AnnouncementBatch {
  readonly announcements: readonly EvidenceRecordAnnouncement[];
  readonly cursor: string;
}

export interface EvidenceRecordAnnouncementSource {
  read(options?: {
    readonly after?: string;
    readonly signal?: AbortSignal;
  }): AsyncIterable<AnnouncementBatch>;
}

export interface EvidenceRepositoryResolver {
  resolve(
    repositoryId: string,
    options?: RepositoryOperationOptions,
  ): Promise<EvidenceRepository | null>;
}

export interface EvidenceIndexerCheckpointStore {
  get(sourceId: string): Promise<string | undefined>;
  put(sourceId: string, cursor: string): Promise<void>;
}

export interface CatalogWriteReceipt {
  readonly reference: EvidenceRecordReference;
  readonly status: "created" | "existing";
}

export interface CatalogLocationReceipt {
  readonly status: "created" | "existing" | "withdrawn" | "absent";
}

export interface EvidenceCatalogReader {
  getRecord(
    reference: EvidenceRecordReference,
    options?: CatalogOperationOptions,
  ): Promise<CatalogRecordProjection | null>;
  findRecordsForEntity(
    entityId: string,
    query?: EntityRecordQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<CatalogRecordProjection>>;
  findExecutions(
    query: ExecutionCatalogQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<ExecutionEvidenceProjection>>;
  findEvaluations(
    query: EvaluationCatalogQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<ResultEvaluationProjection>>;
  findVerifications(
    query: VerificationCatalogQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<ExecutionVerificationProjection>>;
  getRecordLocations(
    reference: EvidenceRecordReference,
    options?: CatalogOperationOptions,
  ): Promise<readonly EvidenceRecordLocation[]>;
}

export interface EvidenceCatalogWriter {
  putRecordProjection(
    projection: CatalogRecordProjection,
    options?: CatalogOperationOptions,
  ): Promise<CatalogWriteReceipt>;
  observeRecordLocation(
    reference: EvidenceRecordReference,
    observation: RecordLocationObservation,
    options?: CatalogOperationOptions,
  ): Promise<CatalogLocationReceipt>;
  withdrawRecordLocationObservation(
    withdrawal: RecordLocationWithdrawal,
    options?: CatalogOperationOptions,
  ): Promise<CatalogLocationReceipt>;
}
