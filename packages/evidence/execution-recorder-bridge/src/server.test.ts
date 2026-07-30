// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import type { EvidenceRepository } from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import { afterEach, describe, expect, test } from "vitest";

import { RECORDER_BRIDGE_PROTOCOL } from "./protocol.js";
import { serveExecutionRecorderBridge } from "./server.js";

function collecting(): { writable: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  return { writable, chunks };
}

function linesOf(chunks: readonly string[]): readonly unknown[] {
  return chunks
    .join("")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function helloLine(id: string): string {
  return JSON.stringify({
    protocol: RECORDER_BRIDGE_PROTOCOL,
    id,
    method: "hello",
    params: {},
  });
}

// `Readable.from` yields one stream chunk per array entry; readline only
// splits on embedded newlines, so every line-shaped test fixture needs its
// own trailing "\n" or readline will concatenate adjacent chunks into one
// unterminated line.
function ndjson(lines: readonly string[]): Readable {
  return Readable.from(lines.map((line) => `${line}\n`));
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
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await delay(1);
  }
}

describe("serveExecutionRecorderBridge framing", () => {
  test("one request line produces one response line", async () => {
    const { writable, chunks } = collecting();
    await serveExecutionRecorderBridge({
      repository: new InMemoryEvidenceRepository(),
      input: ndjson([helloLine("req-1")]),
      output: writable,
    });

    const responses = linesOf(chunks);
    expect(responses).toEqual([
      {
        protocol: RECORDER_BRIDGE_PROTOCOL,
        id: "req-1",
        ok: true,
        result: expect.objectContaining({ protocol: RECORDER_BRIDGE_PROTOCOL }),
      },
    ]);
  });

  test("blank lines are ignored", async () => {
    const { writable, chunks } = collecting();
    await serveExecutionRecorderBridge({
      repository: new InMemoryEvidenceRepository(),
      input: ndjson(["", "   ", helloLine("req-1"), ""]),
      output: writable,
    });

    expect(linesOf(chunks)).toHaveLength(1);
  });

  test("malformed JSON produces a sanitized PARSE_ERROR and the next valid line still succeeds", async () => {
    const { writable, chunks } = collecting();
    await serveExecutionRecorderBridge({
      repository: new InMemoryEvidenceRepository(),
      input: ndjson(["not valid json {{{", helloLine("req-2")]),
      output: writable,
    });

    const responses = linesOf(chunks) as Array<Record<string, unknown>>;
    expect(responses).toHaveLength(2);
    expect(responses[0]).toEqual({
      protocol: RECORDER_BRIDGE_PROTOCOL,
      id: "",
      ok: false,
      error: {
        domain: "bridge",
        code: "PARSE_ERROR",
        message: expect.any(String),
      },
    });
    expect(JSON.stringify(responses[0])).not.toContain("not valid json");
    expect(responses[1]).toMatchObject({ id: "req-2", ok: true });
  });

  test("request IDs are preserved and correlate to their own response", async () => {
    const { writable, chunks } = collecting();
    await serveExecutionRecorderBridge({
      repository: new InMemoryEvidenceRepository(),
      input: ndjson([helloLine("alpha"), helloLine("beta")]),
      output: writable,
    });

    const ids = (linesOf(chunks) as Array<{ id: string }>)
      .map((response) => response.id)
      .sort();
    expect(ids).toEqual(["alpha", "beta"]);
  });

  test("response writes remain whole, one JSON object per line", async () => {
    const { writable, chunks } = collecting();
    await serveExecutionRecorderBridge({
      repository: new InMemoryEvidenceRepository(),
      input: ndjson([helloLine("a"), helloLine("b"), helloLine("c")]),
      output: writable,
    });

    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(chunk.endsWith("\n")).toBe(true);
      expect(chunk.match(/\n/g)).toHaveLength(1);
      expect(() => JSON.parse(chunk.slice(0, -1))).not.toThrow();
    }
  });
});

