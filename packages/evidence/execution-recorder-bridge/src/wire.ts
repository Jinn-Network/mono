// SPDX-License-Identifier: Apache-2.0

import type {
  AbsoluteIri,
  ArtifactCapture,
  ArtifactSource,
  CaptureOrigin,
  ExecutionId,
  ExecutionRecordCapture,
  ExecutorCapture,
  FileArtifactCapture,
  FinalizeExecutionInput,
  IdentifierCapture,
  JsonLdExtensions,
  NativeTraceCapture,
  OpaqueRuntimeComponentCapture,
  ProducerCapture,
  RepositoryStateCapture,
  ResourceRuntimeObservationCapture,
  RuntimeCapture,
  RuntimeComponentCapture,
  RuntimeObservationCapture,
  StartExecutionRecordingInput,
} from "@jinn-network/execution-recorder";

import { RecorderBridgeError } from "./errors.js";
import type { StartRequestParams, WireArtifactSource } from "./protocol.js";

function requireObject(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecorderBridgeError("INVALID_REQUEST", message);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, message: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new RecorderBridgeError("INVALID_REQUEST", message);
  }
  return value;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RecorderBridgeError("INVALID_REQUEST", message);
  }
  return value;
}

export function decodeArtifactSource(value: unknown): ArtifactSource {
  const source = requireObject(
    value,
    "Artifact source must be a JSON object.",
  );
  const mediaType = requireString(
    source.mediaType,
    "Artifact source mediaType must be a non-empty string.",
  );
  const name =
    source.name === undefined
      ? undefined
      : requireString(source.name, "Artifact source name must be a string.");

  if (source.kind === "bytes") {
    if (source.path !== undefined) {
      throw new RecorderBridgeError(
        "INVALID_REQUEST",
        "Artifact source must not declare both bytes and path.",
      );
    }
    const base64 = requireString(
      source.base64,
      "Artifact source base64 must be a non-empty string.",
    );
    const bytes = Buffer.from(base64, "base64");
    if (bytes.toString("base64") !== base64) {
      throw new RecorderBridgeError(
        "INVALID_REQUEST",
        "Artifact bytes must use canonical base64.",
      );
    }
    return {
      bytes: new Uint8Array(bytes),
      mediaType,
      ...(name === undefined ? {} : { name }),
    };
  }

  if (source.kind === "path") {
    if (source.base64 !== undefined) {
      throw new RecorderBridgeError(
        "INVALID_REQUEST",
        "Artifact source must not declare both bytes and path.",
      );
    }
    const path = requireString(
      source.path,
      "Artifact source path must be a non-empty string.",
    );
    return {
      path,
      mediaType,
      ...(name === undefined ? {} : { name }),
    };
  }

  throw new RecorderBridgeError(
    "INVALID_REQUEST",
    `Unknown artifact source kind: ${String(source.kind)}`,
  );
}

function decodeArtifactCapture(value: unknown): ArtifactCapture {
  const object = requireObject(
    value,
    "Artifact capture must be a JSON object.",
  );
  if (object.kind === "file") {
    return decodeFileArtifactCapture(object);
  }
  if (object.kind === "dataset" || object.kind === "collection") {
    return decodeAggregateArtifactCapture(object);
  }
  throw new RecorderBridgeError(
    "INVALID_REQUEST",
    `Unknown artifact capture kind: ${String(object.kind)}`,
  );
}

function decodeFileArtifactCapture(
  object: Record<string, unknown>,
): FileArtifactCapture {
  return {
    kind: "file",
    entityId: requireString(
      object.entityId,
      "File artifact entityId must be a non-empty string.",
    ),
    source: decodeArtifactSource(object.source),
    origin: object.origin as CaptureOrigin,
    ...(object.additionalTypes === undefined
      ? {}
      : { additionalTypes: object.additionalTypes as readonly string[] }),
    ...(object.identifiers === undefined
      ? {}
      : { identifiers: object.identifiers as readonly IdentifierCapture[] }),
    ...(object.extensions === undefined
      ? {}
      : { extensions: object.extensions as JsonLdExtensions }),
  };
}

