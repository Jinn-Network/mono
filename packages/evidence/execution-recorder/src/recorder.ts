// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import type { EvidenceRepository } from "@jinn-network/evidence-repository";

import { findContextualIdentityConflict } from "./contextual-identities.js";
import {
  assertRecorderOperationActive,
  ExecutionRecorderError,
} from "./errors.js";
import {
  finalizeWorkspaceState,
  resumePendingFinalization,
} from "./finalization.js";
import type {
  PersistedArtifactCapture,
  PersistedNativeTraceCapture,
  PersistedRuntimeObservationCapture,
  PersistedStartRecording,
} from "./journal-types.js";
import {
  captureFingerprint,
  persistArtifactCapture,
  persistNativeTrace,
  persistRuntimeObservation,
  persistStartRecording,
} from "./persist-capture.js";
import { copyFinalizedExecutionReceipt } from "./receipt.js";
import {
  appendWorkspaceEvent,
  createWorkspaceState,
  openWorkspaceState,
  type WorkspaceState,
} from "./state.js";
import type {
  ExecutionRecorder,
  ExecutionRecorderOptions,
  ExecutionRecording,
  FinalizeExecutionInput,
  FinalizeExecutionResult,
  InputCapture,
  NativeTraceCapture,
  RecordingOperationOptions,
  ResumeExecutionRecordingInput,
  RuntimeObservationCapture,
  StartExecutionRecordingInput,
} from "./types.js";
import {
  validateNativeTraceCapture,
  validateResumeExecutionRecordingInput,
  validateRuntimeObservationCapture,
  validateStartExecutionRecordingInput,
} from "./validate-input.js";

function conflict(
  state: WorkspaceState,
  message: string,
  entityId?: string,
): never {
  throw new ExecutionRecorderError(
    "RECORDING_CONFLICT",
    message,
    {
      workspaceDir: state.paths.root,
      ...(entityId === undefined ? {} : { entityId }),
    },
  );
}

function artifactIds(
  artifact: PersistedArtifactCapture,
): readonly string[] {
  return [
    artifact.entityId,
    ...(artifact.kind === "file"
      ? []
      : artifact.members.flatMap(artifactIds)),
  ];
}

function observationIds(
  observation: PersistedRuntimeObservationCapture,
): readonly string[] {
  if (observation.kind === "resource") return [observation.entityId];
  if (observation.kind === "environment") {
    return artifactIds(observation.artifact);
  }
  return [
    ...artifactIds(observation.component.descriptor),
  ];
}

function traceIds(trace: PersistedNativeTraceCapture): readonly string[] {
  return [trace.artifact.entityId, ...artifactIds(trace.artifact).slice(1)];
}

function startIds(recording: PersistedStartRecording): readonly string[] {
  return [
    recording.task.entityId,
    recording.runtime.entityId,
    ...recording.initialInputs.flatMap(artifactIds),
    ...(recording.repositoryState === undefined
      ? []
      : artifactIds(recording.repositoryState.artifact)),
    ...recording.runtime.components.flatMap((component) =>
      component.kind === "controlled"
        ? artifactIds(component.artifact)
        : [
            ...artifactIds(component.descriptor),
          ],
    ),
  ];
}

function allCapturedIds(state: WorkspaceState): ReadonlySet<string> {
  if (state.recording === undefined) return new Set();
  return new Set([
    ...startIds(state.recording),
    ...state.inputs.flatMap(artifactIds),
    ...state.results.flatMap(artifactIds),
    ...state.runtimeObservations.flatMap(observationIds),
    ...(state.nativeTrace === undefined ? [] : traceIds(state.nativeTrace)),
  ]);
}

function identityForObservation(
  observation: PersistedRuntimeObservationCapture,
): string {
  if (observation.kind === "resource") return observation.entityId;
  if (observation.kind === "environment") {
    return observation.artifact.entityId;
  }
  return observation.component.descriptor.entityId;
}

function sameHead(left: WorkspaceState, right: WorkspaceState): boolean {
  return (
    left.head.revision === right.head.revision &&
    left.head.digest === right.head.digest
  );
}

function assertContextualIdentities(state: WorkspaceState): void {
  const issue = findContextualIdentityConflict(state);
  if (issue !== undefined) {
    conflict(state, issue.message, issue.entityId);
  }
}

class ExecutionRecordingHandle implements ExecutionRecording {
  constructor(
    private readonly repository: EvidenceRepository,
    private state: WorkspaceState,
  ) {}

  get executionId(): ExecutionRecording["executionId"] {
    return this.state.executionId;
  }

