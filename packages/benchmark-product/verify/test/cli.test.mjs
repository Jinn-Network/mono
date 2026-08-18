import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

async function invoke(args) {
  try {
    return await exec(process.execPath, [bin, ...args]);
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

test("usage exits 2 and states the exit contract", async () => {
  const result = await invoke([]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Exit 0: valid bundle; 1: invalid bundle; 2: usage or operational failure/);
});

test("a missing bundle exits 1 with machine-readable invalid-bundle output", async () => {
  const missing = join(await mkdtemp(join(tmpdir(), "colophon-verify-")), "missing");
  const result = await invoke([missing, "--json"]);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    verifierVersion: "2.0.0",
    supportedFormats: [
      "benchmark-product-public-bundle/2",
      "benchmark-product-public-bundle/4",
      "benchmark-product-public-bundle/5",
      "benchmark-product-public-bundle/6",
    ],
    code: "record-integrity",
    message: "bundle directory is missing",
  });
});

test("human success names all six checks and states the verification limit", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/4",
    identity: "a".repeat(64),
    checks: [
      "manifest",
      "evidence-closure",
      "trust",
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
    ],
    benchmarkSha256: "b".repeat(64),
    runSha256: "c".repeat(64),
    matrixSha256: "d".repeat(64),
    reportSha256: "e".repeat(64),
    reportEnvelopeSha256: "f".repeat(64),
  });
  assert.match(output, /^Verified: 6 of 6 checks passed/m);
  const orderedChecks = ["manifest", "evidence-closure", "trust", "matrix-rederivation", "report-verification", "claim-consistency"];
  for (const check of orderedChecks) {
    assert.match(output, new RegExp(`${check}\\s+passed`));
  }
  assert.deepEqual(orderedChecks.map((check) => output.indexOf(check)), [...orderedChecks.map((check) => output.indexOf(check))].sort((a, b) => a - b));
  assert.match(output, /Format: benchmark-product-public-bundle\/4/);
  assert.match(output, /does not prove that the machine that produced the/);
  assert.match(output, /No files were uploaded/);
});

test("human summary reports the actual passed count against the fixed six-check catalog", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/2",
    identity: "a".repeat(64),
    checks: ["manifest"],
    benchmarkSha256: "b".repeat(64), runSha256: "c".repeat(64), matrixSha256: "d".repeat(64),
    reportSha256: "e".repeat(64), reportEnvelopeSha256: "f".repeat(64),
  });
  assert.match(output, /^Verified: 1 of 6 checks passed/m);
  assert.match(output, /Format: benchmark-product-public-bundle\/2/);
});

test("human summary names all seven evidence-native checks for bundle v5", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/5",
    identity: `sha256:${"a".repeat(64)}`,
    checks: [
      "manifest", "evidence-closure", "artifact-integrity", "signature-validity",
      "matrix-rederivation", "report-verification", "claim-consistency",
    ],
    benchmarkDigest: `sha256:${"b".repeat(64)}`,
    manifestDigest: `sha256:${"c".repeat(64)}`,
    cohortDigest: `sha256:${"d".repeat(64)}`,
    matrixDigest: `sha256:${"e".repeat(64)}`,
    reportDigest: `sha256:${"f".repeat(64)}`,
    evidenceRecords: 336,
    artifacts: 300,
  });
  assert.match(output, /^Verified: 7 of 7 checks passed/m);
  assert.match(output, new RegExp(`Bundle: sha256:${"a".repeat(64)}`));
  assert.doesNotMatch(output, /sha256:sha256:/);
});
