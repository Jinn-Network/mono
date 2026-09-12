// The only production-adjacent file permitted to touch the filesystem. It belongs to the
// testing region: `index.ts` never re-exports it, and the source-boundary guard classifies
// it with `testing.ts` and the `*.test.ts` files.
import { readFile } from "node:fs/promises";

export type GoldenName = "imported" | "tier-1" | "extension";

export interface AdversarialManifestEntry {
  readonly id: string;
  readonly description: string;
  readonly expectedDisposition: "accepted" | "invalid-document" | "invalid-bytes";
}

export interface AdversarialManifest {
  readonly fixtures: readonly AdversarialManifestEntry[];
}

/**
 * The published JSON Schema, read from this package's own `schemas/` directory. It lives
 * here rather than in the parity test so that exactly ONE file in the package touches the
 * filesystem — the source-boundary guard asserts that literally, and the custody story stays
 * simple: one reader, and it only ever opens artifacts this package itself ships.
 */
export async function loadPublishedSchema(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(new URL("../schemas/environment.schema.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

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
export function environmentFixtureUrl(relativePath: string): URL {
  const resolved = new URL(relativePath, FIXTURES_ROOT);
  if (resolved.protocol !== FIXTURES_ROOT.protocol || !resolved.href.startsWith(FIXTURES_ROOT.href)) {
    throw new Error("environment fixture paths must stay inside fixtures/");
  }
  return resolved;
}

async function bytes(relativePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(environmentFixtureUrl(relativePath)));
}

async function json(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(environmentFixtureUrl(relativePath), "utf8"));
}

export async function loadGoldenBytes(name: GoldenName): Promise<Uint8Array> {
  return bytes(`environment/${name}.json`);
}

export async function loadGoldenJson(name: GoldenName): Promise<unknown> {
  return json(`environment/${name}.json`);
}

export async function loadGoldenDigest(name: GoldenName): Promise<`sha256:${string}`> {
  const text = await readFile(environmentFixtureUrl(`environment/${name}.sha256`), "utf8");
  return text.trim() as `sha256:${string}`;
}

export async function loadInvalidJson(name: string): Promise<unknown> {
  return json(`environment/invalid-${name}.json`);
}

export async function loadEquivalenceInput(variant: "a" | "b"): Promise<unknown> {
  return json(`equivalence/input-${variant}.json`);
}

export async function loadEquivalenceExpectedDigest(): Promise<`sha256:${string}`> {
  const parsed = (await json("equivalence/expected-digest.json")) as { digest: string };
  return parsed.digest as `sha256:${string}`;
}

export async function loadAdversarialManifest(): Promise<AdversarialManifest> {
  return (await json("adversarial-v1/manifest.json")) as AdversarialManifest;
}

export async function readAdversarialJson(id: string): Promise<unknown> {
  return json(`adversarial-v1/${id}/document.json`);
}

export async function readAdversarialBytes(id: string): Promise<Uint8Array> {
  return bytes(`adversarial-v1/${id}/document.bytes`);
}
