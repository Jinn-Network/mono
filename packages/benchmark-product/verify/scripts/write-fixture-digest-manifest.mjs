#!/usr/bin/env node
// Writes fixtures/manifest.sha256.json in the repo-wide fixture drift-guard
// shape ({version, entries: [{id, sha256}], errata: []}, ids sorted, the
// manifest itself excluded), matching .github/scripts/fixture-manifest.mjs.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const entries = [];
const walk = (relative) => {
  for (const entry of readdirSync(join(fixturesRoot, relative), { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) walk(rel);
    else if (rel !== "manifest.sha256.json") {
      entries.push({
        id: rel,
        sha256: createHash("sha256").update(readFileSync(join(fixturesRoot, rel))).digest("hex"),
      });
    }
  }
};
walk("");
entries.sort((left, right) => (left.id < right.id ? -1 : 1));
writeFileSync(
  join(fixturesRoot, "manifest.sha256.json"),
  `${JSON.stringify({ entries, errata: [], version: 1 }, null, 2)}\n`,
);
console.log(`wrote digest manifest for ${entries.length} fixture files`);
