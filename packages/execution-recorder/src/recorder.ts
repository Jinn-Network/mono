// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import { EXECUTION_EVIDENCE_PROFILE_URI } from "@jinn-network/evidence-protocol";
import type { EvidenceRepository } from "@jinn-network/evidence-repository";

import {
  assertRecorderOperationActive,
  ExecutionRecorderError,
} from "./errors.js";
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
  CaptureOrigin,
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
  validateFinalizeExecutionInput,
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

type ContextualIdentityKind =
  | "agent"
  | "contextual-agent"
  | "component"
  | "execution"
  | "license"
  | "reserved"
  | "trace-format";

interface ContextualIdentityClaim {
  readonly kind: ContextualIdentityKind;
  readonly fingerprint?: string;
}

function originActorIds(origin: CaptureOrigin): readonly string[] {
  switch (origin.kind) {
    case "producer-observed":
      return [origin.observer];
    case "executor-reported":
      return [origin.reporter, origin.capturedBy];
    case "external-observed":
      return [origin.observer, origin.capturedBy];
  }
}

function artifactOrigins(
  artifact: PersistedArtifactCapture,
): readonly CaptureOrigin[] {
  return [
    artifact.origin,
    ...(artifact.kind === "file"
      ? []
      : artifact.members.flatMap(artifactOrigins)),
  ];
}

function registerContextualClaim(
  state: WorkspaceState,
  claims: Map<string, ContextualIdentityClaim>,
  id: string,
  kind: ContextualIdentityKind,
  value?: unknown,
): void {
  const fingerprint =
    value === undefined
      ? undefined
      : captureFingerprint(`graph-identity:${kind}`, value);
  const current = claims.get(id);
  if (current === undefined) {
    claims.set(id, { kind, fingerprint });
    return;
  }
  if (
    (current.kind === "agent" && kind === "contextual-agent") ||
    (current.kind === "contextual-agent" && kind === "agent") ||
    (current.kind === "contextual-agent" &&
      kind === "contextual-agent")
  ) {
    if (kind === "agent") claims.set(id, { kind, fingerprint });
    return;
  }
  if (
    current.kind === kind &&
    current.fingerprint === fingerprint
  ) {
    return;
  }
  conflict(
    state,
    `Graph identity ${id} is reused for incompatible contextual roles.`,
    id,
  );
}

function registerOrigins(
  state: WorkspaceState,
  claims: Map<string, ContextualIdentityClaim>,
  origins: readonly CaptureOrigin[],
): void {
  for (const origin of origins) {
    for (const id of originActorIds(origin)) {
      registerContextualClaim(
        state,
        claims,
        id,
        "contextual-agent",
      );
    }
  }
}

function contextualClaims(
  state: WorkspaceState,
): Map<string, ContextualIdentityClaim> {
  const claims = new Map<string, ContextualIdentityClaim>();
  for (const id of [
    EXECUTION_EVIDENCE_PROFILE_URI,
    "urn:jinn:execution-recorder:role:producer-observer",
    "urn:jinn:execution-recorder:role:executor-reporter",
    "urn:jinn:execution-recorder:role:external-observer",
    "urn:jinn:execution-recorder:role:capture-agent",
  ]) {
    registerContextualClaim(state, claims, id, "reserved");
  }
  const recording = state.recording;
  if (recording === undefined) return claims;
  registerContextualClaim(
    state,
    claims,
    recording.executionId,
    "execution",
  );
  registerContextualClaim(
    state,
    claims,
    recording.record.license,
    "license",
  );
  for (const value of [recording.executor, recording.producer]) {
    registerContextualClaim(
      state,
      claims,
      value.entityId,
      "agent",
      value,
    );
    registerOrigins(state, claims, [value.origin]);
  }
  registerOrigins(state, claims, [
    recording.task.origin,
    recording.runtime.origin,
    ...recording.initialInputs.flatMap(artifactOrigins),
    ...(recording.repositoryState === undefined
      ? []
      : artifactOrigins(recording.repositoryState.artifact)),
  ]);
  for (const component of recording.runtime.components) {
    if (component.kind === "controlled") {
      registerOrigins(state, claims, artifactOrigins(component.artifact));
      continue;
    }
    registerOrigins(state, claims, artifactOrigins(component.descriptor));
    registerContextualClaim(
      state,
      claims,
      component.component.entityId,
      "component",
      component.component,
    );
    if (component.component.provider !== undefined) {
      registerContextualClaim(
        state,
        claims,
        component.component.provider,
        "contextual-agent",
      );
    }
  }
  for (const input of state.inputs) {
    registerOrigins(state, claims, artifactOrigins(input));
  }
  for (const observation of state.runtimeObservations) {
    if (observation.kind === "resource") {
      registerOrigins(state, claims, [observation.origin]);
    } else if (observation.kind === "environment") {
      registerOrigins(
        state,
        claims,
        artifactOrigins(observation.artifact),
      );
    } else {
      registerOrigins(
        state,
        claims,
        artifactOrigins(observation.component.descriptor),
      );
      registerContextualClaim(
        state,
        claims,
        observation.component.component.entityId,
        "component",
        observation.component.component,
      );
      if (observation.component.component.provider !== undefined) {
        registerContextualClaim(
          state,
          claims,
          observation.component.component.provider,
          "contextual-agent",
        );
      }
    }
  }
  if (state.nativeTrace !== undefined) {
    registerOrigins(
      state,
      claims,
      artifactOrigins(state.nativeTrace.artifact),
    );
    registerContextualClaim(
      state,
      claims,
      state.nativeTrace.format.entityId,
      "trace-format",
      state.nativeTrace.format,
    );
  }
  return claims;
}

function assertArtifactOriginsCompatible(
  state: WorkspaceState,
  artifact: PersistedArtifactCapture,
): void {
  registerOrigins(state, contextualClaims(state), artifactOrigins(artifact));
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
    return this.state.receipt;
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
    assertArtifactOriginsCompatible(this.state, persisted);
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
    const claims = contextualClaims(this.state);
    if (persisted.kind === "resource") {
      registerOrigins(this.state, claims, [persisted.origin]);
    } else if (persisted.kind === "environment") {
      registerOrigins(
        this.state,
        claims,
        artifactOrigins(persisted.artifact),
      );
    } else {
      registerOrigins(
        this.state,
        claims,
        artifactOrigins(persisted.component.descriptor),
      );
      registerContextualClaim(
        this.state,
        claims,
        persisted.component.component.entityId,
        "component",
        persisted.component.component,
      );
      if (persisted.component.component.provider !== undefined) {
        registerContextualClaim(
          this.state,
          claims,
          persisted.component.component.provider,
          "contextual-agent",
        );
      }
    }
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
    const claims = contextualClaims(this.state);
    registerOrigins(
      this.state,
      claims,
      artifactOrigins(persisted.artifact),
    );
    registerContextualClaim(
      this.state,
      claims,
      persisted.format.entityId,
      "trace-format",
      persisted.format,
    );
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
    assertRecorderOperationActive(options?.signal);
    if (this.state.recording === undefined) {
      throw new ExecutionRecorderError(
        "WORKSPACE_CORRUPT",
        "Execution recording has no initialization state.",
        { workspaceDir: this.state.paths.root },
      );
    }
    validateFinalizeExecutionInput(
      input,
      this.state.recording.startedAt,
    );
    throw new ExecutionRecorderError(
      "PROTOCOL_CONFORMANCE_FAILED",
      "Execution finalization is not available in the lifecycle layer.",
      { workspaceDir: this.state.paths.root },
    );
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
    contextualClaims({
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
    const state = await openWorkspaceState(
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
