// SPDX-License-Identifier: Apache-2.0

import type {
  DigestBearingResourceDescriptor,
  EvidenceRecordReference,
  ExecutionBatchCapture,
  ExecutionBatchIntent,
  SealedRecord,
  TypedRecordReference,
} from "@jinn-network/benchmarking-protocol";
import type {
  ExecutionEvidenceArtifactSource,
  ExecutionEvidenceBuilderInput,
} from "@jinn-network/execution-evidence-builder";

export type NativeIdentifier = NonNullable<ExecutionBatchCapture["nativeGroup"]>;

export interface NativeSource {
  readonly kind: string;
  readonly locator: string;
}

export interface NativeSnapshot {
  readonly snapshotId: string;
  readonly source: NativeSource;
  readonly root: DigestBearingResourceDescriptor;
  readonly capturedAt: string;
}

export interface NativeAdapterIdentity {
  readonly id: `${string}:${string}`;
  readonly version: string;
  readonly mappingVersion: string;
}

export interface NativeAdapterProbe {
  readonly compatible: boolean;
  readonly adapter: NativeAdapterIdentity;
  readonly runtimeClosure: readonly DigestBearingResourceDescriptor[];
  readonly expectedScope: {
    readonly unitKind: string;
    readonly nativeGroupId?: NativeIdentifier;
    readonly expectedUnitCount?: number;
    readonly scope: DigestBearingResourceDescriptor;
  };
  readonly limitations: readonly string[];
}

export interface NativeUnitCoordinate {
  readonly unitKey: string;
  readonly identifiers: readonly NativeIdentifier[];
}

export interface NativeRunInventory {
  readonly nativeGroup?: NativeIdentifier;
  readonly units: readonly NativeUnitCoordinate[];
  readonly limitations: readonly string[];
}

export interface NativeAtomDraft {
  readonly unitKey: string;
  readonly status: "captured" | "failed" | "tombstone" | "excluded";
  readonly evidence?: ExecutionEvidenceBuilderInput;
  readonly artifacts: readonly {
    readonly source: ExecutionEvidenceArtifactSource;
    readonly bytes: Uint8Array;
  }[];
  readonly projectedEvaluations: readonly EvidenceRecordReference[];
  readonly limitations: readonly string[];
}

export interface FixedNativeInvocation {
  readonly executable: {
    readonly path: string;
    readonly artifact: DigestBearingResourceDescriptor;
  };
  readonly argv: readonly string[];
  readonly environment: readonly { readonly name: string; readonly value: string }[];
  readonly workingDirectoryPolicy:
    | "sealed-source-root"
    | "isolated-workspace"
    | "adapter-controlled";
  readonly runtimeClosure: readonly DigestBearingResourceDescriptor[];
}

export interface AtomizeContext {
  readonly mode: "prospective" | "retrospective";
  readonly owner: `${string}:${string}`;
  readonly intent?: DigestBearingResourceDescriptor;
}

export interface NativeExecutionAdapter {
  probe(snapshot: NativeSnapshot): NativeAdapterProbe;
  inventory(snapshot: NativeSnapshot): NativeRunInventory;
  atomize(
    snapshot: NativeSnapshot,
    unit: NativeUnitCoordinate,
    context: AtomizeContext,
  ): NativeAtomDraft;
  prepareLaunch?(snapshot: NativeSnapshot, probe: NativeAdapterProbe): FixedNativeInvocation;
}

export interface SnapshotPolicy {
  readonly followSymlinks: false;
  readonly allowHardlinks: false;
  readonly allowSpecialFiles: false;
  readonly maximumBytes: number;
  readonly maximumEntries: number;
}

export interface NativeSnapshotPort {
  snapshot(source: NativeSource, policy: SnapshotPolicy): NativeSnapshot;
  assertUnchanged(snapshot: NativeSnapshot): void;
}

export interface NativeLaunchResult {
  readonly exitCode: number;
  readonly resultSource: NativeSource;
  readonly limitations: readonly string[];
}

