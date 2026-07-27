// SPDX-License-Identifier: Apache-2.0

import { EXECUTION_EVIDENCE_PROFILE_URI } from "@jinn-network/evidence-protocol";

import type {
  PersistedArtifactCapture,
  PersistedNativeTraceCapture,
  PersistedRuntimeObservationCapture,
  PersistedStartRecording,
} from "./journal-types.js";
import { captureFingerprint } from "./persist-capture.js";
import type { CaptureOrigin } from "./types.js";

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

export interface ContextualIdentityState {
  readonly executionId: string;
  readonly recording?: PersistedStartRecording;
  readonly inputs: readonly PersistedArtifactCapture[];
  readonly results: readonly PersistedArtifactCapture[];
  readonly runtimeObservations: readonly PersistedRuntimeObservationCapture[];
  readonly nativeTrace?: PersistedNativeTraceCapture;
}

export interface ContextualIdentityConflict {
  readonly entityId: string;
  readonly message: string;
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

function registerClaim(
  claims: Map<string, ContextualIdentityClaim>,
  id: string,
  kind: ContextualIdentityKind,
  value?: unknown,
): ContextualIdentityConflict | undefined {
  const fingerprint =
    value === undefined
      ? undefined
      : captureFingerprint(`graph-identity:${kind}`, value);
  const current = claims.get(id);
  if (current === undefined) {
    claims.set(id, { kind, fingerprint });
    return undefined;
  }
  if (
    (current.kind === "agent" && kind === "contextual-agent") ||
    (current.kind === "contextual-agent" && kind === "agent") ||
    (current.kind === "contextual-agent" &&
      kind === "contextual-agent")
  ) {
    if (kind === "agent") claims.set(id, { kind, fingerprint });
    return undefined;
  }
  if (
    current.kind === kind &&
    current.fingerprint === fingerprint
  ) {
    return undefined;
  }
  return {
    entityId: id,
    message: `Graph identity ${id} is reused for incompatible contextual roles.`,
  };
}

function registerOrigins(
  claims: Map<string, ContextualIdentityClaim>,
  origins: readonly CaptureOrigin[],
): ContextualIdentityConflict | undefined {
  for (const origin of origins) {
    for (const id of originActorIds(origin)) {
      const issue = registerClaim(claims, id, "contextual-agent");
      if (issue !== undefined) return issue;
    }
  }
  return undefined;
}

function firstIssue(
  ...issues: readonly (ContextualIdentityConflict | undefined)[]
): ContextualIdentityConflict | undefined {
  return issues.find(
    (issue): issue is ContextualIdentityConflict =>
      issue !== undefined,
  );
}

export function findContextualIdentityConflict(
  state: ContextualIdentityState,
): ContextualIdentityConflict | undefined {
  const claims = new Map<string, ContextualIdentityClaim>();
  for (const id of [
    EXECUTION_EVIDENCE_PROFILE_URI,
    "urn:jinn:execution-recorder:role:producer-observer",
    "urn:jinn:execution-recorder:role:executor-reporter",
    "urn:jinn:execution-recorder:role:external-observer",
    "urn:jinn:execution-recorder:role:capture-agent",
  ]) {
    const issue = registerClaim(claims, id, "reserved");
    if (issue !== undefined) return issue;
  }
  const recording = state.recording;
  if (recording === undefined) return undefined;
  let issue = firstIssue(
    registerClaim(claims, recording.executionId, "execution"),
    registerClaim(claims, recording.record.license, "license"),
  );
  if (issue !== undefined) return issue;
  for (const value of [recording.executor, recording.producer]) {
    issue = firstIssue(
      registerClaim(claims, value.entityId, "agent", value),
      registerOrigins(claims, [value.origin]),
    );
    if (issue !== undefined) return issue;
  }
  issue = registerOrigins(claims, [
    recording.task.origin,
    recording.runtime.origin,
    ...recording.initialInputs.flatMap(artifactOrigins),
    ...(recording.repositoryState === undefined
      ? []
      : artifactOrigins(recording.repositoryState.artifact)),
  ]);
  if (issue !== undefined) return issue;
  for (const component of recording.runtime.components) {
    if (component.kind === "controlled") {
      issue = registerOrigins(
        claims,
        artifactOrigins(component.artifact),
      );
    } else {
      issue = firstIssue(
        registerOrigins(
          claims,
          artifactOrigins(component.descriptor),
        ),
        registerClaim(
          claims,
          component.component.entityId,
          "component",
          component.component,
        ),
        component.component.provider === undefined
          ? undefined
          : registerClaim(
              claims,
              component.component.provider,
              "contextual-agent",
            ),
      );
    }
    if (issue !== undefined) return issue;
  }
  issue = registerOrigins(claims, [
    ...state.inputs.flatMap(artifactOrigins),
    ...state.results.flatMap(artifactOrigins),
  ]);
  if (issue !== undefined) return issue;
  for (const observation of state.runtimeObservations) {
    if (observation.kind === "resource") {
      issue = registerOrigins(claims, [observation.origin]);
    } else if (observation.kind === "environment") {
      issue = registerOrigins(
        claims,
        artifactOrigins(observation.artifact),
      );
    } else {
      issue = firstIssue(
        registerOrigins(
          claims,
          artifactOrigins(observation.component.descriptor),
        ),
        registerClaim(
          claims,
          observation.component.component.entityId,
          "component",
          observation.component.component,
        ),
        observation.component.component.provider === undefined
          ? undefined
          : registerClaim(
              claims,
              observation.component.component.provider,
              "contextual-agent",
            ),
      );
    }
    if (issue !== undefined) return issue;
  }
  if (state.nativeTrace !== undefined) {
    issue = firstIssue(
      registerOrigins(
        claims,
        artifactOrigins(state.nativeTrace.artifact),
      ),
      registerClaim(
        claims,
        state.nativeTrace.format.entityId,
        "trace-format",
        state.nativeTrace.format,
      ),
    );
  }
  return issue;
}
