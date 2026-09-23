#!/usr/bin/env node
// Regenerates fixtures/golden-lifecycle/digests.json, then rewrites fixtures/manifest.sha256.json
// through .github/scripts/fixture-manifest.mjs, the same module whose walk the drift guard checks
// against. Existing errata are preserved.
//
// Unlike packages/benchmarking/protocol's generate:fixtures, these digests are not produced by a
// standalone builder: they are the tier-2 digests of the whole golden lifecycle, computable only
// by running it. So this script runs that one test with JINN_WRITE_GOLDEN_LIFECYCLE_DIGESTS=1,
// which makes the test write what it computed instead of only comparing against it.
//
// Fixtures are append-only and immutable: if this script would change an already-published byte,
// the immutability guard fails and the correct move is a new fixture plus a dated erratum.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { rewriteFixtureManifest } from "../../../../.github/scripts/fixture-manifest.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const run = spawnSync("yarn", ["vitest", "run", "src/golden-lifecycle.test.ts"], {
  cwd: packageRoot,
  stdio: "inherit",
  env: { ...process.env, JINN_WRITE_GOLDEN_LIFECYCLE_DIGESTS: "1" },
});
if (run.status !== 0) {
  console.error("golden-lifecycle test did not complete; fixtures left untouched");
  process.exit(run.status ?? 1);
}

const { entries } = rewriteFixtureManifest(packageRoot);
console.log(`wrote digest manifest for ${entries.length} fixture files`);
