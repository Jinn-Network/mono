// SPDX-License-Identifier: Apache-2.0

export type ExecutionId = `urn:uuid:${string}`;
export type AbsoluteIri = `${string}:${string}`;
export type Sha256Digest = `sha256:${string}`;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonLdExtensions = Readonly<Record<string, JsonValue>>;

export interface IdentifierCapture {
  readonly propertyId: AbsoluteIri;
  readonly value: string;
}

export type CaptureOrigin =
  | {
      readonly kind: "producer-observed";
      readonly observer: AbsoluteIri;
    }
  | {
      readonly kind: "executor-reported";
      readonly reporter: AbsoluteIri;
      readonly capturedBy: AbsoluteIri;
    }
  | {
      readonly kind: "external-observed";
      readonly observer: AbsoluteIri;
      readonly capturedBy: AbsoluteIri;
    };

export interface ExecutionEvidenceArtifactSource {
  readonly digest: Sha256Digest;
  readonly size: number;
  readonly mediaType: string;
  readonly name?: string;
}

export interface ArtifactCaptureMetadata {
  readonly origin: CaptureOrigin;
  readonly additionalTypes?: readonly string[];
  readonly identifiers?: readonly IdentifierCapture[];
  readonly extensions?: JsonLdExtensions;
}

export interface ExecutionEvidenceFileArtifact extends ArtifactCaptureMetadata {
  readonly kind: "file";
  readonly entityId: string;
  readonly source: ExecutionEvidenceArtifactSource;
}

export interface ExecutionEvidenceAggregateArtifact
  extends ArtifactCaptureMetadata {
  readonly kind: "dataset" | "collection";
  readonly entityId: string;
  readonly manifest: ExecutionEvidenceArtifactSource;
  readonly members: readonly ExecutionEvidenceArtifact[];
}

export type ExecutionEvidenceArtifact =
  | ExecutionEvidenceFileArtifact
  | ExecutionEvidenceAggregateArtifact;

export interface ExecutionEvidenceTask {
  readonly entityId: string;
  readonly name: string;
  readonly source: ExecutionEvidenceArtifactSource;
  readonly origin: CaptureOrigin;
  readonly identifiers?: readonly IdentifierCapture[];
  readonly extensions?: JsonLdExtensions;
}

export type AgentKind = "person" | "organization" | "software";

export interface AgentCapture {
  readonly entityId: AbsoluteIri;
  readonly kind: AgentKind;
  readonly name: string;
  readonly softwareVersion?: string;
  readonly identifiers?: readonly IdentifierCapture[];
  readonly origin: CaptureOrigin;
  readonly extensions?: JsonLdExtensions;
}

export type ExecutionEvidenceRuntimeComponent =
  | {
      readonly kind: "controlled";
      readonly artifact: ExecutionEvidenceArtifact;
    }
  | {
      readonly kind: "opaque";
      readonly descriptor: ExecutionEvidenceFileArtifact;
      readonly component: {
        readonly entityId: AbsoluteIri;
        readonly name: string;
        readonly softwareVersion?: string;
        readonly provider?: AbsoluteIri;
        readonly extensions?: JsonLdExtensions;
      };
    };

export interface ExecutionEvidenceRuntime {
  readonly entityId: string;
  readonly specification: ExecutionEvidenceArtifactSource;
  readonly name: string;
  readonly softwareVersion?: string;
  readonly origin: CaptureOrigin;
  readonly components: readonly ExecutionEvidenceRuntimeComponent[];
  readonly extensions?: JsonLdExtensions;
}

export type ExecutionEvidenceRuntimeObservation =
  | {
      readonly kind: "resource";
      readonly entityId: string;
      readonly name: string;
      readonly value: string | number | boolean;
      readonly propertyId?: AbsoluteIri;
      readonly unitCode?: string;
      readonly unitText?: string;
      readonly origin: CaptureOrigin;
      readonly extensions?: JsonLdExtensions;
    }
  | {
      readonly kind: "environment";
      readonly artifact: ExecutionEvidenceArtifact;
    }
  | {
      readonly kind: "opaque-component";
      readonly component: Extract<
        ExecutionEvidenceRuntimeComponent,
        { kind: "opaque" }
      >;
    };

export interface ExecutionEvidenceNativeTrace {
  readonly artifact: ExecutionEvidenceArtifact;
  readonly format: {
    readonly entityId: AbsoluteIri;
    readonly name?: string;
  };
}

export interface ExecutionEvidenceRecord {
  readonly name: string;
  readonly description: string;
  readonly license: AbsoluteIri;
  readonly executionName?: string;
  readonly executionIdentifiers?: readonly IdentifierCapture[];
  readonly documentExtensions?: JsonLdExtensions;
  readonly rootExtensions?: JsonLdExtensions;
  readonly executionExtensions?: JsonLdExtensions;
}

export interface ExecutionEvidenceRepositoryState {
  readonly artifact: ExecutionEvidenceAggregateArtifact;
  readonly identifiers: readonly IdentifierCapture[];
  readonly repository?: AbsoluteIri;
  readonly extensions?: JsonLdExtensions;
}

export interface ExecutionEvidenceRecording {
  readonly executionId: ExecutionId;
  readonly startedAt: string;
  readonly record: ExecutionEvidenceRecord;
  readonly task: ExecutionEvidenceTask;
  readonly initialInputs: readonly ExecutionEvidenceArtifact[];
  readonly repositoryState?: ExecutionEvidenceRepositoryState;
  readonly executor: AgentCapture;
  readonly runtime: ExecutionEvidenceRuntime;
  readonly producer: AgentCapture;
}

/**
 * Exact, already-content-addressed material used to construct one Execution
 * Evidence v1 record. The builder observes no process and reads no storage.
 */
export interface ExecutionEvidenceBuilderInput {
  readonly recording: ExecutionEvidenceRecording;
  readonly additionalInputs: readonly ExecutionEvidenceArtifact[];
  readonly runtimeObservations: readonly ExecutionEvidenceRuntimeObservation[];
  readonly outcome: "completed" | "failed" | "abandoned";
  readonly endedAt: string;
  readonly finalizedAt: string;
  readonly results: readonly ExecutionEvidenceArtifact[];
  readonly nativeTrace: ExecutionEvidenceNativeTrace;
}

// Internal compatibility aliases keep graph construction vocabulary stable
// while the public API uses execution-evidence terminology.
export type PersistedArtifactSource = ExecutionEvidenceArtifactSource;
export type PersistedArtifactCapture = ExecutionEvidenceArtifact;
export type PersistedNativeTraceCapture = ExecutionEvidenceNativeTrace;
export type PersistedRuntimeObservationCapture =
  ExecutionEvidenceRuntimeObservation;
export type PersistedStartRecording = ExecutionEvidenceRecording;
