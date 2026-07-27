// SPDX-License-Identifier: Apache-2.0

import type {
  EvidenceRecordReference,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

import { assertRecorderOperationActive, ExecutionRecorderError } from "./errors.js";
import { findContextualIdentityConflict } from "./contextual-identities.js";
import { buildFinalizationCandidate } from "./finalization-candidate.js";
import { finalizationIntentFingerprint } from "./finalization-intent.js";
import {
  appendJournalEntry,
  initializeWorkspaceMarker,
  readWorkspaceMarker,
  replayJournal,
  type JournalHead,
} from "./journal.js";
import type {
  JournalEvent,
  PersistedArtifactCapture,
  PersistedNativeTraceCapture,
  PersistedRuntimeObservationCapture,
  PersistedStartRecording,
  StoredObjectReference,
} from "./journal-types.js";
import { readStoredObject } from "./object-store.js";
import { workspacePaths, type WorkspacePaths } from "./paths.js";
import { captureFingerprint } from "./persist-capture.js";
import type {
  ExecutionId,
  ExecutionRecordingStatus,
  FinalizedExecutionReceipt,
} from "./types.js";

type FinalizationPrepared = Extract<
  JournalEvent,
  { type: "finalization-prepared" }
>;

export interface WorkspaceState {
  readonly paths: WorkspacePaths;
  readonly executionId: ExecutionId;
  readonly status: ExecutionRecordingStatus;
  readonly recording?: PersistedStartRecording;
  readonly inputs: readonly PersistedArtifactCapture[];
  readonly results: readonly PersistedArtifactCapture[];
  readonly runtimeObservations: readonly PersistedRuntimeObservationCapture[];
  readonly nativeTrace?: PersistedNativeTraceCapture;
  readonly finalization?: FinalizationPrepared;
  readonly repositoryArtifactDigests: readonly Sha256Digest[];
  readonly repositoryRecord?: EvidenceRecordReference;
  readonly receipt?: FinalizedExecutionReceipt;
  readonly head: JournalHead;
}

function corruptState(
  state: WorkspaceState,
  message: string,
): ExecutionRecorderError {
  return new ExecutionRecorderError(
    "WORKSPACE_CORRUPT",
    message,
    { workspaceDir: state.paths.root },
  );
}

function artifactObjectReferences(
  artifact: PersistedArtifactCapture,
): readonly StoredObjectReference[] {
  if (artifact.kind === "file") return [artifact.source];
  return [
    artifact.manifest,
    ...artifact.members.flatMap(artifactObjectReferences),
  ];
}

function recordingObjectReferences(
  recording: PersistedStartRecording,
): readonly StoredObjectReference[] {
  return [
    recording.task.source,
    ...recording.initialInputs.flatMap(artifactObjectReferences),
    ...(recording.repositoryState === undefined
      ? []
      : artifactObjectReferences(recording.repositoryState.artifact)),
    recording.runtime.specification,
    ...recording.runtime.components.flatMap((component) =>
      component.kind === "controlled"
        ? artifactObjectReferences(component.artifact)
        : artifactObjectReferences(component.descriptor),
    ),
  ];
}

function eventObjectReferences(
  event: JournalEvent,
): readonly StoredObjectReference[] {
  switch (event.type) {
    case "initialized":
      return recordingObjectReferences(event.recording);
    case "input-captured":
      return artifactObjectReferences(event.input);
    case "runtime-observation-captured":
      if (event.observation.kind === "resource") return [];
      return event.observation.kind === "environment"
        ? artifactObjectReferences(event.observation.artifact)
        : artifactObjectReferences(event.observation.component.descriptor);
    case "native-trace-attached":
      return artifactObjectReferences(event.trace.artifact);
    case "finalization-material-captured":
      return [
        ...event.results.flatMap(artifactObjectReferences),
        ...(event.nativeTrace === undefined
          ? []
          : artifactObjectReferences(event.nativeTrace.artifact)),
      ];
    case "finalization-prepared":
      return [
        ...event.results.flatMap(artifactObjectReferences),
        ...artifactObjectReferences(event.nativeTrace.artifact),
        event.metadata,
      ];
    case "repository-artifact-written":
    case "repository-record-written":
    case "finalized":
      return [];
  }
}

async function verifyEventObjects(
  state: WorkspaceState,
  event: JournalEvent,
  signal?: AbortSignal,
): Promise<void> {
  const declaration =
    event.type === "initialized"
      ? {
          expected: event.declarationFingerprint,
          actual: captureFingerprint("initialized", event.recording),
        }
      : event.type === "input-captured"
        ? {
            expected: event.declarationFingerprint,
            actual: captureFingerprint("input", event.input),
          }
        : event.type === "runtime-observation-captured"
          ? {
              expected: event.declarationFingerprint,
              actual: captureFingerprint(
                "runtime-observation",
                event.observation,
              ),
            }
          : event.type === "native-trace-attached"
            ? {
                expected: event.declarationFingerprint,
                actual: captureFingerprint(
                  "native-trace",
                  event.trace,
                ),
              }
            : event.type === "finalization-material-captured"
              ? {
                  expected: event.declarationFingerprint,
                  actual: captureFingerprint(
                    "finalization-material",
                    {
                      results: event.results,
                      nativeTrace: event.nativeTrace,
                    },
                  ),
                }
            : undefined;
  if (
    declaration !== undefined &&
    declaration.expected !== declaration.actual
  ) {
    throw corruptState(
      state,
      "Journal declaration fingerprint does not match its payload.",
    );
  }
  const projectedIdentityState =
    event.type === "initialized"
      ? {
          ...state,
          recording: event.recording,
          inputs: event.recording.initialInputs,
        }
      : event.type === "input-captured"
        ? { ...state, inputs: [...state.inputs, event.input] }
        : event.type === "runtime-observation-captured"
          ? {
              ...state,
              runtimeObservations: [
                ...state.runtimeObservations,
                event.observation,
              ],
            }
          : event.type === "native-trace-attached"
            ? { ...state, nativeTrace: event.trace }
            : event.type === "finalization-material-captured"
              ? {
                  ...state,
                  results: [...state.results, ...event.results],
                  nativeTrace:
                    event.nativeTrace ?? state.nativeTrace,
                }
              : state;
  const identityIssue = findContextualIdentityConflict(
    projectedIdentityState,
  );
  if (identityIssue !== undefined) {
    throw corruptState(state, identityIssue.message);
  }
  const unique = new Map<Sha256Digest, StoredObjectReference>();
  for (const reference of eventObjectReferences(event)) {
    const previous = unique.get(reference.digest);
    if (previous !== undefined && previous.size !== reference.size) {
      throw corruptState(
        state,
        `Captured object ${reference.digest} has conflicting persisted sizes.`,
      );
    }
    unique.set(reference.digest, reference);
  }
  if (event.type === "finalization-prepared") {
    if (
      finalizationIntentFingerprint(event) !==
      event.intentFingerprint
    ) {
      throw corruptState(
        state,
        "Finalization intent fingerprint does not match its material.",
      );
    }
    if (
      captureFingerprint("finalization-results", event.results) !==
      captureFingerprint("finalization-results", state.results) ||
      state.nativeTrace === undefined ||
      captureFingerprint("native-trace", event.nativeTrace) !==
        captureFingerprint("native-trace", state.nativeTrace)
    ) {
      throw corruptState(
        state,
        "Finalization intent does not match the durably captured finalization material.",
      );
    }
    for (const reference of stateObjectReferences(state)) {
      const previous = unique.get(reference.digest);
      if (previous !== undefined && previous.size !== reference.size) {
        throw corruptState(
          state,
          `Captured object ${reference.digest} has conflicting persisted sizes.`,
        );
      }
      unique.set(reference.digest, reference);
    }
    for (const digest of event.artifactDigests) {
      if (!unique.has(digest)) {
        throw corruptState(
          state,
          `Finalization intent references an object that was not captured: ${digest}`,
        );
      }
    }
  }
  let metadataBytes: Uint8Array | undefined;
  for (const reference of unique.values()) {
    const bytes = await readStoredObject(state.paths, reference, signal);
    if (
      event.type === "finalization-prepared" &&
      reference.digest === event.metadata.digest
    ) {
      metadataBytes = bytes;
    }
  }
  if (event.type === "finalization-prepared") {
    if (metadataBytes === undefined) {
      throw corruptState(
        state,
        "Finalization metadata object was not captured.",
      );
    }
    let candidate;
    try {
      candidate = buildFinalizationCandidate({
        recording: state.recording!,
        additionalInputs: state.inputs.slice(
          state.recording!.initialInputs.length,
        ),
        runtimeObservations: state.runtimeObservations,
        outcome: event.outcome,
        endedAt: event.endedAt,
        finalizedAt: event.finalizedAt,
        results: event.results,
        nativeTrace: event.nativeTrace,
      });
    } catch (error) {
      throw new ExecutionRecorderError(
        "WORKSPACE_CORRUPT",
        "Finalization intent cannot be reconstructed from captured state.",
        { workspaceDir: state.paths.root },
        { cause: error },
      );
    }
    if (!candidate.validation.conforms) {
      throw corruptState(
        state,
        "Finalization metadata is not conforming Execution Evidence.",
      );
    }
    if (
      candidate.intentFingerprint !== event.intentFingerprint ||
      candidate.metadata.digest !== event.metadata.digest ||
      candidate.metadata.size !== event.metadata.size ||
      candidate.metadataBytes.byteLength !== metadataBytes.byteLength ||
      !candidate.metadataBytes.every(
        (byte, index) => byte === metadataBytes[index],
      ) ||
      candidate.artifactDigests.length !==
        event.artifactDigests.length ||
      !candidate.artifactDigests.every(
        (digest, index) => digest === event.artifactDigests[index],
      )
    ) {
      throw corruptState(
        state,
        "Finalization intent does not match its reconstructed metadata.",
      );
    }
  }
}

function stateObjectReferences(
  state: WorkspaceState,
): readonly StoredObjectReference[] {
  if (state.recording === undefined) return [];
  return [
    ...recordingObjectReferences(state.recording),
    ...state.inputs.flatMap(artifactObjectReferences),
    ...state.results.flatMap(artifactObjectReferences),
    ...state.runtimeObservations.flatMap((observation) =>
      eventObjectReferences({
        type: "runtime-observation-captured",
        observation,
        declarationFingerprint: "sha256:state-replay",
      }),
    ),
    ...(state.nativeTrace === undefined
      ? []
      : artifactObjectReferences(state.nativeTrace.artifact)),
  ];
}

function reduceEvent(state: WorkspaceState, event: JournalEvent): WorkspaceState {
  if (event.type === "initialized") {
    if (state.recording !== undefined) {
      throw corruptState(
        state,
        "Recorder journal contains more than one initialization transition.",
      );
    }
    if (event.recording.executionId !== state.executionId) {
      throw corruptState(
        state,
        "Recorder initialization execution ID conflicts with its workspace marker.",
      );
    }
    return {
      ...state,
      recording: event.recording,
      inputs: event.recording.initialInputs,
    };
  }
  if (state.recording === undefined) {
    throw corruptState(
      state,
      "Recorder journal must begin with an initialization transition.",
    );
  }

  switch (event.type) {
    case "input-captured":
      return { ...state, inputs: [...state.inputs, event.input] };
    case "runtime-observation-captured":
      return {
        ...state,
        runtimeObservations: [
          ...state.runtimeObservations,
          event.observation,
        ],
      };
    case "native-trace-attached":
      return { ...state, nativeTrace: event.trace };
    case "finalization-material-captured": {
      if (state.status !== "open") {
        throw corruptState(
          state,
          "Finalization material was captured after an intent was prepared.",
        );
      }
      if (
        event.nativeTrace !== undefined &&
        state.nativeTrace !== undefined &&
        captureFingerprint("native-trace", state.nativeTrace) !==
          captureFingerprint("native-trace", event.nativeTrace)
      ) {
        throw corruptState(
          state,
          "Finalization material conflicts with the selected native trace.",
        );
      }
      return {
        ...state,
        results: [...state.results, ...event.results].sort(
          (left, right) =>
            left.entityId < right.entityId
              ? -1
              : left.entityId > right.entityId
                ? 1
                : 0,
        ),
        nativeTrace: event.nativeTrace ?? state.nativeTrace,
      };
    }
    case "finalization-prepared":
      if (state.finalization !== undefined || state.status === "finalized") {
        throw corruptState(
          state,
          "Recorder journal contains incompatible finalization transitions.",
        );
      }
      if (
        Date.parse(event.endedAt) <
        Date.parse(state.recording.startedAt)
      ) {
        throw corruptState(
          state,
          "Finalization end time precedes the recorded start time.",
        );
      }
      for (const [index, digest] of event.artifactDigests.entries()) {
        if (index > 0 && event.artifactDigests[index - 1] >= digest) {
          throw corruptState(
            state,
            "Finalization artifact digests must be sorted and unique.",
          );
        }
      }
      return {
        ...state,
        status: "finalizing",
        finalization: event,
        nativeTrace: event.nativeTrace,
      };
    case "repository-artifact-written":
      if (state.finalization === undefined) {
        throw corruptState(
          state,
          "Repository artifact transition precedes finalization intent.",
        );
      }
      if (
        state.repositoryRecord !== undefined ||
        !state.finalization.artifactDigests.includes(event.digest) ||
        state.repositoryArtifactDigests.includes(event.digest)
      ) {
        throw corruptState(
          state,
          "Repository artifact transition contradicts finalization intent.",
        );
      }
      return {
        ...state,
        repositoryArtifactDigests: [
          ...state.repositoryArtifactDigests,
          event.digest,
        ],
      };
    case "repository-record-written":
      if (state.finalization === undefined) {
        throw corruptState(
          state,
          "Repository record transition precedes finalization intent.",
        );
      }
      if (
        state.repositoryRecord !== undefined ||
        event.reference.family !== "execution-evidence" ||
        event.reference.digest !== state.finalization.metadata.digest ||
        state.repositoryArtifactDigests.length !==
          state.finalization.artifactDigests.length ||
        !state.finalization.artifactDigests.every((digest) =>
          state.repositoryArtifactDigests.includes(digest),
        )
      ) {
        throw corruptState(
          state,
          "Repository record transition contradicts finalization intent.",
        );
      }
      return { ...state, repositoryRecord: event.reference };
    case "finalized":
      if (
        state.repositoryRecord === undefined ||
        state.finalization === undefined
      ) {
        throw corruptState(
          state,
          "Finalized transition precedes the repository record transition.",
        );
      }
      if (
        state.receipt !== undefined ||
        event.receipt.executionId !== state.executionId ||
        event.receipt.record.family !== state.repositoryRecord.family ||
        event.receipt.record.digest !== state.repositoryRecord.digest ||
        event.receipt.finalizedAt !== state.finalization.finalizedAt ||
        event.receipt.artifacts.length !==
          state.finalization.artifactDigests.length ||
        !event.receipt.artifacts.every(
          (reference, index) =>
            reference.digest === state.finalization?.artifactDigests[index],
        )
      ) {
        throw corruptState(
          state,
          "Finalized receipt contradicts finalization intent.",
        );
      }
      return { ...state, status: "finalized", receipt: event.receipt };
  }
}

function emptyState(
  paths: WorkspacePaths,
  executionId: ExecutionId,
): WorkspaceState {
  return {
    paths,
    executionId,
    status: "open",
    inputs: [],
    results: [],
    runtimeObservations: [],
    repositoryArtifactDigests: [],
    head: { revision: 0, digest: null },
  };
}

export async function createWorkspaceState(
  workspaceDir: string,
  executionId: ExecutionId,
  signal?: AbortSignal,
): Promise<WorkspaceState> {
  const paths = workspacePaths(workspaceDir);
  await initializeWorkspaceMarker(paths, executionId, signal);
  return openWorkspaceState(workspaceDir, signal);
}

export async function openWorkspaceState(
  workspaceDir: string,
  signal?: AbortSignal,
): Promise<WorkspaceState> {
  assertRecorderOperationActive(signal);
  const paths = workspacePaths(workspaceDir);
  const replay = await replayJournal(paths, signal);
  const marker = await readWorkspaceMarker(paths, signal);
  let state = emptyState(paths, marker.executionId);
  for (const entry of replay.entries) {
    await verifyEventObjects(state, entry.event, signal);
    state = reduceEvent(state, entry.event);
    state = { ...state, head: { revision: entry.revision, digest: null } };
  }
  return { ...state, head: replay.head };
}

export async function appendWorkspaceEvent(
  state: WorkspaceState,
  event: JournalEvent,
  committedAt?: string,
  signal?: AbortSignal,
): Promise<WorkspaceState> {
  assertRecorderOperationActive(signal);
  await verifyEventObjects(state, event, signal);
  const reduced = reduceEvent(state, event);
  const appended = await appendJournalEntry(
    state.paths,
    event,
    state.head,
    committedAt,
    signal,
  );
  return { ...reduced, head: appended.head };
}
