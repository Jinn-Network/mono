// SPDX-License-Identifier: Apache-2.0

import type { Sha256Digest } from "@jinn-network/evidence-repository";

import { snapshotArtifactSource } from "./artifact-source.js";
import { serializeCanonicalJson } from "./canonical-json.js";
import type {
  PersistedArtifactCapture,
  PersistedArtifactSource,
  PersistedNativeTraceCapture,
  PersistedRepositoryStateCapture,
  PersistedRuntimeCapture,
  PersistedRuntimeObservationCapture,
  PersistedStartRecording,
  PersistedTaskCapture,
} from "./journal-types.js";
import { objectDigest, storeObject } from "./object-store.js";
import type { WorkspacePaths } from "./paths.js";
import type {
  AgentCapture,
  ArtifactCapture,
  ArtifactSource,
  ExecutionRecordCapture,
  IdentifierCapture,
  JsonLdExtensions,
  JsonValue,
  NativeTraceCapture,
  RepositoryStateCapture,
  RuntimeCapture,
  RuntimeObservationCapture,
  StartExecutionRecordingInput,
  TaskCapture,
} from "./types.js";

const decoder = new TextDecoder();

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(
    decoder.decode(serializeCanonicalJson(value)),
  ) as T;
}

function extensions(
  value: JsonLdExtensions | undefined,
): JsonLdExtensions | undefined {
  return value === undefined ? undefined : cloneJson(value);
}

function identifiers(
  values: readonly IdentifierCapture[] | undefined,
): readonly IdentifierCapture[] | undefined {
  if (values === undefined) return undefined;
  return values
    .map(({ propertyId, value }) => ({ propertyId, value }))
    .sort(
      (left, right) =>
        compareStrings(left.propertyId, right.propertyId) ||
        compareStrings(left.value, right.value),
    )
    .filter(
      (value, index, sorted) =>
        index === 0 ||
        value.propertyId !== sorted[index - 1]!.propertyId ||
        value.value !== sorted[index - 1]!.value,
    );
}

function agent(value: AgentCapture): AgentCapture {
  return {
    entityId: value.entityId,
    kind: value.kind,
    name: value.name,
    ...(value.softwareVersion === undefined
      ? {}
      : { softwareVersion: value.softwareVersion }),
    ...(identifiers(value.identifiers) === undefined
      ? {}
      : { identifiers: identifiers(value.identifiers)! }),
    origin: cloneJson(value.origin),
    ...(extensions(value.extensions) === undefined
      ? {}
      : { extensions: extensions(value.extensions)! }),
  };
}

function record(value: ExecutionRecordCapture): ExecutionRecordCapture {
  return {
    name: value.name,
    description: value.description,
    license: value.license,
    ...(value.executionName === undefined
      ? {}
      : { executionName: value.executionName }),
    ...(identifiers(value.executionIdentifiers) === undefined
      ? {}
      : { executionIdentifiers: identifiers(value.executionIdentifiers)! }),
    ...(extensions(value.documentExtensions) === undefined
      ? {}
      : { documentExtensions: extensions(value.documentExtensions)! }),
    ...(extensions(value.rootExtensions) === undefined
      ? {}
      : { rootExtensions: extensions(value.rootExtensions)! }),
    ...(extensions(value.executionExtensions) === undefined
      ? {}
      : { executionExtensions: extensions(value.executionExtensions)! }),
  };
}

export async function persistArtifactSource(
  paths: WorkspacePaths,
  source: ArtifactSource,
  signal?: AbortSignal,
): Promise<PersistedArtifactSource> {
  const snapshot = await snapshotArtifactSource(source, signal);
  const reference = await storeObject(paths, snapshot.bytes, signal);
  return {
    ...reference,
    mediaType: snapshot.mediaType,
    ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
  };
}

