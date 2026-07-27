// SPDX-License-Identifier: Apache-2.0

import { invalidCaptureInput } from "./errors.js";
import type {
  AbsoluteIri,
  AgentCapture,
  AggregateArtifactCapture,
  ArtifactCapture,
  ArtifactSource,
  CaptureOrigin,
  FinalizeExecutionInput,
  IdentifierCapture,
  JsonLdExtensions,
  NativeTraceCapture,
  OpaqueRuntimeComponentCapture,
  RuntimeObservationCapture,
  StartExecutionRecordingInput,
} from "./types.js";

const EXECUTION_ID =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;
const IRI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const RESERVED_ENTITY_IDS = new Set([
  "./",
  "ro-crate-metadata.json",
  "#capture",
  "#duration-ms",
]);
const RESERVED_EXTENSION_KEYS = new Set([
  "@context",
  "@graph",
  "@id",
  "@type",
  "about",
  "actionStatus",
  "agent",
  "conformsTo",
  "creator",
  "dateCreated",
  "datePublished",
  "description",
  "encodingFormat",
  "endTime",
  "environment",
  "hasPart",
  "identifier",
  "instrument",
  "license",
  "mentions",
  "name",
  "object",
  "provider",
  "prov:qualifiedAttribution",
  "prov:wasDerivedFrom",
  "prov:wasGeneratedBy",
  "resourceUsage",
  "result",
  "sha256",
  "softwareRequirements",
  "softwareVersion",
  "startTime",
  "subjectOf",
]);

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isStrictRfc3339(value: string): boolean {
  const match = RFC3339.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

export function isAbsoluteIri(value: string): value is AbsoluteIri {
  if (!IRI_SCHEME.test(value) || /\s/.test(value)) return false;
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidCaptureInput(`${field} must be a non-empty string.`);
  }
}

function validateIri(value: unknown, field: string): asserts value is AbsoluteIri {
  if (typeof value !== "string" || !isAbsoluteIri(value)) {
    invalidCaptureInput(`${field} must be an absolute IRI.`);
  }
}

function validateEntityId(value: unknown, field: string): asserts value is string {
  nonEmptyString(value, field);
  if (
    RESERVED_ENTITY_IDS.has(value) ||
    value.startsWith("/") ||
    value.startsWith("#") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    value.split("/").some((part) => part === "." || part === "..") ||
    IRI_SCHEME.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalidCaptureInput(`${field} must be a safe crate-local entity id.`, value);
  }
}

