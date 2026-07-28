// SPDX-License-Identifier: Apache-2.0
//
// These tests exercise `createExecutionRecorderBridge` against a real
// (non-double) `InMemoryEvidenceRepository`, matching the test-repository
// convention already used throughout `@jinn-network/execution-recorder`'s
// own suite (`recorder.test.ts`, `producer-contract.integration.test.ts`,
// etc.). `@jinn-network/evidence-repository/fs` is reserved for
// `src/cli.ts` alone (see `.github/scripts/evidence-source-boundaries.test.mjs`);
// filesystem-backed Repository coverage for this package instead lives in
// `cli.test.ts` and `scripts/pack-smoke.mjs`, which exercise the real
// filesystem Repository through the published binary.

import {
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  createArtifactReference,
  type EvidenceRepository,
} from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import { afterEach, describe, expect, test } from "vitest";

import { createExecutionRecorderBridge } from "./bridge.js";
import {
  COMPATIBLE_RECORDER_VERSION,
  RECORDER_BRIDGE_PROTOCOL,
  RECORDER_BRIDGE_VERSION,
} from "./protocol.js";

const ORIGIN = {
  kind: "producer-observed",
  observer: "https://producer.example/bridge-test",
} as const;

function bytesSource(text: string, mediaType: string) {
  return {
    kind: "bytes" as const,
    base64: Buffer.from(text).toString("base64"),
    mediaType,
  };
}

function fileCapture(entityId: string, text: string, mediaType: string) {
  return {
    kind: "file" as const,
    entityId,
    source: bytesSource(text, mediaType),
    origin: ORIGIN,
  };
}

function request(method: string, params: unknown, id: string) {
  return { protocol: RECORDER_BRIDGE_PROTOCOL, id, method, params };
}

function startParams(
  workspaceDir: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    workspaceDir,
    startedAt: "2026-07-28T00:00:00Z",
    record: {
      name: "Bridge dispatch test",
      description: "Recorder Bridge dispatch coverage.",
      license: "https://creativecommons.org/publicdomain/zero/1.0/",
    },
    task: {
      entityId: "task.md",
      name: "Bridge test task",
      source: bytesSource("task body", "text/markdown"),
      origin: ORIGIN,
    },
    executor: {
      entityId: "https://executor.example/bridge-test",
      kind: "software",
      name: "Bridge test executor",
      origin: ORIGIN,
    },
    runtime: {
      entityId: "runtime.json",
      specification: bytesSource("{}", "application/json"),
      name: "Bridge test runtime",
      origin: ORIGIN,
      components: [
        {
          kind: "controlled",
          artifact: fileCapture(
            "runner.mjs",
            "runner body",
            "text/javascript",
          ),
        },
      ],
    },
    producer: {
      entityId: "https://producer.example/bridge-test",
      kind: "software",
      name: "Bridge test producer",
      origin: ORIGIN,
    },
    ...overrides,
  };
}

