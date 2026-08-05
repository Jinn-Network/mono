import { readFile } from "node:fs/promises";

import {
  SPAN_KIND,
  STATUS_CODE,
  SpanSchema,
  compareCodeUnitStrings,
  deriveSpanId,
} from "@jinn-network/evidence-trace";
import { describe, expect, test } from "vitest";

import { parseSessionFeed } from "./feed.js";
import { buildTraceSpans } from "./spans.js";

const TRACE_ID = "0".repeat(31).concat("1");

const golden = async () =>
  parseSessionFeed(
    new Uint8Array(await readFile(new URL("../../fixtures/capture/session.ndjson", import.meta.url))),
  );

const attribute = (span: { attributes: readonly { key: string; value: unknown }[] }, key: string) =>
  span.attributes.find((entry) => entry.key === key)?.value;

describe("buildTraceSpans", () => {
  test("every span validates under the C1 span schema", async () => {
    for (const span of buildTraceSpans({ feed: await golden(), traceId: TRACE_ID })) {
      const result = SpanSchema.safeParse(span);
      expect(result.success, JSON.stringify(result)).toBe(true);
    }
  });

  test("span identifiers are derived from the trace id and the array ordinal", async () => {
    const spans = buildTraceSpans({ feed: await golden(), traceId: TRACE_ID });
    spans.forEach((span, ordinal) => {
      expect(span.spanId).toBe(deriveSpanId(TRACE_ID, ordinal));
    });
  });

  test("span 0 is the session, parents nothing, and carries the outcome and token usage", async () => {
    const [session] = buildTraceSpans({ feed: await golden(), traceId: TRACE_ID });
    expect(session?.parentSpanId).toBeNull();
    expect(session?.kind).toBe(SPAN_KIND.INTERNAL);
    expect(session?.name).toBe("invoke_agent Hermes");
    expect(session?.startTimeUnixNano).toBe("1785488400000000000");
    expect(session?.endTimeUnixNano).toBe("1785488406000000000");
    expect(attribute(session!, "gen_ai.operation.name")).toEqual({ stringValue: "invoke_agent" });
    expect(attribute(session!, "gen_ai.provider.name")).toEqual({ stringValue: "anthropic" });
    expect(attribute(session!, "gen_ai.conversation.id")).toEqual({ stringValue: "c-1" });
    expect(attribute(session!, "gen_ai.usage.input_tokens")).toEqual({ intValue: "1024" });
    expect(attribute(session!, "gen_ai.usage.output_tokens")).toEqual({ intValue: "256" });
    expect(attribute(session!, "jinn.trace.outcome")).toEqual({ stringValue: "completed" });
    expect(session?.status).toEqual({ code: STATUS_CODE.OK });
  });

  test("every non-session span parents to the session span", async () => {
    const spans = buildTraceSpans({ feed: await golden(), traceId: TRACE_ID });
    for (const span of spans.slice(1)) expect(span.parentSpanId).toBe(spans[0]!.spanId);
  });

  test("spans follow the feed order of their terminating event", async () => {
    const spans = buildTraceSpans({ feed: await golden(), traceId: TRACE_ID });
    expect(spans.map((span) => span.name)).toEqual([
      "invoke_agent Hermes",
      "execute_tool read_file",
      "chat claude-opus-4.6",
      "execute_tool write_file",
    ]);
  });

  test("the chat span spans from the session start to the assistant turn and carries its user event", async () => {
    const chat = buildTraceSpans({ feed: await golden(), traceId: TRACE_ID })[2]!;
    expect(chat.kind).toBe(SPAN_KIND.CLIENT);
    expect(chat.startTimeUnixNano).toBe("1785488400000000000");
    expect(chat.endTimeUnixNano).toBe("1785488403000000000");
    expect(attribute(chat, "jinn.trace.turn.role")).toEqual({ stringValue: "assistant" });
    expect(attribute(chat, "jinn.trace.source.ordinal")).toEqual({ intValue: "4" });
    expect(attribute(chat, "gen_ai.response.model")).toEqual({ stringValue: "claude-opus-4.6" });
    expect(chat.events).toHaveLength(1);
    expect(chat.events[0]?.name).toBe("gen_ai.user.message");
    expect(chat.events[0]?.timeUnixNano).toBe("1785488401000000000");
    expect(chat.events[0]?.attributes.map((entry) => entry.key)).toEqual([
      "jinn.trace.source.ordinal",
      "jinn.trace.turn.role",
    ]);
  });

  test("a failed tool call becomes an ERROR span carrying its message", async () => {
    const failing = buildTraceSpans({ feed: await golden(), traceId: TRACE_ID })[3]!;
    expect(failing.status).toEqual({ code: STATUS_CODE.ERROR, message: "read-only workspace" });
    expect(attribute(failing, "gen_ai.tool.call.id")).toEqual({ stringValue: "call-2" });
    expect(attribute(failing, "gen_ai.tool.name")).toEqual({ stringValue: "write_file" });
    expect(failing.startTimeUnixNano).toBe("1785488404000000000");
    expect(failing.endTimeUnixNano).toBe("1785488404200000000");
  });

  test("no span carries message content", async () => {
    const serialized = JSON.stringify(
      buildTraceSpans({ feed: await golden(), traceId: TRACE_ID }),
    );
    expect(serialized).not.toContain("Find where the retry budget");
    expect(serialized).not.toContain("RETRY_BUDGET");
    expect(serialized).not.toContain("src/retry.ts");
  });

  test("attributes are sorted by code unit and unique in every span and event", async () => {
    for (const span of buildTraceSpans({ feed: await golden(), traceId: TRACE_ID })) {
      for (const list of [span.attributes, ...span.events.map((event) => event.attributes)]) {
        const keys = list.map((entry) => entry.key);
        expect(keys).toEqual([...keys].sort(compareCodeUnitStrings));
        expect(new Set(keys).size).toBe(keys.length);
      }
    }
  });

  test("is a pure function of the feed", async () => {
    const feed = await golden();
    expect(JSON.stringify(buildTraceSpans({ feed, traceId: TRACE_ID }))).toBe(
      JSON.stringify(buildTraceSpans({ feed: await golden(), traceId: TRACE_ID })),
    );
  });

  test("a feed with only an open and close yields exactly the session span", async () => {
    const feed = parseSessionFeed(
      new Uint8Array(
        await readFile(new URL("../../fixtures/capture/session-minimal.ndjson", import.meta.url)),
      ),
    );
    const spans = buildTraceSpans({ feed, traceId: TRACE_ID });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status).toEqual({ code: STATUS_CODE.UNSET });
    expect(attribute(spans[0]!, "jinn.trace.outcome")).toEqual({ stringValue: "abandoned" });
  });

  test("an unclosed feed ends the session at its last event and reports abandoned", () => {
    const bytes = new TextEncoder().encode(
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
        JSON.stringify({ type: "user-turn", atUnixNano: "2000", text: "hello" }),
      ].join("\n") + "\n",
    );
    const spans = buildTraceSpans({ feed: parseSessionFeed(bytes), traceId: TRACE_ID });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.endTimeUnixNano).toBe("2000");
    // A trailing user turn with no assistant reply lands on the session span as an event.
    expect(spans[0]?.events).toHaveLength(1);
    expect(spans[0]?.events[0]?.name).toBe("gen_ai.user.message");
  });
});
