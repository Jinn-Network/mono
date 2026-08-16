// SPDX-License-Identifier: Apache-2.0

import {
  ABANDONED_ACTION_STATUS,
  EXECUTION_EVIDENCE_PROFILE_URI,
  validateExecutionEvidence,
} from "@jinn-network/evidence-protocol";

import { serializeCanonicalJson } from "./canonical-json.js";
import { ExecutionEvidenceBuilderError } from "./errors.js";
import type {
  PersistedArtifactCapture,
  PersistedArtifactSource,
  PersistedNativeTraceCapture,
  PersistedRuntimeObservationCapture,
  PersistedStartRecording,
  AgentCapture,
  CaptureOrigin,
  ExecutionEvidenceBuilderInput,
  IdentifierCapture,
  JsonLdExtensions,
  JsonValue,
} from "./types.js";

const RO_CRATE_CONTEXT = "https://w3id.org/ro/crate/1.3/context";
const WORKFLOW_RUN_CONTEXT =
  "https://w3id.org/ro/terms/workflow-run/context";
const RO_CRATE_PROFILE = "https://w3id.org/ro/crate/1.3";
const DURATION_PROPERTY = "https://spec.jinn.network/terms/durationMs";

const ORIGIN_ROLES = {
  "producer-observed": {
    observer: {
      id: "urn:jinn:execution-recorder:role:producer-observer",
      name: "Producer observer",
    },
  },
  "executor-reported": {
    reporter: {
      id: "urn:jinn:execution-recorder:role:executor-reporter",
      name: "Executor reporter",
    },
    capturedBy: {
      id: "urn:jinn:execution-recorder:role:capture-agent",
      name: "Capture agent",
    },
  },
  "external-observed": {
    observer: {
      id: "urn:jinn:execution-recorder:role:external-observer",
      name: "External observer",
    },
    capturedBy: {
      id: "urn:jinn:execution-recorder:role:capture-agent",
      name: "Capture agent",
    },
  },
} as const;

type Entity = { readonly [key: string]: JsonValue };
type MutableEntity = { [key: string]: JsonValue };

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type ExecutionEvidenceMapperInput = ExecutionEvidenceBuilderInput;

interface RankedEntity {
  rank: number;
  readonly entity: MutableEntity;
}

type CaptureRole =
  | "task"
  | "input"
  | "runtime"
  | "environment"
  | "result"
  | "native-trace";

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return left === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]!))
    );
  }
  const leftObject = left as Readonly<Record<string, JsonValue>>;
  const rightObject = right as Readonly<Record<string, JsonValue>>;
  const leftKeys = Object.keys(leftObject).sort(compareStrings);
  const rightKeys = Object.keys(rightObject).sort(compareStrings);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        jsonEqual(leftObject[key]!, rightObject[key]!),
    )
  );
}

function cloneJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJson(entry)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)]),
    ) as T;
  }
  return value;
}

function hasAgentType(entity: MutableEntity): boolean {
  const value = entity["@type"];
  const values = Array.isArray(value) ? value : [value];
  return values.some(
    (type) =>
      type === "Person" ||
      type === "Organization" ||
      type === "prov:Agent" ||
      type === "prov:SoftwareAgent",
  );
}

function reference(id: string): Entity {
  return { "@id": id };
}

function references(ids: readonly string[]): Entity | readonly Entity[] {
  const values = ids.map(reference);
  return values.length === 1 ? values[0]! : values;
}

function digest(source: PersistedArtifactSource): string {
  return source.digest.slice("sha256:".length);
}

function identifiers(
  values: readonly IdentifierCapture[] | undefined,
): Entity | readonly Entity[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const mapped = values
    .filter(
      (identifier, index) =>
        values.findIndex(
          (candidate) =>
            candidate.propertyId === identifier.propertyId &&
            candidate.value === identifier.value,
        ) === index,
    )
    .sort(
      (left, right) =>
        compareStrings(left.propertyId, right.propertyId) ||
        compareStrings(left.value, right.value),
    )
    .map((identifier) => ({
      "@type": "PropertyValue",
      propertyID: identifier.propertyId,
      value: identifier.value,
    }));
  return mapped.length === 1 ? mapped[0]! : mapped;
}