export async function persistArtifactCapture(
  paths: WorkspacePaths,
  artifact: ArtifactCapture,
  signal?: AbortSignal,
): Promise<PersistedArtifactCapture> {
  const common = {
    entityId: artifact.entityId,
    origin: cloneJson(artifact.origin),
    ...(artifact.additionalTypes === undefined
      ? {}
      : {
          additionalTypes: [...artifact.additionalTypes].sort(compareStrings),
        }),
    ...(identifiers(artifact.identifiers) === undefined
      ? {}
      : { identifiers: identifiers(artifact.identifiers)! }),
    ...(extensions(artifact.extensions) === undefined
      ? {}
      : { extensions: extensions(artifact.extensions)! }),
  };
  if (artifact.kind === "file") {
    return {
      kind: "file",
      ...common,
      source: await persistArtifactSource(paths, artifact.source, signal),
    };
  }
  const members: PersistedArtifactCapture[] = [];
  for (const member of [...artifact.members].sort((left, right) =>
    compareStrings(left.entityId, right.entityId),
  )) {
    members.push(await persistArtifactCapture(paths, member, signal));
  }
  return {
    kind: artifact.kind,
    ...common,
    manifest: await persistArtifactSource(paths, artifact.manifest, signal),
    members,
  };
}

async function persistTask(
  paths: WorkspacePaths,
  task: TaskCapture,
  signal?: AbortSignal,
): Promise<PersistedTaskCapture> {
  return {
    entityId: task.entityId,
    name: task.name,
    source: await persistArtifactSource(paths, task.source, signal),
    origin: cloneJson(task.origin),
    ...(identifiers(task.identifiers) === undefined
      ? {}
      : { identifiers: identifiers(task.identifiers)! }),
    ...(extensions(task.extensions) === undefined
      ? {}
      : { extensions: extensions(task.extensions)! }),
  };
}

async function persistRepositoryState(
  paths: WorkspacePaths,
  value: RepositoryStateCapture,
  signal?: AbortSignal,
): Promise<PersistedRepositoryStateCapture> {
  return {
    artifact: (await persistArtifactCapture(
      paths,
      value.artifact,
      signal,
    )) as PersistedRepositoryStateCapture["artifact"],
    identifiers: identifiers(value.identifiers) ?? [],
    ...(value.repository === undefined
      ? {}
      : { repository: value.repository }),
    ...(extensions(value.extensions) === undefined
      ? {}
      : { extensions: extensions(value.extensions)! }),
  };
}

async function persistRuntime(
  paths: WorkspacePaths,
  runtime: RuntimeCapture,
  signal?: AbortSignal,
): Promise<PersistedRuntimeCapture> {
  const components: PersistedRuntimeCapture["components"][number][] = [];
  for (const component of [...runtime.components].sort((left, right) => {
    const leftId =
      left.kind === "controlled"
        ? left.artifact.entityId
        : left.descriptor.entityId;
    const rightId =
      right.kind === "controlled"
        ? right.artifact.entityId
        : right.descriptor.entityId;
    return compareStrings(leftId, rightId);
  })) {
    if (component.kind === "controlled") {
      components.push({
        kind: "controlled",
        artifact: await persistArtifactCapture(
          paths,
          component.artifact,
          signal,
        ),
      });
    } else {
      components.push({
        kind: "opaque",
        descriptor: (await persistArtifactCapture(
          paths,
          component.descriptor,
          signal,
        )) as Extract<
          PersistedRuntimeCapture["components"][number],
          { kind: "opaque" }
        >["descriptor"],
        component: {
          entityId: component.component.entityId,
          name: component.component.name,
          ...(component.component.softwareVersion === undefined
            ? {}
            : { softwareVersion: component.component.softwareVersion }),
          ...(component.component.provider === undefined
            ? {}
            : { provider: component.component.provider }),
          ...(extensions(component.component.extensions) === undefined
            ? {}
            : {
                extensions: extensions(component.component.extensions)!,
              }),
        },
      });
    }
  }
  return {
    entityId: runtime.entityId,
    specification: await persistArtifactSource(
      paths,
      runtime.specification,
      signal,
    ),
    name: runtime.name,
    ...(runtime.softwareVersion === undefined
      ? {}
      : { softwareVersion: runtime.softwareVersion }),
    origin: cloneJson(runtime.origin),
    components,
    ...(extensions(runtime.extensions) === undefined
      ? {}
      : { extensions: extensions(runtime.extensions)! }),
  };
}

