// SPDX-License-Identifier: Apache-2.0

// The only file in this package permitted to touch the filesystem. It belongs to the
// testing region: `index.ts` never re-exports it, and it only ever opens artifacts this
// package itself ships.
import { readdir, readFile } from "node:fs/promises";

import type { Sha256Digest } from "@jinn-network/trust-core";

/** The sealed offer envelopes this package ships. */
export type GoldenOfferName = "free" | "priced" | "superseding";

export const GOLDEN_OFFERS: readonly GoldenOfferName[] = ["free", "priced", "superseding"];

/** Offer documents that must be refused; each name is the fixture's `invalid-<name>.json`. */
export const INVALID_OFFERS: readonly string[] = [
  "zero-amount",
  "signed-amount",
  "leading-zero-amount",
  "duplicate-rail",
  "unsorted-rails",
  "missing-rails",
  "bare-extension-key",
  "bare-hex-subject",
  "relative-gate-uri",
  "relative-rail-identifier",
  "unnormalized-rail-identifier",
  "rail-spelled-twice",
];

const FIXTURES_ROOT = new URL("../fixtures/", import.meta.url);

/**
 * Resolves a path inside the fixture corpus shipped by this package.
 *
 * The check is on the RESOLVED url, not on the input string. A textual `".."` scan is not
 * enough: WHATWG URL treats `%2e%2e` (and `.%2e`, `%2e.`) as a double-dot path segment, so
 * `offer/%2e%2e/%2e%2e/package.json` passes a string scan and still resolves above
 * `fixtures/`. These loaders are exported from `/testing`, so a consumer may pass a name it
 * did not author.
 */
export function offerFixtureUrl(relativePath: string): URL {
  const resolved = new URL(relativePath, FIXTURES_ROOT);
  if (resolved.protocol !== FIXTURES_ROOT.protocol || !resolved.href.startsWith(FIXTURES_ROOT.href)) {
    throw new Error("offer fixture paths must stay inside fixtures/");
  }
  return resolved;
}

async function bytes(relativePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(offerFixtureUrl(relativePath)));
}

async function json(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(offerFixtureUrl(relativePath), "utf8"));
}

/** The exact sealed envelope bytes — the record itself, not a re-encoding of it. */
export async function loadGoldenEnvelope(name: GoldenOfferName): Promise<Uint8Array> {
  return bytes(`offer/${name}.json`);
}

export async function loadGoldenDigest(name: GoldenOfferName): Promise<Sha256Digest> {
  const text = await readFile(offerFixtureUrl(`offer/${name}.sha256`), "utf8");
  return text.trim() as Sha256Digest;
}

/** The offer document (not the envelope) each golden envelope seals. */
export async function loadGoldenDocument(name: GoldenOfferName): Promise<unknown> {
  return json(`offer/${name}.document.json`);
}

export async function loadInvalidDocument(name: string): Promise<unknown> {
  return json(`offer/invalid-${name}.json`);
}

/**
 * The refused cases actually present on disk. `INVALID_OFFERS` is what the conformance kit
 * runs; this is what the generator wrote. A test pins them equal, so a case added to the
 * generator and forgotten here cannot sit in the corpus untested.
 */
export async function listInvalidFixtureNames(): Promise<readonly string[]> {
  const entries = await readdir(offerFixtureUrl("offer"));
  return entries
    .filter((entry) => entry.startsWith("invalid-") && entry.endsWith(".json"))
    .map((entry) => entry.slice("invalid-".length, -".json".length))
    .sort();
}
