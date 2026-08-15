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
    verifierVersion: "1.0.0",
    acceptedFormat: "benchmark-product-public-bundle/2",
    code: "record-integrity",
    message: "bundle directory is missing",
  });
});

test("human success names all six checks and states the verification limit", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
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
  for (const check of ["manifest", "evidence-closure", "trust", "matrix-rederivation", "report-verification", "claim-consistency"]) {
    assert.match(output, new RegExp(`${check}\\s+passed`));
  }
  assert.match(output, /does not prove that the machine that produced the/);
  assert.match(output, /No files were uploaded/);
});
