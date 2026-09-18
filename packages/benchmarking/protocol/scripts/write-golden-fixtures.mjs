#!/usr/bin/env node
// Writes fixtures/<kind>/valid.json + valid.sha256 from src/golden-documents.ts, then rewrites
// fixtures/manifest.sha256.json through .github/scripts/fixture-manifest.mjs, the same module
// whose walk the drift guard checks against. Existing errata are preserved.
//
// Fixtures are append-only and immutable: if this script would change an already-published byte,
// the immutability guard fails and the correct move is a new fixture plus a dated erratum.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { rewriteFixtureManifest } from "../../../../.github/scripts/fixture-manifest.mjs";
import { buildGoldenDocuments } from "../dist/golden-documents.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = join(packageRoot, "fixtures");

for (const [kind, sealed] of Object.entries(buildGoldenDocuments())) {
  const directory = join(fixturesRoot, kind);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "valid.json"), Buffer.from(sealed.bytes));
  writeFileSync(join(directory, "valid.sha256"), `${sealed.digest}\n`);
}

const { entries } = rewriteFixtureManifest(packageRoot);
console.log(`wrote digest manifest for ${entries.length} fixture files`);
