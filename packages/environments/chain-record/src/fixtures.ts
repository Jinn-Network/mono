// The only production-adjacent file permitted to touch the filesystem. It belongs to the
// testing region: `index.ts` never re-exports it, and the source-boundary guard classifies it
// with `testing.ts` and the `*.test.ts` files.
import { readFile } from "node:fs/promises";

export type ChainGoldenName = "closed-anchored-subset" | "closed-local" | "archive-dependent";
export type CompositeGoldenName = "chain-only" | "composed" | "extension";

export interface AdversarialManifestEntry {
  readonly id: string;
  readonly description: string;
  readonly recordKind: "chain-environment" | "crypto-environment";
  readonly expectedDisposition: "accepted" | "invalid-document" | "invalid-bytes";
}

export interface AdversarialManifest {
  readonly fixtures: readonly AdversarialManifestEntry[];
}

/** Resolves a path inside the fixture corpus shipped by this package. */
export function chainFixtureUrl(relativePath: string): URL {
  if (relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
    throw new Error("chain fixture paths must stay inside fixtures/");
  }
  return new URL(`../fixtures/${relativePath}`, import.meta.url);
}

async function bytes(relativePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(chainFixtureUrl(relativePath)));
}

async function json(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(chainFixtureUrl(relativePath), "utf8"));
}

async function digest(relativePath: string): Promise<`sha256:${string}`> {
  return (await readFile(chainFixtureUrl(relativePath), "utf8")).trim() as `sha256:${string}`;
}

/**
 * A published JSON Schema, read from this package's own `schemas/` directory. It lives here so
 * that exactly ONE file in the package touches the filesystem — the source-boundary guard
 * asserts that literally — and it only ever opens artifacts this package itself ships.
 */
export async function loadPublishedSchema(
  name: "chain-environment" | "crypto-environment",
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

export const loadChainGoldenJson = (name: ChainGoldenName) => json(`chain/${name}.json`);
export const loadChainGoldenBytes = (name: ChainGoldenName) => bytes(`chain/${name}.json`);
export const loadChainGoldenDigest = (name: ChainGoldenName) => digest(`chain/${name}.sha256`);

export const loadCompositeGoldenJson = (name: CompositeGoldenName) => json(`composite/${name}.json`);
export const loadCompositeGoldenBytes = (name: CompositeGoldenName) => bytes(`composite/${name}.json`);
export const loadCompositeGoldenDigest = (name: CompositeGoldenName) => digest(`composite/${name}.sha256`);

/** Structurally invalid documents kept beside the goldens for the schema-parity suite. */
export const loadInvalidJson = (name: string) => json(`invalid/${name}.json`);

export const loadEquivalenceInput = (variant: "a" | "b") => json(`equivalence/input-${variant}.json`);

export async function loadEquivalenceExpectedDigest(): Promise<`sha256:${string}`> {
  const parsed = (await json("equivalence/expected-digest.json")) as { digest: string };
  return parsed.digest as `sha256:${string}`;
}

export async function loadAdversarialManifest(): Promise<AdversarialManifest> {
  return (await json("adversarial-v1/manifest.json")) as AdversarialManifest;
}

export const readAdversarialJson = (id: string) => json(`adversarial-v1/${id}/document.json`);
export const readAdversarialBytes = (id: string) => bytes(`adversarial-v1/${id}/document.bytes`);