  get status(): ExecutionRecording["status"] {
    return this.state.status;
  }

  get receipt(): ExecutionRecording["receipt"] {
    return this.state.receipt === undefined
      ? undefined
      : copyFinalizedExecutionReceipt(this.state.receipt);
  }

  private async assertCurrent(signal?: AbortSignal): Promise<void> {
    assertRecorderOperationActive(signal);
    const current = await openWorkspaceState(this.state.paths.root, signal);
    if (!sameHead(this.state, current)) {
      conflict(
        this.state,
        "Execution recording advanced since this handle was resumed.",
      );
    }
  }

  private assertOpen(): void {
    if (this.state.status !== "open") {
      throw new ExecutionRecorderError(
        "RECORDING_FINALIZED",
        "Execution recording no longer accepts capture mutations.",
        { workspaceDir: this.state.paths.root },
      );
    }
  }

  async captureInput(
    input: InputCapture,
    options?: RecordingOperationOptions,
  ): Promise<void> {
    validateRuntimeObservationCapture({
      kind: "environment",
      artifact: input,
    });
    await this.assertCurrent(options?.signal);
    this.assertOpen();
    const persisted = await persistArtifactCapture(
      this.state.paths,
      input,
      options?.signal,
    );
    assertContextualIdentities({
      ...this.state,
      inputs: [...this.state.inputs, persisted],
    });
    const fingerprint = captureFingerprint("input", persisted);
    const sameIdentity = this.state.inputs.find(
      ({ entityId }) => entityId === persisted.entityId,
    );
    if (sameIdentity !== undefined) {
      if (
        captureFingerprint("input", sameIdentity) === fingerprint
      ) {
        return;
      }
      conflict(
        this.state,
        "Input entity identity was reused with incompatible capture data.",
        persisted.entityId,
      );
    }
    const existingIds = allCapturedIds(this.state);
    for (const entityId of artifactIds(persisted)) {
      if (existingIds.has(entityId)) {
        conflict(
          this.state,
          "Input capture reuses an existing entity identity.",
          entityId,
        );
      }
    }
    this.state = await appendWorkspaceEvent(
      this.state,
      {
        type: "input-captured",
        input: persisted,
        declarationFingerprint: fingerprint,
      },
      undefined,
      options?.signal,
    );
  }

  async captureRuntimeObservation(
    observation: RuntimeObservationCapture,
    options?: RecordingOperationOptions,
  ): Promise<void> {
    validateRuntimeObservationCapture(observation);
    await this.assertCurrent(options?.signal);
    this.assertOpen();
    const persisted = await persistRuntimeObservation(
      this.state.paths,
      observation,
      options?.signal,
    );
    assertContextualIdentities({
      ...this.state,
      runtimeObservations: [
        ...this.state.runtimeObservations,
        persisted,
      ],
    });
    const identity = identityForObservation(persisted);
    const fingerprint = captureFingerprint(
      "runtime-observation",
      persisted,
    );
    const sameIdentity = this.state.runtimeObservations.find(
      (candidate) => identityForObservation(candidate) === identity,
    );
    if (sameIdentity !== undefined) {
      if (
        captureFingerprint(
          "runtime-observation",
          sameIdentity,
        ) === fingerprint
      ) {
        return;
      }
      conflict(
        this.state,
        "Runtime observation identity was reused incompatibly.",
        identity,
      );
    }
    const existingIds = allCapturedIds(this.state);
    for (const entityId of observationIds(persisted)) {
      if (existingIds.has(entityId)) {
        conflict(
          this.state,
          "Runtime observation reuses an existing entity identity.",
          entityId,
        );
      }
    }
    this.state = await appendWorkspaceEvent(
      this.state,
      {
        type: "runtime-observation-captured",
        observation: persisted,
        declarationFingerprint: fingerprint,
      },
      undefined,
      options?.signal,
    );
  }

  async attachNativeTrace(
    trace: NativeTraceCapture,
    options?: RecordingOperationOptions,
  ): Promise<void> {
    validateNativeTraceCapture(trace);
    await this.assertCurrent(options?.signal);
    this.assertOpen();
    const persisted = await persistNativeTrace(
      this.state.paths,
      trace,
      options?.signal,
    );
    assertContextualIdentities({
      ...this.state,
      nativeTrace: persisted,
    });
    const fingerprint = captureFingerprint("native-trace", persisted);
    if (this.state.nativeTrace !== undefined) {
      if (
        captureFingerprint(
          "native-trace",
          this.state.nativeTrace,
        ) === fingerprint
      ) {
        return;
      }
      conflict(
        this.state,
        "A different primary native trace is already attached.",
        persisted.artifact.entityId,
      );
    }
    const existingIds = allCapturedIds(this.state);
    for (const entityId of traceIds(persisted)) {
      if (existingIds.has(entityId)) {
        conflict(
          this.state,
          "Native trace reuses an existing entity identity.",
          entityId,
        );
      }
    }
    this.state = await appendWorkspaceEvent(
      this.state,
      {
        type: "native-trace-attached",
        trace: persisted,
        declarationFingerprint: fingerprint,
      },
      undefined,
      options?.signal,
    );
  }

