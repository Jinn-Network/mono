// SPDX-License-Identifier: Apache-2.0

import type { ConformanceDiagnostic } from "@jinn-network/evidence-protocol";
import type {
  EvidenceArtifactReference,
  EvidenceRecordReference,
  EvidenceRepository,
} from "@jinn-network/evidence-repository";

export type ExecutionId = `urn:uuid:${string}`;
export type AbsoluteIri = `${string}:${string}`;

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

export type ArtifactSource =
  | {
      readonly bytes: Uint8Array;
      readonly path?: never;
      readonly mediaType: string;
      readonly name?: string;
    }
  | {
      readonly path: string;
      readonly bytes?: never;
      readonly mediaType: string;
      readonly name?: string;
    };

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

export interface ArtifactCaptureMetadata {
  readonly origin: CaptureOrigin;
  readonly additionalTypes?: readonly string[];
  readonly identifiers?: readonly IdentifierCapture[];
  readonly extensions?: JsonLdExtensions;
}

export interface FileArtifactCapture extends ArtifactCaptureMetadata {
  readonly kind: "file";
  readonly entityId: string;
  readonly source: ArtifactSource;
}

export interface AggregateArtifactCapture extends ArtifactCaptureMetadata {
  readonly kind: "dataset" | "collection";
  readonly entityId: string;
  readonly manifest: ArtifactSource;
  readonly members: readonly ArtifactCapture[];
}

export type ArtifactCapture =
  | FileArtifactCapture
  | AggregateArtifactCapture;

export interface TaskCapture {
  readonly entityId: string;
  readonly name: string;
  readonly source: ArtifactSource;
  readonly origin: CaptureOrigin;
  readonly identifiers?: readonly IdentifierCapture[];
  readonly extensions?: JsonLdExtensions;
}

export type InputCapture = ArtifactCapture;
export type ResultCapture = ArtifactCapture;

export interface RepositoryStateCapture {
  readonly artifact: AggregateArtifactCapture;
  readonly identifiers: readonly IdentifierCapture[];
  readonly repository?: AbsoluteIri;
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

export interface ExecutorCapture extends AgentCapture {}
export interface ProducerCapture extends AgentCapture {}

export interface ControlledRuntimeComponentCapture {
  readonly kind: "controlled";
  readonly artifact: ArtifactCapture;
}

export interface OpaqueRuntimeComponentCapture {
  readonly kind: "opaque";
  readonly descriptor: FileArtifactCapture;
  readonly component: {
    readonly entityId: AbsoluteIri;
    readonly name: string;
    readonly softwareVersion?: string;
    readonly provider?: AbsoluteIri;
    readonly extensions?: JsonLdExtensions;
  };
}

export type RuntimeComponentCapture =
  | ControlledRuntimeComponentCapture
  | OpaqueRuntimeComponentCapture;

export interface RuntimeCapture {
  readonly entityId: string;
  readonly specification: ArtifactSource;
  readonly name: string;
  readonly softwareVersion?: string;
  readonly origin: CaptureOrigin;
  readonly components: readonly RuntimeComponentCapture[];
  readonly extensions?: JsonLdExtensions;
}

export interface ResourceRuntimeObservationCapture {
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

export interface EnvironmentRuntimeObservationCapture {
  readonly kind: "environment";
  readonly artifact: ArtifactCapture;
}

export interface OpaqueComponentRuntimeObservationCapture {
  readonly kind: "opaque-component";
  readonly component: OpaqueRuntimeComponentCapture;
}

export type RuntimeObservationCapture =
  | ResourceRuntimeObservationCapture
  | EnvironmentRuntimeObservationCapture
  | OpaqueComponentRuntimeObservationCapture;

export interface NativeTraceCapture {
  readonly artifact: ArtifactCapture;
  readonly format: {
    readonly entityId: AbsoluteIri;
    readonly name?: string;
  };
}

export interface ExecutionRecordCapture {
  readonly name: string;
  readonly description: string;
  readonly license: AbsoluteIri;
  readonly executionName?: string;
  readonly executionIdentifiers?: readonly IdentifierCapture[];
  readonly documentExtensions?: JsonLdExtensions;
  readonly rootExtensions?: JsonLdExtensions;
  readonly executionExtensions?: JsonLdExtensions;
}

export interface ExecutionRecorderOptions {
  readonly repository: EvidenceRepository;
}

export interface StartExecutionRecordingInput {
  readonly workspaceDir: string;
  readonly executionId?: ExecutionId;
  readonly startedAt: string;
  readonly record: ExecutionRecordCapture;
  readonly task: TaskCapture;
  readonly initialInputs?: readonly InputCapture[];
  readonly repositoryState?: RepositoryStateCapture;
  readonly executor: ExecutorCapture;
  readonly runtime: RuntimeCapture;
  readonly producer: ProducerCapture;
  readonly signal?: AbortSignal;
}

export interface ResumeExecutionRecordingInput {
  readonly workspaceDir: string;
  readonly signal?: AbortSignal;
}

export interface RecordingOperationOptions {
  readonly signal?: AbortSignal;
}

export interface FinalizeExecutionInput {
  readonly outcome: "completed" | "failed" | "abandoned";
  readonly endedAt: string;
  readonly results?: readonly ResultCapture[];
  readonly nativeTrace?: NativeTraceCapture;
}

export const CAPTURE_DIAGNOSTIC_CODES = [
  "NATIVE_TRACE_MISSING",
  "COMPLETED_RESULT_MISSING",
] as const;

export type CaptureDiagnosticCode =
  (typeof CAPTURE_DIAGNOSTIC_CODES)[number];

export interface CaptureDiagnostic {
  readonly code: CaptureDiagnosticCode;
  readonly path: "/nativeTrace" | "/results";
  readonly message: string;
  readonly entityId: ExecutionId;
}

export interface FinalizedExecutionReceipt {
  readonly executionId: ExecutionId;
  readonly record: EvidenceRecordReference;
  readonly artifacts: readonly EvidenceArtifactReference[];
  readonly finalizedAt: string;
}

export type FinalizeExecutionResult =
  | {
      readonly finalized: true;
      readonly receipt: FinalizedExecutionReceipt;
    }
  | {
      readonly finalized: false;
      readonly diagnostics: readonly CaptureDiagnostic[];
    };

export type ExecutionRecordingStatus =
  | "open"
  | "finalizing"
  | "finalized";

export interface ExecutionRecording {
  readonly executionId: ExecutionId;
  readonly status: ExecutionRecordingStatus;
  readonly receipt?: FinalizedExecutionReceipt;

  captureInput(
    input: InputCapture,
    options?: RecordingOperationOptions,
  ): Promise<void>;

  captureRuntimeObservation(
    observation: RuntimeObservationCapture,
    options?: RecordingOperationOptions,
  ): Promise<void>;

  attachNativeTrace(
    trace: NativeTraceCapture,
    options?: RecordingOperationOptions,
  ): Promise<void>;

  finalize(
    input: FinalizeExecutionInput,
    options?: RecordingOperationOptions,
  ): Promise<FinalizeExecutionResult>;
}

export interface ExecutionRecorder {
  start(input: StartExecutionRecordingInput): Promise<ExecutionRecording>;
  resume(input: ResumeExecutionRecordingInput): Promise<ExecutionRecording>;
}

export interface ExecutionRecorderErrorDetails {
  readonly workspaceDir?: string;
  readonly entityId?: string;
  readonly diagnostics?: readonly ConformanceDiagnostic[];
}
