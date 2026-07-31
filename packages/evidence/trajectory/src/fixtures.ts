// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type GoldenName = "valid" | "minimal";

export interface AdversarialManifestEntry {
  readonly id: string;
  readonly description: string;
  readonly expectedDisposition: string;
}

export interface AdversarialManifest {
  readonly fixtures: readonly AdversarialManifestEntry[];
}

const fixtureRoot = resolve(fileURLToPath(new URL("../fixtures", import.meta.url)));

function assertContainedFixturePath(relativePath: string): void {
  if (relativePath.startsWith("/")) {
    throw new Error("trajectory fixture paths must stay inside fixtures/");
  }
  const segments = relativePath.split("/");
  if (segments.includes("..")) {
    throw new Error("trajectory fixture paths must stay inside fixtures/");
  }
  const resolved = resolve(fixtureRoot, relativePath);
  const normalizedRoot = `${fixtureRoot}${fixtureRoot.endsWith("/") ? "" : "/"}`;
  if (!resolved.startsWith(normalizedRoot) && resolved !== fixtureRoot) {
    throw new Error("trajectory fixture paths must stay inside fixtures/");
  }
}

/** Resolves a path inside the fixture corpus shipped by this package. */
export function trajectoryFixtureUrl(relativePath: string): URL {
  const decoded = decodeURIComponent(relativePath);
  assertContainedFixturePath(decoded);
  return new URL(`../fixtures/${relativePath}`, import.meta.url);
}

async function bytes(relativePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(trajectoryFixtureUrl(relativePath)));
}

async function json(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(trajectoryFixtureUrl(relativePath), "utf8"));
}

export async function loadGoldenBytes(name: GoldenName): Promise<Uint8Array> {
  return bytes(`trajectory/${name}.json`);
}

export async function loadGoldenJson(name: GoldenName): Promise<unknown> {
  return json(`trajectory/${name}.json`);
}

export async function loadGoldenDigest(name: GoldenName): Promise<`sha256:${string}`> {
  const text = await readFile(trajectoryFixtureUrl(`trajectory/${name}.sha256`), "utf8");
  return text.trim() as `sha256:${string}`;
}

export async function loadInvalidJson(name: string): Promise<unknown> {
  return json(`trajectory/invalid-${name}.json`);
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

export async function readAdversarialJson(id: string, filename: string): Promise<unknown> {
  return json(`adversarial-v1/${id}/${filename}`);
}
