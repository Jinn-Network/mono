import { describe, expect, test } from "vitest";

import { SPAN_KIND, STATUS_CODE, SpanSchema } from "./span.js";

const span = {
  spanId: "0123456789abcdef",
  parentSpanId: null,
  name: "chat anthropic/claude-opus-4.6",
  kind: SPAN_KIND.CLIENT,
  startTimeUnixNano: "1544712660300000000",
  endTimeUnixNano: "1544712661300000000",
  attributes: [
    { key: "gen_ai.provider.name", value: { stringValue: "anthropic" } },
    { key: "gen_ai.usage.input_tokens", value: { intValue: "1024" } },
  ],
  events: [],
  status: { code: STATUS_CODE.OK },
};

describe("span schema", () => {
  test("accepts a well-formed span", () => {
    expect(SpanSchema.safeParse(span).success).toBe(true);
  });

  test("rejects attributes that are not sorted by key", () => {
    const result = SpanSchema.safeParse({
      ...span,
      attributes: [
        { key: "gen_ai.usage.input_tokens", value: { intValue: "1024" } },
        { key: "gen_ai.provider.name", value: { stringValue: "anthropic" } },
      ],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("sorted");
  });

  test("rejects duplicate attribute keys", () => {
    const result = SpanSchema.safeParse({
      ...span,
      attributes: [
        { key: "gen_ai.provider.name", value: { stringValue: "a" } },
        { key: "gen_ai.provider.name", value: { stringValue: "b" } },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("rejects uppercase or short identifiers", () => {
    expect(SpanSchema.safeParse({ ...span, spanId: "0123456789ABCDEF" }).success).toBe(false);
    expect(SpanSchema.safeParse({ ...span, spanId: "0123" }).success).toBe(false);
  });

  test("rejects non-decimal-string timestamps", () => {
    expect(SpanSchema.safeParse({ ...span, startTimeUnixNano: 1544712660300000000 }).success).toBe(
      false,
    );
    expect(SpanSchema.safeParse({ ...span, startTimeUnixNano: "12.5" }).success).toBe(false);
  });

  test("rejects an end time before the start time", () => {
    expect(
      SpanSchema.safeParse({
        ...span,
        startTimeUnixNano: "20",
        endTimeUnixNano: "10",
      }).success,
    ).toBe(false);
  });

  test("rejects an unknown span kind or status code", () => {
    expect(SpanSchema.safeParse({ ...span, kind: 9 }).success).toBe(false);
    expect(SpanSchema.safeParse({ ...span, status: { code: 7 } }).success).toBe(false);
  });

  test("accepts exactly one AnyValue variant and rejects two", () => {
    expect(
      SpanSchema.safeParse({
        ...span,
        attributes: [{ key: "a", value: { stringValue: "x", intValue: "1" } }],
      }).success,
    ).toBe(false);
    expect(
      SpanSchema.safeParse({ ...span, attributes: [{ key: "a", value: {} }] }).success,
    ).toBe(false);
  });
});
