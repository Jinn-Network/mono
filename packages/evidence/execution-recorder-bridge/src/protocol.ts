// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AbsoluteIri,
  CaptureOrigin,
  ExecutionId,
  ExecutionRecordCapture,
  ExecutionRecordingStatus,
  ExecutorCapture,
  FinalizedExecutionReceipt,
  IdentifierCapture,
  JsonLdExtensions,
  ProducerCapture,
  ResourceRuntimeObservationCapture,
} from "@jinn-network/execution-recorder";

/**
 * Reads this package's own `version` field out of its package.json, which
 * sits one directory above this module both in source (src/protocol.ts)
 * and in the compiled, packed distribution (dist/protocol.js). Failing
 * loudly here (rather than falling back to a placeholder) is deliberate:
 * a bridge shipped without a readable version is a packaging bug that
 * `hello` must never paper over.
 */
function readOwnPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "..", "package.json"), "utf8");
  const pkg = JSON.parse(raw) as { readonly version?: string };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error(
      "execution-recorder-bridge package.json is missing a version field.",
    );
  }
  return pkg.version;
}

export const RECORDER_BRIDGE_PROTOCOL =
  "jinn.execution-recorder.bridge/v1" as const;
export const RECORDER_BRIDGE_VERSION: string = readOwnPackageVersion();
// Declares the Recorder release this bridge build was verified against.
// protocol.test.ts asserts this stays equal to the installed
// @jinn-network/execution-recorder version, so `hello` cannot drift from
// the Recorder it actually fronts.
export const COMPATIBLE_RECORDER_VERSION = "0.1.0" as const;

export const RECORDER_BRIDGE_METHODS = [
  "hello",
  "start",
  "resume",
  "captureInput",
  "captureRuntimeObservation",
  "attachNativeTrace",
  "finalize",
] as const;

export type RecorderBridgeMethod = (typeof RECORDER_BRIDGE_METHODS)[number];

// --- Wire artifact source -------------------------------------------------

export type WireArtifactSource =
  | {
      readonly kind: "bytes";
      readonly base64: string;
      readonly mediaType: string;
      readonly name?: string;
    }
  | {
      readonly kind: "path";
      readonly path: string;
      readonly mediaType: string;
      readonly name?: string;
    };

// --- Wire capture shapes ---------------------------------------------------
//
// These mirror the Recorder's own capture declarations (see
// `@jinn-network/execution-recorder`'s `types.ts`), replacing every Recorder
// `ArtifactSource` with `WireArtifactSource`. Declarations that carry no
// `ArtifactSource` field are reused directly from the Recorder package.

export interface WireFileArtifactCapture {
  readonly kind: "file";
  readonly entityId: string;
  readonly source: WireArtifactSource;
  readonly origin: CaptureOrigin;
  readonly additionalTypes?: readonly string[];
  readonly identifiers?: readonly IdentifierCapture[];
  readonly extensions?: JsonLdExtensions;
}

export interface WireAggregateArtifactCapture {
  readonly kind: "dataset" | "collection";
  readonly entityId: string;
  readonly manifest: WireArtifactSource;
  readonly members: readonly WireArtifactCapture[];
  readonly origin: CaptureOrigin;
  readonly additionalTypes?: readonly string[];
  readonly identifiers?: readonly IdentifierCapture[];
  readonly extensions?: JsonLdExtensions;
}

export type WireArtifactCapture =
  | WireFileArtifactCapture
  | WireAggregateArtifactCapture;

export type WireInputCapture = WireArtifactCapture;
export type WireResultCapture = WireArtifactCapture;

export interface WireTaskCapture {
  readonly entityId: string;
  readonly name: string;
  readonly source: WireArtifactSource;
  readonly origin: CaptureOrigin;
  readonly identifiers?: readonly IdentifierCapture[];
  readonly extensions?: JsonLdExtensions;
}

export interface WireRepositoryStateCapture {
  readonly artifact: WireAggregateArtifactCapture;
  readonly identifiers: readonly IdentifierCapture[];
  readonly repository?: AbsoluteIri;
  readonly extensions?: JsonLdExtensions;
}

export interface WireControlledRuntimeComponentCapture {
  readonly kind: "controlled";
  readonly artifact: WireArtifactCapture;
}

export interface WireOpaqueRuntimeComponentCapture {
  readonly kind: "opaque";
  readonly descriptor: WireFileArtifactCapture;
  readonly component: {
    readonly entityId: AbsoluteIri;
    readonly name: string;
    readonly softwareVersion?: string;
    readonly provider?: AbsoluteIri;
    readonly extensions?: JsonLdExtensions;
  };
}