function decodeAggregateArtifactCapture(
  object: Record<string, unknown>,
): Extract<ArtifactCapture, { kind: "dataset" | "collection" }> {
  const kind = object.kind as "dataset" | "collection";
  const members = requireArray(
    object.members,
    "Aggregate artifact members must be an array.",
  );
  return {
    kind,
    entityId: requireString(
      object.entityId,
      "Aggregate artifact entityId must be a non-empty string.",
    ),
    manifest: decodeArtifactSource(object.manifest),
    members: members.map((member) => decodeArtifactCapture(member)),
    origin: object.origin as CaptureOrigin,
    ...(object.additionalTypes === undefined
      ? {}
      : { additionalTypes: object.additionalTypes as readonly string[] }),
    ...(object.identifiers === undefined
      ? {}
      : { identifiers: object.identifiers as readonly IdentifierCapture[] }),
    ...(object.extensions === undefined
      ? {}
      : { extensions: object.extensions as JsonLdExtensions }),
  };
}

export function decodeInputCapture(value: unknown): ArtifactCapture {
  return decodeArtifactCapture(value);
}

function decodeTaskCapture(
  value: unknown,
): StartExecutionRecordingInput["task"] {
  const object = requireObject(value, "Task capture must be a JSON object.");
  return {
    entityId: requireString(
      object.entityId,
      "Task entityId must be a non-empty string.",
    ),
    name: requireString(
      object.name,
      "Task name must be a non-empty string.",
    ),
    source: decodeArtifactSource(object.source),
    origin: object.origin as CaptureOrigin,
    ...(object.identifiers === undefined
      ? {}
      : { identifiers: object.identifiers as readonly IdentifierCapture[] }),
    ...(object.extensions === undefined
      ? {}
      : { extensions: object.extensions as JsonLdExtensions }),
  };
}

function decodeRepositoryStateCapture(
  value: unknown,
): RepositoryStateCapture {
  const object = requireObject(
    value,
    "Repository state capture must be a JSON object.",
  );
  const artifact = decodeArtifactCapture(object.artifact);
  if (artifact.kind !== "dataset" && artifact.kind !== "collection") {
    throw new RecorderBridgeError(
      "INVALID_REQUEST",
      "Repository state artifact must be an aggregate capture.",
    );
  }
  const identifiers = requireArray(
    object.identifiers,
    "Repository state identifiers must be an array.",
  );
  return {
    artifact,
    identifiers: identifiers as readonly IdentifierCapture[],
    ...(object.repository === undefined
      ? {}
      : { repository: object.repository as AbsoluteIri }),
    ...(object.extensions === undefined
      ? {}
      : { extensions: object.extensions as JsonLdExtensions }),
  };
}

function decodeRuntimeComponentCapture(
  value: unknown,
): RuntimeComponentCapture {
  const object = requireObject(
    value,
    "Runtime component capture must be a JSON object.",
  );
  if (object.kind === "controlled") {
    return { kind: "controlled", artifact: decodeArtifactCapture(object.artifact) };
  }
  if (object.kind === "opaque") {
    const descriptor = decodeArtifactCapture(object.descriptor);
    if (descriptor.kind !== "file") {
      throw new RecorderBridgeError(
        "INVALID_REQUEST",
        "Opaque runtime component descriptor must be a file capture.",
      );
    }
    return {
      kind: "opaque",
      descriptor,
      component: requireObject(
        object.component,
        "Opaque runtime component must declare a component object.",
      ) as unknown as OpaqueRuntimeComponentCapture["component"],
    };
  }
  throw new RecorderBridgeError(
    "INVALID_REQUEST",
    `Unknown runtime component kind: ${String(object.kind)}`,
  );
}

function decodeRuntimeCapture(value: unknown): RuntimeCapture {
  const object = requireObject(
    value,
    "Runtime capture must be a JSON object.",
  );
  const components = requireArray(
    object.components,
    "Runtime components must be an array.",
  );
  return {
    entityId: requireString(
      object.entityId,
      "Runtime entityId must be a non-empty string.",
    ),
    specification: decodeArtifactSource(object.specification),
    name: requireString(
      object.name,
      "Runtime name must be a non-empty string.",
    ),
    origin: object.origin as CaptureOrigin,
    components: components.map((component) =>
      decodeRuntimeComponentCapture(component),
    ),
    ...(object.softwareVersion === undefined
      ? {}
      : { softwareVersion: object.softwareVersion as string }),
    ...(object.extensions === undefined
      ? {}
      : { extensions: object.extensions as JsonLdExtensions }),
  };
}