function finalizeParams(
  target: { workspaceDir: string; executionId: string },
  overrides: Record<string, unknown> = {},
) {
  return {
    target,
    outcome: "completed",
    endedAt: "2026-07-28T00:00:01Z",
    results: [fileCapture("result.txt", "result body", "text/plain")],
    nativeTrace: {
      artifact: fileCapture(
        "trace.jsonl",
        "trace body",
        "application/x-ndjson",
      ),
      format: { entityId: "https://example.test/formats/bridge-test" },
    },
    ...overrides,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await delay(1);
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function temporaryWorkspace(prefix = "jinn-bridge-"): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.push(parent);
  return join(parent, "recording");
}

describe("ExecutionRecorderBridge dispatch", () => {
  test("hello reports bridge and recorder versions", async () => {
    const bridge = createExecutionRecorderBridge({
      repository: new InMemoryEvidenceRepository(),
    });
    const response = await bridge.dispatch(request("hello", {}, "hello-1"));
    expect(response).toEqual({
      protocol: RECORDER_BRIDGE_PROTOCOL,
      id: "hello-1",
      ok: true,
      result: {
        bridgeVersion: RECORDER_BRIDGE_VERSION,
        recorderVersion: COMPATIBLE_RECORDER_VERSION,
        protocol: RECORDER_BRIDGE_PROTOCOL,
      },
    });
  });

  test("start returns a generated Execution ID with open status", async () => {
    const bridge = createExecutionRecorderBridge({
      repository: new InMemoryEvidenceRepository(),
    });
    const workspaceDir = await temporaryWorkspace();
    const response = await bridge.dispatch(
      request("start", startParams(workspaceDir), "start-1"),
    );
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error("expected start to succeed");
    expect(response.result).toMatchObject({ status: "open" });
    const result = response.result as { executionId: string };
    expect(result.executionId).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("drives the attached recording through capture and finalize", async () => {
    const repository = new InMemoryEvidenceRepository();
    const bridge = createExecutionRecorderBridge({ repository });
    const workspaceDir = await temporaryWorkspace();

    const startResponse = await bridge.dispatch(
      request("start", startParams(workspaceDir), "start-1"),
    );
    if (!startResponse.ok) throw new Error("expected start to succeed");
    const target = {
      workspaceDir,
      executionId: (startResponse.result as { executionId: string })
        .executionId,
    };

    const captureInputResponse = await bridge.dispatch(
      request(
        "captureInput",
        {
          target,
          input: fileCapture("input-1.txt", "input body", "text/plain"),
        },
        "capture-input-1",
      ),
    );
    expect(captureInputResponse.ok).toBe(true);
    expect(captureInputResponse).toMatchObject({
      result: { executionId: target.executionId, status: "open" },
    });

    const captureObservationResponse = await bridge.dispatch(
      request(
        "captureRuntimeObservation",
        {
          target,
          observation: {
            kind: "resource",
            entityId: "cpu-seconds",
            name: "CPU seconds",
            value: 1,
            origin: ORIGIN,
          },
        },
        "capture-observation-1",
      ),
    );
    expect(captureObservationResponse.ok).toBe(true);

    const attachTraceResponse = await bridge.dispatch(
      request(
        "attachNativeTrace",
        {
          target,
          trace: {
            artifact: fileCapture(
              "trace.jsonl",
              "trace body",
              "application/x-ndjson",
            ),
            format: {
              entityId: "https://example.test/formats/bridge-test",
            },
          },
        },
        "attach-trace-1",
      ),
    );
    expect(attachTraceResponse.ok).toBe(true);

    const finalizeResponse = await bridge.dispatch(
      request(
        "finalize",
        finalizeParams(target, { nativeTrace: undefined }),
        "finalize-1",
      ),
    );
    expect(finalizeResponse.ok).toBe(true);
    if (!finalizeResponse.ok) throw new Error("expected finalize to succeed");
    expect(finalizeResponse.result).toMatchObject({ finalized: true });
  });

  test("rejects a mutation before start or resume with RECORDING_NOT_ATTACHED", async () => {
    const bridge = createExecutionRecorderBridge({
      repository: new InMemoryEvidenceRepository(),
    });
    const workspaceDir = await temporaryWorkspace();
    const target = {
      workspaceDir,
      executionId: "urn:uuid:00000000-0000-4000-8000-000000000000",
    };

    const response = await bridge.dispatch(
      request(
        "captureInput",
        { target, input: fileCapture("input.txt", "x", "text/plain") },
        "capture-1",
      ),
    );
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error("expected failure");
    expect(response.error).toMatchObject({
      domain: "bridge",
      code: "RECORDING_NOT_ATTACHED",
    });
  });

  test("rejects a mismatched target Execution ID with EXECUTION_ID_MISMATCH", async () => {
    const bridge = createExecutionRecorderBridge({
      repository: new InMemoryEvidenceRepository(),
    });
    const workspaceDir = await temporaryWorkspace();

    const startResponse = await bridge.dispatch(
      request("start", startParams(workspaceDir), "start-1"),
    );
    if (!startResponse.ok) throw new Error("expected start to succeed");

    const wrongTarget = {
      workspaceDir,
      executionId: "urn:uuid:00000000-0000-4000-8000-000000000000",
    };
    const response = await bridge.dispatch(
      request(
        "captureInput",
        {
          target: wrongTarget,
          input: fileCapture("input.txt", "x", "text/plain"),
        },
        "capture-1",
      ),
    );
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error("expected failure");
    expect(response.error).toMatchObject({
      domain: "bridge",
      code: "EXECUTION_ID_MISMATCH",
    });
  });

  test("a new bridge instance can resume an open workspace and recover its state", async () => {
    const repository = new InMemoryEvidenceRepository();
    const workspaceDir = await temporaryWorkspace();

    const firstBridge = createExecutionRecorderBridge({ repository });
    const startResponse = await firstBridge.dispatch(
      request("start", startParams(workspaceDir), "start-1"),
    );
    if (!startResponse.ok) throw new Error("expected start to succeed");
    const executionId = (startResponse.result as { executionId: string })
      .executionId;

    const secondBridge = createExecutionRecorderBridge({ repository });
    const resumeResponse = await secondBridge.dispatch(
      request("resume", { workspaceDir }, "resume-1"),
    );
    expect(resumeResponse.ok).toBe(true);
    if (!resumeResponse.ok) throw new Error("expected resume to succeed");
    expect(resumeResponse.result).toEqual({
      executionId,
      status: "open",
    });

    const finalizeResponse = await secondBridge.dispatch(
      request(
        "finalize",
        finalizeParams({ workspaceDir, executionId }),
        "finalize-1",
      ),
    );
    expect(finalizeResponse.ok).toBe(true);
  });

  test("snapshots a path-backed Task at start time", async () => {
    const repository = new InMemoryEvidenceRepository();
    const bridge = createExecutionRecorderBridge({ repository });
    const workspaceDir = await temporaryWorkspace();
    const taskParent = await realpath(
      await mkdtemp(join(tmpdir(), "jinn-bridge-task-")),
    );
    temporaryDirectories.push(taskParent);
    const taskPath = join(taskParent, "task.md");
    const beforeBytes = new TextEncoder().encode("task before overwrite");
    await writeFile(taskPath, beforeBytes);

    const startResponse = await bridge.dispatch(
      request(
        "start",
        startParams(workspaceDir, {
          task: {
            entityId: "task.md",
            name: "Path-backed task",
            source: {
              kind: "path",
              path: taskPath,
              mediaType: "text/markdown",
            },
            origin: ORIGIN,
          },
        }),
        "start-1",
      ),
    );
    if (!startResponse.ok) throw new Error("expected start to succeed");
    const target = {
      workspaceDir,
      executionId: (startResponse.result as { executionId: string })
        .executionId,
    };

    await writeFile(taskPath, "task after overwrite");

    const finalizeResponse = await bridge.dispatch(
      request("finalize", finalizeParams(target), "finalize-1"),
    );
    expect(finalizeResponse.ok).toBe(true);

    const stored = await repository.getArtifact(
      createArtifactReference(beforeBytes),
    );
    expect(stored).toEqual(beforeBytes);
  });

  test("rejects a symlinked artifact source path without leaking it in the response", async () => {
    const bridge = createExecutionRecorderBridge({
      repository: new InMemoryEvidenceRepository(),
    });
    const workspaceDir = await temporaryWorkspace();
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "jinn-bridge-symlink-")),
    );
    temporaryDirectories.push(parent);
    const targetPath = join(parent, "real-task.md");
    const symlinkPath = join(parent, "linked-task.md");
    await writeFile(targetPath, "task body");
    await symlink(targetPath, symlinkPath);

    const response = await bridge.dispatch(
      request(
        "start",
        startParams(workspaceDir, {
          task: {
            entityId: "task.md",
            name: "Symlinked task",
            source: {
              kind: "path",
              path: symlinkPath,
              mediaType: "text/markdown",
            },
            origin: ORIGIN,
          },
        }),
        "start-1",
      ),
    );
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error("expected failure");
    expect(response.error.domain).toBe("recorder");
    expect(response.error.code).toBe("UNSAFE_PATH");
    const serialized = JSON.stringify(response.error);
    expect(serialized).not.toContain(symlinkPath);
    expect(serialized).not.toContain(targetPath);
  });
});

