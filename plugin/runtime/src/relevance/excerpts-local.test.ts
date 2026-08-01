// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";
import { GEN_AI_ATTRIBUTES, JINN_ATTRIBUTES, SPAN_KIND, STATUS_CODE } from "@jinn-network/evidence-trajectory";
import type { Span } from "@jinn-network/evidence-trajectory";

import { excerptsFromSpans, spanAttribute } from "./excerpts-local.js";

const DIGEST = `sha256:${"c".repeat(64)}` as const;

const span = (
  ordinal: number,
  overrides: {
    readonly toolName?: string;
    readonly role?: string;
    readonly status?: number;
  } = {},
): Span => {
  const attributes = [
    ...(overrides.toolName === undefined
      ? []
      : [{ key: GEN_AI_ATTRIBUTES.toolName, value: { stringValue: overrides.toolName } }]),
    ...(overrides.role === undefined
      ? []
      : [{ key: JINN_ATTRIBUTES.turnRole, value: { stringValue: overrides.role } }]),
    { key: JINN_ATTRIBUTES.sourceOrdinal, value: { intValue: String(ordinal) } },
  ].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return {
    spanId: String(ordinal).padStart(16, "0"),
    parentSpanId: null,
    name: overrides.toolName ?? "turn",
    kind: SPAN_KIND.INTERNAL,
    startTimeUnixNano: String(1_000 + ordinal),
    endTimeUnixNano: String(2_000 + ordinal),
    attributes,
    events: [],
    status: { code: overrides.status ?? STATUS_CODE.OK },
  } as Span;
};

const feed = (lines: readonly unknown[]): Uint8Array =>
  new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join("\n"));

describe("local-plane excerpts", () => {
  test("reads an attribute out of a span", () => {
    expect(spanAttribute(span(3, { toolName: "Bash" }), GEN_AI_ATTRIBUTES.toolName)).toBe("Bash");
    expect(spanAttribute(span(3), "absent")).toBeUndefined();
  });

  test("selects failure, fix, and last-passing command in that order", () => {
    const excerpts = excerptsFromSpans({
      spans: [
        span(0, { toolName: "Bash", status: STATUS_CODE.ERROR }),
        span(1, { toolName: "Bash" }),
        span(2, { toolName: "Bash" }),
      ],
      feedBytes: feed([
        { command: "yarn test", result: "FAIL src/a.test.ts" },
        { command: "yarn test --no-threads", result: "PASS" },
        { command: "yarn build", result: "done" },
      ]),
      sourceEntityId: "session-feed.ndjson",
      sourceDigest: DIGEST,
    });
    expect(excerpts.map((excerpt) => excerpt.label)).toEqual(["failure", "fix", "command"]);
    expect(excerpts[0]!.text).toContain("FAIL src/a.test.ts");
    expect(excerpts[1]!.text).toContain("--no-threads");
    expect(excerpts[2]!.text).toContain("yarn build");
  });

  test("a diff-bearing line becomes a diff excerpt", () => {
    const excerpts = excerptsFromSpans({
      spans: [span(0, { toolName: "Edit" })],
      feedBytes: feed([{ diff: "--- a/x\n+++ b/x\n+added" }]),
      sourceEntityId: "session-feed.ndjson",
      sourceDigest: DIGEST,
    });
    expect(excerpts.map((excerpt) => excerpt.label)).toContain("diff");
  });

  test("a conversational session contributes the assistant turn, not the prompt", () => {
    const excerpts = excerptsFromSpans({
      spans: [span(0, { role: "user" }), span(1, { role: "assistant" })],
      feedBytes: feed([{ text: "how do I rebuild the index?" }, { text: "run yarn rebuild" }]),
      sourceEntityId: "session-feed.ndjson",
      sourceDigest: DIGEST,
    });
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0]!.label).toBe("note");
    expect(excerpts[0]!.text).toBe("run yarn rebuild");
  });

  test("every excerpt is attributed to the digest-bound feed", () => {
    const excerpts = excerptsFromSpans({
      spans: [span(0, { toolName: "Bash" })],
      feedBytes: feed([{ command: "ls" }]),
      sourceEntityId: "session-feed.ndjson",
      sourceDigest: DIGEST,
    });
    expect(excerpts[0]!.sourceEntityId).toBe("session-feed.ndjson");
    expect(excerpts[0]!.sourceDigest).toBe(DIGEST);
  });

  test("a span pointing past the end of the feed is skipped, not fatal", () => {
    const excerpts = excerptsFromSpans({
      spans: [span(99, { toolName: "Bash" })],
      feedBytes: feed([{ command: "ls" }]),
      sourceEntityId: "session-feed.ndjson",
      sourceDigest: DIGEST,
    });
    expect(excerpts).toEqual([]);
  });

  test("empty spans, empty feed, and a malformed feed all yield nothing", () => {
    const base = { sourceEntityId: "f", sourceDigest: DIGEST } as const;
    expect(excerptsFromSpans({ ...base, spans: [], feedBytes: feed([]) })).toEqual([]);
    expect(
      excerptsFromSpans({
        ...base,
        spans: [span(0, { toolName: "Bash" })],
        feedBytes: new TextEncoder().encode("not json at all"),
      }),
    ).toEqual([]);
  });
});
