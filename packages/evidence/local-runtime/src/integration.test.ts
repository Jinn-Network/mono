// SPDX-License-Identifier: MIT
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkArtifactIntegrity,
  validateExecutionEvidence,
} from "@jinn-network/evidence-protocol";
import {
  createArtifactReference,
  type EvidenceRecordReference,
} from "@jinn-network/evidence-repository";
import { createExecutionRecorder } from "@jinn-network/execution-recorder";
import { afterEach, describe, expect, it } from "vitest";

import { openLocalEvidenceRuntime } from "./runtime.js";
import type { LocalEvidenceRuntime } from "./types.js";

const EXECUTION_ID = "urn:uuid:11111111-1111-4111-8111-111111111111";
const EXECUTOR_ID = "https://executor.example/contract-driver";
const PRODUCER_ID = "https://producer.example/contract-driver";
const STARTED_AT = "2026-07-24T10:00:00Z";
const ENDED_AT = "2026-07-24T10:00:01Z";
const ORIGIN = {
  kind: "producer-observed",
  observer: PRODUCER_ID,
} as const;

const recorderFixtureRoot = new URL(
  ".",
  import.meta.resolve(
    "@jinn-network/execution-recorder/fixtures/producer-contract-v1/README.md",
  ),
);
const protocolFixtureRoot = new URL(
  ".",
  import.meta.resolve(
    "@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/README.md",
  ),
);

const temporaryRoots: string[] = [];
const openRuntimes: LocalEvidenceRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(openRuntimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(path);
  return path;
}

async function openTrackedRuntime(rootDir: string): Promise<LocalEvidenceRuntime> {
  const runtime = await openLocalEvidenceRuntime({ rootDir });
  openRuntimes.push(runtime);
  return runtime;
}

async function closeTrackedRuntime(runtime: LocalEvidenceRuntime): Promise<void> {
  await runtime.close();
  const index = openRuntimes.indexOf(runtime);
  if (index >= 0) openRuntimes.splice(index, 1);
}

async function recorderFixture(name: string): Promise<Uint8Array> {
  return readFile(new URL(name, recorderFixtureRoot));
}

async function protocolFixture(name: string): Promise<Uint8Array> {
  return readFile(new URL(name, protocolFixtureRoot));
}

function file(
  entityId: string,
  bytes: Uint8Array,
  mediaType: string,
) {
  return {
    kind: "file" as const,
    entityId,
    source: {
      bytes,
      mediaType,
      name: entityId,
    },
    origin: ORIGIN,
  };
}

async function expectExactRecord(
  runtime: LocalEvidenceRuntime,
  reference: EvidenceRecordReference,
  expected: Uint8Array,
): Promise<void> {
  const actual = await runtime.repository.getRecord(reference);
  expect(actual).not.toBeNull();
  expect(actual).toEqual(expected);
}

