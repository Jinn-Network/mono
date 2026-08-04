import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { PluginRuntimeError } from "../errors.js";
import { parseSessionFeed } from "./feed.js";
import {
  CAPTURE_LICENSE,
  PRODUCER_IRI,
  SESSION_FEED_FORMAT_IRI,
  SESSION_FEED_MEDIA_TYPE,
  SESSION_ID_PROPERTY,
  TRACE_RECORD_IDENTIFIER_PROPERTY,
} from "./identity.js";
import {
  buildFinalizeInput,
  buildStartInput,
  resolveSessionOutcome,
  sessionSummary,
} from "./assemble.js";

const TRACE_DIGEST = `sha256:${"c".repeat(64)}` as const;

const assembly = async () => {
  const feed = parseSessionFeed(
    new Uint8Array(await readFile(new URL("../../fixtures/capture/session.ndjson", import.meta.url))),
  );
  return {
    feed,
    feedPath: "/home/op/capture/sessions/s-golden/feed.ndjson",
    workspaceDir: "/home/op/capture/workspaces/s-golden",
    producerVersion: "0.1.0",
    outcome: resolveSessionOutcome(feed),
    trajectoryDigest: TRACE_DIGEST,
  };
};

describe("resolveSessionOutcome", () => {
  test("takes the outcome and wall clock from the close event", async () => {
    const { feed } = await assembly();
    expect(resolveSessionOutcome(feed)).toEqual({
      outcome: "completed",
      endedAt: "2026-07-30T09:00:06Z",
    });
  });

  test("an explicit override wins over the close event", async () => {
    const { feed } = await assembly();
    expect(
      resolveSessionOutcome(feed, { outcome: "abandoned", endedAt: "2026-07-30T09:00:09Z" }),
    ).toEqual({ outcome: "abandoned", endedAt: "2026-07-30T09:00:09Z" });
  });

  test("refuses an unclosed feed with no override", () => {
    const feed = parseSessionFeed(
      new TextEncoder().encode(
        JSON.stringify({
          type: "session-open",
          v: 1,
          sessionId: "s-1",
          startedAt: "2026-07-30T09:00:00Z",
          atUnixNano: "1000",
          host: { name: "Hermes", version: "0.9.1" },
          model: { provider: "anthropic", name: "claude-opus-4.6" },
        }) + "\n",
      ),
    );
    expect(() => resolveSessionOutcome(feed)).toThrow(PluginRuntimeError);
    expect(resolveSessionOutcome(feed, { outcome: "abandoned", endedAt: "2026-07-30T09:00:05Z" })
      .outcome).toBe("abandoned");
  });

  test("refuses an override that ends before the session started", () => {
    const feed = parseSessionFeed(
      new TextEncoder().encode(
        JSON.stringify({
          type: "session-open",
          v: 1,
          sessionId: "s-1",
          startedAt: "2026-07-30T09:00:00Z",
          atUnixNano: "1000",
          host: { name: "Hermes", version: "0.9.1" },
          model: { provider: "anthropic", name: "claude-opus-4.6" },
        }) + "\n",
      ),
    );
    expect(() =>
      resolveSessionOutcome(feed, { outcome: "failed", endedAt: "2026-07-30T08:59:00Z" }),
    ).toThrow(/endedAt/u);
  });
});

describe("sessionSummary", () => {
  test("prefers the close event's summary", async () => {
    expect(sessionSummary((await assembly()).feed)).toBe("Locate the retry budget");
  });

  test("falls back to the first line of the first user turn, bounded", () => {
    const feed = parseSessionFeed(
      new TextEncoder().encode(
        [
          JSON.stringify({
            type: "session-open",
            v: 1,
            sessionId: "s-1",
            startedAt: "2026-07-30T09:00:00Z",
            atUnixNano: "1000",
            host: { name: "Hermes", version: "0.9.1" },
            model: { provider: "anthropic", name: "claude-opus-4.6" },
          }),
          JSON.stringify({ type: "user-turn", atUnixNano: "2000", text: `${"x".repeat(600)}\nsecond` }),
        ].join("\n") + "\n",
      ),
    );
    expect(sessionSummary(feed)).toBe("x".repeat(500));
  });

  test("falls back to a stated placeholder when there is nothing to summarize", () => {
    const feed = parseSessionFeed(
      new TextEncoder().encode(
        JSON.stringify({
          type: "session-open",
          v: 1,
          sessionId: "s-1",
          startedAt: "2026-07-30T09:00:00Z",
          atUnixNano: "1000",
          host: { name: "Hermes", version: "0.9.1" },
          model: { provider: "anthropic", name: "claude-opus-4.6" },
        }) + "\n",
      ),
    );
    expect(sessionSummary(feed)).toBe("(no summary)");
  });
});

