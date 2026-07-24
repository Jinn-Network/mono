// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import { describe, expect, test } from "vitest";

import {
  describeExecutionProducerContract,
  type ExecutionProducerContractDriver,
  type ExecutionProducerContractFinalizedObservation,
  type ExecutionProducerContractScenario,
  type InterruptedFinalizationExecutionProducerContractObservation,
} from "./testing.js";
import type {
  ExecutionId,
  FinalizedExecutionReceipt,
} from "./types.js";

const fixtureUrl = (name: string) =>
  new URL(`../fixtures/producer-contract-v1/${name}`, import.meta.url);

const scenarioFixtures = {
  completed: {
    record: "completed.json",
    executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
    result: true,
  },
  failed: {
    record: "failed.json",
    executionId: "urn:uuid:22222222-2222-4222-8222-222222222222",
    result: false,
  },
  abandoned: {
    record: "abandoned.json",
    executionId: "urn:uuid:33333333-3333-4333-8333-333333333333",
    result: false,
  },
  "interrupted-finalization": {
    record: "completed.json",
    executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
    result: true,
  },
} as const satisfies Record<
  ExecutionProducerContractScenario,
  {
    readonly record: string;
    readonly executionId: ExecutionId;
    readonly result: boolean;
  }
>;

async function literalFixtureDriver(): Promise<ExecutionProducerContractDriver> {
  const taskBytes = await readFile(fixtureUrl("task.md"));
  const traceBytes = await readFile(fixtureUrl("trace.jsonl"));
  const resultBytes = await readFile(fixtureUrl("result.txt"));
  const runtimeBytes = await readFile(fixtureUrl("runtime.json"));
  const runnerBytes = await readFile(fixtureUrl("runner.mjs"));
  let interruptedRepository: InMemoryEvidenceRepository | undefined;
  let interruptedArtifactReferences:
    | FinalizedExecutionReceipt["artifacts"]
    | undefined;
  let interruptedRecordBytes: Uint8Array | undefined;

  return {
    async run(
      scenario,
    ): Promise<ExecutionProducerContractFinalizedObservation> {
      const fixture = scenarioFixtures[scenario];
      const repository = new InMemoryEvidenceRepository();
      const artifactReceipts = await Promise.all(
        [
          taskBytes,
          traceBytes,
          runtimeBytes,
          runnerBytes,
          ...(fixture.result ? [resultBytes] : []),
        ].map((bytes) => repository.putArtifact(bytes)),
      );
      const recordBytes = await readFile(fixtureUrl(fixture.record));
      const recordReceipt = await repository.putRecord(
        "execution-evidence",
        recordBytes,
      );
      const receipt: FinalizedExecutionReceipt = {
        executionId: fixture.executionId,
        record: recordReceipt.reference,
        artifacts: artifactReceipts.map(({ reference }) => reference),
        finalizedAt: "2026-07-24T10:00:02Z",
      };
      const common = {
        scenario,
        executionId: fixture.executionId,
        workspaceDir: `/tmp/producer-contract/${scenario}`,
        captureStartedAt: "2026-07-24T09:59:59.900Z",
        executorStartedAt: "2026-07-24T10:00:00Z",
        repository,
        receipt,
        expectedTaskBytes: taskBytes,
        expectedTraceBytes: traceBytes,
      };

      if (scenario === "completed") {
        return {
          ...common,
          scenario,
          expectedResultBytes: resultBytes,
        };
      }
      return {
        ...common,
        scenario,
      };
    },
    async runUntilFinalizationInterrupted(
      interruptFinalization,
    ): Promise<never> {
      const fixture = scenarioFixtures["interrupted-finalization"];
      interruptedRepository = new InMemoryEvidenceRepository();
      const artifactReceipts = await Promise.all(
        [
          taskBytes,
          traceBytes,
          runtimeBytes,
          runnerBytes,
          resultBytes,
        ].map((bytes) => interruptedRepository!.putArtifact(bytes)),
      );
      interruptedArtifactReferences = artifactReceipts.map(
        ({ reference }) => reference,
      );
      interruptedRecordBytes = await readFile(fixtureUrl(fixture.record));

      return interruptFinalization();
    },
    async recoverFinalization(): Promise<InterruptedFinalizationExecutionProducerContractObservation> {
      const fixture = scenarioFixtures["interrupted-finalization"];
      if (
        interruptedRepository === undefined ||
        interruptedArtifactReferences === undefined ||
        interruptedRecordBytes === undefined
      ) {
        throw new Error("No interrupted finalization is available to recover");
      }
      const recordReceipt = await interruptedRepository.putRecord(
        "execution-evidence",
        interruptedRecordBytes,
      );
      const receipt: FinalizedExecutionReceipt = {
        executionId: fixture.executionId,
        record: recordReceipt.reference,
        artifacts: interruptedArtifactReferences,
        finalizedAt: "2026-07-24T10:00:02Z",
      };

      return {
        scenario: "interrupted-finalization",
        executionId: fixture.executionId,
        workspaceDir: "/tmp/producer-contract/interrupted-finalization",
        captureStartedAt: "2026-07-24T09:59:59.900Z",
        executorStartedAt: "2026-07-24T10:00:00Z",
        repository: interruptedRepository,
        receipt,
        expectedTaskBytes: taskBytes,
        expectedTraceBytes: traceBytes,
        expectedResultBytes: resultBytes,
      };
    },
  };
}

describe("producer contract v1 literal fixtures", () => {
  test.each([
    [
      "task.md",
      "e45052641fe323b2d3af30b66faedfa5639fbaefc5f98bcf30c6d39181ba24ae",
    ],
    [
      "trace.jsonl",
      "5caabae431fd2b3d56a6faf789eb8f0c0de610f2308a964601bed1f6c0764e33",
    ],
    [
      "result.txt",
      "ccaa8c827989d0748102c5482c782eab9cf335b79de0b0b35cbf2c99be9782fd",
    ],
    [
      "runtime.json",
      "dc29d5930386817582122b1662c5daaa1c0ea8235ebca22e869e9e20b9483477",
    ],
    [
      "runner.mjs",
      "3d15502b22e80a2944f9a82768005a8b01a54f5a204f300d797f45dd9f1ae75d",
    ],
  ])("binds %s to its independently checked SHA-256", async (name, digest) => {
    const bytes = await readFile(fixtureUrl(name));

    expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
  });
});

describeExecutionProducerContract(literalFixtureDriver);