function mergeIdentifiers(
  left: readonly IdentifierCapture[] | undefined,
  right: readonly IdentifierCapture[] | undefined,
): readonly IdentifierCapture[] | undefined {
  const merged = [...(left ?? []), ...(right ?? [])];
  return merged.length === 0 ? undefined : merged;
}

function mergeExtensions(
  builder: GraphBuilder,
  entityId: string,
  left: JsonLdExtensions | undefined,
  right: JsonLdExtensions | undefined,
): JsonLdExtensions | undefined {
  if (left === undefined && right === undefined) return undefined;
  const merged = new Map<string, JsonValue>(Object.entries(left ?? {}));
  for (const [key, value] of Object.entries(right ?? {})) {
    const current = merged.get(key);
    if (merged.has(key) && !jsonEqual(current!, value)) {
      builder.conflict(entityId, `values for extension ${key}`);
    }
    merged.set(key, value);
  }
  return Object.fromEntries(merged);
}

function types(base: readonly string[], additional?: readonly string[]): JsonValue {
  const combined = [
    ...base,
    ...[...(additional ?? [])].sort(compareStrings),
  ].filter((value, index, values) => values.indexOf(value) === index);
  return combined.length === 1 ? combined[0]! : combined;
}

function sourceFields(source: PersistedArtifactSource): MutableEntity {
  return {
    contentSize: source.size,
    encodingFormat: source.mediaType,
    ...(source.name === undefined ? {} : { name: source.name }),
    sha256: digest(source),
  };
}

class GraphBuilder {
  readonly entities = new Map<string, RankedEntity>();
  readonly declarations = new Map<string, MutableEntity>();
  readonly contextualAgents = new Set<string>();
  readonly captureRoles = new Map<string, CaptureRole>();
  readonly contentIds = new Set<string>();
  readonly roles = new Map<string, string>();
  readonly origins = new Map<string, CaptureOrigin>();
  attributionOrdinal = 0;

  conflict(id: string, detail: string): never {
    throw new ExecutionEvidenceBuilderError(
      "RECORDING_CONFLICT",
      `Graph entity ${id} has incompatible ${detail}.`,
      { entityId: id },
    );
  }

  claimCaptureRole(id: string, role: CaptureRole): void {
    const current = this.captureRoles.get(id);
    if (current !== undefined && current !== role) {
      this.conflict(id, `capture roles ${current} and ${role}`);
    }
    this.captureRoles.set(id, role);
  }

  add(entity: MutableEntity, rank: number): MutableEntity {
    const id = entity["@id"];
    if (typeof id !== "string") {
      throw new TypeError("Graph entities require an @id.");
    }
    const current = this.entities.get(id);
    if (current) {
      if (this.contextualAgents.has(id)) {
        if (!hasAgentType(entity)) {
          this.conflict(id, "substantive declarations");
        }
        this.contextualAgents.delete(id);
        for (const key of Object.keys(current.entity)) {
          delete current.entity[key];
        }
        Object.assign(current.entity, entity);
        this.declarations.set(id, cloneJson(entity));
        current.rank = Math.min(current.rank, rank);
        return current.entity;
      }
      const declaration = this.declarations.get(id);
      if (declaration === undefined || !jsonEqual(declaration, entity)) {
        this.conflict(id, "substantive declarations");
      }
      current.rank = Math.min(current.rank, rank);
      return current.entity;
    }
    this.entities.set(id, { rank, entity });
    this.declarations.set(id, cloneJson(entity));
    return entity;
  }

  contextualAgent(id: string): void {
    const current = this.entities.get(id);
    if (current) {
      if (!hasAgentType(current.entity)) {
        this.conflict(id, "Agent and non-Agent declarations");
      }
      return;
    }
    const entity = {
      "@id": id,
      "@type": "prov:Agent",
    };
    this.entities.set(id, { rank: 160, entity });
    this.declarations.set(id, cloneJson(entity));
    this.contextualAgents.add(id);
  }

  setProperty(id: string, property: string, value: JsonValue): void {
    const target = this.entities.get(id)?.entity;
    if (target === undefined) {
      throw new TypeError(`Graph entity ${id} has not been declared.`);
    }
    const current = target[property];
    if (current !== undefined && !jsonEqual(current, value)) {
      this.conflict(id, `values for ${property}`);
    }
    target[property] = value;
  }