  async finalize(
    input: FinalizeExecutionInput,
    options?: RecordingOperationOptions,
  ): Promise<FinalizeExecutionResult> {
    await this.assertCurrent(options?.signal);
    try {
      const outcome = await finalizeWorkspaceState(
        this.repository,
        this.state,
        input,
        { signal: options?.signal },
      );
      this.state = outcome.state;
      return outcome.result;
    } catch (error) {
      try {
        this.state = await openWorkspaceState(this.state.paths.root);
      } catch {
        // Preserve the operation's original typed failure. A later resume
        // performs the authoritative workspace replay and integrity check.
      }
      throw error;
    }
  }
}

class ExecutionRecorderImpl implements ExecutionRecorder {
  constructor(private readonly repository: EvidenceRepository) {}

  async start(
    input: StartExecutionRecordingInput,
  ): Promise<ExecutionRecording> {
    validateStartExecutionRecordingInput(input);
    assertRecorderOperationActive(input.signal);

    let state: WorkspaceState;
    try {
      state = await openWorkspaceState(input.workspaceDir, input.signal);
    } catch (error) {
      if (
        !(error instanceof ExecutionRecorderError) ||
        error.code !== "RECORDING_NOT_FOUND"
      ) {
        throw error;
      }
      const executionId =
        input.executionId ?? `urn:uuid:${randomUUID()}`;
      state = await createWorkspaceState(
        input.workspaceDir,
        executionId,
        input.signal,
      );
    }

    if (
      input.executionId !== undefined &&
      input.executionId !== state.executionId
    ) {
      conflict(
        state,
        "Recorder workspace belongs to a different execution ID.",
      );
    }

    const persisted = await persistStartRecording(
      state.paths,
      input,
      state.executionId,
      input.signal,
    );
    assertContextualIdentities({
      ...state,
      recording: persisted,
      inputs: persisted.initialInputs,
    });
    const fingerprint = captureFingerprint("initialized", persisted);
    if (state.recording !== undefined) {
      if (
        captureFingerprint("initialized", state.recording) !==
        fingerprint
      ) {
        conflict(
          state,
          "Recorder workspace was initialized with different capture data.",
        );
      }
      return new ExecutionRecordingHandle(this.repository, state);
    }

    state = await appendWorkspaceEvent(
      state,
      {
        type: "initialized",
        recording: persisted,
        declarationFingerprint: fingerprint,
      },
      undefined,
      input.signal,
    );
    return new ExecutionRecordingHandle(this.repository, state);
  }

  async resume(
    input: ResumeExecutionRecordingInput,
  ): Promise<ExecutionRecording> {
    validateResumeExecutionRecordingInput(input);
    assertRecorderOperationActive(input.signal);
    let state = await openWorkspaceState(
      input.workspaceDir,
      input.signal,
    );
    if (state.recording === undefined) {
      throw new ExecutionRecorderError(
        "WORKSPACE_CORRUPT",
        "Execution recording workspace has no initialization transition.",
        { workspaceDir: state.paths.root },
      );
    }
    if (state.status === "finalizing") {
      state = (
        await resumePendingFinalization(this.repository, state, {
          signal: input.signal,
        })
      ).state;
    }
    return new ExecutionRecordingHandle(this.repository, state);
  }
}

export function createExecutionRecorder(
  options: ExecutionRecorderOptions,
): ExecutionRecorder {
  if (
    !options ||
    typeof options !== "object" ||
    !options.repository ||
    typeof options.repository.putRecord !== "function" ||
    typeof options.repository.getRecord !== "function" ||
    typeof options.repository.putArtifact !== "function" ||
    typeof options.repository.getArtifact !== "function"
  ) {
    throw new ExecutionRecorderError(
      "INVALID_CAPTURE_INPUT",
      "createExecutionRecorder requires an EvidenceRepository.",
    );
  }
  return new ExecutionRecorderImpl(options.repository);
}
