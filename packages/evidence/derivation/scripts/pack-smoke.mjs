// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(packageRoot, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-derivation-"));
const protocolArchive = join(temporaryRoot, "evidence-protocol.tgz");
const derivationArchive = join(temporaryRoot, "evidence-derivation.tgz");
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
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(
        new Error(
          `${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    });
  });
}

try {
  await run(
    "corepack",
    ["yarn@4.13.0", "pack", "--out", protocolArchive],
    { cwd: join(packagesRoot, "protocol") },
  );
  await run(
    "corepack",
    ["yarn@4.13.0", "pack", "--out", derivationArchive],
    { cwd: packageRoot },
  );

  const entries = (await output("tar", ["-tzf", derivationArchive]))
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const required of [
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/package.json",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`packed derivation is missing ${required}`);
    }
  }
  const leaked = entries.filter(
    (entry) =>
      /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry) ||
      entry.endsWith(".map") ||
      entry.includes("/src/") ||
      entry.includes("/fixtures."),
  );
  if (leaked.length > 0) {
    throw new Error(
      `private/test implementation material leaked into tarball: ${leaked.join(", ")}`,
    );
  }

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/evidence-derivation": `file:${derivationArchive}`,
        "@jinn-network/evidence-protocol": `file:${protocolArchive}`,
      },
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer },
  );
  await writeFile(
    join(consumer, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import * as root from "@jinn-network/evidence-derivation";

assert.equal(typeof root.createEvidenceDeriver, "function");
assert.equal(typeof root.parseDerivationPolicy, "function");
assert.equal(typeof root.parseScrubReceipt, "function");
assert.equal("canonicalJsonBytes" in root, false);
assert.equal("sha256Digest" in root, false);
`,
  );
  await run(process.execPath, [join(consumer, "smoke.mjs")], {
    cwd: consumer,
  });
  console.log("Packed derivation root import and archive boundary verified.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
