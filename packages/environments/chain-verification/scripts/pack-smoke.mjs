// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const recordRoot = join(packageRoot, "..", "chain-record");
const trustCoreRoot = join(packageRoot, "..", "..", "trust", "core");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-chain-verification-"));
const recordArchive = join(temporaryRoot, "chain-environment-record.tgz");
const trustCoreArchive = join(temporaryRoot, "trust-core.tgz");
const verificationArchive = join(temporaryRoot, "chain-environment-verification.tgz");
const consumer = join(temporaryRoot, "consumer");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with ${code}`)));
  });
}

function output(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"], ...options });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(Buffer.concat(chunks).toString("utf8"))
      : reject(new Error(`${command} exited with ${code}`)));
  });
}

try {
  for (const [root, archive] of [
    [recordRoot, recordArchive],
    [trustCoreRoot, trustCoreArchive],
    [packageRoot, verificationArchive],
  ]) {
    await run("corepack", ["yarn@4.13.0", "pack", "--out", archive], { cwd: root });
  }
  const entries = (await output("tar", ["-tzf", verificationArchive]))
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const required of [
    "package/README.md",
    "package/ANVIL-CAVEATS.md",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/testing.js",
    "package/dist/testing.d.ts",
    "package/fixtures/predicate-v1/closed-reproducible.json",
    "package/fixtures/attestations-v1/sealed-stable.json",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`packed chain-environment-verification is missing ${required}`);
    }
  }
  const leaked = entries.filter((entry) => /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry));
  if (leaked.length > 0) throw new Error(`test files leaked into tarball: ${leaked.join(", ")}`);

  await mkdir(consumer);
  // Relative file: tarballs — Yarn 4 resolves absolute file: URLs against the registry.
  const recordLocal = join(consumer, "chain-environment-record.tgz");
  const trustLocal = join(consumer, "trust-core.tgz");
  const verificationLocal = join(consumer, "chain-environment-verification.tgz");
  await run("cp", [recordArchive, recordLocal]);
  await run("cp", [trustCoreArchive, trustLocal]);
  await run("cp", [verificationArchive, verificationLocal]);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    packageManager: "yarn@4.13.0",
    dependencies: {
      "@jinn-network/chain-environment-record": "file:./chain-environment-record.tgz",
      "@jinn-network/trust-core": "file:./trust-core.tgz",
      "@jinn-network/chain-environment-verification": "file:./chain-environment-verification.tgz",
      vitest: "4.1.8",
    },
    resolutions: {
      "@jinn-network/chain-environment-record": "file:./chain-environment-record.tgz",
      "@jinn-network/trust-core": "file:./trust-core.tgz",
    },
  }));
  // Yarn's optional-platform resolver can reject Rolldown's Android binding while
  // installing this Linux-only generated consumer. npm's legacy peer resolver keeps
  // the local tarball graph repeatable; the packed imports below remain the oracle.
  await run("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps",
  ], { cwd: consumer });
  await writeFile(join(consumer, "packed-imports.test.mjs"), `
import assert from "node:assert/strict";
import {
  CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
  createAnvilMaterializer,
  createProbeExecutor,
  createScriptReplayer,
  verifyChainEnvironment,
  verifyCryptoEnvironment,
} from "@jinn-network/chain-environment-verification";
import {
  createInMemoryArtifactStore,
  describeChainVerificationConformance,
} from "@jinn-network/chain-environment-verification/testing";
import { test } from "vitest";

test("packed chain-environment-verification exposes its distribution contract", () => {
  assert.equal(
    CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
    "https://jinn.network/attestations/chain-environment-verification/v1",
  );
  for (const fn of [verifyChainEnvironment, verifyCryptoEnvironment, createAnvilMaterializer,
    createProbeExecutor, createScriptReplayer, describeChainVerificationConformance,
    createInMemoryArtifactStore]) {
    assert.equal(typeof fn, "function");
  }
});
`);
  const vitest = join(consumer, "node_modules", ".bin",
    process.platform === "win32" ? "vitest.cmd" : "vitest");
  await run(vitest, ["run", "packed-imports.test.mjs"], { cwd: consumer });
  console.log("Packed root/testing imports, fixtures, and archive shape verified.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
