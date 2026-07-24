// SPDX-License-Identifier: Apache-2.0

import type {
  EvidenceRecordReference,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

import type {
  AgentCapture,
  ArtifactCapture,
  ArtifactSource,
  ExecutionId,
  ExecutionRecordCapture,
  FinalizedExecutionReceipt,
  NativeTraceCapture,
  RepositoryStateCapture,
  RuntimeCapture,
  RuntimeObservationCapture,
  TaskCapture,
} from "./types.js";

export const WORKSPACE_FORMAT_VERSION = 1 as const;

export interface StoredObjectReference {
  readonly digest: Sha256Digest;
  readonly size: number;
}

export interface PersistedArtifactSource extends StoredObjectReference {
  readonly mediaType: string;
  readonly name?: string;
}

export type PersistedFileArtifactCapture = Omit<
  Extract<ArtifactCapture, { kind: "file" }>,
  "source"
> & {
  readonly source: PersistedArtifactSource;
};

export type PersistedAggregateArtifactCapture = Omit<
  Extract<ArtifactCapture, { kind: "dataset" | "collection" }>,
  "manifest" | "members"
> & {
  readonly manifest: PersistedArtifactSource;
  readonly members: readonly PersistedArtifactCapture[];
};

export type PersistedArtifactCapture =
  | PersistedFileArtifactCapture
  | PersistedAggregateArtifactCapture;

export type PersistedTaskCapture = Omit<TaskCapture, "source"> & {
  readonly source: PersistedArtifactSource;
};

export type PersistedRepositoryStateCapture = Omit<
  RepositoryStateCapture,
  "artifact"
> & {
  readonly artifact: PersistedAggregateArtifactCapture;
};

export type PersistedRuntimeCapture = Omit<
  RuntimeCapture,
  "specification" | "components"
> & {
  readonly specification: PersistedArtifactSource;
  readonly components: readonly (
    | {
        readonly kind: "controlled";
        readonly artifact: PersistedArtifactCapture;
      }
    | {
        readonly kind: "opaque";
        readonly descriptor: PersistedFileArtifactCapture;
        readonly component: Extract<
          RuntimeCapture["components"][number],
          { kind: "opaque" }
        >["component"];
      }
  )[];
};

export type PersistedRuntimeObservationCapture =
  | Extract<RuntimeObservationCapture, { kind: "resource" }>
  | {
      readonly kind: "environment";
      readonly artifact: PersistedArtifactCapture;
    }
  | {
      readonly kind: "opaque-component";
      readonly component: {
        readonly kind: "opaque";
        readonly descriptor: PersistedFileArtifactCapture;
        readonly component: Extract<
          RuntimeCapture["components"][number],
          { kind: "opaque" }
        >["component"];
      };
    };

export type PersistedNativeTraceCapture = Omit<
  NativeTraceCapture,
  "artifact"
> & {
  readonly artifact: PersistedArtifactCapture;
};

export interface PersistedStartRecording {
  readonly executionId: ExecutionId;
  readonly startedAt: string;
  readonly record: ExecutionRecordCapture;
  readonly task: PersistedTaskCapture;
  readonly initialInputs: readonly PersistedArtifactCapture[];
  readonly repositoryState?: PersistedRepositoryStateCapture;
  readonly executor: AgentCapture;
  readonly runtime: PersistedRuntimeCapture;
  readonly producer: AgentCapture;
}

export type JournalEvent =
  | {
      readonly type: "initialized";
      readonly recording: PersistedStartRecording;
      readonly declarationFingerprint: Sha256Digest;
    }
  | {
      readonly type: "input-captured";
      readonly input: PersistedArtifactCapture;
      readonly declarationFingerprint: Sha256Digest;
    }
  | {
      readonly type: "runtime-observation-captured";
      readonly observation: PersistedRuntimeObservationCapture;
      readonly declarationFingerprint: Sha256Digest;
    }
  | {
      readonly type: "native-trace-attached";
      readonly trace: PersistedNativeTraceCapture;
      readonly declarationFingerprint: Sha256Digest;
    }
  | {
      readonly type: "finalization-material-captured";
      readonly results: readonly PersistedArtifactCapture[];
      readonly nativeTrace?: PersistedNativeTraceCapture;
      readonly declarationFingerprint: Sha256Digest;
    }
  | {
      readonly type: "finalization-prepared";
      readonly intentFingerprint: Sha256Digest;
      readonly finalizedAt: string;
      readonly outcome: "completed" | "failed" | "abandoned";
      readonly endedAt: string;
      readonly results: readonly PersistedArtifactCapture[];
      readonly nativeTrace: PersistedNativeTraceCapture;
      readonly metadata: StoredObjectReference;
      readonly artifactDigests: readonly Sha256Digest[];
    }
  | {
      readonly type: "repository-artifact-written";
      readonly digest: Sha256Digest;
    }
  | {
      readonly type: "repository-record-written";
      readonly reference: EvidenceRecordReference;
    }
  | {
      readonly type: "finalized";
      readonly receipt: FinalizedExecutionReceipt;
    };

export interface JournalEntry {
  readonly formatVersion: typeof WORKSPACE_FORMAT_VERSION;
  readonly revision: number;
  readonly previousEntryDigest: Sha256Digest | null;
  readonly committedAt: string;
  readonly event: JournalEvent;
}

export type UnpersistedArtifactSource = ArtifactSource;
