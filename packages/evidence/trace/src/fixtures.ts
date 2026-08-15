// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const ENCODED_SEPARATOR = /%(?:2f|5c|2e%2e|%2e%2e)/iu;
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const CONTROL_OR_NUL = /[\0-\x1f\x7f]/u;

function rejectUriAuthorityPaths(relativePath: string): void {
  if (CONTROL_OR_NUL.test(relativePath)) {
    throw new Error("trace fixture paths must stay inside fixtures/");
  }
  if (SCHEME_PREFIX.test(relativePath)) {
    throw new Error("trace fixture paths must stay inside fixtures/");
  }
  if (relativePath.startsWith("//") || relativePath.startsWith("\\\\")) {
    throw new Error("trace fixture paths must stay inside fixtures/");
  }
}

function decodeFixturePathSegments(relativePath: string): string {
  let decoded = relativePath;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function rejectTraversalSegments(relativePath: string): void {
  rejectUriAuthorityPaths(relativePath);
  if (relativePath.includes("\\")) {
    throw new Error("trace fixture paths must stay inside fixtures/");
  }
  if (ENCODED_SEPARATOR.test(relativePath)) {
    throw new Error("trace fixture paths must stay inside fixtures/");
  }
  const decoded = decodeFixturePathSegments(relativePath);
  rejectUriAuthorityPaths(decoded);
  if (decoded.includes("\\")) {
    throw new Error("trace fixture paths must stay inside fixtures/");
  }
  if (/(^|\/)\.\.(\/|$)/u.test(decoded)) {
    throw new Error("trace fixture paths must stay inside fixtures/");
  }
  if (decoded.startsWith("/")) {
    throw new Error("trace fixture paths must stay inside fixtures/");
  }
  if (/^[A-Za-z]:/u.test(decoded)) {
    throw new Error("trace fixture paths must stay inside fixtures/");
  }
  if (/[?#]/u.test(relativePath)) {
    throw new Error("trace fixture paths must stay inside fixtures/");
  }
}

function assertContainedFixturePath(relativePath: string): void {
  rejectTraversalSegments(relativePath);
  const resolved = resolve(
    fixtureRoot,
    ...decodeFixturePathSegments(relativePath).split("/").filter(Boolean),
  );
  const rootWithSep = fixtureRoot.endsWith(sep) ? fixtureRoot : `${fixtureRoot}${sep}`;
  if (resolved !== fixtureRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error("trace fixture paths must stay inside fixtures/");
  }
}

/** Resolves a path inside the fixture corpus shipped by this package. */
export function traceFixtureUrl(relativePath: string): URL {
  assertContainedFixturePath(relativePath);
  const decoded = decodeFixturePathSegments(relativePath);
  return pathToFileURL(resolve(fixtureRoot, ...decoded.split("/").filter(Boolean)));
}

async function bytes(relativePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(traceFixtureUrl(relativePath)));
}

async function json(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(traceFixtureUrl(relativePath), "utf8"));
}

export async function loadGoldenBytes(name: GoldenName): Promise<Uint8Array> {
  return bytes(`trace/${name}.json`);
}

export async function loadGoldenJson(name: GoldenName): Promise<unknown> {
  return json(`trace/${name}.json`);
}

export async function loadGoldenDigest(name: GoldenName): Promise<`sha256:${string}`> {
  const text = await readFile(traceFixtureUrl(`trace/${name}.sha256`), "utf8");
  return text.trim() as `sha256:${string}`;
}

export async function loadInvalidJson(name: string): Promise<unknown> {
  return json(`trace/invalid-${name}.json`);
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
