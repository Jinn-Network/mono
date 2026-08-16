// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";

import {
  EvidenceCatalogError,
  InMemoryEvidenceCatalog,
  type CatalogRecordProjection,
  type EvidenceRecordFamily,
  type EvidenceRecordReference,
  type JsonValue,
  type RecordLocationObservation,
  type RecordLocationWithdrawal,
  type Sha256Digest,
} from "@jinn-network/evidence-discovery";

export interface ProjectionRows {
  readonly record: {
    readonly family: EvidenceRecordFamily;
    readonly digest: Sha256Digest;
    readonly byteSize: number;
    readonly projectionJson: string;
    readonly projectionHash: string;
  };
  readonly entityIds: readonly string[];
  readonly familyRow: Readonly<Record<string, string | number>>;
  readonly resultRows: readonly Readonly<Record<string, string | number>>[];
  readonly identifierRows: readonly Readonly<Record<string, string | number>>[];
}

function invalid(message: string): never {
  throw new EvidenceCatalogError("INVALID_PROJECTION", message);
}

function canonicalValue(
  value: unknown,
  path: string,
  ancestors = new WeakSet<object>(),
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      invalid(`${path} must contain finite JSON values.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      invalid(`${path} must contain only standard JSON arrays.`);
    }
    if (ancestors.has(value)) invalid(`${path} must not contain cycles.`);
    ancestors.add(value);
    if (
      Reflect.ownKeys(value).some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" &&
            (!/^(?:0|[1-9][0-9]*)$/u.test(key) ||
              Number(key) >= value.length ||
              Number(key) > 0xffff_fffe)),
      )
    ) {
      invalid(`${path} must not contain non-index array properties.`);
    }
    const accepted: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        invalid(`${path} must contain dense enumerable data-property arrays.`);
      }
      accepted.push(
        canonicalValue(descriptor.value, `${path}[${index}]`, ancestors),
      );
    }
    ancestors.delete(value);
    return accepted;
  }
  if (typeof value !== "object" || value === null) {
    return invalid(`${path} must contain only JSON values.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${path} must contain only plain JSON objects.`);
  }
  if (ancestors.has(value)) invalid(`${path} must not contain cycles.`);
  ancestors.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    invalid(`${path} must not contain symbol properties.`);
  }
  const accepted: Record<string, JsonValue> = {};
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  ).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      invalid(`${path}.${key} must be an enumerable JSON data property.`);
    }
    accepted[key] = canonicalValue(
      descriptor.value,
      `${path}.${key}`,
      ancestors,
    );
  }
  ancestors.delete(value);
  return accepted;
}

export function canonicalJsonSnapshot<T>(
  value: T,
  path = "value",
): { readonly json: string; readonly value: T } {
  const accepted = canonicalValue(value, path);
  const json = JSON.stringify(accepted);
  return { json, value: JSON.parse(json) as T };
}

export function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function nonEmpty(value: unknown, role: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${role} must be a non-empty string.`);
  }
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  role: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    invalid(`${role} contains unsupported or missing fields.`);
  }
}

export function snapshotReference(
  input: EvidenceRecordReference,
): EvidenceRecordReference {
  const { value } = canonicalJsonSnapshot(input, "reference");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("reference must be a plain JSON object.");
  }
  exactKeys(value as unknown as Record<string, unknown>, [
    "family",
    "digest",
  ], "reference");
  const { family, digest } = value;
  if (
    family !== "execution-evidence" &&
    family !== "result-evaluation" &&
    family !== "execution-verification"
  ) {
    invalid("reference.family is unsupported.");
  }
  if (
    typeof digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(digest)
  ) {
    invalid("reference.digest must be a canonical lowercase SHA-256 digest.");
  }
  return { family, digest };
}

export function snapshotLocationObservation(
  input: RecordLocationObservation,
): RecordLocationObservation {
  const { value } = canonicalJsonSnapshot(input, "observation");
  const record = value as unknown as Record<string, unknown>;
  const expected = [
    "sourceId",
    "announcementId",
    "repositoryId",
    ...(record.publishedLocation === undefined ? [] : ["publishedLocation"]),
  ];
  exactKeys(record, expected, "observation");
  nonEmpty(record.sourceId, "sourceId");
  nonEmpty(record.announcementId, "announcementId");
  nonEmpty(record.repositoryId, "repositoryId");
  if (record.publishedLocation !== undefined) {
    const published = record.publishedLocation as Record<string, unknown>;
    if (
      typeof published !== "object" ||
      published === null ||
      Array.isArray(published)
    ) {
      invalid("publishedLocation must be a plain JSON object.");
    }
    exactKeys(
      published,
      ["bindingProfile", "locator"],
      "publishedLocation",
    );
    nonEmpty(published.bindingProfile, "bindingProfile");
    try {
      new URL(published.bindingProfile);
    } catch {
      invalid("bindingProfile must be an absolute identifier.");
    }
    if (
      typeof published.locator !== "object" ||
      published.locator === null ||
      Array.isArray(published.locator)
    ) {
      invalid("locator must be a plain JSON object.");
    }
  }
  return value;
}

