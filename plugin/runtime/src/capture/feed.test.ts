import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { PluginRuntimeError } from "../errors.js";
import { SESSION_FEED_FORMAT_IRI, SESSION_FEED_MEDIA_TYPE, executorIri } from "./identity.js";
import { parseSessionFeed } from "./feed.js";

const fixture = async (name: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(new URL(`../../fixtures/capture/${name}`, import.meta.url)));

const encode = (lines: readonly unknown[]): Uint8Array =>
  new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

const open = {
  type: "session-open",
  v: 1,
  sessionId: "s-1",
  startedAt: "2026-07-30T09:00:00Z",
  atUnixNano: "1000",
  host: { name: "Hermes", version: "0.9.1" },
  model: { provider: "anthropic", name: "claude-opus-4.6" },
};
const close = {
  type: "session-close",
  atUnixNano: "9000",
  endedAt: "2026-07-30T09:00:06Z",
  outcome: "completed",
  summary: "s",
};

describe("session feed identity", () => {
  test("declares one format IRI and media type for the feed", () => {
    expect(SESSION_FEED_FORMAT_IRI).toBe("https://spec.jinn.network/formats/agent-session-feed/v1");
    expect(SESSION_FEED_MEDIA_TYPE).toBe("application/x-ndjson");
  });

  test("derives an absolute executor IRI from the host name", () => {
    expect(executorIri("Hermes")).toBe("https://spec.jinn.network/software/agent-host/hermes");
    expect(executorIri("Claude Code")).toBe("https://spec.jinn.network/software/agent-host/claude-code");
    expect(() => executorIri("  ")).toThrow(PluginRuntimeError);
  });
});

describe("parseSessionFeed", () => {
  test("parses the golden feed with stable line ordinals", async () => {
    const feed = parseSessionFeed(await fixture("session.ndjson"));
    expect(feed.sessionId).toBe("s-golden");
    expect(feed.open.host.name).toBe("Hermes");
    expect(feed.close?.outcome).toBe("completed");
    expect(feed.lines).toHaveLength(8);
    expect(feed.lines.map((line) => line.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(feed.lines[3]?.event.type).toBe("tool-call");
    expect(feed.tokens).toEqual({ inputTokens: 1024, outputTokens: 256 });
    expect(feed.environment).toEqual({
      tools: ["read_file", "write_file"],
      skills: ["superpowers:writing-plans"],
    });
  });

  test("parses a feed carrying nothing but its open and close", async () => {
    const feed = parseSessionFeed(await fixture("session-minimal.ndjson"));
    expect(feed.lines).toHaveLength(2);
    expect(feed.tokens).toBeUndefined();
    expect(feed.environment).toBeUndefined();
  });

  test("tolerates a feed with no close event", () => {
    const feed = parseSessionFeed(encode([open]));
    expect(feed.close).toBeUndefined();
  });

  test("rejects bytes that are not valid UTF-8", () => {
    expect(() => parseSessionFeed(new Uint8Array([0xff, 0xfe]))).toThrow(PluginRuntimeError);
  });

  test("rejects a line that is not JSON, naming the ordinal", () => {
    const bytes = new TextEncoder().encode(`${JSON.stringify(open)}\nnot json\n`);
    expect(() => parseSessionFeed(bytes)).toThrow(/line 1/u);
  });

  test("rejects an unknown event type and an unknown key", () => {
    expect(() => parseSessionFeed(encode([open, { type: "mystery", atUnixNano: "2000" }]))).toThrow(
      PluginRuntimeError,
    );
    expect(() =>
      parseSessionFeed(encode([open, { type: "user-turn", atUnixNano: "2000", text: "x", extra: 1 }])),
    ).toThrow(PluginRuntimeError);
  });

  test("requires session-open first and exactly once", () => {
    expect(() => parseSessionFeed(encode([{ type: "user-turn", atUnixNano: "1", text: "x" }]))).toThrow(
      /session-open/u,
    );
    expect(() => parseSessionFeed(encode([open, open]))).toThrow(/session-open/u);
    expect(() => parseSessionFeed(new Uint8Array())).toThrow(/session-open/u);
  });

  test("requires session-close to be last and at most once", () => {
    expect(() =>
      parseSessionFeed(encode([open, close, { type: "user-turn", atUnixNano: "9500", text: "x" }])),
    ).toThrow(/session-close/u);
  });

  test("requires non-decreasing timestamps", () => {
    expect(() =>
      parseSessionFeed(encode([open, { type: "user-turn", atUnixNano: "500", text: "x" }])),
    ).toThrow(/non-decreasing/u);
  });

  test("requires a tool call to end no earlier than it started", () => {
    expect(() =>
      parseSessionFeed(
        encode([
          open,
          {
            type: "tool-call",
            startedAtUnixNano: "5000",
            atUnixNano: "2000",
            toolName: "t",
            toolCallId: "c",
            status: "ok",
            arguments: "{}",
            result: "",
          },
        ]),
      ),
    ).toThrow(/tool call/u);
  });

  test("requires the close wall clock not to precede the open wall clock", () => {
    expect(() =>
      parseSessionFeed(encode([open, { ...close, endedAt: "2026-07-30T08:59:59Z" }])),
    ).toThrow(/endedAt/u);
  });

  test("rejects timestamps that are not unsigned decimal strings", () => {
    expect(() => parseSessionFeed(encode([{ ...open, atUnixNano: 1000 }]))).toThrow(PluginRuntimeError);
    expect(() => parseSessionFeed(encode([{ ...open, atUnixNano: "0100" }]))).toThrow(PluginRuntimeError);
  });

  test("rejects a non-RFC3339 wall clock", () => {
    expect(() => parseSessionFeed(encode([{ ...open, startedAt: "2026-07-30 09:00:00" }]))).toThrow(
      PluginRuntimeError,
    );
  });

  test("rejects a feed version this build does not implement", () => {
    expect(() => parseSessionFeed(encode([{ ...open, v: 2 }]))).toThrow(PluginRuntimeError);
  });

  test("keeps the last tokens and environment event when repeated", () => {
    const feed = parseSessionFeed(
      encode([
        open,
        { type: "tokens", atUnixNano: "2000", inputTokens: 1, outputTokens: 2 },
        { type: "tokens", atUnixNano: "3000", inputTokens: 10, outputTokens: 20 },
      ]),
    );
    expect(feed.tokens).toEqual({ inputTokens: 10, outputTokens: 20 });
  });
});
