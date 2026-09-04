#!/usr/bin/env node
// Writes fixtures/<kind>/valid.json + valid.sha256 from src/golden-documents.ts, then rewrites
// fixtures/manifest.sha256.json in the repo-wide drift-guard shape
// ({version, entries: [{id, sha256}], errata}, ids sorted, the manifest itself excluded) that
// .github/scripts/fixture-manifest.mjs checks. Existing errata are preserved.
//
// Fixtures are append-only and immutable: if this script would change an already-published byte,
// the immutability guard fails and the correct move is a new fixture plus a dated erratum.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildGoldenDocuments } from "../dist/golden-documents.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = join(packageRoot, "fixtures");
const MANIFEST_NAME = "manifest.sha256.json";
const IGNORED = new Set([".DS_Store", MANIFEST_NAME]);

for (const [kind, sealed] of Object.entries(buildGoldenDocuments())) {
  const directory = join(fixturesRoot, kind);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "valid.json"), Buffer.from(sealed.bytes));
  writeFileSync(join(directory, "valid.sha256"), `${sealed.digest}\n`);
}

const entries = [];
const walk = (relative) => {
  for (const entry of readdirSync(join(fixturesRoot, relative), { withFileTypes: true }).sort(
    (left, right) => (left.name < right.name ? -1 : 1),
  )) {
    if (IGNORED.has(entry.name)) continue;
    const id = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) walk(id);
    else entries.push({ id, sha256: createHash("sha256").update(readFileSync(join(fixturesRoot, id))).digest("hex") });
  }
};
walk("");
entries.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

const manifestPath = join(fixturesRoot, MANIFEST_NAME);
const errata = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")).errata ?? []) : [];
writeFileSync(manifestPath, `${JSON.stringify({ version: 1, entries, errata }, null, 2)}\n`);
console.log(`wrote digest manifest for ${entries.length} fixture files`);
