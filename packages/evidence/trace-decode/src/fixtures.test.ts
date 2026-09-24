import { describe, expect, test } from "vitest";

import { traceDecodeFixtureUrl } from "./fixtures.js";

describe("the shipped fixture corpus", () => {
  test("resolves a relative path inside fixtures/", () => {
    const root = new URL("../fixtures/", import.meta.url).href;
    expect(traceDecodeFixtureUrl("claude-code-stream-json/manifest.json").href)
      .toBe(`${root}claude-code-stream-json/manifest.json`);
  });

  test("refuses a path that escapes fixtures/", () => {
    expect(() => traceDecodeFixtureUrl("/etc/passwd")).toThrow();
    expect(() => traceDecodeFixtureUrl("../package.json")).toThrow();
    expect(() => traceDecodeFixtureUrl("claude-code-stream-json/../../package.json")).toThrow();
    // WHATWG URL resolves these as double-dot path segments, so a textual ".." scan misses
    // them and the guard has to be on the resolved url instead.
    expect(() => traceDecodeFixtureUrl("x/%2e%2e/%2e%2e/package.json")).toThrow();
    expect(() => traceDecodeFixtureUrl("x/%2E%2E/%2E%2E/package.json")).toThrow();
    expect(() => traceDecodeFixtureUrl("x/.%2e/.%2e/package.json")).toThrow();
    expect(() => traceDecodeFixtureUrl("file:///etc/passwd")).toThrow();
    expect(() => traceDecodeFixtureUrl("https://example.invalid/x")).toThrow();
  });
});