export function snapshotLocationWithdrawal(
  input: RecordLocationWithdrawal,
): RecordLocationWithdrawal {
  const { value } = canonicalJsonSnapshot(input, "withdrawal");
  const record = value as unknown as Record<string, unknown>;
  exactKeys(
    record,
    ["sourceId", "announcementId", "retractsAnnouncementId"],
    "withdrawal",
  );
  nonEmpty(record.sourceId, "sourceId");
  nonEmpty(record.announcementId, "announcementId");
  nonEmpty(record.retractsAnnouncementId, "retractsAnnouncementId");
  return value;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    invalid("Projection timestamp is invalid.");
  }
  return milliseconds;
}

function projectionEntityIds(
  projection: CatalogRecordProjection,
): readonly string[] {
  const ids = new Set(
    projection.declaredEntities.map(({ entityId }) => entityId),
  );
  if (projection.family === "execution-evidence") {
    for (const id of [
      projection.executionId,
      projection.task.entityId,
      projection.executorId,
      projection.runtime.entityId,
      projection.nativeTrace.entityId,
      ...projection.results.map(({ entityId }) => entityId),
    ]) {
      ids.add(id);
    }
  } else if (projection.family === "result-evaluation") {
    ids.add(projection.evaluatorId);
    for (const subject of [
      projection.taskSubject,
      ...projection.resultSubjects,
    ]) {
      if (subject.uri !== undefined) ids.add(subject.uri);
    }
  } else {
    ids.add(projection.verifierId);
    ids.add(projection.executionId);
  }
  return [...ids].sort();
}

export async function buildProjectionRows(
  input: CatalogRecordProjection,
): Promise<ProjectionRows> {
  const { json: projectionJson, value: projection } =
    canonicalJsonSnapshot(input, "projection");
  const validator = new InMemoryEvidenceCatalog();
  await validator.putRecordProjection(projection);
  const family = projection.family;
  const digest = projection.reference.digest;

  if (family === "execution-evidence") {
    return {
      record: {
        family,
        digest,
        byteSize: projection.byteSize,
        projectionJson,
        projectionHash: sha256Text(projectionJson),
      },
      entityIds: projectionEntityIds(projection),
      familyRow: {
        family,
        digest,
        executionId: projection.executionId,
        taskId: projection.task.entityId,
        taskDigest: projection.task.digest,
        executorId: projection.executorId,
        runtimeId: projection.runtime.entityId,
        runtimeDigest: projection.runtime.digest,
        outcome: projection.outcome,
        startedMs: timestamp(projection.startedAt),
        endedMs: timestamp(projection.endedAt),
        publishedMs: timestamp(projection.publishedAt),
      },
      resultRows: projection.results.map((result, ordinal) => ({
        family,
        digest,
        ordinal,
        resultId: result.entityId,
        resultDigest: result.digest,
      })),
      identifierRows: (projection.identifiers ?? []).map((identifier, ordinal) => ({
        family,
        digest,
        ordinal,
        entityId: identifier.entityId,
        scheme: identifier.scheme,
        value: identifier.value,
      })),
    };
  }

  if (family === "result-evaluation") {
    return {
      record: {
        family,
        digest,
        byteSize: projection.byteSize,
        projectionJson,
        projectionHash: sha256Text(projectionJson),
      },
      entityIds: projectionEntityIds(projection),
      familyRow: {
        family,
        digest,
        taskDigest: projection.taskSubject.digest,
        evaluatorId: projection.evaluatorId,
        verdict: projection.verdict,
        evaluatedMs: timestamp(projection.evaluatedAt),
      },
      resultRows: projection.resultSubjects.map((result, ordinal) => ({
        family,
        digest,
        ordinal,
        resultDigest: result.digest,
      })),
      identifierRows: [],
    };
  }

  return {
    record: {
      family,
      digest,
      byteSize: projection.byteSize,
      projectionJson,
      projectionHash: sha256Text(projectionJson),
    },
    entityIds: projectionEntityIds(projection),
    familyRow: {
      family,
      digest,
      executionId: projection.executionId,
      subjectRecordDigest: projection.subjectRecord.digest,
      verifierId: projection.verifierId,
      verdict: projection.verdict,
      verifiedMs: timestamp(projection.verifiedAt),
    },
    resultRows: [],
    identifierRows: [],
  };
}
