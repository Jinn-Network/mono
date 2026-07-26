// SPDX-License-Identifier: Apache-2.0

import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkArtifactIntegrity,
  validateExecutionEvidence,
} from "@jinn-network/evidence-protocol";
import {
  EvidenceRepositoryError,
  type EvidenceRepository,
} from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import { afterEach, describe, expect, test } from "vitest";

import { createExecutionRecorder } from "./recorder.js";
import { readStoredObject } from "./object-store.js";
import { openWorkspaceState } from "./state.js";
import type {
  FileArtifactCapture,
  NativeTraceCapture,
  RuntimeObservationCapture,
  StartExecutionRecordingInput,
} from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const roots: string[] = [];

async function workspace(name = "recording"): Promise<string> {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "jinn-recorder-lifecycle-")),
  );
  roots.push(parent);
  return join(parent, name);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const origin = {
  kind: "producer-observed",
  observer: "https://producer.example/recorder",
} as const;

function file(
  entityId: string,
  text: string,
  mediaType = "text/plain",
): FileArtifactCapture {
  return {
    kind: "file",
    entityId,
    source: {
      bytes: encoder.encode(text),
      mediaType,
      name: entityId.split("/").at(-1),
    },
    origin,
  };
}

function startInput(
  workspaceDir: string,
  overrides: Partial<StartExecutionRecordingInput> = {},
): StartExecutionRecordingInput {
  return {
    workspaceDir,
    executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
    startedAt: "2026-07-24T10:00:00Z",
    record: {
      name: "Recorder lifecycle fixture",
      description: "Captures one exact execution.",
      license: "https://spdx.org/licenses/Apache-2.0.html",
    },
    task: {
      entityId: "task.md",
      name: "Lifecycle task",
      source: {
        bytes: encoder.encode("perform the task\n"),
        mediaType: "text/markdown",
        name: "task.md",
      },
      origin,
    },
    initialInputs: [file("inputs/initial.txt", "initial\n")],
    executor: {
      entityId: "https://executor.example/agent",
      kind: "software",
      name: "Fixture executor",
      softwareVersion: "1.0.0",
      origin,
    },
    runtime: {
      entityId: "runtime/spec.json",
      name: "Fixture runtime",
      specification: {
        bytes: encoder.encode('{"node":"22"}\n'),
        mediaType: "application/json",
        name: "spec.json",
      },
      origin,
      components: [
        {
          kind: "controlled",
          artifact: file(
            "runtime/runner.mjs",
            "export const run = true;\n",
            "text/javascript",
          ),
        },
      ],
    },
    producer: {
      entityId: "https://producer.example/recorder",
      kind: "software",
      name: "Fixture producer",
      softwareVersion: "0.1.0",
      origin,
    },
    ...overrides,
  };
}

function nativeTrace(text = "native trace\n"): NativeTraceCapture {
  return {
    artifact: file(
      "trace/native.jsonl",
      text,
      "application/x-ndjson",
    ),
    format: {
      entityId: "https://example.test/formats/native-trace/v1",
      name: "Fixture native trace",
    },
  };
}

