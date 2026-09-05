#!/usr/bin/env node
// Regenerates fixtures/golden-lifecycle/digests.json, then rewrites fixtures/manifest.sha256.json
// in the repo-wide drift-guard shape ({version, entries: [{id, sha256}], errata}, ids sorted, the
// manifest itself excluded) that .github/scripts/fixture-manifest.mjs checks. Existing errata are
// preserved.
//
// Unlike packages/benchmarking/protocol's generate:fixtures, these digests are not produced by a
// standalone builder: they are the tier-2 digests of the whole golden lifecycle, computable only
// by running it. So this script runs that one test with JINN_WRITE_GOLDEN_LIFECYCLE_DIGESTS=1,
// which makes the test write what it computed instead of only comparing against it.
//
// Fixtures are append-only and immutable: if this script would change an already-published byte,
// the immutability guard fails and the correct move is a new fixture plus a dated erratum.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = join(packageRoot, "fixtures");
const MANIFEST_NAME = "manifest.sha256.json";
const IGNORED = new Set([".DS_Store", MANIFEST_NAME]);

const run = spawnSync("yarn", ["vitest", "run", "src/golden-lifecycle.test.ts"], {
  cwd: packageRoot,
  stdio: "inherit",
  env: { ...process.env, JINN_WRITE_GOLDEN_LIFECYCLE_DIGESTS: "1" },
});
if (run.status !== 0) {
  console.error("golden-lifecycle test did not complete; fixtures left untouched");
  process.exit(run.status ?? 1);
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