export type WireRuntimeComponentCapture =
  | WireControlledRuntimeComponentCapture
  | WireOpaqueRuntimeComponentCapture;

export interface WireRuntimeCapture {
  readonly entityId: string;
  readonly specification: WireArtifactSource;
  readonly name: string;
  readonly softwareVersion?: string;
  readonly origin: CaptureOrigin;
  readonly components: readonly WireRuntimeComponentCapture[];
  readonly extensions?: JsonLdExtensions;
}

export interface WireEnvironmentRuntimeObservationCapture {
  readonly kind: "environment";
  readonly artifact: WireArtifactCapture;
}

export interface WireOpaqueComponentRuntimeObservationCapture {
  readonly kind: "opaque-component";
  readonly component: WireOpaqueRuntimeComponentCapture;
}

export type WireRuntimeObservationCapture =
  | ResourceRuntimeObservationCapture
  | WireEnvironmentRuntimeObservationCapture
  | WireOpaqueComponentRuntimeObservationCapture;

export interface WireNativeTraceCapture {
  readonly artifact: WireArtifactCapture;
  readonly format: {
    readonly entityId: AbsoluteIri;
    readonly name?: string;
  };
}

// --- Mutation target ---------------------------------------------------

export interface RecorderBridgeTarget {
  readonly workspaceDir: string;
  readonly executionId: ExecutionId;
}

// --- Method request params -------------------------------------------------

export interface HelloRequestParams {}

export interface StartRequestParams {
  readonly workspaceDir: string;
  readonly executionId?: ExecutionId;
  readonly startedAt: string;
  readonly record: ExecutionRecordCapture;
  readonly task: WireTaskCapture;
  readonly initialInputs?: readonly WireInputCapture[];
  readonly repositoryState?: WireRepositoryStateCapture;
  readonly executor: ExecutorCapture;
  readonly runtime: WireRuntimeCapture;
  readonly producer: ProducerCapture;
}

export interface ResumeRequestParams {
  readonly workspaceDir: string;
}

export interface CaptureInputRequestParams {
  readonly target: RecorderBridgeTarget;
  readonly input: WireInputCapture;
}

export interface CaptureRuntimeObservationRequestParams {
  readonly target: RecorderBridgeTarget;
  readonly observation: WireRuntimeObservationCapture;
}

export interface AttachNativeTraceRequestParams {
  readonly target: RecorderBridgeTarget;
  readonly trace: WireNativeTraceCapture;
}

export interface FinalizeRequestParams {
  readonly target: RecorderBridgeTarget;
  readonly outcome: "completed" | "failed" | "abandoned";
  readonly endedAt: string;
  readonly results?: readonly WireResultCapture[];
  readonly nativeTrace?: WireNativeTraceCapture;
}

interface RecorderBridgeRequestEnvelope<
  TMethod extends RecorderBridgeMethod,
  TParams,
> {
  readonly protocol: typeof RECORDER_BRIDGE_PROTOCOL;
  readonly id: string;
  readonly method: TMethod;
  readonly params: TParams;
}

export type RecorderBridgeRequest =
  | RecorderBridgeRequestEnvelope<"hello", HelloRequestParams>
  | RecorderBridgeRequestEnvelope<"start", StartRequestParams>
  | RecorderBridgeRequestEnvelope<"resume", ResumeRequestParams>
  | RecorderBridgeRequestEnvelope<"captureInput", CaptureInputRequestParams>
  | RecorderBridgeRequestEnvelope<
      "captureRuntimeObservation",
      CaptureRuntimeObservationRequestParams
    >
  | RecorderBridgeRequestEnvelope<
      "attachNativeTrace",
      AttachNativeTraceRequestParams
    >
  | RecorderBridgeRequestEnvelope<"finalize", FinalizeRequestParams>;

// --- Responses ---------------------------------------------------------

export interface HelloResult {
  readonly bridgeVersion: typeof RECORDER_BRIDGE_VERSION;
  readonly recorderVersion: typeof COMPATIBLE_RECORDER_VERSION;
  readonly protocol: typeof RECORDER_BRIDGE_PROTOCOL;
}

export interface RecorderBridgeMutationResult {
  readonly executionId: ExecutionId;
  readonly status: ExecutionRecordingStatus;
  readonly receipt?: FinalizedExecutionReceipt;
}

export interface RecorderBridgeErrorPayload {
  readonly domain: "bridge" | "recorder" | "repository";
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type RecorderBridgeResponse =
  | {
      readonly protocol: typeof RECORDER_BRIDGE_PROTOCOL;
      readonly id: string;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly protocol: typeof RECORDER_BRIDGE_PROTOCOL;
      readonly id: string;
      readonly ok: false;
      readonly error: RecorderBridgeErrorPayload;
    };