  addOrigin(target: MutableEntity, origin: CaptureOrigin): void {
    const targetId = target["@id"];
    if (typeof targetId !== "string") return;
    const currentOrigin = this.origins.get(targetId);
    if (currentOrigin !== undefined) {
      if (!jsonEqual(currentOrigin, origin)) {
        this.conflict(targetId, "capture origins");
      }
      return;
    }
    this.origins.set(targetId, cloneJson(origin));

    const attributions: { agent: string; role: { id: string; name: string } }[] =
      [];
    if (origin.kind === "producer-observed") {
      attributions.push({
        agent: origin.observer,
        role: ORIGIN_ROLES["producer-observed"].observer,
      });
    } else if (origin.kind === "executor-reported") {
      attributions.push({
        agent: origin.reporter,
        role: ORIGIN_ROLES["executor-reported"].reporter,
      });
      attributions.push({
        agent: origin.capturedBy,
        role: ORIGIN_ROLES["executor-reported"].capturedBy,
      });
    } else {
      attributions.push({
        agent: origin.observer,
        role: ORIGIN_ROLES["external-observed"].observer,
      });
      attributions.push({
        agent: origin.capturedBy,
        role: ORIGIN_ROLES["external-observed"].capturedBy,
      });
    }

    const attributionIds = attributions.map(({ agent, role }) => {
      this.contextualAgent(agent);
      this.roles.set(role.id, role.name);
      this.attributionOrdinal += 1;
      const id = `#attribution-${this.attributionOrdinal}`;
      this.add(
        {
          "@id": id,
          "@type": "prov:Attribution",
          "prov:agent": reference(agent),
          "prov:hadRole": reference(role.id),
        },
        170,
      );
      return id;
    });
    target["prov:qualifiedAttribution"] = references(attributionIds);
  }

  addArtifact(
    artifact: PersistedArtifactCapture,
    rank: number,
    role: CaptureRole,
  ): string[] {
    this.claimCaptureRole(artifact.entityId, role);
    const directMemberIds = new Set<string>();
    const descendantIds: string[] = [];
    if (artifact.kind !== "file") {
      for (const member of [...artifact.members].sort((left, right) =>
        compareStrings(left.entityId, right.entityId),
      )) {
        directMemberIds.add(member.entityId);
        descendantIds.push(...this.addArtifact(member, rank, role));
      }
    }
    const source =
      artifact.kind === "file" ? artifact.source : artifact.manifest;
    const baseTypes =
      artifact.kind === "file"
        ? ["File"]
        : ["File", artifact.kind === "dataset" ? "Dataset" : "Collection"];
    const mapped = this.add(
      {
        ...(artifact.extensions ?? {}),
        "@id": artifact.entityId,
        "@type": types(baseTypes, artifact.additionalTypes),
        ...sourceFields(source),
        ...(identifiers(artifact.identifiers) === undefined
          ? {}
          : { identifier: identifiers(artifact.identifiers)! }),
        ...(directMemberIds.size === 0
          ? {}
          : {
              hasPart: [...directMemberIds]
                .sort(compareStrings)
                .map(reference),
            }),
      },
      rank,
    );
    this.contentIds.add(artifact.entityId);
    this.addOrigin(mapped, artifact.origin);
    return [artifact.entityId, ...descendantIds];
  }

  addAgent(agent: AgentCapture, rank: number): void {
    const type =
      agent.kind === "person"
        ? ["Person", "prov:Agent"]
        : agent.kind === "organization"
          ? ["Organization", "prov:Agent"]
          : ["SoftwareApplication", "prov:SoftwareAgent"];
    const mapped = this.add(
      {
        ...(agent.extensions ?? {}),
        "@id": agent.entityId,
        "@type": type,
        name: agent.name,
        ...(agent.softwareVersion === undefined
          ? {}
          : { softwareVersion: agent.softwareVersion }),
        ...(identifiers(agent.identifiers) === undefined
          ? {}
          : { identifier: identifiers(agent.identifiers)! }),
      },
      rank,
    );
    this.addOrigin(mapped, agent.origin);
  }

