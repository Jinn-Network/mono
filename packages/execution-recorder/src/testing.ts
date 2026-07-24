// SPDX-License-Identifier: Apache-2.0

import type {
  EvidenceRepository,
} from "@jinn-network/evidence-repository";
import {
  validateExecutionEvidence,
  type ExecutionEvidenceDocument,
} from "@jinn-network/evidence-protocol";
import {
  describe,
  expect,
  test,
} from "vitest";

import type {
  ExecutionId,
  FinalizedExecutionReceipt,
} from "./types.js";

export type CompletedExecutionProducerContractScenario = "completed";
export type FailedExecutionProducerContractScenario = "failed";
export type AbandonedExecutionProducerContractScenario = "abandoned";
export type InterruptedFinalizationExecutionProducerContractScenario =
  "interrupted-finalization";

export type ExecutionProducerContractScenario =
  | CompletedExecutionProducerContractScenario
  | FailedExecutionProducerContractScenario
  | AbandonedExecutionProducerContractScenario
  | InterruptedFinalizationExecutionProducerContractScenario;

export interface ExecutionProducerContractResult {
  readonly repository: EvidenceRepository;
  readonly receipt: FinalizedExecutionReceipt;
}

interface ExecutionProducerContractObservationBase
  extends ExecutionProducerContractResult {
  readonly scenario: ExecutionProducerContractScenario;
  readonly executionId: ExecutionId;
  readonly workspaceDir: string;
  readonly captureStartedAt: string;
  readonly executorStartedAt: string;
  readonly expectedTaskBytes: Uint8Array;
  readonly expectedTraceBytes: Uint8Array;
  readonly cleanup?: () => Promise<void> | void;
}

export interface CompletedExecutionProducerContractObservation
  extends ExecutionProducerContractObservationBase {
  readonly scenario: CompletedExecutionProducerContractScenario;
  readonly expectedResultBytes: Uint8Array;
}

export interface FailedExecutionProducerContractObservation
  extends ExecutionProducerContractObservationBase {
  readonly scenario: FailedExecutionProducerContractScenario;
  readonly expectedResultBytes?: Uint8Array;
}

export interface AbandonedExecutionProducerContractObservation
  extends ExecutionProducerContractObservationBase {
  readonly scenario: AbandonedExecutionProducerContractScenario;
  readonly expectedResultBytes?: Uint8Array;
}

export interface InterruptedFinalizationRecoveryObservation {
  readonly finalizationInterrupted: true;
  readonly resumedFromWorkspace: true;
  readonly receipt: FinalizedExecutionReceipt;
}

export interface InterruptedFinalizationExecutionProducerContractObservation
  extends ExecutionProducerContractObservationBase {
  readonly scenario: InterruptedFinalizationExecutionProducerContractScenario;
  readonly expectedResultBytes: Uint8Array;
  readonly recovery: InterruptedFinalizationRecoveryObservation;
}

export type ExecutionProducerContractObservation =
  | CompletedExecutionProducerContractObservation
  | FailedExecutionProducerContractObservation
  | AbandonedExecutionProducerContractObservation
  | InterruptedFinalizationExecutionProducerContractObservation;

export interface ExecutionProducerContractDriver {
  run(
    scenario: ExecutionProducerContractScenario,
  ): Promise<ExecutionProducerContractObservation>;
}

export type ExecutionProducerContractDriverFactory = () =>
  | ExecutionProducerContractDriver
  | Promise<ExecutionProducerContractDriver>;

type GraphEntity = ExecutionEvidenceDocument["@graph"][number];

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
  expect(entity.sha256).toMatch(/^[a-f0-9]{64}$/);
  return {
    digest: `sha256:${String(entity.sha256)}`,
  };
}

async function retrieveArtifact(
  observation: ExecutionProducerContractObservation,
  entity: GraphEntity,
): Promise<Uint8Array> {
  const bytes = await observation.repository.getArtifact(
    artifactReference(entity),
  );
  expect(bytes, `missing artifact bytes for ${entity["@id"]}`).not.toBeNull();
  if (bytes === null) {
    throw new Error(`Missing artifact bytes for ${entity["@id"]}`);
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

async function verifyObservation(
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

  const report = validateExecutionEvidence(recordBytes);
  expect(
    report.conforms,
    JSON.stringify(report.diagnostics, null, 2),
  ).toBe(true);
  expect(report.value).toBeDefined();
  if (report.value === undefined) {
    throw new Error("Conforming evidence did not include a parsed document");
  }

  const root = entityById(report.value, "./");
  expect(root).toBeDefined();
  if (root === undefined) throw new Error("Missing root Dataset");

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
    await retrieveArtifact(observation, tasks[0]!),
    observation.expectedTaskBytes,
  );

  const traceIds = references(execution.subjectOf);
  expect(traceIds).toHaveLength(1);
  const trace = entityById(report.value, traceIds[0]!);
  expect(trace).toBeDefined();
  if (trace === undefined) throw new Error("Missing selected native trace");
  expectExactBytes(
    await retrieveArtifact(observation, trace),
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
        return retrieveArtifact(observation, result);
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

  if (observation.scenario === "interrupted-finalization") {
    expect(observation.recovery).toMatchObject({
      finalizationInterrupted: true,
      resumedFromWorkspace: true,
      receipt: observation.receipt,
    });
    const recoveredRecordBytes = await observation.repository.getRecord(
      observation.recovery.receipt.record,
    );
    expect(
      recoveredRecordBytes,
      "recovery receipt did not resolve after producer recovery",
    ).not.toBeNull();
    if (recoveredRecordBytes === null) {
      throw new Error("Recovery receipt did not resolve after producer recovery");
    }
    expectExactBytes(recoveredRecordBytes, recordBytes);
  }
}

export function describeExecutionProducerContract(
  driverFactory: ExecutionProducerContractDriverFactory,
): void {
  describe("ExecutionProducerContract", () => {
    test.each<ExecutionProducerContractScenario>([
      "completed",
      "failed",
      "abandoned",
      "interrupted-finalization",
    ])("satisfies the %s scenario", async (scenario) => {
      const driver = await driverFactory();
      const observation = await driver.run(scenario);
      try {
        await verifyObservation(scenario, observation);
      } finally {
        await observation.cleanup?.();
      }
    });
  });
}
