// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  EvidenceRepository,
  Sha256Digest,
} from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import { describe, expect, test } from "vitest";

import { verifyExecutionProducerContractObservation } from "./producer-contract-verifier.js";
import {
  describeExecutionProducerContract,
  type CompletedExecutionProducerContractObservation,
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

const finalizedAt = "2026-07-24T10:00:02Z";

const fixtureDigests = {
  task: "sha256:e45052641fe323b2d3af30b66faedfa5639fbaefc5f98bcf30c6d39181ba24ae",
  trace:
    "sha256:5caabae431fd2b3d56a6faf789eb8f0c0de610f2308a964601bed1f6c0764e33",
  result:
    "sha256:ccaa8c827989d0748102c5482c782eab9cf335b79de0b0b35cbf2c99be9782fd",
  runtime:
    "sha256:dc29d5930386817582122b1662c5daaa1c0ea8235ebca22e869e9e20b9483477",
  runner:
    "sha256:3d15502b22e80a2944f9a82768005a8b01a54f5a204f300d797f45dd9f1ae75d",
} as const satisfies Record<string, Sha256Digest>;

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

async function fixtureRecordBytes(name: string): Promise<Uint8Array> {
  const document = JSON.parse(
    await readFile(fixtureUrl(name), "utf8"),
  ) as {
    "@graph": Array<Record<string, unknown> & { "@id": string }>;
  };
  const root = document["@graph"].find((entity) => entity["@id"] === "./");
  if (root === undefined) {
    throw new Error(`Fixture ${name} is missing its Root Dataset`);
  }
  root.datePublished = finalizedAt;
  root["prov:wasGeneratedBy"] = { "@id": "#capture" };
  document["@graph"].push({
    "@id": "#capture",
    "@type": "prov:Activity",
    name: "Execution Recorder capture and sealing",
    endTime: finalizedAt,
    agent: {
      "@id": "urn:uuid:99999999-9999-4999-8999-999999999999",
    },
  });
  return new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
}

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
      const recordBytes = await fixtureRecordBytes(fixture.record);
      const recordReceipt = await repository.putRecord(
        "execution-evidence",
        recordBytes,
      );
      const receipt: FinalizedExecutionReceipt = {
        executionId: fixture.executionId,
        record: recordReceipt.reference,
        artifacts: artifactReceipts
          .map(({ reference }) => reference)
          .sort((left, right) => left.digest.localeCompare(right.digest)),
        finalizedAt,
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
      ).sort((left, right) => left.digest.localeCompare(right.digest));
      interruptedRecordBytes = await fixtureRecordBytes(fixture.record);

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
        finalizedAt,
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

async function completedObservation(): Promise<CompletedExecutionProducerContractObservation> {
  const driver = await literalFixtureDriver();
  const observation = await driver.run("completed");
  if (observation.scenario !== "completed") {
    throw new Error("Literal completed scenario returned the wrong observation");
  }
  return observation;
}

function wrapRepository(
  repository: EvidenceRepository,
  overrides: Partial<
    Pick<EvidenceRepository, "getRecord" | "getArtifact">
  >,
): EvidenceRepository {
  return {
    capabilities: repository.capabilities,
    async putRecord(family, bytes, options) {
      return repository.putRecord(family, bytes, options);
    },
    async getRecord(reference, options) {
      return overrides.getRecord === undefined
        ? repository.getRecord(reference, options)
        : overrides.getRecord(reference, options);
    },
    async putArtifact(bytes, options) {
      return repository.putArtifact(bytes, options);
    },
    async getArtifact(reference, options) {
      return overrides.getArtifact === undefined
        ? repository.getArtifact(reference, options)
        : overrides.getArtifact(reference, options);
    },
  };
}

function withoutReceiptArtifact(
  observation: CompletedExecutionProducerContractObservation,
  digest: Sha256Digest,
): CompletedExecutionProducerContractObservation {
  return {
    ...observation,
    receipt: {
      ...observation.receipt,
      artifacts: observation.receipt.artifacts.filter(
        (reference) => reference.digest !== digest,
      ),
    },
  };
}

async function withMutatedRecord(
  observation: CompletedExecutionProducerContractObservation,
  mutate: (
    graph: Array<Record<string, unknown> & { "@id": string }>,
  ) => void,
): Promise<CompletedExecutionProducerContractObservation> {
  const bytes = await observation.repository.getRecord(
    observation.receipt.record,
  );
  if (bytes === null) {
    throw new Error("Completed observation record is missing");
  }
  const document = JSON.parse(new TextDecoder().decode(bytes)) as {
    "@graph": Array<Record<string, unknown> & { "@id": string }>;
  };
  mutate(document["@graph"]);
  const mutatedBytes = new TextEncoder().encode(
    `${JSON.stringify(document, null, 2)}\n`,
  );
  const record = await observation.repository.putRecord(
    "execution-evidence",
    mutatedBytes,
  );
  return {
    ...observation,
    receipt: {
      ...observation.receipt,
      record: record.reference,
    },
  };
}

describe("producer contract integrity failures", () => {
  test.each([
    ["runtime", fixtureDigests.runtime],
    ["runner", fixtureDigests.runner],
    ["result", fixtureDigests.result],
  ] as const)(
    "rejects a receipt missing the %s artifact reference",
    async (_name, digest) => {
      const observation = await completedObservation();
      try {
        await expect(
          verifyExecutionProducerContractObservation(
            "completed",
            withoutReceiptArtifact(observation, digest),
          ),
        ).rejects.toThrow(
          "receipt artifacts do not exactly match the evidence metadata",
        );
      } finally {
        await observation.cleanup?.();
      }
    },
  );

  test("rejects a receipt with an extra artifact reference", async () => {
    const observation = await completedObservation();
    try {
      await expect(
        verifyExecutionProducerContractObservation("completed", {
          ...observation,
          receipt: {
            ...observation.receipt,
            artifacts: [
              ...observation.receipt.artifacts,
              { digest: `sha256:${"f".repeat(64)}` },
            ],
          },
        }),
      ).rejects.toThrow(
        "receipt artifacts do not exactly match the evidence metadata",
      );
    } finally {
      await observation.cleanup?.();
    }
  });

  test("rejects record bytes that do not match their receipt reference", async () => {
    const observation = await completedObservation();
    const originalReference = observation.receipt.record;
    const inconsistentReference = {
      family: "execution-evidence",
      digest: `sha256:${"0".repeat(64)}`,
    } as const;
    const repository = wrapRepository(observation.repository, {
      async getRecord(reference, options) {
        if (reference.digest === inconsistentReference.digest) {
          return observation.repository.getRecord(originalReference, options);
        }
        return observation.repository.getRecord(reference, options);
      },
    });

    try {
      await expect(
        verifyExecutionProducerContractObservation("completed", {
          ...observation,
          repository,
          receipt: {
            ...observation.receipt,
            record: inconsistentReference,
          },
        }),
      ).rejects.toThrow(
        "record reference does not match the retrieved exact bytes",
      );
    } finally {
      await observation.cleanup?.();
    }
  });

  test("rejects a receipt finalization time not bound to its record", async () => {
    const observation = await completedObservation();
    try {
      await expect(
        verifyExecutionProducerContractObservation("completed", {
          ...observation,
          receipt: {
            ...observation.receipt,
            finalizedAt: "2026-07-24T10:00:03Z",
          },
        }),
      ).rejects.toThrow(
        "receipt finalization time does not match the evidence metadata",
      );
    } finally {
      await observation.cleanup?.();
    }
  });

  test("rejects a capture completion time not bound to its receipt", async () => {
    const observation = await completedObservation();
    const mutated = await withMutatedRecord(observation, (graph) => {
      const capture = graph.find((entity) => entity["@id"] === "#capture");
      if (capture === undefined) {
        throw new Error("Completed observation capture Activity is missing");
      }
      capture.endTime = "2026-07-24T10:00:03Z";
    });
    try {
      await expect(
        verifyExecutionProducerContractObservation("completed", mutated),
      ).rejects.toThrow(
        "receipt finalization time does not match the capture completion time",
      );
    } finally {
      await observation.cleanup?.();
    }
  });

  test("rejects a non-RFC-3339 receipt finalization time", async () => {
    const observation = await completedObservation();
    try {
      await expect(
        verifyExecutionProducerContractObservation("completed", {
          ...observation,
          receipt: {
            ...observation.receipt,
            finalizedAt: "2026-02-30T10:00:02Z",
          },
        }),
      ).rejects.toThrow("receipt finalization time is not strict RFC 3339");
    } finally {
      await observation.cleanup?.();
    }
  });

  test.each([
    ["runtime", fixtureDigests.runtime, "runner.mjs"],
    ["runner", fixtureDigests.runner, "runtime.json"],
  ] as const)(
    "rejects %s bytes that do not match their artifact reference",
    async (_name, digest, replacementFixture) => {
      const observation = await completedObservation();
      const replacementBytes = await readFile(fixtureUrl(replacementFixture));
      const repository = wrapRepository(observation.repository, {
        async getArtifact(reference, options) {
          if (reference.digest === digest) {
            return Uint8Array.from(replacementBytes);
          }
          return observation.repository.getArtifact(reference, options);
        },
      });

      try {
        await expect(
          verifyExecutionProducerContractObservation("completed", {
            ...observation,
            repository,
          }),
        ).rejects.toThrow(
          "artifact bytes do not match the evidence metadata digest",
        );
      } finally {
        await observation.cleanup?.();
      }
    },
  );
});

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
