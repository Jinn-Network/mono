// SPDX-License-Identifier: Apache-2.0

import { validateExecutionEvidence } from "@jinn-network/evidence-protocol";
import {
  createArtifactReference,
  createRecordReference,
  EvidenceRepositoryError,
  type EvidenceArtifactReference,
  type EvidenceRecordReference,
  type EvidenceRepository,
  type RepositoryWriteReceipt,
  type Sha256Digest,
} from "@jinn-network/evidence-repository";

import {
  assertRecorderOperationActive,
  ExecutionRecorderError,
} from "./errors.js";
import { finalizationIntentFingerprint } from "./finalization-intent.js";
import { buildExecutionEvidence } from "./graph.js";
import type {
  PersistedArtifactCapture,
  PersistedNativeTraceCapture,
  PersistedRuntimeObservationCapture,
  PersistedStartRecording,
  StoredObjectReference,
} from "./journal-types.js";
import {
  captureFingerprint,
  persistArtifactCapture,
  persistNativeTrace,
} from "./persist-capture.js";
import {
  objectDigest,
  readStoredObject,
  storeObject,
} from "./object-store.js";
import {
  appendWorkspaceEvent,
  type WorkspaceState,
} from "./state.js";
import type {
  CaptureDiagnostic,
  FinalizeExecutionInput,
  FinalizeExecutionResult,
} from "./types.js";
import { validateFinalizeExecutionInput } from "./validate-input.js";