export interface IdempotentNativeLauncher {
  ensureStarted(launchId: string, invocation: FixedNativeInvocation): void;
  wait(launchId: string): NativeLaunchResult;
}

export interface StoredNativeRecord {
  readonly reference: EvidenceRecordReference;
  readonly bytes: Uint8Array;
}

export type NativeCaptureSession =
  | {
      readonly sessionId: string;
      readonly revision: number;
      readonly phase: "planned";
      readonly owner: `${string}:${string}`;
      readonly adapterId: string;
      readonly sourceSnapshot: NativeSnapshot;
      readonly intent: SealedRecord;
      readonly intentReference: TypedRecordReference;
      readonly invocation: FixedNativeInvocation;
      readonly policy: SnapshotPolicy;
    }
  | {
      readonly sessionId: string;
      readonly revision: number;
      readonly phase: "launching";
      readonly owner: `${string}:${string}`;
      readonly adapterId: string;
      readonly sourceSnapshot: NativeSnapshot;
      readonly intent: SealedRecord;
      readonly intentReference: TypedRecordReference;
      readonly invocation: FixedNativeInvocation;
      readonly launchId: string;
      readonly policy: SnapshotPolicy;
    }
  | {
      readonly sessionId: string;
      readonly revision: number;
      readonly phase: "ingesting";
      readonly mode: "prospective" | "retrospective";
      readonly owner: `${string}:${string}`;
      readonly adapterId: string;
      readonly resultSnapshot: NativeSnapshot;
      readonly policy: SnapshotPolicy;
      readonly launchLimitations: readonly string[];
      readonly intent?: SealedRecord;
      readonly intentReference?: TypedRecordReference;
    }
  | {
      readonly sessionId: string;
      readonly revision: number;
      readonly phase: "complete";
      readonly owner: `${string}:${string}`;
      readonly adapterId: string;
      readonly capture: SealedRecord;
      readonly captureReference: TypedRecordReference;
      readonly intent?: SealedRecord;
      readonly intentReference?: TypedRecordReference;
    };

export interface NativeCaptureStore {
  loadSession(sessionId: string): NativeCaptureSession | undefined;
  saveSession(session: NativeCaptureSession, expectedRevision: number | undefined): void;
  putRecord(recordKind: string, name: string, record: SealedRecord): TypedRecordReference;
  putExecution(idempotencyKey: string, bytes: Uint8Array): EvidenceRecordReference;
  putArtifact(source: ExecutionEvidenceArtifactSource, bytes: Uint8Array): void;
  resolveEvidence(reference: EvidenceRecordReference): Uint8Array;
}

export interface CaptureClock {
  now(): string;
}

export interface CapturePrivacyPolicy {
  readonly policy: DigestBearingResourceDescriptor;
  readonly publication: "local-only" | "transport-neutral" | "public";
  readonly defaultAvailability: "public-exact" | "digest-only" | "scrub-derived" | "source-absent";
  readonly lowEntropyDigestPolicy: "forbid" | "explicit-review";
}

export interface PlanNativeCaptureInput {
  readonly sessionId: string;
  readonly owner: `${string}:${string}`;
  readonly adapterId: string;
  readonly source: NativeSource;
  readonly privacy: CapturePrivacyPolicy;
  readonly publicRegistration?: DigestBearingResourceDescriptor;
  readonly policy: SnapshotPolicy;
}

export interface ImportNativeCaptureInput {
  readonly sessionId: string;
  readonly owner: `${string}:${string}`;
  readonly adapterId: string;
  readonly source: NativeSource;
  readonly policy: SnapshotPolicy;
}

export interface NativeCaptureVerification {
  readonly conforms: boolean;
  readonly intent?: ExecutionBatchIntent;
  readonly capture?: ExecutionBatchCapture;
  readonly diagnostics: readonly string[];
}

export type CaptureAssurance = ExecutionBatchCapture["assurance"];
