// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import { deriveFence, FENCE_PREFIX, quoteBlock, QUOTE_PREFIX } from "./fence.js";
import { truncateLineBoundary, TRUNCATION_TAIL } from "./truncate.js";

describe("provenance fence", () => {
  test("is prefixed, hex, and stable for the same content", () => {
    const fence = deriveFence(["alpha", "beta"]);
    expect(fence.startsWith(FENCE_PREFIX)).toBe(true);
    expect(fence.slice(FENCE_PREFIX.length)).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveFence(["alpha", "beta"])).toBe(fence);
  });

  test("changes with the content", () => {
    expect(deriveFence(["alpha"])).not.toBe(deriveFence(["alpha", "beta"]));
    expect(deriveFence(["a", "bc"])).not.toBe(deriveFence(["ab", "c"]));
  });

  test("is never contained in the content it fences", () => {
    const guessed = deriveFence(["payload"]);
    const attack = `payload with ${guessed} embedded`;
    const fence = deriveFence([attack]);
    expect(attack.includes(fence)).toBe(false);
  });

  test("survives content engineered to contain its own fence", () => {
    // Feed the derivation a body that already contains every fence it might produce for a
    // short prefix; the counter loop must still terminate on a fence absent from the body.
    const body = Array.from({ length: 64 }, (_unused, index) =>
      deriveFence([`seed-${index}`]),
    ).join(" ");
    const fence = deriveFence([body]);
    expect(body.includes(fence)).toBe(false);
  });

  test("quoting prefixes every line, including empty ones", () => {
    expect(quoteBlock("one\n\ntwo")).toBe(`${QUOTE_PREFIX}one\n${QUOTE_PREFIX}\n${QUOTE_PREFIX}two`);
  });

  test("quoting neutralises carriage returns and lone control characters", () => {
    const quoted = quoteBlock("first\r\nsecond\u0007 third");
    expect(quoted.split("\n").every((line) => line.startsWith(QUOTE_PREFIX))).toBe(true);
    expect(quoted).not.toContain("\u0007");
    expect(quoted).not.toContain("\r");
  });
});

describe("line-boundary truncation", () => {
  test("returns text that already fits, unchanged", () => {
    expect(truncateLineBoundary("short", 100)).toBe("short");
  });

  test("cuts at a line boundary and marks the cut", () => {
    const text = "line one\nline two\nline three";
    const truncated = truncateLineBoundary(text, 29);
    expect(truncated.endsWith(TRUNCATION_TAIL)).toBe(true);
    expect(truncated.length).toBeLessThanOrEqual(29);
    expect(truncated).toBe(`line one\nline two${TRUNCATION_TAIL}`);
  });

  test("falls back to a hard cut when there is no line boundary to use", () => {
    const truncated = truncateLineBoundary("a".repeat(50), 20);
    expect(truncated.length).toBeLessThanOrEqual(20);
    expect(truncated.endsWith(TRUNCATION_TAIL)).toBe(true);
  });

  test("returns empty when the budget cannot hold both content and the marker", () => {
    expect(truncateLineBoundary("some text", 5)).toBe("");
    expect(truncateLineBoundary("some text", TRUNCATION_TAIL.length)).toBe("");
  });

  test("never splits a surrogate pair", () => {
    const truncated = truncateLineBoundary("🙂".repeat(20), 20);
    expect(() => [...truncated]).not.toThrow();
    expect(truncated).not.toMatch(/[\uD800-\uDBFF]$/u);
  });
});
