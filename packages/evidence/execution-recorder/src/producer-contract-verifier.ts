// SPDX-License-Identifier: Apache-2.0

import {
  createArtifactReference,
  createRecordReference,
} from "@jinn-network/evidence-repository";
import {
  validateExecutionEvidence,
  type ExecutionEvidenceDocument,
} from "@jinn-network/evidence-protocol";
import { expect } from "vitest";

import type {
  ExecutionProducerContractObservation,
  ExecutionProducerContractScenario,
} from "./testing.js";
import { isStrictRfc3339 } from "./validate-input.js";

type GraphEntity = ExecutionEvidenceDocument["@graph"][number];

const SHA256 = /^[a-f0-9]{64}$/;

function values(value: unknown): readonly unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function references(value: unknown): readonly string[] {
  return values(value)
    .map((candidate) => {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        !("@id" in candidate) ||
        typeof candidate["@id"] !== "string"
      ) {
        return undefined;
      }
      return candidate["@id"];
    })
    .filter((candidate): candidate is string => candidate !== undefined);
}

function entityTypes(entity: GraphEntity): readonly string[] {
  return Array.isArray(entity["@type"])
    ? entity["@type"]
    : [entity["@type"]];
}

function entityById(
  document: ExecutionEvidenceDocument,
  id: string,
): GraphEntity | undefined {
  return document["@graph"].find((candidate) => candidate["@id"] === id);
}

function artifactReference(entity: GraphEntity): {
  readonly digest: `sha256:${string}`;
} {
  expect(entity.sha256).toMatch(SHA256);
  return {
    digest: `sha256:${String(entity.sha256)}`,
  };
}

function byteBearingEntities(
  document: ExecutionEvidenceDocument,
): readonly GraphEntity[] {
  return document["@graph"]
    .filter(
      (entity) =>
        typeof entity.sha256 === "string" && SHA256.test(entity.sha256),
    )
    .sort((left, right) => left["@id"].localeCompare(right["@id"]));
}

async function retrieveAllArtifacts(
  observation: ExecutionProducerContractObservation,
  entities: readonly GraphEntity[],
): Promise<ReadonlyMap<string, Uint8Array>> {
  const retrieved = new Map<string, Uint8Array>();
  for (const entity of entities) {
    const reference = artifactReference(entity);
    const bytes = await observation.repository.getArtifact(reference);
    expect(bytes, `missing artifact bytes for ${entity["@id"]}`).not.toBeNull();
    if (bytes === null) {
      throw new Error(`Missing artifact bytes for ${entity["@id"]}`);
    }
    expect(
      createArtifactReference(bytes),
      `artifact bytes do not match the evidence metadata digest for ${entity["@id"]}`,
    ).toEqual(reference);
    retrieved.set(entity["@id"], bytes);
  }
  return retrieved;
}

function retrievedArtifact(
  artifacts: ReadonlyMap<string, Uint8Array>,
  entity: GraphEntity,
): Uint8Array {
  const bytes = artifacts.get(entity["@id"]);
  if (bytes === undefined) {
    throw new Error(`Artifact ${entity["@id"]} was not retrieved`);
  }
  return bytes;
}

function expectExactBytes(
  actual: Uint8Array,
  expected: Uint8Array,
): void {
  expect(Array.from(actual)).toEqual(Array.from(expected));
}

function expectedStatus(
  scenario: ExecutionProducerContractScenario,
): string {
  switch (scenario) {
    case "completed":
    case "interrupted-finalization":
      return "https://schema.org/CompletedActionStatus";
    case "failed":
      return "https://schema.org/FailedActionStatus";
    case "abandoned":
      return "https://jinn.network/terms/AbandonedActionStatus";
  }
}

