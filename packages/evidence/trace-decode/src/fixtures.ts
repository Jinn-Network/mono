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

/** Resolves a path inside the fixture corpus this package ships. */
export function traceDecodeFixtureUrl(relativePath: string): URL {
  if (relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
    throw new Error("trace-decode fixture paths must stay inside fixtures/");
  }
  return new URL(`../fixtures/${relativePath}`, import.meta.url);
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
