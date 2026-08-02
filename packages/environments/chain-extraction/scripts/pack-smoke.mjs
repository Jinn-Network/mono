// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const recordRoot = join(packageRoot, "..", "chain-record");
const verificationRoot = join(packageRoot, "..", "chain-verification");
const trustCoreRoot = join(packageRoot, "..", "..", "trust", "core");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-chain-state-extraction-"));
const recordArchive = join(temporaryRoot, "chain-environment-record.tgz");
const verificationArchive = join(temporaryRoot, "chain-environment-verification.tgz");
const trustCoreArchive = join(temporaryRoot, "trust-core.tgz");
const extractionArchive = join(temporaryRoot, "chain-state-extraction.tgz");
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
    [verificationRoot, verificationArchive],
    [trustCoreRoot, trustCoreArchive],
    [packageRoot, extractionArchive],
  ]) {
    await run("corepack", ["yarn@4.13.0", "pack", "--out", archive], { cwd: root });
  }
  const entries = (await output("tar", ["-tzf", extractionArchive]))
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const required of [
    "package/README.md",
    "package/dist/index.js",
    "package/dist/testing.js",
    "package/fixtures/",
  ]) {
    const present = required.endsWith("/")
      ? entries.some((entry) => entry.startsWith(required))
      : entries.includes(required);
    if (!present) {
      throw new Error(`packed chain-state-extraction is missing ${required}`);
    }
  }
  const leaked = entries.filter((entry) => /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry));
  if (leaked.length > 0) throw new Error(`test files leaked into tarball: ${leaked.join(", ")}`);

  await mkdir(consumer);
  const recordLocal = join(consumer, "chain-environment-record.tgz");
  const verificationLocal = join(consumer, "chain-environment-verification.tgz");
  const trustLocal = join(consumer, "trust-core.tgz");
  const extractionLocal = join(consumer, "chain-state-extraction.tgz");
  await run("cp", [recordArchive, recordLocal]);
  await run("cp", [verificationArchive, verificationLocal]);
  await run("cp", [trustCoreArchive, trustLocal]);
  await run("cp", [extractionArchive, extractionLocal]);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    packageManager: "yarn@4.13.0",
    dependencies: {
      "@jinn-network/chain-environment-record": "file:./chain-environment-record.tgz",
      "@jinn-network/chain-environment-verification": "file:./chain-environment-verification.tgz",
      "@jinn-network/trust-core": "file:./trust-core.tgz",
      "@jinn-network/chain-state-extraction": "file:./chain-state-extraction.tgz",
      vitest: "4.1.8",
    },
    resolutions: {
      "@jinn-network/chain-environment-record": "file:./chain-environment-record.tgz",
      "@jinn-network/chain-environment-verification": "file:./chain-environment-verification.tgz",
      "@jinn-network/trust-core": "file:./trust-core.tgz",
    },
  }));
  await writeFile(join(consumer, ".yarnrc.yml"), [
    "nodeLinker: node-modules",
    "enableGlobalCache: false",
  ].join("\n") + "\n");
  await run("corepack", ["yarn@4.13.0", "install"], { cwd: consumer });
  await writeFile(join(consumer, "packed-imports.test.mjs"), `
import assert from "node:assert/strict";
import {
  BASELINE_RUN_COUNT,
  CHAIN_EXTRACTION_PROTOCOL_URI,
  DEFAULT_MAX_WIDENINGS,
  MAX_WIDENINGS_CEILING,
} from "@jinn-network/chain-state-extraction";
import { test } from "vitest";

test("packed chain-state-extraction exposes its distribution contract", () => {
  assert.equal(BASELINE_RUN_COUNT, 2);
  assert.equal(DEFAULT_MAX_WIDENINGS, 3);
  assert.equal(MAX_WIDENINGS_CEILING, 8);
  assert.equal(
    CHAIN_EXTRACTION_PROTOCOL_URI,
    "https://jinn.network/protocols/chain-state-extraction/v1",
  );
});
`);
  const vitest = join(consumer, "node_modules", ".bin",
    process.platform === "win32" ? "vitest.cmd" : "vitest");
  await run(vitest, ["run", "packed-imports.test.mjs"], { cwd: consumer });
  console.log("Packed root/testing imports, fixtures, and archive shape verified.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