const ORIGIN = {
  kind: "producer-observed",
  observer: "https://producer.example/server-test",
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

function startLine(id: string, workspaceDir: string, executionId: string) {
  return JSON.stringify({
    protocol: RECORDER_BRIDGE_PROTOCOL,
    id,
    method: "start",
    params: {
      workspaceDir,
      executionId,
      startedAt: "2026-07-28T00:00:00Z",
      record: {
        name: "Server framing test",
        description: "Out-of-order response coverage.",
        license: "https://creativecommons.org/publicdomain/zero/1.0/",
      },
      task: {
        entityId: "task.md",
        name: "Server test task",
        source: bytesSource("task body", "text/markdown"),
        origin: ORIGIN,
      },
      executor: {
        entityId: "https://executor.example/server-test",
        kind: "software",
        name: "Server test executor",
        origin: ORIGIN,
      },
      runtime: {
        entityId: "runtime.json",
        specification: bytesSource("{}", "application/json"),
        name: "Server test runtime",
        origin: ORIGIN,
        components: [
          {
            kind: "controlled",
            artifact: fileCapture("runner.mjs", "runner body", "text/javascript"),
          },
        ],
      },
      producer: {
        entityId: "https://producer.example/server-test",
        kind: "software",
        name: "Server test producer",
        origin: ORIGIN,
      },
    },
  });
}

function finalizeLine(id: string, workspaceDir: string, executionId: string) {
  return JSON.stringify({
    protocol: RECORDER_BRIDGE_PROTOCOL,
    id,
    method: "finalize",
    params: {
      target: { workspaceDir, executionId },
      outcome: "completed",
      endedAt: "2026-07-28T00:00:01Z",
      results: [fileCapture("result.txt", "result body", "text/plain")],
      nativeTrace: {
        artifact: fileCapture("trace.jsonl", "trace body", "application/x-ndjson"),
        format: { entityId: "https://example.test/formats/server-test" },
      },
    },
  });
}

function gatedRepository(
  backing: EvidenceRepository,
  gate: { readonly promise: Promise<void> },
): EvidenceRepository {
  let putRecordCalls = 0;
  return {
    capabilities: backing.capabilities,
    putArtifact: (...args) => backing.putArtifact(...args),
    getArtifact: (...args) => backing.getArtifact(...args),
    getRecord: (...args) => backing.getRecord(...args),
    putRecord: async (...args) => {
      putRecordCalls += 1;
      if (putRecordCalls === 1) await gate.promise;
      return backing.putRecord(...args);
    },
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function temporaryWorkspace(prefix: string): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.push(parent);
  return join(parent, "recording");
}

describe("serveExecutionRecorderBridge concurrency", () => {
  test("independent delayed requests may respond out of input order, and end-of-input waits for every write", async () => {
    const gate = deferred<void>();
    const repository = gatedRepository(new InMemoryEvidenceRepository(), gate);
    const { writable, chunks } = collecting();
    // Real disk-backed Recorder workspaces are involved on both sides of the
    // gate; give this enough headroom under contended parallel test runs.

    const workspaceA = await temporaryWorkspace("jinn-bridge-server-a-");
    const workspaceB = await temporaryWorkspace("jinn-bridge-server-b-");
    const executionA = "urn:uuid:11111111-1111-4111-8111-111111111111";
    const executionB = "urn:uuid:22222222-2222-4222-8222-222222222222";

    const input = ndjson([
      startLine("start-a", workspaceA, executionA),
      startLine("start-b", workspaceB, executionB),
      finalizeLine("finalize-a", workspaceA, executionA),
      finalizeLine("finalize-b", workspaceB, executionB),
    ]);

    const served = serveExecutionRecorderBridge({
      repository,
      input,
      output: writable,
    });
    let servedSettled = false;
    served.then(() => {
      servedSettled = true;
    });

    // Workspace A and workspace B are independent queues, so which one's
    // finalize happens to reach the gated first Repository write is a race
    // — this must not assume finalize-a always wins it. Exactly one of the
    // two finalize responses arrives before the gate is released; the other
    // (whichever workspace that turns out to be) is still pending.
    await waitUntil(() =>
      linesOf(chunks).some((response) =>
        ["finalize-a", "finalize-b"].includes(
          (response as { id: string }).id,
        ),
      ),
    );
    await delay(20);
    const finalizeIdsSoFar = linesOf(chunks)
      .map((response) => (response as { id: string }).id)
      .filter((id) => id === "finalize-a" || id === "finalize-b");
    expect(finalizeIdsSoFar).toHaveLength(1);

    // End-of-input has already been reached (the readable source is
    // exhausted), yet the serve() call must not resolve until the
    // still-gated workspace's write completes.
    await delay(20);
    expect(servedSettled).toBe(false);

    gate.resolve();
    await served;
    expect(servedSettled).toBe(true);

    const responses = linesOf(chunks) as Array<{ id: string; ok: boolean }>;
    expect(responses).toHaveLength(4);
    expect(responses.every((response) => response.ok)).toBe(true);
  }, 20_000);
});
