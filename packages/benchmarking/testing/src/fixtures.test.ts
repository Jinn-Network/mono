import { describe, expect, test } from "vitest";

import { benchmarkingFixtureUrl } from "./fixtures.js";

describe("the shipped fixture corpus", () => {
  test("resolves a relative path inside fixtures/", () => {
    const root = new URL("../fixtures/", import.meta.url).href;
    expect(benchmarkingFixtureUrl("miniature-run/benchmark.json").href)
      .toBe(`${root}miniature-run/benchmark.json`);
  });

  test("refuses a path that escapes fixtures/", () => {
    expect(() => benchmarkingFixtureUrl("/etc/passwd")).toThrow();
    expect(() => benchmarkingFixtureUrl("../package.json")).toThrow();
    expect(() => benchmarkingFixtureUrl("miniature-run/../../package.json")).toThrow();
    // WHATWG URL resolves these as double-dot path segments, so a textual ".." scan misses
    // them and the guard has to be on the resolved url instead.
    expect(() => benchmarkingFixtureUrl("x/%2e%2e/%2e%2e/package.json")).toThrow();
    expect(() => benchmarkingFixtureUrl("x/%2E%2E/%2E%2E/package.json")).toThrow();
    expect(() => benchmarkingFixtureUrl("x/.%2e/.%2e/package.json")).toThrow();
    expect(() => benchmarkingFixtureUrl("file:///etc/passwd")).toThrow();
    expect(() => benchmarkingFixtureUrl("https://example.invalid/x")).toThrow();
  });
});