  ordered(): readonly Entity[] {
    for (const [id, name] of this.roles) {
      this.add(
        {
          "@id": id,
          "@type": "prov:Role",
          name,
        },
        180,
      );
    }
    return [...this.entities.values()]
      .sort(
        (left, right) =>
          left.rank - right.rank ||
          compareStrings(
            String(left.entity["@id"]),
            String(right.entity["@id"]),
          ),
      )
      .map(({ entity }) => entity);
  }
}

function status(outcome: ExecutionEvidenceMapperInput["outcome"]): string {
  switch (outcome) {
    case "completed":
      return "https://schema.org/CompletedActionStatus";
    case "failed":
      return "https://schema.org/FailedActionStatus";
    case "abandoned":
      return ABANDONED_ACTION_STATUS;
  }
}

function withExtensions(
  extensions: JsonLdExtensions | undefined,
  entity: MutableEntity,
): MutableEntity {
  return {
    ...(extensions ?? {}),
    ...entity,
  };
}

export function buildExecutionEvidence(
  input: ExecutionEvidenceMapperInput,
): Uint8Array {
  const { recording } = input;
  const builder = new GraphBuilder();

  builder.add(
    {
      "@id": "ro-crate-metadata.json",
      "@type": "CreativeWork",
      about: reference("./"),
      conformsTo: reference(RO_CRATE_PROFILE),
    },
    0,
  );
  builder.add(
    {
      "@id": EXECUTION_EVIDENCE_PROFILE_URI,
      "@type": ["CreativeWork", "Profile"],
      name: "Jinn Execution Evidence Profile 1.0",
    },
    20,
  );
  builder.add(
    {
      "@id": recording.record.license,
      "@type": "CreativeWork",
    },
    30,
  );

  builder.claimCaptureRole(recording.task.entityId, "task");
  const task = builder.add(
    withExtensions(recording.task.extensions, {
      "@id": recording.task.entityId,
      "@type": ["File", "CreativeWork", "prov:Plan"],
      ...sourceFields(recording.task.source),
      name: recording.task.name,
      ...(identifiers(recording.task.identifiers) === undefined
        ? {}
        : { identifier: identifiers(recording.task.identifiers)! }),
    }),
    40,
  );
  builder.contentIds.add(recording.task.entityId);
  builder.addOrigin(task, recording.task.origin);

  const repositoryArtifact =
    recording.repositoryState === undefined
      ? undefined
      : {
          ...recording.repositoryState.artifact,
          identifiers: mergeIdentifiers(
            recording.repositoryState.artifact.identifiers,
            recording.repositoryState.identifiers,
          ),
          extensions: mergeExtensions(
            builder,
            recording.repositoryState.artifact.entityId,
            recording.repositoryState.artifact.extensions,
            recording.repositoryState.extensions,
          ),
        };
  const inputArtifacts = [
    ...recording.initialInputs,
    ...input.additionalInputs,
    ...(repositoryArtifact === undefined ? [] : [repositoryArtifact]),
  ];
  const inputIds = new Set<string>();
  const inputContentIds: string[] = [];
  for (const artifact of [...inputArtifacts].sort((left, right) =>
    compareStrings(left.entityId, right.entityId),
  )) {
    inputIds.add(artifact.entityId);
    inputContentIds.push(...builder.addArtifact(artifact, 50, "input"));
  }
  if (recording.repositoryState) {
    const repository = recording.repositoryState;
    if (repository.repository !== undefined) {
      builder.setProperty(
        repository.artifact.entityId,
        "codeRepository",
        repository.repository,
      );
    }
  }

  const runtimePartIds: string[] = [];
  const runtimeContentIds: string[] = [];
  const opaqueComponentIds: string[] = [];
  for (const component of [...recording.runtime.components].sort(
    (left, right) => {
      const leftId =
        left.kind === "controlled"
          ? left.artifact.entityId
          : left.descriptor.entityId;
      const rightId =
        right.kind === "controlled"
          ? right.artifact.entityId
          : right.descriptor.entityId;
      return compareStrings(leftId, rightId);
    },
  )) {
    if (component.kind === "controlled") {
      runtimeContentIds.push(
        ...builder.addArtifact(component.artifact, 70, "runtime"),
      );
      runtimePartIds.push(component.artifact.entityId);
    } else {
      runtimeContentIds.push(
        ...builder.addArtifact(component.descriptor, 70, "runtime"),
      );
      runtimePartIds.push(component.descriptor.entityId);
      opaqueComponentIds.push(component.component.entityId);
      builder.setProperty(
        component.descriptor.entityId,
        "about",
        reference(component.component.entityId),
      );
      builder.add(
        withExtensions(component.component.extensions, {
          "@id": component.component.entityId,
          "@type": "SoftwareApplication",
          name: component.component.name,
          ...(component.component.softwareVersion === undefined
            ? {}
            : { softwareVersion: component.component.softwareVersion }),
          ...(component.component.provider === undefined
            ? {}
            : { provider: reference(component.component.provider) }),
        }),
        160,
      );
      if (component.component.provider) {
        builder.contextualAgent(component.component.provider);
      }
    }
  }

  const environmentIds: string[] = [];
  const environmentContentIds: string[] = [];
  const resourceIds: string[] = [];
  for (const observation of [...input.runtimeObservations].sort(
    (left, right) => {
      const leftId =
        left.kind === "resource"
          ? left.entityId
          : left.kind === "environment"
            ? left.artifact.entityId
            : left.component.descriptor.entityId;
      const rightId =
        right.kind === "resource"
          ? right.entityId
          : right.kind === "environment"
            ? right.artifact.entityId
            : right.component.descriptor.entityId;
      return compareStrings(leftId, rightId);
    },
  )) {
    if (observation.kind === "resource") {
      const mapped = builder.add(
        withExtensions(observation.extensions, {
          "@id": observation.entityId,
          "@type": "PropertyValue",
          name: observation.name,
          value: observation.value,
          ...(observation.propertyId === undefined
            ? {}
            : { propertyID: observation.propertyId }),
          ...(observation.unitCode === undefined
            ? {}
            : { unitCode: observation.unitCode }),
          ...(observation.unitText === undefined
            ? {}
            : { unitText: observation.unitText }),
        }),
        130,
      );
      builder.addOrigin(mapped, observation.origin);
      resourceIds.push(observation.entityId);
    } else if (observation.kind === "environment") {
      environmentContentIds.push(
        ...builder.addArtifact(observation.artifact, 130, "environment"),
      );
      environmentIds.push(observation.artifact.entityId);
    } else {
      const component = observation.component;
      runtimeContentIds.push(
        ...builder.addArtifact(component.descriptor, 70, "runtime"),
      );
      runtimePartIds.push(component.descriptor.entityId);
      opaqueComponentIds.push(component.component.entityId);
      builder.setProperty(
        component.descriptor.entityId,
        "about",
        reference(component.component.entityId),
      );
      builder.add(
        withExtensions(component.component.extensions, {
          "@id": component.component.entityId,
          "@type": "SoftwareApplication",
          name: component.component.name,
          ...(component.component.softwareVersion === undefined
            ? {}
            : { softwareVersion: component.component.softwareVersion }),
          ...(component.component.provider === undefined
            ? {}
            : { provider: reference(component.component.provider) }),
        }),
        160,
      );
      if (component.component.provider) {
        builder.contextualAgent(component.component.provider);
      }
    }
  }

  builder.claimCaptureRole(recording.runtime.entityId, "runtime");
  const runtime = builder.add(
    withExtensions(recording.runtime.extensions, {
      "@id": recording.runtime.entityId,
      "@type": ["File", "SoftwareApplication"],
      ...sourceFields(recording.runtime.specification),
      name: recording.runtime.name,
      ...(recording.runtime.softwareVersion === undefined
        ? {}
        : { softwareVersion: recording.runtime.softwareVersion }),
      hasPart: [...new Set(runtimePartIds)].sort().map(reference),
      ...(opaqueComponentIds.length === 0
        ? {}
        : {
            softwareRequirements: references(
              [...new Set(opaqueComponentIds)].sort(),
            ),
          }),
    }),
    60,
  );
  builder.contentIds.add(recording.runtime.entityId);
  builder.addOrigin(runtime, recording.runtime.origin);

  builder.addAgent(recording.executor, 90);

  const resultIds: string[] = [];
  const resultContentIds: string[] = [];
  for (const result of [...input.results].sort((left, right) =>
    compareStrings(left.entityId, right.entityId),
  )) {
    resultIds.push(result.entityId);
    resultContentIds.push(...builder.addArtifact(result, 100, "result"));
    builder.setProperty(
      result.entityId,
      "prov:wasGeneratedBy",
      reference(recording.executionId),
    );
  }

  const traceContentIds = builder.addArtifact(
    input.nativeTrace.artifact,
    110,
    "native-trace",
  );
  builder.setProperty(
    input.nativeTrace.artifact.entityId,
    "about",
    reference(recording.executionId),
  );
  builder.setProperty(
    input.nativeTrace.artifact.entityId,
    "conformsTo",
    reference(input.nativeTrace.format.entityId),
  );
  builder.add(
    {
      "@id": input.nativeTrace.format.entityId,
      "@type": ["CreativeWork", "Profile"],
      ...(input.nativeTrace.format.name === undefined
        ? {}
        : { name: input.nativeTrace.format.name }),
    },
    120,
  );

  const execution = withExtensions(recording.record.executionExtensions, {
    "@id": recording.executionId,
    "@type": ["CreateAction", "prov:Activity"],
    name: recording.record.executionName ?? recording.record.name,
    actionStatus: reference(status(input.outcome)),
    agent: reference(recording.executor.entityId),
    endTime: input.endedAt,
    ...(environmentIds.length === 0
      ? {}
      : { environment: references([...new Set(environmentIds)].sort()) }),
    instrument: reference(recording.runtime.entityId),
    ...(identifiers(recording.record.executionIdentifiers) === undefined
      ? {}
      : {
          identifier: identifiers(recording.record.executionIdentifiers)!,
        }),
    object: references([
      recording.task.entityId,
      ...[...inputIds].sort(compareStrings),
    ]),
    resourceUsage: references([
      "#duration-ms",
      ...[...new Set(resourceIds)].sort(),
    ]),
    ...(resultIds.length === 0
      ? {}
      : { result: references([...new Set(resultIds)].sort()) }),
    startTime: recording.startedAt,
    subjectOf: reference(input.nativeTrace.artifact.entityId),
  });
  builder.add(execution, 80);

  builder.addAgent(recording.producer, 140);
  builder.add(
    {
      "@id": "#capture",
      "@type": "prov:Activity",
      name: "Execution Recorder capture and sealing",
      endTime: input.finalizedAt,
      agent: reference(recording.producer.entityId),
    },
    150,
  );
  builder.add(
    {
      "@id": "#duration-ms",
      "@type": "PropertyValue",
      name: "durationMs",
      propertyID: DURATION_PROPERTY,
      value: Date.parse(input.endedAt) - Date.parse(recording.startedAt),
      unitCode: "ms",
    },
    150,
  );

  const contentOrder = [
    recording.task.entityId,
    ...inputContentIds,
    recording.runtime.entityId,
    ...runtimeContentIds,
    ...environmentContentIds,
    ...resultContentIds,
    ...traceContentIds,
  ].filter((id, index, values) => values.indexOf(id) === index);
  for (const id of [...builder.contentIds].sort()) {
    if (!contentOrder.includes(id)) contentOrder.push(id);
  }

  builder.add(
    withExtensions(recording.record.rootExtensions, {
      "@id": "./",
      "@type": "Dataset",
      name: recording.record.name,
      description: recording.record.description,
      dateCreated: input.finalizedAt,
      datePublished: input.finalizedAt,
      license: reference(recording.record.license),
      conformsTo: reference(EXECUTION_EVIDENCE_PROFILE_URI),
      creator: reference(recording.producer.entityId),
      hasPart: contentOrder.map(reference),
      mentions: reference(recording.executionId),
      "prov:wasGeneratedBy": reference("#capture"),
    }),
    10,
  );

  const document = {
    ...(recording.record.documentExtensions ?? {}),
    "@context": [
      RO_CRATE_CONTEXT,
      WORKFLOW_RUN_CONTEXT,
      {
        prov: "http://www.w3.org/ns/prov#",
        jinn: "https://spec.jinn.network/terms/",
      },
    ],
    "@graph": builder.ordered(),
  } as JsonValue;
  const bytes = serializeCanonicalJson(document);
  const report = validateExecutionEvidence(bytes);
  if (!report.conforms) {
    throw new ExecutionEvidenceBuilderError(
      "PROTOCOL_CONFORMANCE_FAILED",
      "Constructed Execution Evidence does not conform to the protocol.",
      { diagnostics: report.diagnostics },
    );
  }
  return bytes;
}
