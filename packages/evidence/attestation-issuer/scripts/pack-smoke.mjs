// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(packageRoot, "..");
const protocolRoot = join(packagesRoot, "protocol");
const repositoryRoot = join(packagesRoot, "repository");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-attestation-issuer-"));
const protocolArchive = join(temporaryRoot, "evidence-protocol.tgz");
const repositoryArchive = join(temporaryRoot, "evidence-repository.tgz");
const issuerArchive = join(temporaryRoot, "attestation-issuer.tgz");
const consumer = join(temporaryRoot, "consumer");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

function output(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(Buffer.concat(stdout).toString("utf8"))
      : reject(new Error(
        `${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`,
      )));
  });
}

function assertArchiveShape(entries) {
  const required = [
    "package/README.md",
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/dist/testing.d.ts",
    "package/dist/testing.js",
    "package/fixtures/issuer-contract-v1/README.md",
    "package/fixtures/issuer-contract-v1/expected-digests.json",
    "package/fixtures/issuer-contract-v1/execution-verification.json",
    "package/fixtures/issuer-contract-v1/result-evaluation.json",
  ];
  for (const entry of required) {
    if (!entries.includes(entry)) {
      throw new Error(`packed attestation issuer is missing ${entry}`);
    }
  }
  const leakedTests = entries.filter((entry) =>
    /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry));
  if (leakedTests.length > 0) {
    throw new Error(`test files leaked into issuer tarball: ${leakedTests.join(", ")}`);
  }
}

try {
  for (const [root, archive] of [
    [protocolRoot, protocolArchive],
    [repositoryRoot, repositoryArchive],
    [packageRoot, issuerArchive],
  ]) {
    await run("corepack", ["yarn@4.13.0", "pack", "--out", archive], { cwd: root });
  }
  const archiveEntries = (await output("tar", ["-tzf", issuerArchive]))
    .split(/\r?\n/u)
    .filter(Boolean);
  assertArchiveShape(archiveEntries);

  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@jinn-network/evidence-protocol": `file:${protocolArchive}`,
      "@jinn-network/evidence-repository": `file:${repositoryArchive}`,
      "@jinn-network/attestation-issuer": `file:${issuerArchive}`,
      vitest: "4.1.8",
    },
  }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: consumer,
  });
  const installedRoot = join(
    consumer,
    "node_modules",
    "@jinn-network",
    "attestation-issuer",
  );
  await writeFile(join(consumer, "packed-imports.test.mjs"), `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ATTESTATION_ISSUER_ERROR_CODES,
  commitPreparedAttestation,
  parsePreparedAttestation,
  prepareExecutionVerification,
  prepareResultEvaluation,
} from "@jinn-network/attestation-issuer";
import {
  describeAttestationIssuerIntegrationContract,
} from "@jinn-network/attestation-issuer/testing";
import {
  validateExecutionVerification,
  validateResultEvaluation,
} from "@jinn-network/evidence-protocol";
import { test } from "vitest";

test("packed issuer exposes its distribution contract", async () => {
  assert.equal(typeof prepareResultEvaluation, "function");
  assert.equal(typeof prepareExecutionVerification, "function");
  assert.equal(typeof parsePreparedAttestation, "function");
  assert.equal(typeof commitPreparedAttestation, "function");
  assert.equal(typeof describeAttestationIssuerIntegrationContract, "function");
  assert.ok(ATTESTATION_ISSUER_ERROR_CODES.includes("PREPARED_ATTESTATION_INVALID"));
  const evaluation = await readFile(new URL(import.meta.resolve(
    "@jinn-network/attestation-issuer/fixtures/issuer-contract-v1/result-evaluation.json"
  )));
  const verification = await readFile(new URL(import.meta.resolve(
    "@jinn-network/attestation-issuer/fixtures/issuer-contract-v1/execution-verification.json"
  )));
  assert.equal(validateResultEvaluation(evaluation).conforms, true);
  assert.equal(validateExecutionVerification(verification).conforms, true);
  assert.equal(parsePreparedAttestation(evaluation).family, "result-evaluation");
  const packageJson = JSON.parse(await readFile(
    ${JSON.stringify(join(installedRoot, "package.json"))},
    "utf8",
  ));
  assert.deepEqual(packageJson.dependencies, {
    "@jinn-network/evidence-protocol": "0.1.0",
    "@jinn-network/evidence-repository": "0.1.0",
  });
  assert.deepEqual(packageJson.peerDependencies, { vitest: "^4.1.8" });
  assert.deepEqual(packageJson.peerDependenciesMeta, {
    vitest: { optional: true },
  });
});
`);
  const vitest = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "vitest.cmd" : "vitest",
  );
  await run(vitest, ["run", "packed-imports.test.mjs"], { cwd: consumer });
  console.log(
    "Packed root/testing imports, fixtures, dependency boundary, validation, and archive shape verified.",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
