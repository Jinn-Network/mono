// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";
import { formatIriForEnvelopeFormat } from "@jinn-network/evidence-trace-decode";

import { createTraceSpanSource } from "./trace-decode-adapter.js";

const DIGEST = `sha256:${"d".repeat(64)}` as const;
const CLAUDE_CODE = formatIriForEnvelopeFormat("claude-code-stream-json");

describe("trace decode adapter", () => {
  test("the first real format resolves to a canonical IRI", () => {
    expect(CLAUDE_CODE).toBe("https://spec.jinn.network/formats/claude-code-stream-json/v1");
  });

  test("an unknown format yields no spans and does not throw", () => {
    const source = createTraceSpanSource();
    expect(
      source.spansFor({
        formatIri: "https://example.test/formats/nope/v1",
        bytes: new TextEncoder().encode("{}"),
        nativeTraceDigest: DIGEST,
      }),
    ).toEqual([]);
  });

  test("a non-harness-trace format is skipped without attempting a decode", () => {
    const source = createTraceSpanSource();
    expect(
      source.spansFor({
        formatIri: "https://spec.jinn.network/formats/backend-local-supervisor-facts/v1",
        bytes: new TextEncoder().encode("{}"),
        nativeTraceDigest: DIGEST,
      }),
    ).toEqual([]);
  });

  test("an absent format yields no spans", () => {
    const source = createTraceSpanSource();
    expect(source.spansFor({ bytes: new Uint8Array(), nativeTraceDigest: DIGEST })).toEqual([]);
  });

  test("garbage bytes under a known format degrade to no spans, never a throw", () => {
    const source = createTraceSpanSource();
    expect(() =>
      source.spansFor({
        formatIri: CLAUDE_CODE!,
        bytes: new Uint8Array([0xff, 0xff, 0xff]),
        nativeTraceDigest: DIGEST,
      }),
    ).not.toThrow();
  });

  test("a real claude-code stream decodes to spans", () => {
    const source = createTraceSpanSource();
    const bytes = new TextEncoder().encode(
      [
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
        JSON.stringify({ type: "result", subtype: "success" }),
      ].join("\n"),
    );
    const spans = source.spansFor({
      formatIri: CLAUDE_CODE!,
      bytes,
      nativeTraceDigest: DIGEST,
    });
    expect(Array.isArray(spans)).toBe(true);
  });
});
