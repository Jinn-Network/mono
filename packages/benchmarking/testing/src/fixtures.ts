import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve a path inside the fixture corpus shipped by this package. */
export function benchmarkingFixtureUrl(relativePath: string): URL {
  if (relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
    throw new Error("benchmarking fixture paths must stay inside fixtures/");
  }
  return new URL(`../fixtures/${relativePath}`, import.meta.url);
}

export async function loadBenchmarkingFixtureBytes(relativePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(benchmarkingFixtureUrl(relativePath)));
}

export async function loadBenchmarkingFixtureText(relativePath: string): Promise<string> {
  return readFile(benchmarkingFixtureUrl(relativePath), "utf8");
}

export async function loadBenchmarkingFixtureJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await loadBenchmarkingFixtureText(relativePath));
}

export async function listBenchmarkingFixtures(relativeDirectory = ""): Promise<string[]> {
  const url = benchmarkingFixtureUrl(relativeDirectory.endsWith("/") ? relativeDirectory : `${relativeDirectory}/`);
  const fixtureRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));
  return (await readdir(url, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(fixtureRoot, join(entry.parentPath, entry.name)))
    .sort();
}
