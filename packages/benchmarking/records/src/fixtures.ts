import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

function fixtureUrl(relativePath: string): URL {
  return new URL(`../fixtures/${relativePath}`, import.meta.url);
}

async function readFixtureBytes(relativePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(fixtureUrl(relativePath)));
}

async function readFixtureText(relativePath: string): Promise<string> {
  return (await readFile(fixtureUrl(relativePath), "utf8")).trim();
}

async function readFixtureJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(fixtureUrl(relativePath), "utf8"));
}

export type RecordKind = "benchmark" | "run" | "matrix" | "report" | "benchmark-accounting" | "observation-archive";

/** Golden sealed-record fixtures, one directory per record kind (§16). */
export async function loadGoldenBytes(kind: RecordKind, name: string): Promise<Uint8Array> {
  return readFixtureBytes(`${kind}/${name}.json`);
}

export async function loadGoldenJson(kind: RecordKind, name: string): Promise<unknown> {
  return readFixtureJson(`${kind}/${name}.json`);
}

/** The pinned digest for a golden fixture (e.g. `benchmark`/`valid` -> `benchmark/valid.sha256`). */
export async function loadGoldenDigest(kind: RecordKind, name: string): Promise<`sha256:${string}`> {
  return (await readFixtureText(`${kind}/${name}.sha256`)) as `sha256:${string}`;
}

// --- reveal fixtures (§6.4/§16): a committed Benchmark + full/partial/tampered reveal scenarios ---

export type RevealScenario = "revealed-full" | "revealed-partial" | "tampered-item";

export async function loadRevealCommitted(): Promise<unknown> {
  return readFixtureJson("reveal/committed.json");
}

export async function loadRevealExpectedCoverage(): Promise<unknown> {
  return readFixtureJson("reveal/expected-coverage.json");
}

async function listRevealedDigests(scenario: RevealScenario): Promise<string[]> {
  const directory = fileURLToPath(fixtureUrl(`reveal/${scenario}`));
  const entries = await readdir(directory);
  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
}

/** Loads a reveal scenario's revealed Task bytes into the `Map<digest, bytes>` shape `checkRevealConsistency` consumes. */
export async function loadRevealedMap(scenario: RevealScenario): Promise<Map<string, Uint8Array>> {
  const digests = await listRevealedDigests(scenario);
  const entries = await Promise.all(
    digests.map(async (digest) => [digest, await readFixtureBytes(`reveal/${scenario}/${digest}.json`)] as const),
  );
  return new Map(entries);
}

// --- equivalence fixtures (program §7.1/§7.14): two key-permuted inputs, one expected digest ---

export async function loadEquivalenceInput(variant: "a" | "b"): Promise<unknown> {
  return readFixtureJson(`equivalence/input-${variant}.json`);
}

export async function loadEquivalenceExpectedDigest(): Promise<`sha256:${string}`> {
  const { digest } = (await readFixtureJson("equivalence/expected-digest.json")) as {
    digest: `sha256:${string}`;
  };
  return digest;
}
