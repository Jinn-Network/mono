import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_ROOT = new URL("../fixtures/", import.meta.url);

/**
 * Resolves a path inside the fixture corpus shipped by this package.
 *
 * The check is on the RESOLVED url, not on the input string. A textual `".."` scan is not
 * enough: WHATWG URL treats `%2e%2e` (and `.%2e`, `%2e.`) as a double-dot path segment, so
 * `x/%2e%2e/%2e%2e/package.json` passes a string scan and still resolves above
 * `fixtures/`. These loaders are exported from `/testing`, so a consumer may pass a name it
 * did not author.
 */
export function benchmarkingFixtureUrl(relativePath: string): URL {
  const resolved = new URL(relativePath, FIXTURES_ROOT);
  if (resolved.protocol !== FIXTURES_ROOT.protocol || !resolved.href.startsWith(FIXTURES_ROOT.href)) {
    throw new Error("benchmarking fixture paths must stay inside fixtures/");
  }
  return resolved;
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
