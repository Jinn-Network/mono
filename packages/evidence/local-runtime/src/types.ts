// SPDX-License-Identifier: MIT
import type {
  CatalogRecordProjection,
  EvidenceCatalogReader,
  EvidenceRecordAnnouncementSource,
} from "@jinn-network/evidence-discovery";
import type { ConformanceDiagnostic } from "@jinn-network/evidence-protocol";
import type {
  EvidenceRecordReference,
  EvidenceRepository,
} from "@jinn-network/evidence-repository";
import type { SourceIdentity } from "@jinn-network/record-discovery-protocol";
import type {
  DurableSourceSigner,
  ReadableImmutableBlobStore,
} from "@jinn-network/record-discovery-serve";
import type {
  EvidenceJournalPublicDiscoveryBridgeFactory,
  LocalPublicDiscoveryBridge,
} from "./public-discovery.js";

export interface LocalEvidencePublicDiscoveryOptions {
  readonly source: SourceIdentity;
  readonly signer: DurableSourceSigner;
  readonly blobs: ReadableImmutableBlobStore;
  /** Explicit adapter factory; the ordinary local-runtime dependency closure does not include it. */
  readonly bridgeFactory: EvidenceJournalPublicDiscoveryBridgeFactory;
  readonly withdrawals?: EvidenceRecordAnnouncementSource;
  readonly now?: () => Date;
  readonly refreshWithinMs?: number;
}

export interface OpenLocalEvidenceRuntimeOptions {
  readonly rootDir: string;
  readonly signal?: AbortSignal;
  /** Explicit optional local-journal -> sole public Record Discovery source composition. */
  readonly publicDiscovery?: LocalEvidencePublicDiscoveryOptions;
}

export type LocalRuntimeLifecycleState =
  | "ready"
  | "degraded"
  | "rebuilding"
  | "closing"
  | "closed";

export interface LocalRuntimeOperationOptions {
  readonly signal?: AbortSignal;
}

export type LocalIndexingFailureCategory =
  | "protocol-nonconformance"
  | "content-corrupt"
  | "announcement-invalid"
  | "validated-record-inconsistent"
  | "catalog-conflict";

export interface LocalIndexingFailure {
  readonly reference: EvidenceRecordReference;
  readonly category: LocalIndexingFailureCategory;
  readonly sourceCode: string;
  readonly message: string;
  readonly diagnostics?: readonly ConformanceDiagnostic[];
  readonly observedAt: string;
}

export interface LocalTransientIndexingFailure {
  readonly reference?: EvidenceRecordReference;
  readonly sourceCode: string;
  readonly message: string;
  readonly attempt: number;
  readonly observedAt: string;
}

export type LocalEvidenceIndexingOutcome =
  | {
      readonly status: "indexed";
      readonly reference: EvidenceRecordReference;
      readonly projection: CatalogRecordProjection;
    }
  | {
      readonly status: "failed";
      readonly reference: EvidenceRecordReference;
      readonly failure: LocalIndexingFailure;
    }
  | {
      readonly status: "not-announced";
      readonly reference: EvidenceRecordReference;
    };

export interface LocalEvidenceSyncReport {
  readonly status: "synchronized";
  readonly highWaterCursor?: string;
  readonly indexed: number;
  readonly failed: number;
}

export interface LocalIndexingFailureQuery {
  readonly reference?: EvidenceRecordReference;
  readonly category?: LocalIndexingFailureCategory;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface LocalIndexingFailurePage {
  readonly items: readonly LocalIndexingFailure[];
  readonly nextCursor?: string;
}

export interface LocalEvidenceRuntimeStatus {
  readonly state: LocalRuntimeLifecycleState;
  readonly sourceId: string;
  readonly repositoryId: string;
  readonly activeGenerationId: string;
  readonly journalHighWaterCursor?: string;
  readonly indexerCheckpointCursor?: string;
  readonly pendingPublications: number;
  readonly pendingAnnouncements: number;
  readonly terminalFailureCount: number;
  readonly recentFailures: readonly LocalIndexingFailure[];
  readonly transientFailure?: LocalTransientIndexingFailure;
}

export interface LocalEvidenceRuntime {
  readonly repository: EvidenceRepository;
  readonly catalog: EvidenceCatalogReader;
  readonly publicDiscovery?: LocalPublicDiscoveryBridge;
  sync(options?: LocalRuntimeOperationOptions): Promise<LocalEvidenceSyncReport>;
  awaitIndexed(
    reference: EvidenceRecordReference,
    options?: LocalRuntimeOperationOptions,
  ): Promise<LocalEvidenceIndexingOutcome>;
  getStatus(): Promise<LocalEvidenceRuntimeStatus>;
  listIndexingFailures(
    query?: LocalIndexingFailureQuery,
    options?: LocalRuntimeOperationOptions,
  ): Promise<LocalIndexingFailurePage>;
  close(options?: LocalRuntimeOperationOptions): Promise<void>;
}
