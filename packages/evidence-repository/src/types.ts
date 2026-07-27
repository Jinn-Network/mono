export const EVIDENCE_RECORD_FAMILIES = [
  "execution-evidence",
  "result-evaluation",
  "execution-verification",
] as const;

export type Sha256Digest = `sha256:${string}`;

export type EvidenceRecordFamily = (typeof EVIDENCE_RECORD_FAMILIES)[number];

export interface EvidenceRecordReference {
  readonly family: EvidenceRecordFamily;
  readonly digest: Sha256Digest;
}

export interface EvidenceArtifactReference {
  readonly digest: Sha256Digest;
}

export interface RepositoryOperationOptions {
  readonly signal?: AbortSignal;
}

export interface RepositoryWriteReceipt<TReference> {
  readonly reference: TReference;
  readonly size: number;
  readonly status: "created" | "existing";
}

export interface EvidenceRepository {
  putRecord(
    family: EvidenceRecordFamily,
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceRecordReference>>;

  getRecord(
    reference: EvidenceRecordReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null>;

  putArtifact(
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceArtifactReference>>;

  getArtifact(
    reference: EvidenceArtifactReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null>;
}