export async function verifyExecutionProducerContractObservation(
  requestedScenario: ExecutionProducerContractScenario,
  observation: ExecutionProducerContractObservation,
): Promise<void> {
  expect(observation.scenario).toBe(requestedScenario);

  const captureStartedAt = Date.parse(observation.captureStartedAt);
  const executorStartedAt = Date.parse(observation.executorStartedAt);
  expect(Number.isFinite(captureStartedAt)).toBe(true);
  expect(Number.isFinite(executorStartedAt)).toBe(true);
  expect(captureStartedAt).toBeLessThanOrEqual(executorStartedAt);

  expect(observation.receipt.record.family).toBe("execution-evidence");
  const recordBytes = await observation.repository.getRecord(
    observation.receipt.record,
  );
  expect(recordBytes, "finalized evidence record was not durable").not.toBeNull();
  if (recordBytes === null) {
    throw new Error("Finalized evidence record was not durable");
  }
  expect(
    createRecordReference("execution-evidence", recordBytes),
    "record reference does not match the retrieved exact bytes",
  ).toEqual(observation.receipt.record);

  const report = validateExecutionEvidence(recordBytes);
  expect(
    report.conforms,
    JSON.stringify(report.diagnostics, null, 2),
  ).toBe(true);
  expect(report.value).toBeDefined();
  if (report.value === undefined) {
    throw new Error("Conforming evidence did not include a parsed document");
  }

  const artifactEntities = byteBearingEntities(report.value);
  const metadataArtifactDigests = [
    ...new Set(
      artifactEntities.map((entity) => artifactReference(entity).digest),
    ),
  ].sort();
  expect(
    observation.receipt.artifacts.map(({ digest }) => digest),
    "receipt artifacts do not exactly match the evidence metadata",
  ).toEqual(metadataArtifactDigests);
  const retrievedArtifacts = await retrieveAllArtifacts(
    observation,
    artifactEntities,
  );

  const root = entityById(report.value, "./");
  expect(root).toBeDefined();
  if (root === undefined) throw new Error("Missing root Dataset");

  expect(
    isStrictRfc3339(observation.receipt.finalizedAt),
    "receipt finalization time is not strict RFC 3339",
  ).toBe(true);
  expect(
    root.datePublished,
    "receipt finalization time does not match the evidence metadata",
  ).toBe(observation.receipt.finalizedAt);

  const captureIds = references(root["prov:wasGeneratedBy"]);
  expect(
    captureIds,
    "evidence metadata does not identify one capture activity",
  ).toHaveLength(1);
  const capture = entityById(report.value, captureIds[0]!);
  expect(capture, "evidence metadata capture activity is missing").toBeDefined();
  if (capture === undefined) throw new Error("Missing capture Activity");
  expect(entityTypes(capture)).toContain("prov:Activity");
  expect(
    capture.endTime,
    "receipt finalization time does not match the capture completion time",
  ).toBe(observation.receipt.finalizedAt);

  const executionIds = references(root.mentions);
  expect(executionIds).toHaveLength(1);
  expect(executionIds[0]).toBe(observation.receipt.executionId);
  expect(observation.executionId).toBe(observation.receipt.executionId);

  const execution = entityById(
    report.value,
    observation.receipt.executionId,
  );
  expect(execution).toBeDefined();
  if (execution === undefined) throw new Error("Missing primary Execution");
  expect(entityTypes(execution)).toEqual(
    expect.arrayContaining(["CreateAction", "prov:Activity"]),
  );
  expect(references(execution.actionStatus)).toEqual([
    expectedStatus(observation.scenario),
  ]);

  const taskIds = references(execution.object);
  const tasks = taskIds
    .map((id) => entityById(report.value!, id))
    .filter(
      (entity): entity is GraphEntity =>
        entity !== undefined && entityTypes(entity).includes("prov:Plan"),
    );
  expect(tasks).toHaveLength(1);
  expectExactBytes(
    retrievedArtifact(retrievedArtifacts, tasks[0]!),
    observation.expectedTaskBytes,
  );

  const traceIds = references(execution.subjectOf);
  expect(traceIds).toHaveLength(1);
  const trace = entityById(report.value, traceIds[0]!);
  expect(trace).toBeDefined();
  if (trace === undefined) throw new Error("Missing selected native trace");
  expectExactBytes(
    retrievedArtifact(retrievedArtifacts, trace),
    observation.expectedTraceBytes,
  );

  if (
    observation.scenario === "completed" ||
    observation.scenario === "interrupted-finalization"
  ) {
    const resultIds = references(execution.result);
    expect(resultIds.length).toBeGreaterThan(0);
    const resultBytes = await Promise.all(
      resultIds.map(async (id) => {
        const result = entityById(report.value!, id);
        expect(result).toBeDefined();
        if (result === undefined) throw new Error(`Missing Result ${id}`);
        return retrievedArtifact(retrievedArtifacts, result);
      }),
    );
    expect(
      resultBytes.some((bytes) =>
        bytes.length === observation.expectedResultBytes.length &&
        bytes.every(
          (value, index) =>
            value === observation.expectedResultBytes[index],
        ),
      ),
    ).toBe(true);
  }
}