describe("execution recorder lifecycle", () => {
  test("starts durably and treats an identical retry as a no-op", async () => {
    const workspaceDir = await workspace();
    const repository = new InMemoryEvidenceRepository();
    const recorder = createExecutionRecorder({ repository });
    const input = startInput(workspaceDir);

    const first = await recorder.start(input);
    const initialState = await openWorkspaceState(workspaceDir);
    const second = await recorder.start(input);
    const retriedState = await openWorkspaceState(workspaceDir);

    expect(first.executionId).toBe(input.executionId);
    expect(second.executionId).toBe(input.executionId);
    expect(first.status).toBe("open");
    expect(initialState.head.revision).toBe(1);
    expect(retriedState.head).toEqual(initialState.head);
  });

  test("generates one execution ID and resumes it", async () => {
    const workspaceDir = await workspace();
    const repository = new InMemoryEvidenceRepository();
    const recorder = createExecutionRecorder({ repository });
    const input = startInput(workspaceDir, { executionId: undefined });

    const started = await recorder.start(input);
    const resumed = await recorder.resume({ workspaceDir });
    const retried = await recorder.start(input);

    expect(started.executionId).toMatch(/^urn:uuid:/);
    expect(resumed.executionId).toBe(started.executionId);
    expect(retried.executionId).toBe(started.executionId);
  });

  test("snapshots path bytes before start returns", async () => {
    const workspaceDir = await workspace();
    const sourceDir = await realpath(
      await mkdtemp(join(tmpdir(), "jinn-recorder-sources-")),
    );
    roots.push(sourceDir);
    const sourcePath = join(sourceDir, "task.md");
    await writeFile(sourcePath, "before\n");
    const repository = new InMemoryEvidenceRepository();
    const recorder = createExecutionRecorder({ repository });

    await recorder.start(
      startInput(workspaceDir, {
        task: {
          ...startInput(workspaceDir).task,
          source: {
            path: sourcePath,
            mediaType: "text/markdown",
            name: "task.md",
          },
        },
      }),
    );
    await writeFile(sourcePath, "after\n");

    const state = await openWorkspaceState(workspaceDir);
    const bytes = await readStoredObject(
      state.paths,
      state.recording!.task.source,
    );
    expect(decoder.decode(bytes)).toBe("before\n");
  });

  test("captures inputs idempotently and rejects incompatible identity reuse", async () => {
    const workspaceDir = await workspace();
    const recorder = createExecutionRecorder({
      repository: new InMemoryEvidenceRepository(),
    });
    const recording = await recorder.start(startInput(workspaceDir));
    const input = file("inputs/discovered.txt", "same\n");

    await recording.captureInput(input);
    const captured = await openWorkspaceState(workspaceDir);
    await recording.captureInput(input);
    const repeated = await openWorkspaceState(workspaceDir);

    expect(captured.head.revision).toBe(2);
    expect(repeated.head).toEqual(captured.head);
    await expect(
      recording.captureInput(file("inputs/discovered.txt", "different\n")),
    ).rejects.toMatchObject({ code: "RECORDING_CONFLICT" });
  });

  test("normalizes duplicate identifiers for idempotent capture", async () => {
    const workspaceDir = await workspace();
    const recorder = createExecutionRecorder({
      repository: new InMemoryEvidenceRepository(),
    });
    const recording = await recorder.start(startInput(workspaceDir));
    const identifier = {
      propertyId: "https://example.test/terms/content-id" as const,
      value: "same",
    };
    const once = {
      ...file("inputs/identified.txt", "same\n"),
      identifiers: [identifier],
    } as const;

    await recording.captureInput(once);
    const captured = await openWorkspaceState(workspaceDir);
    await recording.captureInput({
      ...once,
      identifiers: [identifier, identifier],
    });

    expect((await openWorkspaceState(workspaceDir)).head).toEqual(
      captured.head,
    );
  });

  test("captures runtime observations idempotently", async () => {
    const workspaceDir = await workspace();
    const recorder = createExecutionRecorder({
      repository: new InMemoryEvidenceRepository(),
    });
    const recording = await recorder.start(startInput(workspaceDir));
    const observation: RuntimeObservationCapture = {
      kind: "resource",
      entityId: "observations/tokens",
      name: "Tokens",
      value: 123,
      propertyId: "https://example.test/terms/tokenCount",
      origin,
    };

    await recording.captureRuntimeObservation(observation);
    const captured = await openWorkspaceState(workspaceDir);
    await recording.captureRuntimeObservation(observation);
    expect((await openWorkspaceState(workspaceDir)).head).toEqual(
      captured.head,
    );

    await expect(
      recording.captureRuntimeObservation({
        ...observation,
        value: 124,
      }),
    ).rejects.toMatchObject({ code: "RECORDING_CONFLICT" });
  });

  test("allows compatible opaque-component observations with distinct descriptors", async () => {
    const workspaceDir = await workspace();
    const component = {
      entityId: "https://components.example/hosted-model",
      name: "Hosted model",
      softwareVersion: "2026-07",
      provider: "https://provider.example/organization",
    } as const;
    const input = startInput(workspaceDir);
    const recorder = createExecutionRecorder({
      repository: new InMemoryEvidenceRepository(),
    });
    const recording = await recorder.start({
      ...input,
      runtime: {
        ...input.runtime,
        components: [
          {
            kind: "opaque",
            descriptor: file(
              "runtime/hosted-start.json",
              '{"observed":"start"}\n',
              "application/json",
            ),
            component,
          },
        ],
      },
    });

    await recording.captureRuntimeObservation({
      kind: "opaque-component",
      component: {
        kind: "opaque",
        descriptor: file(
          "runtime/hosted-end.json",
          '{"observed":"end"}\n',
          "application/json",
        ),
        component,
      },
    });

    expect((await openWorkspaceState(workspaceDir)).head.revision).toBe(2);
  });

  test("selects exactly one native trace", async () => {
    const workspaceDir = await workspace();
    const recorder = createExecutionRecorder({
      repository: new InMemoryEvidenceRepository(),
    });
    const recording = await recorder.start(startInput(workspaceDir));
    const trace = {
      artifact: file(
        "trace/native.jsonl",
        '{"event":"done"}\n',
        "application/x-ndjson",
      ),
      format: {
        entityId: "https://example.test/formats/native-trace",
        name: "Native trace",
      },
    } as const;

    await recording.attachNativeTrace(trace);
    const captured = await openWorkspaceState(workspaceDir);
    await recording.attachNativeTrace(trace);
    expect((await openWorkspaceState(workspaceDir)).head).toEqual(
      captured.head,
    );

    await expect(
      recording.attachNativeTrace({
        ...trace,
        artifact: file(
          "trace/other.jsonl",
          '{"event":"done"}\n',
          "application/x-ndjson",
        ),
      }),
    ).rejects.toMatchObject({ code: "RECORDING_CONFLICT" });
  });

  test("rejects a trace format that collides with an existing graph identity", async () => {
    const workspaceDir = await workspace();
    const input = startInput(workspaceDir);
    const recorder = createExecutionRecorder({
      repository: new InMemoryEvidenceRepository(),
    });
    const recording = await recorder.start(input);

    await expect(
      recording.attachNativeTrace({
        artifact: file(
          "trace/native.jsonl",
          '{"event":"done"}\n',
          "application/x-ndjson",
        ),
        format: {
          entityId: input.executor.entityId,
          name: "Conflicting profile",
        },
      }),
    ).rejects.toMatchObject({ code: "RECORDING_CONFLICT" });
    expect((await openWorkspaceState(workspaceDir)).head.revision).toBe(1);
  });

  test("rejects stale handles and leaves the winning transition intact", async () => {
    const workspaceDir = await workspace();
    const recorder = createExecutionRecorder({
      repository: new InMemoryEvidenceRepository(),
    });
    const first = await recorder.start(startInput(workspaceDir));
    const stale = await recorder.resume({ workspaceDir });

    await first.captureInput(file("inputs/first.txt", "first\n"));
    await expect(
      stale.captureInput(file("inputs/stale.txt", "stale\n")),
    ).rejects.toMatchObject({ code: "RECORDING_CONFLICT" });

    const state = await openWorkspaceState(workspaceDir);
    expect(state.inputs.map(({ entityId }) => entityId)).toContain(
      "inputs/first.txt",
    );
    expect(state.inputs.map(({ entityId }) => entityId)).not.toContain(
      "inputs/stale.txt",
    );
  });

  test("rejects incompatible start retries and missing workspaces", async () => {
    const workspaceDir = await workspace();
    const recorder = createExecutionRecorder({
      repository: new InMemoryEvidenceRepository(),
    });
    await recorder.start(startInput(workspaceDir));

    await expect(
      recorder.start(
        startInput(workspaceDir, {
          record: {
            ...startInput(workspaceDir).record,
            description: "different",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "RECORDING_CONFLICT" });
    await expect(
      recorder.resume({ workspaceDir: await workspace("missing") }),
    ).rejects.toMatchObject({ code: "RECORDING_NOT_FOUND" });
    await expect(recorder.resume(undefined as never)).rejects.toMatchObject({
      code: "INVALID_CAPTURE_INPUT",
    });
  });

  test("rejects supplied identities reserved for recorder provenance", async () => {
    const workspaceDir = await workspace();
    const input = startInput(workspaceDir);
    const recorder = createExecutionRecorder({
      repository: new InMemoryEvidenceRepository(),
    });

    await expect(
      recorder.start({
        ...input,
        executor: {
          ...input.executor,
          entityId:
            "urn:jinn:execution-recorder:role:producer-observer",
        },
      }),
    ).rejects.toMatchObject({ code: "RECORDING_CONFLICT" });
    expect((await openWorkspaceState(workspaceDir)).head.revision).toBe(0);
  });

  test("detects a last-entry payload mutation through its declaration fingerprint", async () => {
    const workspaceDir = await workspace();
    const recorder = createExecutionRecorder({
      repository: new InMemoryEvidenceRepository(),
    });
    await recorder.start(startInput(workspaceDir));
    const entryPath = join(
      workspaceDir,
      "journal",
      "000000000001.json",
    );
    const entry = JSON.parse(await readFile(entryPath, "utf8")) as {
      event: {
        recording: {
          record: { name: string };
        };
      };
    };
    entry.event.recording.record.name = "mutated after publication";
    await writeFile(entryPath, `${JSON.stringify(entry)}\n`);

    await expect(recorder.resume({ workspaceDir })).rejects.toMatchObject({
      code: "WORKSPACE_CORRUPT",
    });
  });

  test("honors cancellation without advancing the journal", async () => {
    const workspaceDir = await workspace();
    const recorder = createExecutionRecorder({
      repository: new InMemoryEvidenceRepository(),
    });
    const recording = await recorder.start(startInput(workspaceDir));
    const controller = new AbortController();
    controller.abort(new Error("stop"));

    await expect(
      recording.captureInput(file("inputs/aborted.txt", "no\n"), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    expect((await openWorkspaceState(workspaceDir)).head.revision).toBe(1);
  });
});

describe("execution recorder finalization lifecycle", () => {
  test("finalizes through the public handle and returns exact conforming repository bytes", async () => {
    const workspaceDir = await workspace();
    const repository = new InMemoryEvidenceRepository();
    const recording = await createExecutionRecorder({
      repository,
    }).start(startInput(workspaceDir));

    const outcome = await recording.finalize({
      outcome: "completed",
      endedAt: "2026-07-24T10:01:00Z",
      results: [file("results/result.txt", "result\n")],
      nativeTrace: nativeTrace(),
    });

    expect(outcome.finalized).toBe(true);
    expect(recording.status).toBe("finalized");
    expect(recording.receipt).toEqual(
      outcome.finalized ? outcome.receipt : undefined,
    );
    if (!outcome.finalized) throw new Error("Expected finalization.");

    const metadata = await repository.getRecord(outcome.receipt.record);
    expect(metadata).not.toBeNull();
    const report = validateExecutionEvidence(metadata!);
    expect(report).toMatchObject({ conforms: true, diagnostics: [] });
    if (report.value === undefined) {
      throw new Error("Expected parsed Execution Evidence.");
    }
    const byDigest = new Map<string, Uint8Array>();
    for (const reference of outcome.receipt.artifacts) {
      const bytes = await repository.getArtifact(reference);
      expect(bytes).not.toBeNull();
      byDigest.set(reference.digest, bytes!);
    }
    const artifacts = new Map<string, Uint8Array>();
    for (const entity of report.value["@graph"]) {
      if (typeof entity.sha256 !== "string") continue;
      const bytes = byDigest.get(`sha256:${entity.sha256}`);
      if (bytes !== undefined) artifacts.set(entity["@id"], bytes);
    }
    expect(
      checkArtifactIntegrity(report.value, artifacts).artifacts,
    ).toSatisfy(
      (entries: readonly { status: string }[]) =>
        entries.every(({ status }) => status === "verified"),
    );

    const repeated = await recording.finalize({
      outcome: "completed",
      endedAt: "2026-07-24T10:01:00Z",
      results: [file("results/result.txt", "result\n")],
      nativeTrace: nativeTrace(),
    });
    expect(repeated).toEqual(outcome);
  });

  test("caller mutation of a finalize result cannot change the persisted receipt", async () => {
    const workspaceDir = await workspace();
    const repository = new InMemoryEvidenceRepository();
    const recording = await createExecutionRecorder({
      repository,
    }).start(startInput(workspaceDir));
    const input = {
      outcome: "completed" as const,
      endedAt: "2026-07-24T10:01:00Z",
      results: [file("results/result.txt", "result\n")],
      nativeTrace: nativeTrace(),
    };
    const outcome = await recording.finalize(input);
    if (!outcome.finalized) throw new Error("Expected finalization.");
    const expected = structuredClone(outcome.receipt);
    const exposed = outcome.receipt as unknown as {
      executionId: string;
      record: { family: string; digest: string };
      artifacts: Array<{ digest: string }>;
      finalizedAt: string;
    };

    exposed.executionId =
      "urn:uuid:00000000-0000-4000-8000-000000000000";
    exposed.record.family = "result-evaluation";
    exposed.record.digest = `sha256:${"0".repeat(64)}`;
    exposed.artifacts[0]!.digest = `sha256:${"1".repeat(64)}`;
    exposed.artifacts.splice(1);
    exposed.finalizedAt = "2030-01-01T00:00:00.000Z";

    const repeated = await recording.finalize(input);
    expect(repeated).toEqual({
      finalized: true,
      receipt: expected,
    });
    expect(recording.receipt).toEqual(expected);
  });

  test("caller mutation of the receipt getter cannot change later views", async () => {
    const workspaceDir = await workspace();
    const recording = await createExecutionRecorder({
      repository: new InMemoryEvidenceRepository(),
    }).start(startInput(workspaceDir));
    const outcome = await recording.finalize({
      outcome: "completed",
      endedAt: "2026-07-24T10:01:00Z",
      results: [file("results/result.txt", "result\n")],
      nativeTrace: nativeTrace(),
    });
    if (!outcome.finalized) throw new Error("Expected finalization.");
    const expected = structuredClone(outcome.receipt);
    const receiptView = recording.receipt;
    if (receiptView === undefined) {
      throw new Error("Expected the recording receipt.");
    }
    const exposed = receiptView as unknown as {
      record: { digest: string };
      artifacts: Array<{ digest: string }>;
    };

    exposed.record.digest = `sha256:${"0".repeat(64)}`;
    exposed.artifacts.splice(0);

    const later = recording.receipt;
    expect(later).toEqual(expected);
    expect(later).not.toBe(exposed);
    expect(later?.record).not.toBe(exposed.record);
    expect(later?.artifacts).not.toBe(exposed.artifacts);
  });

  test("durably snapshots incomplete finalization material for a later retry", async () => {
    const workspaceDir = await workspace();
    const sourceDir = await realpath(
      await mkdtemp(join(tmpdir(), "jinn-recorder-result-")),
    );
    roots.push(sourceDir);
    const resultPath = join(sourceDir, "result.txt");
    await writeFile(resultPath, "captured result\n");
    const repository = new InMemoryEvidenceRepository();
    const recorder = createExecutionRecorder({ repository });
    const recording = await recorder.start(startInput(workspaceDir));

    const incomplete = await recording.finalize({
      outcome: "completed",
      endedAt: "2026-07-24T10:01:00Z",
      results: [
        {
          kind: "file",
          entityId: "results/result.txt",
          source: {
            path: resultPath,
            mediaType: "text/plain",
          },
          origin,
        },
      ],
    });
    expect(incomplete).toMatchObject({
      finalized: false,
      diagnostics: [{ code: "NATIVE_TRACE_MISSING" }],
    });
    expect(recording.status).toBe("open");

    await writeFile(resultPath, "mutated after capture\n");
    const finalized = await recording.finalize({
      outcome: "completed",
      endedAt: "2026-07-24T10:01:00Z",
      nativeTrace: nativeTrace(),
    });
    expect(finalized.finalized).toBe(true);
    if (!finalized.finalized) throw new Error("Expected finalization.");
    const artifactValues = await Promise.all(
      finalized.receipt.artifacts.map((reference) =>
        repository.getArtifact(reference),
      ),
    );
    expect(
      artifactValues.some(
        (bytes) =>
          bytes !== null &&
          decoder.decode(bytes) === "captured result\n",
      ),
    ).toBe(true);
  });

  test("rejects contextual identity conflicts before finalization material becomes durable", async () => {
    const workspaceDir = await workspace();
    const repository = new InMemoryEvidenceRepository();
    const recording = await createExecutionRecorder({
      repository,
    }).start(startInput(workspaceDir));

    await expect(
      recording.finalize({
        outcome: "completed",
        endedAt: "2026-07-24T10:01:00Z",
        results: [
          {
            ...file("results/result.txt", "result\n"),
            origin: {
              kind: "producer-observed",
              observer:
                "https://spdx.org/licenses/Apache-2.0.html",
            },
          },
        ],
        nativeTrace: nativeTrace(),
      }),
    ).rejects.toMatchObject({ code: "RECORDING_CONFLICT" });
    expect((await openWorkspaceState(workspaceDir)).head.revision).toBe(1);

    await expect(
      recording.finalize({
        outcome: "completed",
        endedAt: "2026-07-24T10:01:00Z",
        results: [file("results/result.txt", "result\n")],
        nativeTrace: {
          ...nativeTrace(),
          format: {
            entityId: "https://executor.example/agent",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "RECORDING_CONFLICT" });
    expect((await openWorkspaceState(workspaceDir)).head.revision).toBe(1);

    expect(
      await recording.finalize({
        outcome: "completed",
        endedAt: "2026-07-24T10:01:00Z",
        results: [file("results/result.txt", "result\n")],
        nativeTrace: nativeTrace(),
      }),
    ).toMatchObject({ finalized: true });
  });

  test("resume completes a journaled finalization after a repository interruption", async () => {
    const workspaceDir = await workspace();
    const backing = new InMemoryEvidenceRepository();
    let interruptRecord = true;
    const repository: EvidenceRepository = {
      capabilities: backing.capabilities,
      putArtifact: (...args) => backing.putArtifact(...args),
      getArtifact: (...args) => backing.getArtifact(...args),
      getRecord: (...args) => backing.getRecord(...args),
      putRecord: async (...args) => {
        if (interruptRecord) {
          interruptRecord = false;
          throw new EvidenceRepositoryError(
            "DEPENDENCY_UNAVAILABLE",
            "simulated interruption",
          );
        }
        return backing.putRecord(...args);
      },
    };
    const recorder = createExecutionRecorder({ repository });
    const recording = await recorder.start(startInput(workspaceDir));

    await expect(
      recording.finalize({
        outcome: "failed",
        endedAt: "2026-07-24T10:01:00Z",
        nativeTrace: nativeTrace(),
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    expect(recording.status).toBe("finalizing");

    const recovered = await recorder.resume({ workspaceDir });
    expect(recovered.status).toBe("finalized");
    expect(recovered.receipt).toBeDefined();
  });
});
