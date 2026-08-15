import { describe, expect, test } from "vitest";

import { deriveSpanId, deriveTraceId } from "./identity.js";

const input = {
  sourceDigest: "sha256:".concat("a".repeat(64)),
  formatIri: "https://spec.jinn.network/formats/claude-code-stream-json/v1",
  decoderId: "claude-code-stream-json",
  decoderVersion: "1.0.0",
  vocabularyProfile: "https://spec.jinn.network/profiles/trace-vocabulary/v1",
};

describe("identity derivation", () => {
  test("trace id is 32 lowercase hex characters", () => {
    expect(deriveTraceId(input)).toMatch(/^[0-9a-f]{32}$/);
  });

  test("trace id is stable across calls", () => {
    expect(deriveTraceId(input)).toBe(deriveTraceId({ ...input }));
  });

  test("every input field changes the trace id", () => {
    const base = deriveTraceId(input);
    expect(deriveTraceId({ ...input, sourceDigest: `sha256:${"b".repeat(64)}` })).not.toBe(base);
    expect(deriveTraceId({ ...input, formatIri: "https://example.test/other/v1" })).not.toBe(base);
    expect(deriveTraceId({ ...input, decoderId: "other" })).not.toBe(base);
    expect(deriveTraceId({ ...input, decoderVersion: "1.0.1" })).not.toBe(base);
    expect(deriveTraceId({ ...input, vocabularyProfile: "https://example.test/v2" })).not.toBe(base);
  });

  test("field boundaries are unambiguous", () => {
    const a = deriveTraceId({ ...input, decoderId: "ab", decoderVersion: "c" });
    const b = deriveTraceId({ ...input, decoderId: "a", decoderVersion: "bc" });
    expect(a).not.toBe(b);
  });

  test("span id is 16 lowercase hex and ordinal-sensitive", () => {
    const traceId = deriveTraceId(input);
    expect(deriveSpanId(traceId, 0)).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveSpanId(traceId, 0)).not.toBe(deriveSpanId(traceId, 1));
    expect(deriveSpanId(traceId, 7)).toBe(deriveSpanId(traceId, 7));
  });

  test("span ids do not collide across traces", () => {
    const other = deriveTraceId({ ...input, decoderId: "other" });
    expect(deriveSpanId(deriveTraceId(input), 0)).not.toBe(deriveSpanId(other, 0));
  });

  test("rejects a negative or non-integer ordinal", () => {
    const traceId = deriveTraceId(input);
    expect(() => deriveSpanId(traceId, -1)).toThrow(RangeError);
    expect(() => deriveSpanId(traceId, 1.5)).toThrow(RangeError);
  });
});
