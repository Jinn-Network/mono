// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(packageRoot, "..");
const trustCoreRoot = join(packagesRoot, "..", "trust", "core");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-evidence-trajectory-"));
const protocolArchive = join(temporaryRoot, "evidence-protocol.tgz");
const trustCoreArchive = join(temporaryRoot, "trust-core.tgz");
const trajectoryArchive = join(temporaryRoot, "evidence-trajectory.tgz");
const rootConsumer = join(temporaryRoot, "root-consumer");
const testingConsumer = join(temporaryRoot, "testing-consumer");

const REQUIRED_ENTRIES = [
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/dist/testing.js",
  "package/dist/testing.d.ts",
  "package/schemas/trajectory.schema.json",
  "package/fixtures/trajectory/valid.json",
  "package/fixtures/trajectory/valid.sha256",
  "package/fixtures/adversarial-v1/manifest.json",
  "package/fixtures/derivation/execution-golden-base.json",
  "package/README.md",
  "package/package.json",
];

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
  await run("corepack", ["yarn@4.13.0", "build"], { cwd: trustCoreRoot });
  await run(
    "corepack",
    ["yarn@4.13.0", "pack", "--out", trustCoreArchive],
    { cwd: trustCoreRoot },
  );
  await run(
    "corepack",
    ["yarn@4.13.0", "pack", "--out", protocolArchive],
    { cwd: join(packagesRoot, "protocol") },
  );
  await run(
    "corepack",
    ["yarn@4.13.0", "pack", "--out", trajectoryArchive],
    { cwd: packageRoot },
  );

  const entries = (await output("tar", ["-tzf", trajectoryArchive]))
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const required of REQUIRED_ENTRIES) {
    if (!entries.includes(required)) {
      throw new Error(`packed trajectory is missing ${required}`);
    }
  }
  const leaked = entries.filter(
    (entry) =>
      /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry) ||
      entry.endsWith(".map") ||
      entry.includes("/src/") ||
      entry.includes("local-corpus"),
  );
  if (leaked.length > 0) {
    throw new Error(
      `private/test implementation material leaked into tarball: ${leaked.join(", ")}`,
    );
  }

  const manifestEntry = entries.find((entry) =>
    entry.endsWith("fixtures/adversarial-v1/manifest.json"),
  );
  assert.ok(manifestEntry, "packed adversarial manifest must be present");
  const manifest = JSON.parse(
    await output("tar", ["-xOf", trajectoryArchive, manifestEntry]),
  );
  assert.equal(
    manifest.fixtures.length,
    8,
    "packed adversarial manifest must ship exactly eight fixtures",
  );

  await mkdir(rootConsumer);
  await writeFile(
    join(rootConsumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/evidence-trajectory": `file:${trajectoryArchive}`,
        "@jinn-network/evidence-protocol": `file:${protocolArchive}`,
        "@jinn-network/trust-core": `file:${trustCoreArchive}`,
      },
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: rootConsumer },
  );
  await writeFile(
    join(rootConsumer, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import * as root from "@jinn-network/evidence-trajectory";

assert.equal(typeof root.sealTrajectory, "function");
assert.equal(typeof root.parseTrajectory, "function");
assert.equal(typeof root.verifyTrajectoryDerivationAttestation, "function");
assert.equal(root.TRAJECTORY_RECORD_KIND, "https://jinn.network/records/trajectory/1.0");
assert.equal("canonicalJsonBytes" in root, false);
assert.equal("sha256Digest" in root, false);
`,
  );
  await run(process.execPath, [join(rootConsumer, "smoke.mjs")], {
    cwd: rootConsumer,
  });
  await assert.rejects(
    access(join(rootConsumer, "node_modules", "vitest", "package.json")),
    { code: "ENOENT" },
  );
  const installedManifest = JSON.parse(
    await readFile(
      join(
        rootConsumer,
        "node_modules",
        "@jinn-network",
        "evidence-trajectory",
        "package.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(installedManifest.peerDependencies, {
    vitest: "^4.1.8",
  });
  assert.deepEqual(installedManifest.peerDependenciesMeta, {
    vitest: { optional: true },
  });
  const forbiddenDependencies = [
    "@jinn-network/attestation-issuer",
    "@huggingface/transformers",
    "@lmoe/gliner-onnx",
    "better-sqlite3",
    "viem",
  ];
  for (const dependency of forbiddenDependencies) {
    if (
      dependency in (installedManifest.dependencies ?? {}) ||
      dependency in (installedManifest.optionalDependencies ?? {})
    ) {
      throw new Error(`packed trajectory includes forbidden ${dependency}`);
    }
  }
  assert.ok(
    "@jinn-network/trust-core" in (installedManifest.dependencies ?? {}),
    "packed trajectory must depend on @jinn-network/trust-core",
  );

  await mkdir(testingConsumer);
  await writeFile(
    join(testingConsumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/evidence-trajectory": `file:${trajectoryArchive}`,
        "@jinn-network/evidence-protocol": `file:${protocolArchive}`,
        "@jinn-network/trust-core": `file:${trustCoreArchive}`,
        typescript: "5.9.3",
        vite: "6.4.3",
        vitest: "4.1.8",
      },
    }),
  );
  await writeFile(
    join(testingConsumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        strict: true,
        noEmit: true,
        types: ["vitest/globals"],
      },
      include: ["conformance.test.ts"],
    }),
  );
  await writeFile(
    join(testingConsumer, "conformance.test.ts"),
    `
import { describeTrajectoryDerivationAttestationConformance, describeTrajectoryRecordConformance } from "@jinn-network/evidence-trajectory/testing";

describeTrajectoryRecordConformance();
describeTrajectoryDerivationAttestationConformance();
`,
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: testingConsumer },
  );
  await run(
    "npm",
    ["exec", "--", "tsc", "--noEmit", "-p", "tsconfig.json"],
    { cwd: testingConsumer },
  );
  await run(
    "npm",
    ["exec", "--", "vitest", "run", "conformance.test.ts"],
    { cwd: testingConsumer },
  );
  console.log(
    "Packed trajectory root isolation, packed conformance kit, and archive boundary verified.",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
