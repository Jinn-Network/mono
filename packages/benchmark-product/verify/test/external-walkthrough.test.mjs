// Executes the documented external verification path (scripts/external-verify.py,
// Python 3 stdlib + openssl, no Jinn code) against the conformance kit: the
// golden bundle must pass, every externally detectable tampered variant must
// fail, and the two documented external blind spots must pass externally while
// the reference verifier rejects them — the honest boundary the profile
// document states. Skips loudly only when python3/openssl are unusable.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/external-verify.py", import.meta.url));
const kit = fileURLToPath(new URL("../fixtures/public-bundle-conformance-v1", import.meta.url));
const manifest = JSON.parse(readFileSync(join(kit, "manifest.json"), "utf8"));

async function externalVerify(dir) {
  try {
    const result = await exec("python3", [script, dir]);
    return { code: 0, stdout: result.stdout };
  } catch (error) {
    return { code: error.code ?? 2, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

const probe = await externalVerify(join(kit, "golden"));
const skip = probe.code === 2 ? `python3/openssl unavailable: ${(probe.stderr ?? "").slice(0, 120)}` : false;

test("external walkthrough accepts the golden bundle with every check ok", { skip }, () => {
  assert.equal(probe.code, 0, probe.stdout);
  for (const check of [
    "manifest-files", "cas-records", "sealed-bytes", "report-signature",
    "report-pins-matrix", "verdict-signatures", "matrix-verdict-closure",
    "claim-mirror", "key-derivations",
  ]) {
    assert.match(probe.stdout, new RegExp(`CHECK ${check}: ok`));
  }
  assert.match(probe.stdout, /no tool can prove the producing venue was honest/);
});

for (const fixture of manifest.fixtures) {
  test(`external walkthrough on ${fixture.id} (externallyDetectable: ${fixture.externallyDetectable})`, { skip }, async () => {
    const { code } = await externalVerify(join(kit, fixture.path));
    if (fixture.externallyDetectable) {
      assert.equal(code, 1, `${fixture.id} must fail the external path`);
    } else {
      assert.equal(code, 0, `${fixture.id} is a documented external blind spot and must pass the external path`);
    }
  });
}

test("the kit declares both boundary exhibits external tools cannot catch", { skip: false }, () => {
  const blind = manifest.fixtures.filter((fixture) => !fixture.externallyDetectable).map(({ id }) => id);
  assert.deepEqual(blind, ["claim-text-tampered", "results-miscomputed-resigned"]);
});