export interface FinalizeWorkspaceStateOptions {
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export interface WorkspaceFinalizationOutcome {
  readonly state: WorkspaceState;
  readonly result: FinalizeExecutionResult;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function conflict(state: WorkspaceState, message: string): never {
  throw new ExecutionRecorderError(
    "RECORDING_CONFLICT",
    message,
    { workspaceDir: state.paths.root },
  );
}

function corrupt(state: WorkspaceState, message: string): never {
  throw new ExecutionRecorderError(
    "WORKSPACE_CORRUPT",
    message,
    { workspaceDir: state.paths.root },
  );
}

function invalidRepositoryReceipt(message: string): never {
  throw new EvidenceRepositoryError("CONTENT_CORRUPT", message);
}

function validateArtifactReceipt(
  value: Uint8Array,
  receipt: RepositoryWriteReceipt<EvidenceArtifactReference>,
): void {
  const expected = createArtifactReference(value);
  if (
    receipt.reference.digest !== expected.digest ||
    receipt.size !== value.byteLength
  ) {
    return invalidRepositoryReceipt(
      "Repository artifact acknowledgement does not match the exact requested bytes.",
    );
  }
}

function validateRecordReceipt(
  value: Uint8Array,
  receipt: RepositoryWriteReceipt<EvidenceRecordReference>,
): void {
  const expected = createRecordReference(
    "execution-evidence",
    value,
  );
  if (
    receipt.reference.family !== expected.family ||
    receipt.reference.digest !== expected.digest ||
    receipt.size !== value.byteLength
  ) {
    return invalidRepositoryReceipt(
      "Repository record acknowledgement does not match the exact execution-evidence metadata.",
    );
  }
}

function artifactReferences(
  artifact: PersistedArtifactCapture,
): readonly StoredObjectReference[] {
  if (artifact.kind === "file") return [artifact.source];
  return [
    artifact.manifest,
    ...artifact.members.flatMap(artifactReferences),
  ];
}

function recordingReferences(
  recording: PersistedStartRecording,
): readonly StoredObjectReference[] {
  return [
    recording.task.source,
    ...recording.initialInputs.flatMap(artifactReferences),
    ...(recording.repositoryState === undefined
      ? []
      : artifactReferences(recording.repositoryState.artifact)),
    recording.runtime.specification,
    ...recording.runtime.components.flatMap((component) =>
      component.kind === "controlled"
        ? artifactReferences(component.artifact)
        : artifactReferences(component.descriptor),
    ),
  ];
}

function observationReferences(
  observation: PersistedRuntimeObservationCapture,
): readonly StoredObjectReference[] {
  if (observation.kind === "resource") return [];
  return observation.kind === "environment"
    ? artifactReferences(observation.artifact)
    : artifactReferences(observation.component.descriptor);
}

function capturedReferences(
  state: WorkspaceState,
): ReadonlyMap<Sha256Digest, StoredObjectReference> {
  if (state.recording === undefined) {
    return corrupt(
      state,
      "Execution recording has no initialization state.",
    );
  }
  const references = [
    ...recordingReferences(state.recording),
    ...state.inputs.flatMap(artifactReferences),
    ...state.runtimeObservations.flatMap(observationReferences),
    ...(state.nativeTrace === undefined
      ? []
      : artifactReferences(state.nativeTrace.artifact)),
    ...(state.finalization === undefined
      ? []
      : [
          ...state.finalization.results.flatMap(artifactReferences),
          ...artifactReferences(state.finalization.nativeTrace.artifact),
        ]),
  ];
  const byDigest = new Map<Sha256Digest, StoredObjectReference>();
  for (const reference of references) {
    const current = byDigest.get(reference.digest);
    if (current !== undefined && current.size !== reference.size) {
      return corrupt(
        state,
        `Captured object ${reference.digest} has conflicting persisted sizes.`,
      );
    }
    byDigest.set(reference.digest, reference);
  }
  return byDigest;
}

async function persistResults(
  state: WorkspaceState,
  input: FinalizeExecutionInput,
  signal?: AbortSignal,
): Promise<readonly PersistedArtifactCapture[]> {
  const results: PersistedArtifactCapture[] = [];
  for (const result of [...(input.results ?? [])].sort((left, right) =>
    compareStrings(left.entityId, right.entityId),
  )) {
    results.push(
      await persistArtifactCapture(state.paths, result, signal),
    );
  }
  return results;
}

async function selectNativeTrace(
  state: WorkspaceState,
  input: FinalizeExecutionInput,
  signal?: AbortSignal,
): Promise<PersistedNativeTraceCapture | undefined> {
  if (input.nativeTrace === undefined) return state.nativeTrace;
  const persisted = await persistNativeTrace(
    state.paths,
    input.nativeTrace,
    signal,
  );
  if (
    state.nativeTrace !== undefined &&
    captureFingerprint("native-trace", state.nativeTrace) !==
      captureFingerprint("native-trace", persisted)
  ) {
    return conflict(
      state,
      "A different primary native trace is already attached.",
    );
  }
  return state.nativeTrace ?? persisted;
}

function missingDiagnostics(
  state: WorkspaceState,
  input: FinalizeExecutionInput,
  results: readonly PersistedArtifactCapture[],
  nativeTrace: PersistedNativeTraceCapture | undefined,
): readonly CaptureDiagnostic[] {
  const diagnostics: CaptureDiagnostic[] = [];
  if (input.outcome === "completed" && results.length === 0) {
    diagnostics.push({
      code: "COMPLETED_RESULT_MISSING",
      path: "/results",
      message: "Completed execution requires at least one Result.",
      entityId: state.executionId,
    });
  }
  if (nativeTrace === undefined) {
    diagnostics.push({
      code: "NATIVE_TRACE_MISSING",
      path: "/nativeTrace",
      message: "Execution recording requires a primary native trace.",
      entityId: state.executionId,
    });
  }
  return diagnostics.sort((left, right) =>
    compareStrings(left.code, right.code),
  );
}

function metadataArtifactDigests(
  state: WorkspaceState,
  bytes: Uint8Array,
): readonly Sha256Digest[] {
  const report = validateExecutionEvidence(bytes);
  if (!report.conforms || report.value === undefined) {
    throw new ExecutionRecorderError(
      "PROTOCOL_CONFORMANCE_FAILED",
      "Constructed Execution Evidence does not conform to the protocol.",
      {
        workspaceDir: state.paths.root,
        diagnostics: report.diagnostics,
      },
    );
  }
  return [
    ...new Set(
      report.value["@graph"]
        .filter(
          (entity) => entity["@id"] !== "ro-crate-metadata.json",
        )
        .map((entity) =>
          typeof entity.sha256 === "string"
            ? (`sha256:${entity.sha256}` as Sha256Digest)
            : null,
        )
        .filter(
          (digest): digest is Sha256Digest => digest !== null,
        ),
    ),
  ].sort(compareStrings);
}

function assertPersistedIntent(
  state: WorkspaceState,
): void {
  if (state.finalization === undefined) {
    return corrupt(state, "Execution recording has no finalization intent.");
  }
  if (
    finalizationIntentFingerprint(state.finalization) !==
    state.finalization.intentFingerprint
  ) {
    return corrupt(
      state,
      "Persisted finalization intent fingerprint does not match its material.",
    );
  }
}

function buildFinalizationCandidate(
  state: WorkspaceState,
  input: FinalizeExecutionInput,
  results: readonly PersistedArtifactCapture[],
  nativeTrace: PersistedNativeTraceCapture,
  finalizedAt: string,
): {
  readonly intentFingerprint: Sha256Digest;
  readonly metadataBytes: Uint8Array;
  readonly metadata: StoredObjectReference;
  readonly artifactDigests: readonly Sha256Digest[];
} {
  const metadataBytes = buildExecutionEvidence({
    recording: state.recording!,
    additionalInputs: state.inputs.slice(
      state.recording!.initialInputs.length,
    ),
    runtimeObservations: state.runtimeObservations,
    outcome: input.outcome,
    endedAt: input.endedAt,
    finalizedAt,
    results,
    nativeTrace,
  });
  const artifactDigests = metadataArtifactDigests(
    state,
    metadataBytes,
  );
  const metadata = {
    digest: objectDigest(metadataBytes),
    size: metadataBytes.byteLength,
  };
  return {
    intentFingerprint: finalizationIntentFingerprint({
      outcome: input.outcome,
      endedAt: input.endedAt,
      results,
      nativeTrace,
      finalizedAt,
      metadata,
      artifactDigests,
    }),
    metadataBytes,
    metadata,
    artifactDigests,
  };
}

function finalizedOutcome(
  state: WorkspaceState,
): WorkspaceFinalizationOutcome {
  if (state.receipt === undefined) {
    return corrupt(state, "Finalized recording has no persisted receipt.");
  }
  return {
    state,
    result: {
      finalized: true,
      receipt: state.receipt,
    },
  };
}

export async function resumePendingFinalization(
  repository: EvidenceRepository,
  state: WorkspaceState,
  options: Pick<FinalizeWorkspaceStateOptions, "signal"> = {},
): Promise<WorkspaceFinalizationOutcome> {
  assertRecorderOperationActive(options.signal);
  if (state.status === "finalized") {
    assertPersistedIntent(state);
    return finalizedOutcome(state);
  }
  if (state.status !== "finalizing" || state.finalization === undefined) {
    return conflict(state, "Execution recording has no pending finalization.");
  }

  assertPersistedIntent(state);
  const intent = state.finalization;
  let current = state;
  const references = capturedReferences(current);
  for (const digest of intent.artifactDigests) {
    if (current.repositoryArtifactDigests.includes(digest)) continue;
    const reference = references.get(digest);
    if (reference === undefined) {
      return corrupt(
        current,
        `Finalization artifact was not captured: ${digest}`,
      );
    }
    const value = await readStoredObject(
      current.paths,
      reference,
      options.signal,
    );
    const receipt = await repository.putArtifact(value, {
      signal: options.signal,
    });
    validateArtifactReceipt(value, receipt);
    current = await appendWorkspaceEvent(
      current,
      { type: "repository-artifact-written", digest },
      undefined,
      options.signal,
    );
  }

  if (current.repositoryRecord === undefined) {
    const metadata = await readStoredObject(
      current.paths,
      intent.metadata,
      options.signal,
    );
    const receipt = await repository.putRecord(
      "execution-evidence",
      metadata,
      { signal: options.signal },
    );
    validateRecordReceipt(metadata, receipt);
    current = await appendWorkspaceEvent(
      current,
      {
        type: "repository-record-written",
        reference: receipt.reference,
      },
      undefined,
      options.signal,
    );
  }

  const receipt = {
    executionId: current.executionId,
    record: current.repositoryRecord!,
    artifacts: intent.artifactDigests.map((digest) => ({
      digest,
    })),
    finalizedAt: intent.finalizedAt,
  };
  current = await appendWorkspaceEvent(
    current,
    { type: "finalized", receipt },
    undefined,
    options.signal,
  );
  return finalizedOutcome(current);
}

export async function finalizeWorkspaceState(
  repository: EvidenceRepository,
  state: WorkspaceState,
  input: FinalizeExecutionInput,
  options: FinalizeWorkspaceStateOptions = {},
): Promise<WorkspaceFinalizationOutcome> {
  assertRecorderOperationActive(options.signal);
  if (state.recording === undefined) {
    return corrupt(
      state,
      "Execution recording has no initialization state.",
    );
  }
  validateFinalizeExecutionInput(input, state.recording.startedAt);
  const results = await persistResults(state, input, options.signal);
  const nativeTrace = await selectNativeTrace(
    state,
    input,
    options.signal,
  );
  if (state.finalization !== undefined) {
    assertPersistedIntent(state);
    if (nativeTrace === undefined) {
      return corrupt(
        state,
        "Persisted finalization intent has no primary native trace.",
      );
    }
    const candidate = buildFinalizationCandidate(
      state,
      input,
      results,
      nativeTrace,
      state.finalization.finalizedAt,
    );
    if (
      state.finalization.intentFingerprint !==
      candidate.intentFingerprint
    ) {
      return conflict(
        state,
        "Finalization material conflicts with the persisted intent.",
      );
    }
    return resumePendingFinalization(repository, state, options);
  }
  const diagnostics = missingDiagnostics(
    state,
    input,
    results,
    nativeTrace,
  );
  if (diagnostics.length > 0) {
    return {
      state,
      result: {
        finalized: false,
        diagnostics,
      },
    };
  }
  if (state.status !== "open" || state.finalization !== undefined) {
    return conflict(
      state,
      "Execution recording already has a finalization intent.",
    );
  }

  const finalizedAt = (
    options.now?.() ?? new Date()
  ).toISOString();
  const candidate = buildFinalizationCandidate(
    state,
    input,
    results,
    nativeTrace!,
    finalizedAt,
  );
  const metadata = await storeObject(
    state.paths,
    candidate.metadataBytes,
    options.signal,
  );
  if (
    metadata.digest !== candidate.metadata.digest ||
    metadata.size !== candidate.metadata.size
  ) {
    return corrupt(
      state,
      "Stored finalization metadata does not match its candidate reference.",
    );
  }
  const prepared = await appendWorkspaceEvent(
    state,
    {
      type: "finalization-prepared",
      intentFingerprint: candidate.intentFingerprint,
      finalizedAt,
      outcome: input.outcome,
      endedAt: input.endedAt,
      results,
      nativeTrace: nativeTrace!,
      metadata,
      artifactDigests: candidate.artifactDigests,
    },
    finalizedAt,
    options.signal,
  );
  return resumePendingFinalization(repository, prepared, options);
}
