// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { RecorderBridgeError } from "./errors.js";
import {
  decodeArtifactSource,
  decodeFinalizeInput,
  decodeInputCapture,
  decodeNativeTrace,
  decodeRuntimeObservation,
  decodeStartInput,
} from "./wire.js";

describe("decodeArtifactSource", () => {
  test("decodes exact byte sources", () => {
    expect(
      decodeArtifactSource({
        kind: "bytes",
        base64: Buffer.from("exact").toString("base64"),
        mediaType: "text/plain",
      }),
    ).toEqual({
      bytes: new TextEncoder().encode("exact"),
      mediaType: "text/plain",
    });
  });

  test("decodes path sources", () => {
    expect(
      decodeArtifactSource({
        kind: "path",
        path: "/tmp/trace.jsonl",
        mediaType: "application/x-ndjson",
      }),
    ).toEqual({
      path: "/tmp/trace.jsonl",
      mediaType: "application/x-ndjson",
    });
  });

  test("preserves an optional name", () => {
    expect(
      decodeArtifactSource({
        kind: "bytes",
        base64: Buffer.from("named").toString("base64"),
        mediaType: "text/plain",
        name: "named.txt",
      }),
    ).toEqual({
      bytes: new TextEncoder().encode("named"),
      mediaType: "text/plain",
      name: "named.txt",
    });
  });

  test.each([
    [
      "empty media type",
      {
        kind: "bytes",
        base64: Buffer.from("x").toString("base64"),
        mediaType: "",
      },
    ],
    [
      "empty path",
      { kind: "path", path: "", mediaType: "application/x-ndjson" },
    ],
    [
      "invalid base64",
      { kind: "bytes", base64: "not base64!!", mediaType: "text/plain" },
    ],
    [
      "non-canonical base64",
      // valid base64 alphabet, but not the canonical re-encoding of its own bytes
      { kind: "bytes", base64: "QQ=", mediaType: "text/plain" },
    ],
    [
      "unknown source kind",
      { kind: "url", url: "https://example.test", mediaType: "text/plain" },
    ],
    [
      "ambiguous bytes and path",
      {
        kind: "bytes",
        base64: Buffer.from("x").toString("base64"),
        path: "/tmp/x",
        mediaType: "text/plain",
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(() => decodeArtifactSource(value)).toThrowError(
      expect.objectContaining({
        name: "RecorderBridgeError",
        code: "INVALID_REQUEST",
      }),
    );
  });

  test("throws RecorderBridgeError instances", () => {
    try {
      decodeArtifactSource({ kind: "bytes", mediaType: "text/plain" });
      throw new Error("expected decodeArtifactSource to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RecorderBridgeError);
    }
  });
});

const ORIGIN = {
  kind: "producer-observed",
  observer: "https://producer.example/wire-test",
} as const;

function fileCapture(entityId: string, text: string, mediaType: string) {
  return {
    kind: "file" as const,
    entityId,
    source: {
      kind: "bytes" as const,
      base64: Buffer.from(text).toString("base64"),
      mediaType,
    },
    origin: ORIGIN,
  };
}

describe("decodeInputCapture", () => {
  test("decodes a nested collection, converting every artifact source", () => {
    const extension = {
      nested: {
        kind: "bytes",
        base64: "not-an-artifact-source",
        mediaType: "application/example",
      },
    };
    const decoded = decodeInputCapture({
      kind: "collection",
      entityId: "collection.json",
      manifest: {
        kind: "bytes",
        base64: Buffer.from("manifest").toString("base64"),
        mediaType: "application/json",
      },
      members: [fileCapture("member-1.txt", "member one", "text/plain")],
      origin: ORIGIN,
      extensions: extension,
    });

    expect(decoded).toEqual({
      kind: "collection",
      entityId: "collection.json",
      manifest: {
        bytes: new TextEncoder().encode("manifest"),
        mediaType: "application/json",
      },
      members: [
        {
          kind: "file",
          entityId: "member-1.txt",
          source: {
            bytes: new TextEncoder().encode("member one"),
            mediaType: "text/plain",
          },
          origin: ORIGIN,
        },
      ],
      origin: ORIGIN,
      extensions: extension,
    });
  });
});

describe("decodeStartInput", () => {
  test("converts every nested artifact source and leaves opaque extensions untouched", () => {
    const extension = {
      nested: {
        kind: "bytes",
        base64: "not-an-artifact-source",
        mediaType: "application/example",
      },
    };

    const decoded = decodeStartInput({
      workspaceDir: "/tmp/workspace",
      startedAt: "2026-07-28T00:00:00Z",
      record: {
        name: "Wire decode start",
        description: "Nested conversion test.",
        license: "https://creativecommons.org/publicdomain/zero/1.0/",
      },
      task: fileTaskCapture(),
      initialInputs: [
        {
          kind: "collection",
          entityId: "inputs.json",
          manifest: {
            kind: "bytes",
            base64: Buffer.from("inputs-manifest").toString("base64"),
            mediaType: "application/json",
          },
          members: [
            fileCapture("input-1.txt", "input one", "text/plain"),
          ],
          origin: ORIGIN,
        },
      ],
      repositoryState: {
        artifact: {
          kind: "collection",
          entityId: "repository-state.json",
          manifest: {
            kind: "bytes",
            base64: Buffer.from("state-manifest").toString("base64"),
            mediaType: "application/json",
          },
          members: [],
          origin: ORIGIN,
        },
        identifiers: [],
      },
      executor: {
        entityId: "https://executor.example/wire-test",
        kind: "software",
        name: "Wire decode executor",
        origin: ORIGIN,
      },
      runtime: {
        entityId: "runtime.json",
        specification: {
          kind: "path",
          path: "/tmp/runtime.json",
          mediaType: "application/json",
        },
        name: "Wire decode runtime",
        origin: ORIGIN,
        components: [
          {
            kind: "controlled",
            artifact: fileCapture(
              "controlled.mjs",
              "controlled component",
              "text/javascript",
            ),
          },
          {
            kind: "opaque",
            descriptor: fileCapture(
              "opaque.json",
              "opaque descriptor",
              "application/json",
            ),
            component: {
              entityId: "https://runtime.example/opaque-component",
              name: "Opaque runtime component",
            },
          },
        ],
        extensions: extension,
      },
      producer: {
        entityId: "https://producer.example/wire-test",
        kind: "software",
        name: "Wire decode producer",
        origin: ORIGIN,
      },
    });

    expect(decoded.record.executionExtensions).toBeUndefined();
    expect(decoded.runtime.extensions).toEqual(extension);
    expect(decoded.task.source).toEqual({
      bytes: new TextEncoder().encode("task body"),
      mediaType: "text/markdown",
    });
    expect(decoded.runtime.specification).toEqual({
      path: "/tmp/runtime.json",
      mediaType: "application/json",
    });
    expect(decoded.runtime.components).toEqual([
      {
        kind: "controlled",
        artifact: {
          kind: "file",
          entityId: "controlled.mjs",
          source: {
            bytes: new TextEncoder().encode("controlled component"),
            mediaType: "text/javascript",
          },
          origin: ORIGIN,
        },
      },
      {
        kind: "opaque",
        descriptor: {
          kind: "file",
          entityId: "opaque.json",
          source: {
            bytes: new TextEncoder().encode("opaque descriptor"),
            mediaType: "application/json",
          },
          origin: ORIGIN,
        },
        component: {
          entityId: "https://runtime.example/opaque-component",
          name: "Opaque runtime component",
        },
      },
    ]);
    expect(decoded.initialInputs?.[0]).toMatchObject({
      kind: "collection",
      members: [
        expect.objectContaining({
          source: {
            bytes: new TextEncoder().encode("input one"),
            mediaType: "text/plain",
          },
        }),
      ],
    });
    expect(decoded.repositoryState?.artifact.manifest).toEqual({
      bytes: new TextEncoder().encode("state-manifest"),
      mediaType: "application/json",
    });
  });
});

function fileTaskCapture() {
  return {
    entityId: "task.md",
    name: "Wire decode task",
    source: {
      kind: "bytes" as const,
      base64: Buffer.from("task body").toString("base64"),
      mediaType: "text/markdown",
    },
    origin: ORIGIN,
  };
}

describe("decodeRuntimeObservation", () => {
  test("decodes a resource observation without an artifact source", () => {
    expect(
      decodeRuntimeObservation({
        kind: "resource",
        entityId: "cpu-seconds",
        name: "CPU seconds",
        value: 1.5,
        origin: ORIGIN,
      }),
    ).toEqual({
      kind: "resource",
      entityId: "cpu-seconds",
      name: "CPU seconds",
      value: 1.5,
      origin: ORIGIN,
    });
  });

  test("decodes an environment observation's nested artifact", () => {
    expect(
      decodeRuntimeObservation({
        kind: "environment",
        artifact: fileCapture("env.json", "environment", "application/json"),
      }),
    ).toEqual({
      kind: "environment",
      artifact: {
        kind: "file",
        entityId: "env.json",
        source: {
          bytes: new TextEncoder().encode("environment"),
          mediaType: "application/json",
        },
        origin: ORIGIN,
      },
    });
  });
});

describe("decodeNativeTrace", () => {
  test("decodes the trace artifact and format", () => {
    expect(
      decodeNativeTrace({
        artifact: fileCapture("trace.jsonl", "trace body", "application/x-ndjson"),
        format: {
          entityId: "https://example.test/formats/wire-test",
          name: "Wire test native trace",
        },
      }),
    ).toEqual({
      artifact: {
        kind: "file",
        entityId: "trace.jsonl",
        source: {
          bytes: new TextEncoder().encode("trace body"),
          mediaType: "application/x-ndjson",
        },
        origin: ORIGIN,
      },
      format: {
        entityId: "https://example.test/formats/wire-test",
        name: "Wire test native trace",
      },
    });
  });
});

describe("decodeFinalizeInput", () => {
  test("decodes results and native trace", () => {
    const decoded = decodeFinalizeInput({
      outcome: "completed",
      endedAt: "2026-07-28T00:00:01Z",
      results: [fileCapture("result.txt", "result body", "text/plain")],
      nativeTrace: {
        artifact: fileCapture("trace.jsonl", "trace body", "application/x-ndjson"),
        format: { entityId: "https://example.test/formats/wire-test" },
      },
    });

    expect(decoded.outcome).toBe("completed");
    expect(decoded.results?.[0]).toMatchObject({
      source: {
        bytes: new TextEncoder().encode("result body"),
        mediaType: "text/plain",
      },
    });
    expect(decoded.nativeTrace?.artifact).toMatchObject({
      source: {
        bytes: new TextEncoder().encode("trace body"),
        mediaType: "application/x-ndjson",
      },
    });
  });

  test("rejects an unknown outcome", () => {
    expect(() =>
      decodeFinalizeInput({
        outcome: "unknown",
        endedAt: "2026-07-28T00:00:01Z",
      }),
    ).toThrowError(
      expect.objectContaining({ name: "RecorderBridgeError", code: "INVALID_REQUEST" }),
    );
  });
});
