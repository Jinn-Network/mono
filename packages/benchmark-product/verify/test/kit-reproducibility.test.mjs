// The published conformance kit must be byte-reproducible: an external
// implementer who regenerates the tampered corpus from the shipped golden has
// to get exactly the bytes we published, or the pinned fixture digest manifest
// and their own comparisons are meaningless.
//
// Regression test for a real defect: trust-key-swapped minted a fresh Ed25519
// key on every run, so each regeneration churned that fixture and the digest
// manifest. This runs the generator against a copy of the shipped golden and
// requires the result to equal the committed tree byte for byte, which fails
// loudly if anyone reintroduces a per-run key, a timestamp, or an
// order-dependent walk.
//
// Scope: this covers deriving `tampered/` from the shipped `golden/`. Minting a
// new golden is deliberately not reproducible (generate-conformance-kit.mjs
// mints fresh venue keys and the trust file carries a wall-clock validFrom).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const kitName = "public-bundle-conformance-v1";
const committedKit = join(packageRoot, "fixtures", kitName);

const digestTree = (root) => {
  const entries = [];
  const walk = (relative) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name !== ".DS_Store") {
        entries.push(`${rel} ${createHash("sha256").update(readFileSync(join(root, rel))).digest("hex")}`);
      }
    }
  };
  walk("");
  return entries;
};

test("regenerating the tampered corpus from the shipped golden reproduces the committed bytes", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kit-reproducibility-"));
  try {
    // Same layout the generator resolves against: <root>/scripts + <root>/fixtures.
    cpSync(join(packageRoot, "scripts"), join(scratch, "scripts"), { recursive: true });
    for (const carried of ["golden", "keys", "manifest.json"]) {
      cpSync(join(committedKit, carried), join(scratch, "fixtures", kitName, carried), { recursive: true });
    }

    await exec(process.execPath, [join(scratch, "scripts", "generate-tamper-variants.mjs")]);

    const regenerated = join(scratch, "fixtures", kitName);
    assert.deepEqual(
      digestTree(join(regenerated, "tampered")),
      digestTree(join(committedKit, "tampered")),
      "regenerated tampered corpus differs from the committed bytes -- the generator is not deterministic, "
        + "or the committed fixtures are stale (regenerate with scripts/generate-tamper-variants.mjs)",
    );
    assert.equal(
      readFileSync(join(regenerated, "manifest.json"), "utf8"),
      readFileSync(join(committedKit, "manifest.json"), "utf8"),
      "regenerated kit manifest differs from the committed one",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
