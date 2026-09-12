// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";

import type { TraceDecoderFixture } from "./contract.js";

export interface DecoderFixtureManifestEntry {
  readonly id: string;
  readonly description: string;
  /** A string the source carries that no span may carry. Marks an adversarial case. */
  readonly mustNotContain?: string;
}

export interface DecoderFixtureManifest {
  readonly formatIri: string;
  readonly decoderId: string;
  readonly decoderVersion: string;
  readonly fixtures: readonly DecoderFixtureManifestEntry[];
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
export function traceDecodeFixtureUrl(relativePath: string): URL {
  const resolved = new URL(relativePath, FIXTURES_ROOT);
  if (resolved.protocol !== FIXTURES_ROOT.protocol || !resolved.href.startsWith(FIXTURES_ROOT.href)) {
    throw new Error("trace-decode fixture paths must stay inside fixtures/");
  }
  return resolved;
}

const CORPUS = "claude-code-stream-json";

export async function loadDecoderFixtureManifest(): Promise<DecoderFixtureManifest> {
  return JSON.parse(
    await readFile(traceDecodeFixtureUrl(`${CORPUS}/manifest.json`), "utf8"),
  ) as DecoderFixtureManifest;
}

export async function loadClaudeCodeFixtures(): Promise<readonly TraceDecoderFixture[]> {
  const manifest = await loadDecoderFixtureManifest();
  return Promise.all(
    manifest.fixtures.map(async (entry) => {
      const bytes = new Uint8Array(
        await readFile(traceDecodeFixtureUrl(`${CORPUS}/cases/${entry.id}/input.jsonl`)),
      );
      const expected = JSON.parse(
        await readFile(
          traceDecodeFixtureUrl(`${CORPUS}/cases/${entry.id}/expected.json`),
          "utf8",
        ),
      ) as TraceDecoderFixture["expected"];
      return { id: entry.id, description: entry.description, bytes, expected };
    }),
  );
}
