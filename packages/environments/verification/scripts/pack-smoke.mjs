// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const recordRoot = join(packageRoot, "..", "record");
const trustCoreRoot = join(packageRoot, "..", "..", "trust", "core");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-environment-verification-"));
const recordArchive = join(temporaryRoot, "environment-record.tgz");
const trustCoreArchive = join(temporaryRoot, "trust-core.tgz");
const verificationArchive = join(temporaryRoot, "environment-verification.tgz");
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
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/testing.js",
    "package/dist/testing.d.ts",
    "package/fixtures/predicate-v1/stable.json",
    "package/fixtures/attestations-v1/stable.json",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`packed environment-verification is missing ${required}`);
    }
  }
  const leaked = entries.filter((entry) => /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry));
  if (leaked.length > 0) throw new Error(`test files leaked into tarball: ${leaked.join(", ")}`);

  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@jinn-network/environment-record": `file:${recordArchive}`,
      "@jinn-network/trust-core": `file:${trustCoreArchive}`,
      "@jinn-network/environment-verification": `file:${verificationArchive}`,
      vitest: "4.1.8",
    },
  }));
  // npm 10.9.x Arborist can crash with `edgesOut` while resolving these local tarballs and
  // Vitest's optional peer graph. The peer relationship is exercised by the packed test below;
  // use the stable legacy-peer resolver rather than weakening the consumer assertion.
  await run("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps",
  ], { cwd: consumer });
  await writeFile(join(consumer, "packed-imports.test.mjs"), `
import assert from "node:assert/strict";
import {
  ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
  buildEnvironmentCandidatesFromRows,
  verifyEnvironment,
} from "@jinn-network/environment-verification";
import {
  createInMemoryArtifactStore,
  describeEnvironmentVerificationConformance,
} from "@jinn-network/environment-verification/testing";
import { test } from "vitest";

test("packed environment-verification exposes its distribution contract", () => {
  assert.equal(
    ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
    "https://spec.jinn.network/attestations/environment-verification/v1",
  );
  assert.equal(typeof verifyEnvironment, "function");
  assert.equal(typeof buildEnvironmentCandidatesFromRows, "function");
  assert.equal(typeof describeEnvironmentVerificationConformance, "function");
  assert.equal(typeof createInMemoryArtifactStore, "function");
});
`);
  const vitest = join(consumer, "node_modules", ".bin",
    process.platform === "win32" ? "vitest.cmd" : "vitest");
  await run(vitest, ["run", "packed-imports.test.mjs"], { cwd: consumer });
  console.log("Packed root/testing imports, fixtures, and archive shape verified.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