export async function persistStartRecording(
  paths: WorkspacePaths,
  input: StartExecutionRecordingInput,
  executionId: PersistedStartRecording["executionId"],
  signal?: AbortSignal,
): Promise<PersistedStartRecording> {
  const initialInputs: PersistedArtifactCapture[] = [];
  for (const capture of [...(input.initialInputs ?? [])].sort((left, right) =>
    compareStrings(left.entityId, right.entityId),
  )) {
    initialInputs.push(
      await persistArtifactCapture(paths, capture, signal),
    );
  }
  return {
    executionId,
    startedAt: input.startedAt,
    record: record(input.record),
    task: await persistTask(paths, input.task, signal),
    initialInputs,
    ...(input.repositoryState === undefined
      ? {}
      : {
          repositoryState: await persistRepositoryState(
            paths,
            input.repositoryState,
            signal,
          ),
        }),
    executor: agent(input.executor),
    runtime: await persistRuntime(paths, input.runtime, signal),
    producer: agent(input.producer),
  };
}

export async function persistRuntimeObservation(
  paths: WorkspacePaths,
  observation: RuntimeObservationCapture,
  signal?: AbortSignal,
): Promise<PersistedRuntimeObservationCapture> {
  if (observation.kind === "resource") {
    return {
      kind: "resource",
      entityId: observation.entityId,
      name: observation.name,
      value: observation.value,
      ...(observation.propertyId === undefined
        ? {}
        : { propertyId: observation.propertyId }),
      ...(observation.unitCode === undefined
        ? {}
        : { unitCode: observation.unitCode }),
      ...(observation.unitText === undefined
        ? {}
        : { unitText: observation.unitText }),
      origin: cloneJson(observation.origin),
      ...(extensions(observation.extensions) === undefined
        ? {}
        : { extensions: extensions(observation.extensions)! }),
    };
  }
  if (observation.kind === "environment") {
    return {
      kind: "environment",
      artifact: await persistArtifactCapture(
        paths,
        observation.artifact,
        signal,
      ),
    };
  }
  return {
    kind: "opaque-component",
    component: {
      kind: "opaque",
      descriptor: (await persistArtifactCapture(
        paths,
        observation.component.descriptor,
        signal,
      )) as Extract<
        PersistedRuntimeObservationCapture,
        { kind: "opaque-component" }
      >["component"]["descriptor"],
      component: {
        entityId: observation.component.component.entityId,
        name: observation.component.component.name,
        ...(observation.component.component.softwareVersion === undefined
          ? {}
          : {
              softwareVersion:
                observation.component.component.softwareVersion,
            }),
        ...(observation.component.component.provider === undefined
          ? {}
          : { provider: observation.component.component.provider }),
        ...(extensions(
          observation.component.component.extensions,
        ) === undefined
          ? {}
          : {
              extensions: extensions(
                observation.component.component.extensions,
              )!,
            }),
      },
    },
  };
}

export async function persistNativeTrace(
  paths: WorkspacePaths,
  trace: NativeTraceCapture,
  signal?: AbortSignal,
): Promise<PersistedNativeTraceCapture> {
  return {
    artifact: await persistArtifactCapture(paths, trace.artifact, signal),
    format: {
      entityId: trace.format.entityId,
      ...(trace.format.name === undefined
        ? {}
        : { name: trace.format.name }),
    },
  };
}

export function captureFingerprint(
  role: string,
  value: unknown,
): Sha256Digest {
  return objectDigest(
    serializeCanonicalJson({
      role,
      value,
    } as unknown as JsonValue),
  );
}