export function decodeRuntimeObservation(
  value: unknown,
): RuntimeObservationCapture {
  const object = requireObject(
    value,
    "Runtime observation must be a JSON object.",
  );
  if (object.kind === "resource") {
    requireString(
      object.entityId,
      "Resource observation entityId must be a non-empty string.",
    );
    requireString(
      object.name,
      "Resource observation name must be a non-empty string.",
    );
    if (!["string", "number", "boolean"].includes(typeof object.value)) {
      throw new RecorderBridgeError(
        "INVALID_REQUEST",
        "Resource observation value must be a string, number, or boolean.",
      );
    }
    return object as unknown as ResourceRuntimeObservationCapture;
  }
  if (object.kind === "environment") {
    return {
      kind: "environment",
      artifact: decodeArtifactCapture(object.artifact),
    };
  }
  if (object.kind === "opaque-component") {
    const component = decodeRuntimeComponentCapture(object.component);
    if (component.kind !== "opaque") {
      throw new RecorderBridgeError(
        "INVALID_REQUEST",
        "Opaque component observation must declare an opaque component.",
      );
    }
    return { kind: "opaque-component", component };
  }
  throw new RecorderBridgeError(
    "INVALID_REQUEST",
    `Unknown runtime observation kind: ${String(object.kind)}`,
  );
}

export function decodeNativeTrace(value: unknown): NativeTraceCapture {
  const object = requireObject(
    value,
    "Native trace must be a JSON object.",
  );
  const format = requireObject(
    object.format,
    "Native trace format must be a JSON object.",
  );
  return {
    artifact: decodeArtifactCapture(object.artifact),
    format: {
      entityId: requireString(
        format.entityId,
        "Native trace format entityId must be a non-empty string.",
      ) as AbsoluteIri,
      ...(format.name === undefined
        ? {}
        : { name: format.name as string }),
    },
  };
}

export function decodeStartInput(
  value: unknown,
): StartExecutionRecordingInput {
  const object = requireObject(
    value,
    "Start request params must be a JSON object.",
  ) as unknown as StartRequestParams & Record<string, unknown>;

  const workspaceDir = requireString(
    object.workspaceDir,
    "workspaceDir must be a non-empty string.",
  );
  const startedAt = requireString(
    object.startedAt,
    "startedAt must be a non-empty string.",
  );
  const record = requireObject(
    object.record,
    "record must be a JSON object.",
  ) as unknown as ExecutionRecordCapture;
  const task = decodeTaskCapture(object.task);
  const executor = requireObject(
    object.executor,
    "executor must be a JSON object.",
  ) as unknown as ExecutorCapture;
  const runtime = decodeRuntimeCapture(object.runtime);
  const producer = requireObject(
    object.producer,
    "producer must be a JSON object.",
  ) as unknown as ProducerCapture;

  const initialInputs =
    object.initialInputs === undefined
      ? undefined
      : requireArray(
          object.initialInputs,
          "initialInputs must be an array.",
        ).map((input) => decodeInputCapture(input));

  const repositoryState =
    object.repositoryState === undefined
      ? undefined
      : decodeRepositoryStateCapture(object.repositoryState);

  const executionId =
    object.executionId === undefined
      ? undefined
      : (requireString(
          object.executionId,
          "executionId must be a non-empty string.",
        ) as ExecutionId);

  return {
    workspaceDir,
    ...(executionId === undefined ? {} : { executionId }),
    startedAt,
    record,
    task,
    ...(initialInputs === undefined ? {} : { initialInputs }),
    ...(repositoryState === undefined ? {} : { repositoryState }),
    executor,
    runtime,
    producer,
  };
}

export function decodeFinalizeInput(value: unknown): FinalizeExecutionInput {
  const object = requireObject(
    value,
    "Finalize request params must be a JSON object.",
  );
  const outcome = object.outcome;
  if (outcome !== "completed" && outcome !== "failed" && outcome !== "abandoned") {
    throw new RecorderBridgeError(
      "INVALID_REQUEST",
      `Unknown finalize outcome: ${String(outcome)}`,
    );
  }
  const endedAt = requireString(
    object.endedAt,
    "endedAt must be a non-empty string.",
  );
  const results =
    object.results === undefined
      ? undefined
      : requireArray(object.results, "results must be an array.").map(
          (result) => decodeInputCapture(result),
        );
  const nativeTrace =
    object.nativeTrace === undefined
      ? undefined
      : decodeNativeTrace(object.nativeTrace);

  return {
    outcome,
    endedAt,
    ...(results === undefined ? {} : { results }),
    ...(nativeTrace === undefined ? {} : { nativeTrace }),
  };
}