describe("buildStartInput", () => {
  test("names the workspace, the session start, and the license", async () => {
    const start = buildStartInput(await assembly());
    expect(start.workspaceDir).toBe("/home/op/capture/workspaces/s-golden");
    expect(start.startedAt).toBe("2026-07-30T09:00:00Z");
    expect(start.record.license).toBe(CAPTURE_LICENSE);
    expect(start.record.executionIdentifiers).toEqual([
      { propertyId: SESSION_ID_PROPERTY, value: "s-golden" },
    ]);
  });

  test("gives the executor an absolute IRI derived from the host", async () => {
    const start = buildStartInput(await assembly());
    expect(start.executor.entityId).toBe("https://jinn.network/software/agent-host/hermes");
    expect(start.executor.kind).toBe("software");
    expect(start.executor.softwareVersion).toBe("0.9.1");
  });

  test("names the producer as this runtime, with its version", async () => {
    const start = buildStartInput(await assembly());
    expect(start.producer.entityId).toBe(PRODUCER_IRI);
    expect(start.producer.softwareVersion).toBe("0.1.0");
  });

  test("gives the runtime specification at least one content-bound component", async () => {
    const start = buildStartInput(await assembly());
    expect(start.runtime.entityId).toBe("runtime/host.json");
    expect(start.runtime.components).toHaveLength(1);
    const [component] = start.runtime.components;
    expect(component?.kind).toBe("controlled");
    expect(component?.kind === "controlled" && component.artifact.entityId).toBe(
      "runtime/host-environment.json",
    );
  });

  test("the task carries a JSON media type and the session summary", async () => {
    const start = buildStartInput(await assembly());
    expect(start.task.entityId).toBe("input/session-task.json");
    expect(start.task.source.mediaType).toBe("application/json");
    const decoded = JSON.parse(new TextDecoder().decode(start.task.source.bytes!));
    expect(decoded.summary).toBe("Locate the retry budget");
    expect(decoded.sessionId).toBe("s-golden");
  });

  test("every capture declares one executor-reported origin", async () => {
    const start = buildStartInput(await assembly());
    const expected = {
      kind: "executor-reported",
      reporter: "https://jinn.network/software/agent-host/hermes",
      capturedBy: PRODUCER_IRI,
    };
    expect(start.task.origin).toEqual(expected);
    expect(start.runtime.origin).toEqual(expected);
    expect(start.executor.origin).toEqual(expected);
    expect(start.producer.origin).toEqual(expected);
  });

  test("is deterministic for one feed", async () => {
    expect(JSON.stringify(buildStartInput(await assembly()))).toBe(
      JSON.stringify(buildStartInput(await assembly())),
    );
  });
});

describe("buildFinalizeInput", () => {
  test("always supplies a result, so a completed execution conforms", async () => {
    const finalize = buildFinalizeInput(await assembly());
    expect(finalize.outcome).toBe("completed");
    expect(finalize.endedAt).toBe("2026-07-30T09:00:06Z");
    expect(finalize.results).toHaveLength(1);
    expect(finalize.results?.[0]?.entityId).toBe("results/session-summary.json");
    const summary = JSON.parse(
      new TextDecoder().decode(
        (finalize.results![0] as { source: { bytes: Uint8Array } }).source.bytes,
      ),
    );
    expect(summary).toEqual({
      outcome: "completed",
      endedAt: "2026-07-30T09:00:06Z",
      summary: "Locate the retry budget",
      userTurns: 1,
      assistantTurns: 1,
      toolCalls: 2,
      failedToolCalls: 1,
      tokens: { inputTokens: 1024, outputTokens: 256 },
    });
  });

  test("attaches the feed by path with its format IRI", async () => {
    const finalize = buildFinalizeInput(await assembly());
    expect(finalize.nativeTrace?.format.entityId).toBe(SESSION_FEED_FORMAT_IRI);
    const artifact = finalize.nativeTrace!.artifact;
    expect(artifact.entityId).toBe("trace/feed.ndjson");
    expect(artifact.kind === "file" && artifact.source.path).toBe(
      "/home/op/capture/sessions/s-golden/feed.ndjson",
    );
    expect(artifact.kind === "file" && artifact.source.bytes).toBeUndefined();
    expect(artifact.kind === "file" && artifact.source.mediaType).toBe(SESSION_FEED_MEDIA_TYPE);
  });

  test("links the trajectory record forward as an identifier on the trace entity", async () => {
    const finalize = buildFinalizeInput(await assembly());
    expect(finalize.nativeTrace?.artifact.identifiers).toEqual([
      { propertyId: TRACE_RECORD_IDENTIFIER_PROPERTY, value: TRACE_DIGEST },
    ]);
  });
});