function validateJsonValue(
  value: unknown,
  field: string,
  ancestors: Set<object>,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      invalidCaptureInput(`${field} contains a non-finite number.`);
    }
    return;
  }
  if (typeof value !== "object") {
    invalidCaptureInput(`${field} must contain JSON values only.`);
  }
  if (ancestors.has(value)) {
    invalidCaptureInput(`${field} must not contain cycles.`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateJsonValue(item, `${field}/${index}`, ancestors),
    );
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalidCaptureInput(`${field} must contain plain JSON objects only.`);
    }
    for (const [key, item] of Object.entries(value)) {
      validateJsonValue(item, `${field}/${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function validateExtensions(
  extensions: JsonLdExtensions | undefined,
  field: string,
): void {
  if (extensions === undefined) return;
  if (
    typeof extensions !== "object" ||
    extensions === null ||
    Array.isArray(extensions)
  ) {
    invalidCaptureInput(`${field} must be a JSON object.`);
  }
  for (const key of Object.keys(extensions)) {
    if (RESERVED_EXTENSION_KEYS.has(key)) {
      invalidCaptureInput(`${field} cannot override recorder-owned field ${key}.`);
    }
  }
  validateJsonValue(extensions, field, new Set());
}

function validateIdentifiers(
  identifiers: readonly IdentifierCapture[] | undefined,
  field: string,
): void {
  if (identifiers === undefined) return;
  for (const [index, identifier] of identifiers.entries()) {
    validateIri(identifier?.propertyId, `${field}/${index}/propertyId`);
    nonEmptyString(identifier?.value, `${field}/${index}/value`);
  }
}

function validateOrigin(origin: CaptureOrigin, field: string): void {
  if (!origin || typeof origin !== "object") {
    invalidCaptureInput(`${field} is required.`);
  }
  switch (origin.kind) {
    case "producer-observed":
      validateIri(origin.observer, `${field}/observer`);
      break;
    case "executor-reported":
      validateIri(origin.reporter, `${field}/reporter`);
      validateIri(origin.capturedBy, `${field}/capturedBy`);
      break;
    case "external-observed":
      validateIri(origin.observer, `${field}/observer`);
      validateIri(origin.capturedBy, `${field}/capturedBy`);
      break;
    default:
      invalidCaptureInput(`${field}/kind is invalid.`);
  }
}

function validateSource(source: ArtifactSource, field: string): void {
  if (!source || typeof source !== "object") {
    invalidCaptureInput(`${field} is required.`);
  }
  const hasBytes = source.bytes instanceof Uint8Array;
  const hasPath = typeof source.path === "string";
  if (hasBytes === hasPath) {
    invalidCaptureInput(`${field} must provide exactly one of bytes or path.`);
  }
  if (hasPath && source.path.trim().length === 0) {
    invalidCaptureInput(`${field}/path must be non-empty.`);
  }
  nonEmptyString(source.mediaType, `${field}/mediaType`);
  if (source.name !== undefined) {
    nonEmptyString(source.name, `${field}/name`);
  }
}

function validateAdditionalTypes(
  types: readonly string[] | undefined,
  field: string,
): void {
  if (types === undefined) return;
  const seen = new Set<string>();
  for (const [index, type] of types.entries()) {
    nonEmptyString(type, `${field}/${index}`);
    if (seen.has(type)) {
      invalidCaptureInput(`${field} contains duplicate type ${type}.`);
    }
    seen.add(type);
  }
}

function validateArtifact(
  artifact: ArtifactCapture,
  field: string,
  entityIds: Set<string>,
  ancestors: Set<object>,
): void {
  if (!artifact || typeof artifact !== "object") {
    invalidCaptureInput(`${field} is required.`);
  }
  if (ancestors.has(artifact)) {
    invalidCaptureInput(`${field} contains an aggregate cycle.`);
  }
  validateEntityId(artifact.entityId, `${field}/entityId`);
  if (entityIds.has(artifact.entityId)) {
    invalidCaptureInput(
      `${field}/entityId duplicates another artifact entity id.`,
      artifact.entityId,
    );
  }
  entityIds.add(artifact.entityId);
  validateOrigin(artifact.origin, `${field}/origin`);
  validateAdditionalTypes(artifact.additionalTypes, `${field}/additionalTypes`);
  validateIdentifiers(artifact.identifiers, `${field}/identifiers`);
  validateExtensions(artifact.extensions, `${field}/extensions`);

  if (artifact.kind === "file") {
    validateSource(artifact.source, `${field}/source`);
    return;
  }
  if (artifact.kind !== "dataset" && artifact.kind !== "collection") {
    invalidCaptureInput(`${field}/kind is invalid.`);
  }
  validateSource(artifact.manifest, `${field}/manifest`);
  if (!Array.isArray(artifact.members) || artifact.members.length === 0) {
    invalidCaptureInput(`${field}/members must be non-empty.`);
  }
  ancestors.add(artifact);
  artifact.members.forEach((member, index) =>
    validateArtifact(
      member,
      `${field}/members/${index}`,
      entityIds,
      ancestors,
    ),
  );
  ancestors.delete(artifact);
}

function validateAgent(agent: AgentCapture, field: string): void {
  if (!agent || typeof agent !== "object") {
    invalidCaptureInput(`${field} is required.`);
  }
  validateIri(agent.entityId, `${field}/entityId`);
  if (!["person", "organization", "software"].includes(agent.kind)) {
    invalidCaptureInput(`${field}/kind is invalid.`);
  }
  nonEmptyString(agent.name, `${field}/name`);
  if (agent.softwareVersion !== undefined) {
    nonEmptyString(agent.softwareVersion, `${field}/softwareVersion`);
  }
  validateIdentifiers(agent.identifiers, `${field}/identifiers`);
  validateOrigin(agent.origin, `${field}/origin`);
  validateExtensions(agent.extensions, `${field}/extensions`);
}

function validateOpaqueComponent(
  component: OpaqueRuntimeComponentCapture,
  field: string,
  entityIds: Set<string>,
): void {
  if (!component || component.kind !== "opaque") {
    invalidCaptureInput(`${field}/kind must be opaque.`);
  }
  if (
    !component.descriptor ||
    typeof component.descriptor !== "object" ||
    component.descriptor.kind !== "file"
  ) {
    invalidCaptureInput(`${field}/descriptor must be a file artifact.`);
  }
  validateArtifact(
    component.descriptor,
    `${field}/descriptor`,
    entityIds,
    new Set(),
  );
  validateIri(component.component?.entityId, `${field}/component/entityId`);
  nonEmptyString(component.component?.name, `${field}/component/name`);
  if (component.component.softwareVersion !== undefined) {
    nonEmptyString(
      component.component.softwareVersion,
      `${field}/component/softwareVersion`,
    );
  }
  if (component.component.provider !== undefined) {
    validateIri(component.component.provider, `${field}/component/provider`);
  }
  validateExtensions(
    component.component.extensions,
    `${field}/component/extensions`,
  );
}

export function validateRuntimeObservationCapture(
  observation: RuntimeObservationCapture,
): void {
  const entityIds = new Set<string>();
  if (!observation || typeof observation !== "object") {
    invalidCaptureInput("runtime observation is required.");
  }
  if (observation.kind === "resource") {
    validateEntityId(observation.entityId, "runtimeObservation/entityId");
    nonEmptyString(observation.name, "runtimeObservation/name");
    if (
      !["string", "number", "boolean"].includes(typeof observation.value) ||
      (typeof observation.value === "number" &&
        !Number.isFinite(observation.value))
    ) {
      invalidCaptureInput("runtimeObservation/value is invalid.");
    }
    if (observation.propertyId !== undefined) {
      validateIri(
        observation.propertyId,
        "runtimeObservation/propertyId",
      );
    }
    if (observation.unitCode !== undefined) {
      nonEmptyString(observation.unitCode, "runtimeObservation/unitCode");
    }
    if (observation.unitText !== undefined) {
      nonEmptyString(observation.unitText, "runtimeObservation/unitText");
    }
    validateOrigin(observation.origin, "runtimeObservation/origin");
    validateExtensions(
      observation.extensions,
      "runtimeObservation/extensions",
    );
    return;
  }
  if (observation.kind === "environment") {
    validateArtifact(
      observation.artifact,
      "runtimeObservation/artifact",
      entityIds,
      new Set(),
    );
    return;
  }
  if (observation.kind === "opaque-component") {
    validateOpaqueComponent(
      observation.component,
      "runtimeObservation/component",
      entityIds,
    );
    return;
  }
  invalidCaptureInput("runtimeObservation/kind is invalid.");
}

export function validateNativeTraceCapture(trace: NativeTraceCapture): void {
  if (!trace || typeof trace !== "object") {
    invalidCaptureInput("nativeTrace is required.");
  }
  validateArtifact(
    trace.artifact,
    "nativeTrace/artifact",
    new Set(),
    new Set(),
  );
  validateIri(trace.format?.entityId, "nativeTrace/format/entityId");
  if (trace.format.name !== undefined) {
    nonEmptyString(trace.format.name, "nativeTrace/format/name");
  }
}

export function validateStartExecutionRecordingInput(
  input: StartExecutionRecordingInput,
): void {
  if (!input || typeof input !== "object") {
    invalidCaptureInput("start input is required.");
  }
  nonEmptyString(input.workspaceDir, "workspaceDir");
  if (input.executionId !== undefined && !EXECUTION_ID.test(input.executionId)) {
    invalidCaptureInput("executionId must be a valid urn:uuid IRI.");
  }
  if (!isStrictRfc3339(input.startedAt)) {
    invalidCaptureInput("startedAt must be a valid RFC 3339 timestamp.");
  }

  nonEmptyString(input.record?.name, "record/name");
  nonEmptyString(input.record?.description, "record/description");
  validateIri(input.record?.license, "record/license");
  if (input.record.executionName !== undefined) {
    nonEmptyString(input.record.executionName, "record/executionName");
  }
  validateIdentifiers(
    input.record.executionIdentifiers,
    "record/executionIdentifiers",
  );
  validateExtensions(
    input.record.documentExtensions,
    "record/documentExtensions",
  );
  validateExtensions(input.record.rootExtensions, "record/rootExtensions");
  validateExtensions(
    input.record.executionExtensions,
    "record/executionExtensions",
  );

  const entityIds = new Set<string>();
  validateEntityId(input.task?.entityId, "task/entityId");
  entityIds.add(input.task.entityId);
  nonEmptyString(input.task.name, "task/name");
  validateSource(input.task.source, "task/source");
  validateOrigin(input.task.origin, "task/origin");
  validateIdentifiers(input.task.identifiers, "task/identifiers");
  validateExtensions(input.task.extensions, "task/extensions");

  for (const [index, artifact] of (input.initialInputs ?? []).entries()) {
    validateArtifact(
      artifact,
      `initialInputs/${index}`,
      entityIds,
      new Set(),
    );
  }

  if (input.repositoryState !== undefined) {
    validateArtifact(
      input.repositoryState.artifact,
      "repositoryState/artifact",
      entityIds,
      new Set(),
    );
    validateIdentifiers(
      input.repositoryState.identifiers,
      "repositoryState/identifiers",
    );
    if (input.repositoryState.repository !== undefined) {
      validateIri(
        input.repositoryState.repository,
        "repositoryState/repository",
      );
    }
    validateExtensions(
      input.repositoryState.extensions,
      "repositoryState/extensions",
    );
  }

  validateAgent(input.executor, "executor");
  validateAgent(input.producer, "producer");

  validateEntityId(input.runtime?.entityId, "runtime/entityId");
  if (entityIds.has(input.runtime.entityId)) {
    invalidCaptureInput(
      "runtime/entityId duplicates another artifact entity id.",
      input.runtime.entityId,
    );
  }
  entityIds.add(input.runtime.entityId);
  validateSource(input.runtime.specification, "runtime/specification");
  nonEmptyString(input.runtime.name, "runtime/name");
  if (input.runtime.softwareVersion !== undefined) {
    nonEmptyString(input.runtime.softwareVersion, "runtime/softwareVersion");
  }
  validateOrigin(input.runtime.origin, "runtime/origin");
  validateExtensions(input.runtime.extensions, "runtime/extensions");
  if (
    !Array.isArray(input.runtime.components) ||
    input.runtime.components.length === 0
  ) {
    invalidCaptureInput("runtime/components must be non-empty.");
  }
  input.runtime.components.forEach((component, index) => {
    if (component.kind === "controlled") {
      validateArtifact(
        component.artifact,
        `runtime/components/${index}/artifact`,
        entityIds,
        new Set(),
      );
    } else if (component.kind === "opaque") {
      validateOpaqueComponent(
        component,
        `runtime/components/${index}`,
        entityIds,
      );
    } else {
      invalidCaptureInput(`runtime/components/${index}/kind is invalid.`);
    }
  });
}

export function validateFinalizeExecutionInput(
  input: FinalizeExecutionInput,
  startedAt: string,
): void {
  if (!input || typeof input !== "object") {
    invalidCaptureInput("finalize input is required.");
  }
  if (!["completed", "failed", "abandoned"].includes(input.outcome)) {
    invalidCaptureInput("outcome is invalid.");
  }
  if (!isStrictRfc3339(input.endedAt)) {
    invalidCaptureInput("endedAt must be a valid RFC 3339 timestamp.");
  }
  if (
    !isStrictRfc3339(startedAt) ||
    Date.parse(input.endedAt) < Date.parse(startedAt)
  ) {
    invalidCaptureInput("endedAt must not precede startedAt.");
  }
  const entityIds = new Set<string>();
  for (const [index, result] of (input.results ?? []).entries()) {
    validateArtifact(result, `results/${index}`, entityIds, new Set());
  }
  if (input.nativeTrace !== undefined) {
    validateNativeTraceCapture(input.nativeTrace);
    const traceIds = new Set<string>();
    const collect = (artifact: ArtifactCapture): void => {
      traceIds.add(artifact.entityId);
      if (artifact.kind !== "file") artifact.members.forEach(collect);
    };
    collect(input.nativeTrace.artifact);
    for (const id of traceIds) {
      if (entityIds.has(id)) {
        invalidCaptureInput(
          "nativeTrace contains an entity id already used by a Result.",
          id,
        );
      }
    }
  }
}

export function validateAggregateArtifactCapture(
  aggregate: AggregateArtifactCapture,
): void {
  validateArtifact(aggregate, "aggregate", new Set(), new Set());
}