describe("ExecutionRecorderBridge workspace concurrency", () => {
  function gatedRepository(
    backing: EvidenceRepository,
    gate: { readonly promise: Promise<void> },
    onFirstEntry?: () => void,
  ): EvidenceRepository {
    let putRecordCalls = 0;
    return {
      capabilities: backing.capabilities,
      putArtifact: (...args) => backing.putArtifact(...args),
      getArtifact: (...args) => backing.getArtifact(...args),
      getRecord: (...args) => backing.getRecord(...args),
      putRecord: async (...args) => {
        putRecordCalls += 1;
        if (putRecordCalls === 1) {
          onFirstEntry?.();
          await gate.promise;
        }
        return backing.putRecord(...args);
      },
    };
  }

  test("serializes two finalize dispatches targeting the same workspace", async () => {
    const gate = deferred<void>();
    let firstEnteredPutRecord = false;
    const repository = gatedRepository(
      new InMemoryEvidenceRepository(),
      gate,
      () => {
        firstEnteredPutRecord = true;
      },
    );
    const bridge = createExecutionRecorderBridge({ repository });
    const workspaceDir = await temporaryWorkspace();

    const startResponse = await bridge.dispatch(
      request("start", startParams(workspaceDir), "start-1"),
    );
    if (!startResponse.ok) throw new Error("expected start to succeed");
    const target = {
      workspaceDir,
      executionId: (startResponse.result as { executionId: string })
        .executionId,
    };

    const firstFinalize = bridge.dispatch(
      request("finalize", finalizeParams(target), "finalize-1"),
    );
    await waitUntil(() => firstEnteredPutRecord);

    let secondSettled = false;
    const secondFinalize = bridge
      .dispatch(request("finalize", finalizeParams(target), "finalize-2"))
      .then((response) => {
        secondSettled = true;
        return response;
      });

    await delay(20);
    expect(secondSettled).toBe(false);

    gate.resolve();
    const [firstResponse, secondResponse] = await Promise.all([
      firstFinalize,
      secondFinalize,
    ]);
    expect(firstResponse.ok).toBe(true);
    expect(secondResponse.ok).toBe(true);
  });

  test("allows finalize dispatches for independent workspaces to proceed concurrently", async () => {
    const gate = deferred<void>();
    const repository = gatedRepository(new InMemoryEvidenceRepository(), gate);
    const bridge = createExecutionRecorderBridge({ repository });
    const workspaceA = await temporaryWorkspace("jinn-bridge-a-");
    const workspaceB = await temporaryWorkspace("jinn-bridge-b-");

    const startA = await bridge.dispatch(
      request("start", startParams(workspaceA), "start-a"),
    );
    const startB = await bridge.dispatch(
      request("start", startParams(workspaceB), "start-b"),
    );
    if (!startA.ok || !startB.ok) throw new Error("expected start to succeed");
    const targetA = {
      workspaceDir: workspaceA,
      executionId: (startA.result as { executionId: string }).executionId,
    };
    const targetB = {
      workspaceDir: workspaceB,
      executionId: (startB.result as { executionId: string }).executionId,
    };

    const finalizeA = bridge.dispatch(
      request("finalize", finalizeParams(targetA), "finalize-a"),
    );
    // Workspace B is an independent queue: it must settle even while
    // workspace A's finalize is still gated inside its Repository write.
    const finalizeB = await bridge.dispatch(
      request("finalize", finalizeParams(targetB), "finalize-b"),
    );
    expect(finalizeB.ok).toBe(true);

    gate.resolve();
    const finalizeAResponse = await finalizeA;
    expect(finalizeAResponse.ok).toBe(true);
  });
});
