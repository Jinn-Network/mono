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

import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import { afterEach, describe, expect, test } from "vitest";

import { createExecutionRecorder } from "./recorder.js";
import { readStoredObject } from "./object-store.js";
import { openWorkspaceState } from "./state.js";
import type {
  FileArtifactCapture,
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