describe("local evidence runtime producer integration", () => {
  it("accepts the real Execution Recorder contract flow and preserves exact evidence across restart", async () => {
    const parent = await temporaryRoot("jinn-local-producer-");
    const runtimeRoot = join(parent, "runtime");
    const workspaceDir = join(parent, "recording");
    const [task, trace, result, runtimeSpecification, runner] =
      await Promise.all([
        recorderFixture("task.md"),
        recorderFixture("trace.jsonl"),
        recorderFixture("result.txt"),
        recorderFixture("runtime.json"),
        recorderFixture("runner.mjs"),
      ]);

    const runtime = await openTrackedRuntime(runtimeRoot);
    const recording = await createExecutionRecorder({
      repository: runtime.repository,
    }).start({
      workspaceDir,
      executionId: EXECUTION_ID,
      startedAt: STARTED_AT,
      record: {
        name: "Local runtime producer contract",
        description: "Execution Evidence generated through the public producer contract.",
        license: "https://creativecommons.org/publicdomain/zero/1.0/",
      },
      task: {
        entityId: "task.md",
        name: "Producer contract task",
        source: {
          bytes: task,
          mediaType: "text/markdown",
          name: "task.md",
        },
        origin: ORIGIN,
      },
      executor: {
        entityId: EXECUTOR_ID,
        kind: "software",
        name: "Producer contract executor",
        softwareVersion: "1.0.0",
        origin: ORIGIN,
      },
      runtime: {
        entityId: "runtime.json",
        specification: {
          bytes: runtimeSpecification,
          mediaType: "application/json",
          name: "runtime.json",
        },
        name: "Producer contract runtime",
        softwareVersion: "1.0.0",
        origin: ORIGIN,
        components: [{
          kind: "controlled",
          artifact: file("runner.mjs", runner, "text/javascript"),
        }],
      },
      producer: {
        entityId: PRODUCER_ID,
        kind: "software",
        name: "Producer contract driver",
        softwareVersion: "1.0.0",
        origin: ORIGIN,
      },
    });

    // Finalization itself performs no Catalog polling. It returns once exact bytes
    // and the durable local announcement has crossed the Repository boundary.
    const finalized = await recording.finalize({
      outcome: "completed",
      endedAt: ENDED_AT,
      results: [file("result.txt", result, "text/plain")],
      nativeTrace: {
        artifact: file("trace.jsonl", trace, "application/x-ndjson"),
        format: {
          entityId: "https://example.test/formats/producer-contract-v1",
          name: "Producer contract native trace",
        },
      },
    });
    expect(finalized.finalized).toBe(true);
    if (!finalized.finalized) throw new Error("Recorder finalization was incomplete.");

    const metadataBytes = await runtime.repository.getRecord(
      finalized.receipt.record,
    );
    expect(metadataBytes).not.toBeNull();
    if (metadataBytes === null) throw new Error("Recorder metadata was not stored.");

    const validation = validateExecutionEvidence(metadataBytes);
    expect(validation.conforms).toBe(true);
    if (!validation.conforms || validation.value === undefined) {
      throw new Error("Recorder metadata did not conform.");
    }
    const availableArtifacts = new Map<string, Uint8Array>();
    for (const entity of validation.value["@graph"]) {
      if (typeof entity.sha256 !== "string") continue;
      const bytes = await runtime.repository.getArtifact({
        digest: `sha256:${entity.sha256}`,
      });
      expect(bytes, `missing ${entity["@id"]}`).not.toBeNull();
      if (bytes !== null) availableArtifacts.set(entity["@id"], bytes);
    }
    const integrity = checkArtifactIntegrity(
      validation.value,
      availableArtifacts,
    );
    expect(integrity).toMatchObject({
      mismatched: 0,
      unavailable: 0,
      verified: finalized.receipt.artifacts.length,
    });
    for (const bytes of availableArtifacts.values()) {
      expect(finalized.receipt.artifacts).toContainEqual(
        createArtifactReference(bytes),
      );
    }

    const indexed = await runtime.awaitIndexed(finalized.receipt.record);
    expect(indexed.status).toBe("indexed");
    if (indexed.status !== "indexed") throw new Error("Recorder record was not indexed.");
    expect(indexed.projection).toMatchObject({
      family: "execution-evidence",
      reference: finalized.receipt.record,
      byteSize: metadataBytes.byteLength,
      executionId: EXECUTION_ID,
      executorId: EXECUTOR_ID,
      task: {
        entityId: "task.md",
        digest: createArtifactReference(task).digest,
      },
      runtime: {
        entityId: "runtime.json",
        digest: createArtifactReference(runtimeSpecification).digest,
      },
      results: [{
        entityId: "result.txt",
        digest: createArtifactReference(result).digest,
      }],
      nativeTrace: {
        entityId: "trace.jsonl",
        digest: createArtifactReference(trace).digest,
      },
      outcome: "completed",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      publishedAt: finalized.receipt.finalizedAt,
    });
    expect(await runtime.catalog.getRecord(finalized.receipt.record))
      .toEqual(indexed.projection);

    await closeTrackedRuntime(runtime);
    const reopened = await openTrackedRuntime(runtimeRoot);
    await expectExactRecord(reopened, finalized.receipt.record, metadataBytes);
    expect(await reopened.catalog.getRecord(finalized.receipt.record))
      .toEqual(indexed.projection);
    for (const [entityId, expected] of availableArtifacts) {
      const entity = validation.value["@graph"]
        .find((candidate) => candidate["@id"] === entityId)!;
      expect(await reopened.repository.getArtifact({
        digest: `sha256:${String(entity.sha256)}`,
      })).toEqual(expected);
    }
  }, 30_000);

  it("indexes all families, isolates invalid bytes, and advances to a later good record", async () => {
    const root = await temporaryRoot("jinn-local-families-");
    const runtime = await openTrackedRuntime(root);
    const [executionBytes, evaluationBytes, verificationBytes] =
      await Promise.all([
        protocolFixture("execution/ro-crate-metadata.json"),
        protocolFixture(
          "claims/result-evaluation/result-evaluation.dsse.json",
        ),
        protocolFixture(
          "claims/execution-verification/execution-verification.dsse.json",
        ),
      ]);

    const execution = await runtime.repository.putRecord(
      "execution-evidence",
      executionBytes,
    );
    const evaluation = await runtime.repository.putRecord(
      "result-evaluation",
      evaluationBytes,
    );
    expect((await runtime.awaitIndexed(execution.reference)).status)
      .toBe("indexed");
    expect((await runtime.awaitIndexed(evaluation.reference)).status)
      .toBe("indexed");

    const invalidBytes = new TextEncoder().encode(
      '{"payloadType":"application/vnd.in-toto+json","payload":"invalid"}',
    );
    const invalid = await runtime.repository.putRecord(
      "result-evaluation",
      invalidBytes,
    );
    await expectExactRecord(runtime, invalid.reference, invalidBytes);
    expect(await runtime.awaitIndexed(invalid.reference)).toMatchObject({
      status: "failed",
      reference: invalid.reference,
      failure: {
        category: "protocol-nonconformance",
        sourceCode: "PROTOCOL_NONCONFORMANCE",
      },
    });
    expect(await runtime.catalog.getRecord(invalid.reference)).toBeNull();
    expect(await runtime.sync()).toMatchObject({
      status: "synchronized",
      indexed: 2,
      failed: 1,
    });

    const verification = await runtime.repository.putRecord(
      "execution-verification",
      verificationBytes,
    );
    expect((await runtime.awaitIndexed(verification.reference)).status)
      .toBe("indexed");
    expect(await runtime.sync()).toMatchObject({
      status: "synchronized",
      indexed: 3,
      failed: 1,
    });

    const executions = await runtime.catalog.findExecutions({
      executionId: "urn:uuid:22222222-2222-4222-8222-222222222222",
      executorId: "urn:uuid:33333333-3333-4333-8333-333333333333",
      outcome: "completed",
    });
    expect(executions.items.map(({ reference }) => reference))
      .toEqual([execution.reference]);

    const evaluations = await runtime.catalog.findEvaluations({
      evaluatorId: "urn:uuid:55555555-5555-4555-8555-555555555555",
      resultDigest:
        "sha256:c43b406505b8c53ff9bf0a1c57442080d99a14b9f278739cb426313cf3238b07",
      verdict: "pass",
    });
    expect(evaluations.items.map(({ reference }) => reference))
      .toEqual([evaluation.reference]);

    const verifications = await runtime.catalog.findVerifications({
      executionId: "urn:uuid:22222222-2222-4222-8222-222222222222",
      subjectRecordDigest:
        "sha256:dcaa588c17467cdf4939ff18d578537995c04bc700d0c0e6df3d64ddc02dd4cf",
      verifierId: "urn:uuid:66666666-6666-4666-8666-666666666666",
      verdict: "verified",
    });
    expect(verifications.items.map(({ reference }) => reference))
      .toEqual([verification.reference]);
  }, 30_000);
});
