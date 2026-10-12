import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { benchmarkingFixtureUrl, listBenchmarkingFixtures } from "./fixtures.js";

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

describe("listBenchmarkingFixtures", () => {
  // `.DS_Store` is machine-local Finder junk that the fixture manifest never pins either.
  const listed = async (directory?: string): Promise<string[]> =>
    (await listBenchmarkingFixtures(directory)).filter((path) => !path.endsWith(".DS_Store"));

  test("lists the whole corpus when called with no argument", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../fixtures/manifest.sha256.json", import.meta.url), "utf8"),
    ) as { entries: { id: string }[] };
    // The manifest pins every shipped fixture except itself, so it is an independent oracle for
    // "every file in the shipped corpus".
    const corpus = [...manifest.entries.map((entry) => entry.id), "manifest.sha256.json"].sort();

    expect(await listed()).toEqual(corpus);
  });

  test("treats the root spelled out the same as the default", async () => {
    const whole = await listed("./");
    expect(await listed()).toEqual(whole);
    expect(await listed("")).toEqual(whole);
  });

  test("a subdirectory lists exactly its own files, still relative to the corpus root", async () => {
    const whole = await listed("./");
    const subdirectory = await listed("miniature-run");

    expect(subdirectory).toContain("miniature-run/expected-matrix.json");
    expect(await listed("miniature-run/")).toEqual(subdirectory);
    expect(subdirectory).toEqual(whole.filter((path) => path.startsWith("miniature-run/")));
  });

  test("still refuses a directory that escapes fixtures/", async () => {
    await expect(listBenchmarkingFixtures("..")).rejects.toThrow("must stay inside fixtures/");
    await expect(listBenchmarkingFixtures("/etc")).rejects.toThrow("must stay inside fixtures/");
  });
});
