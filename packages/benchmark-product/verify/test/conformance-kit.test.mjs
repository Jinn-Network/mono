// The public conformance kit is the regression suite for the verifier and the
// self-test corpus for external implementations: the golden bundle must verify
// with all six checks, and every tampered variant must fail with the failure
// its kit manifest declares. Assertions are driven by manifest.json only —
// never by observed verifier output pasted back in.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const fixturesRoot = fileURLToPath(new URL("../fixtures", import.meta.url));
const kit = join(fixturesRoot, "public-bundle-conformance-v1");
const manifest = JSON.parse(readFileSync(join(kit, "manifest.json"), "utf8"));

async function verify(bundleDir) {
  try {
    const result = await exec(process.execPath, [bin, bundleDir, "--json"]);
    return { code: 0, output: JSON.parse(result.stdout) };
  } catch (error) {
    return { code: error.code, output: JSON.parse(error.stdout) };
  }
}

test("kit manifest is sorted and covers exactly the tampered directories", () => {
  const ids = manifest.fixtures.map(({ id }) => id);
  assert.deepEqual(ids, [...ids].sort());
  assert.deepEqual(new Set(readdirSync(join(kit, "tampered"))), new Set(ids));
  assert.equal(manifest.format, "benchmark-product-conformance-kit/1");
  for (const fixture of manifest.fixtures) {
    assert.equal(fixture.path, `tampered/${fixture.id}`);
    assert.equal(fixture.expectedDisposition, "invalid");
    assert.equal(typeof fixture.expectedMessagePattern, "string");
    assert.equal(typeof fixture.externallyDetectable, "boolean");
    assert.ok(
      manifest.golden.expectedChecks.includes(fixture.expectedFailingCheck),
      `${fixture.id} names an unknown check ${fixture.expectedFailingCheck}`,
    );
  }
});

test("golden bundle verifies with the six checks in canonical order", async () => {
  const { code, output } = await verify(join(kit, manifest.golden.path));
  assert.equal(code, 0, JSON.stringify(output));
  assert.equal(output.ok, true);
  assert.deepEqual(output.checks, manifest.golden.expectedChecks);
});

for (const fixture of manifest.fixtures) {
  test(`tampered variant ${fixture.id} fails as its manifest declares`, async () => {
    const { code, output } = await verify(join(kit, fixture.path));
    assert.equal(code, 1, `${fixture.id} must exit 1`);
    assert.equal(output.ok, false);
    assert.equal(output.code, "record-integrity");
    assert.match(output.message, new RegExp(fixture.expectedMessagePattern), fixture.id);
  });
}

test("fixtures digest manifest is current", () => {
  const digestManifestPath = join(fixturesRoot, "manifest.sha256.json");
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
  const expected = { entries, errata: [], version: 1 };
  let actual;
  try {
    statSync(digestManifestPath);
    actual = JSON.parse(readFileSync(digestManifestPath, "utf8"));
  } catch {
    assert.fail("fixtures/manifest.sha256.json is missing -- regenerate with: node scripts/write-fixture-digest-manifest.mjs");
  }
  assert.deepEqual(
    { entries: actual.entries, errata: actual.errata, version: actual.version },
    expected,
    "fixtures drifted -- regenerate with: node scripts/write-fixture-digest-manifest.mjs",
  );
});
