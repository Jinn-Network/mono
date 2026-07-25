// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  EXECUTION_RECORDER_ERROR_CODES,
  ExecutionRecorderError,
} from "./errors.js";
import * as publicApi from "./index.js";
import {
  validateFinalizeExecutionInput,
  validateStartExecutionRecordingInput,
} from "./validate-input.js";
import type {
  FileArtifactCapture,
  StartExecutionRecordingInput,
} from "./types.js";

const encoder = new TextEncoder();

function origin() {
  return {
    kind: "producer-observed" as const,
    observer: "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as const,
  };
}

function file(
  entityId: string,
  content = entityId,
): FileArtifactCapture {
  return {
    kind: "file",
    entityId,
    source: {
      bytes: encoder.encode(content),
      mediaType: "application/octet-stream",
    },
    origin: origin(),
  };
}

function validStart(): StartExecutionRecordingInput {
  return {
    workspaceDir: "/tmp/execution-recorder-contract-test",
    executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
    startedAt: "2026-07-24T10:00:00Z",
    record: {
      name: "Contract fixture",
      description: "A complete execution recording contract fixture.",
      license: "https://creativecommons.org/publicdomain/zero/1.0/",
    },
    task: {
      entityId: "task/task.md",
      name: "Implement the fixture",
      source: {
        bytes: encoder.encode("Implement the fixture."),
        mediaType: "text/markdown",
      },
      origin: origin(),
    },
    executor: {
      entityId: "urn:uuid:22222222-2222-4222-8222-222222222222",
      kind: "software",
      name: "Fixture executor",
      origin: origin(),
    },
    runtime: {
      entityId: "runtime/runtime.json",
      specification: {
        bytes: encoder.encode('{"runtime":"fixture"}'),
        mediaType: "application/json",
      },
      name: "Fixture runtime",
      origin: origin(),
      components: [
        {
          kind: "controlled",
          artifact: file("runtime/runner.mjs", "export default {};"),
        },
      ],
    },
    producer: {
      entityId: "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "software",
      name: "Fixture producer",
      origin: origin(),
    },
  };
}

describe("execution recorder contracts", () => {
  test("accepts a complete start declaration", () => {
    expect(() => validateStartExecutionRecordingInput(validStart())).not.toThrow();
  });

  test.each([
    ["execution id", { executionId: "not-a-uuid" }],
    ["timestamp", { startedAt: "2026-02-30T10:00:00Z" }],
    ["license", { record: { ...validStart().record, license: "relative" } }],
  ])("rejects an invalid %s", (_name, patch) => {
    expect(() =>
      validateStartExecutionRecordingInput({
        ...validStart(),
        ...patch,
      } as StartExecutionRecordingInput),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_CAPTURE_INPUT",
      }),
    );
  });

  test("requires at least one runtime component", () => {
    const input = validStart();
    expect(() =>
      validateStartExecutionRecordingInput({
        ...input,
        runtime: { ...input.runtime, components: [] },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_CAPTURE_INPUT",
      }),
    );
  });

  test("rejects empty and cyclic aggregate captures", () => {
    const empty = {
      kind: "dataset" as const,
      entityId: "inputs/tree.json",
      manifest: {
        bytes: encoder.encode("{}"),
        mediaType: "application/json",
      },
      members: [],
      origin: origin(),
    };
    const input = validStart();

    expect(() =>
      validateStartExecutionRecordingInput({
        ...input,
        initialInputs: [empty],
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CAPTURE_INPUT" }));

    const cyclic = {
      ...empty,
      members: [] as unknown[],
    };
    cyclic.members.push(cyclic);
    expect(() =>
      validateStartExecutionRecordingInput({
        ...input,
        initialInputs: [cyclic as never],
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CAPTURE_INPUT" }));
  });

  test("rejects duplicate artifact entity ids", () => {
    const input = validStart();
    expect(() =>
      validateStartExecutionRecordingInput({
        ...input,
        initialInputs: [file("runtime/runner.mjs", "different")],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_CAPTURE_INPUT",
      }),
    );
  });

  test("rejects a file artifact as repository state", () => {
    const input = validStart();

    expect(() =>
      validateStartExecutionRecordingInput({
        ...input,
        repositoryState: {
          artifact: file("repository/source.patch"),
          identifiers: [],
        } as never,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_CAPTURE_INPUT",
      }),
    );
  });

  test("rejects extension fields that collide with recorder-owned fields", () => {
    const input = validStart();
    expect(() =>
      validateStartExecutionRecordingInput({
        ...input,
        task: {
          ...input.task,
          extensions: {
            sha256: "caller-must-not-own-this",
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_CAPTURE_INPUT",
      }),
    );
  });

  test("normalizes a missing opaque descriptor to a stable input error", () => {
    const input = validStart();
    expect(() =>
      validateStartExecutionRecordingInput({
        ...input,
        runtime: {
          ...input.runtime,
          components: [
            {
              kind: "opaque",
              component: {
                entityId:
                  "urn:uuid:33333333-3333-4333-8333-333333333333",
                name: "Hosted fixture",
              },
            } as never,
          ],
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_CAPTURE_INPUT",
      }),
    );
  });

  test("validates finalization timestamps and outcome", () => {
    expect(() =>
      validateFinalizeExecutionInput(
        {
          outcome: "completed",
          endedAt: "2026-07-24T10:01:00Z",
          results: [file("results/result.patch", "patch")],
        },
        "2026-07-24T10:00:00Z",
      ),
    ).not.toThrow();

    expect(() =>
      validateFinalizeExecutionInput(
        {
          outcome: "completed",
          endedAt: "2026-07-24T09:59:59Z",
        },
        "2026-07-24T10:00:00Z",
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CAPTURE_INPUT" }));
  });

  test("exports the complete stable exceptional error code set", () => {
    expect(EXECUTION_RECORDER_ERROR_CODES).toEqual([
      "INVALID_CAPTURE_INPUT",
      "RECORDING_NOT_FOUND",
      "WORKSPACE_VERSION_UNSUPPORTED",
      "RECORDING_CONFLICT",
      "WORKSPACE_CORRUPT",
      "CAPTURED_OBJECT_CORRUPT",
      "UNSAFE_PATH",
      "RECORDING_FINALIZED",
      "OPERATION_ABORTED",
      "IO_FAILURE",
      "PROTOCOL_CONFORMANCE_FAILED",
    ]);

    const error = new ExecutionRecorderError(
      "RECORDING_CONFLICT",
      "conflict",
      { entityId: "task/task.md" },
    );
    expect(error).toMatchObject({
      name: "ExecutionRecorderError",
      code: "RECORDING_CONFLICT",
      details: { entityId: "task/task.md" },
    });
    expect(publicApi.EXECUTION_RECORDER_ERROR_CODES).toBe(
      EXECUTION_RECORDER_ERROR_CODES,
    );
    expect(publicApi.CAPTURE_DIAGNOSTIC_CODES).toEqual([
      "NATIVE_TRACE_MISSING",
      "COMPLETED_RESULT_MISSING",
    ]);
    expect(publicApi.createExecutionRecorder).toBeTypeOf("function");
  });
});
