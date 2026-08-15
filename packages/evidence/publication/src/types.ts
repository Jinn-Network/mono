// SPDX-License-Identifier: Apache-2.0
import type {
  EvidenceArtifactReference,
  EvidenceRecordReference,
  EvidenceRepository,
  RepositoryOperationOptions,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

export type DestinationScope = string;

export interface PublishRecord {
  readonly reference: EvidenceRecordReference;
  readonly bytes: Uint8Array;
}

export interface PublishArtifact {
  readonly reference: EvidenceArtifactReference;
  readonly bytes: Uint8Array;
}

export interface PublishInput {
  readonly records: readonly PublishRecord[];
  readonly artifacts?: readonly PublishArtifact[];
  readonly destination: DestinationScope;
  readonly signal?: AbortSignal;
}

export interface NormalizedPublishInput {
  readonly records: readonly PublishRecord[];
  readonly artifacts: readonly PublishArtifact[];
  readonly destination: DestinationScope;
  readonly bundleKey: Sha256Digest;
  readonly payloadFingerprint: Sha256Digest;
}

export interface AnnouncementMember {
  readonly reference: EvidenceRecordReference;
}

export interface AnnouncementPreparationContext {
  readonly destination: DestinationScope;
  readonly partitionOrdinal: number;
}

export interface PreparedAnnouncement {
  readonly medium: string;
  readonly profile: string;
  readonly members: readonly AnnouncementMember[];
  readonly frameBytes: Uint8Array;
  readonly frameDigest: Sha256Digest;
  readonly frameSize: number;
}

export interface AnnouncementSinkCapabilities {
  readonly maxMembersPerAnnouncement?: number;
  readonly maxFrameBytes?: number;
}

export interface OpaqueSinkState {
  readonly format: string;
  readonly bytes: Uint8Array;
}

export interface Placement {
  readonly externalId: string;
  readonly state?: OpaqueSinkState;
}

export interface PendingAnnouncement {
  readonly idempotencyKey: Sha256Digest;
  readonly frameDigest: Sha256Digest;
  readonly state?: OpaqueSinkState;
}

export type PlaceResult =
  | {
      readonly status: "placed" | "existing";
      readonly placement: Placement;
    }
  | {
      readonly status: "pending";
      readonly pending: PendingAnnouncement;
    };

export type ReconcileResult =
  | {
      readonly status: "placed" | "existing";
      readonly placement: Placement;
    }
  | {
      readonly status: "pending";
      readonly pending: PendingAnnouncement;
    }
  | { readonly status: "not-found" }
  | {
      readonly status: "reverted";
      readonly externalId?: string;
      readonly reason?: string;
    };

export interface AnnouncementSink {
  readonly medium: string;
  readonly profile: string;
  readonly capabilities: AnnouncementSinkCapabilities;

  prepare(
    members: readonly AnnouncementMember[],
    context: AnnouncementPreparationContext,
    options?: RepositoryOperationOptions,
  ): Promise<PreparedAnnouncement>;

  place(
    prepared: PreparedAnnouncement,
    idempotencyKey: Sha256Digest,
    options?: RepositoryOperationOptions,
  ): Promise<PlaceResult>;

  reconcile(
    prepared: PreparedAnnouncement,
    pending: PendingAnnouncement,
    options?: RepositoryOperationOptions,
  ): Promise<ReconcileResult>;
}

export interface JournalRepositoryCapabilities {
  readonly maxObjectBytes?: number;
}

export interface StoredArtifactCheckpoint {
  readonly reference: EvidenceArtifactReference;
  readonly size: number;
}

export interface StoredRecordCheckpoint {
  readonly reference: EvidenceRecordReference;
  readonly size: number;
}

export type PublicationPartitionPlacement =
  | { readonly status: "unplaced" }
  | {
      readonly status: "pending";
      readonly pending: PendingAnnouncement;
    }
  | {
      readonly status: "confirmed";
      readonly result: "placed" | "existing";
      readonly placement: Placement;
    };

export interface PreparedPublicationPartition {
  readonly ordinal: number;
  readonly prepared: PreparedAnnouncement;
  readonly placement: PublicationPartitionPlacement;
}

export interface PublicationJournalEntry {
  readonly schemaVersion: 1;
  readonly bundleKey: Sha256Digest;
  readonly payloadFingerprint: Sha256Digest;
  readonly destination: DestinationScope;
  readonly repositoryCapabilities: JournalRepositoryCapabilities;
  readonly artifacts: readonly EvidenceArtifactReference[];
  readonly records: readonly EvidenceRecordReference[];
  readonly storedArtifacts: readonly StoredArtifactCheckpoint[];
  readonly storedRecords: readonly StoredRecordCheckpoint[];
  readonly preparedPartitions?: readonly PreparedPublicationPartition[];
  readonly completed: boolean;
}

export interface VersionedPublicationJournalEntry
  extends PublicationJournalEntry {
  readonly revision: number;
}

export interface PublicationJournalStore {
  load(
    bundleKey: Sha256Digest,
    options?: RepositoryOperationOptions,
  ): Promise<VersionedPublicationJournalEntry | null>;

  create(
    entry: PublicationJournalEntry,
    options?: RepositoryOperationOptions,
  ): Promise<VersionedPublicationJournalEntry>;

  compareAndSwap(
    expected: VersionedPublicationJournalEntry,
    next: PublicationJournalEntry,
    options?: RepositoryOperationOptions,
  ): Promise<VersionedPublicationJournalEntry>;
}

export interface PublicationDependencies {
  readonly repository: EvidenceRepository;
  readonly sink: AnnouncementSink;
  readonly journal: PublicationJournalStore;
}

export interface PublicationPlacementReceipt {
  readonly ordinal: number;
  readonly frameDigest: Sha256Digest;
  readonly result: "placed" | "existing";
  readonly placement: Placement;
}

export interface PublicationReceipt {
  readonly bundleKey: Sha256Digest;
  readonly payloadFingerprint: Sha256Digest;
  readonly destination: DestinationScope;
  readonly artifacts: readonly EvidenceArtifactReference[];
  readonly records: readonly EvidenceRecordReference[];
  readonly placements: readonly PublicationPlacementReceipt[];
  readonly completed: true;
}
