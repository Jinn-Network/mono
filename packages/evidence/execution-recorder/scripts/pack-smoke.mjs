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
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "jinn-execution-recorder-"),
);
const protocolArchive = join(temporaryRoot, "evidence-protocol.tgz");
const repositoryArchive = join(temporaryRoot, "evidence-repository.tgz");
const recorderArchive = join(temporaryRoot, "execution-recorder.tgz");
const consumer = join(temporaryRoot, "consumer");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
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

function assertArchiveShape(entries) {
  const required = [
    "package/README.md",
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/dist/testing.d.ts",
    "package/dist/testing.js",
    "package/fixtures/producer-contract-v1/README.md",
    "package/fixtures/producer-contract-v1/completed.json",
    "package/fixtures/producer-contract-v1/failed.json",
    "package/fixtures/producer-contract-v1/abandoned.json",
  ];
  for (const entry of required) {
    if (!entries.includes(entry)) {
      throw new Error(`packed execution recorder is missing ${entry}`);
    }
  }

  const leakedTests = entries.filter((entry) =>
    /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry),
  );
  if (leakedTests.length > 0) {
    throw new Error(
      `test files leaked into execution recorder tarball: ${leakedTests.join(", ")}`,
    );
  }
}

try {
  await run("yarn", ["pack", "--out", protocolArchive], {
    cwd: protocolRoot,
  });
  await run("yarn", ["pack", "--out", repositoryArchive], {
    cwd: repositoryRoot,
  });
  await run("yarn", ["pack", "--out", recorderArchive], {
    cwd: packageRoot,
  });

  const archiveEntries = (
    await output("tar", ["-tzf", recorderArchive])
  )
    .split(/\r?\n/u)
    .filter(Boolean);
  assertArchiveShape(archiveEntries);

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/evidence-protocol": `file:${protocolArchive}`,
        "@jinn-network/evidence-repository": `file:${repositoryArchive}`,
        "@jinn-network/execution-recorder": `file:${recorderArchive}`,
        vitest: "4.1.8",
      },
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer },
  );

  const installedRoot = join(
    consumer,
    "node_modules",
    "@jinn-network",
    "execution-recorder",
  );
  const smokeTest = join(consumer, "packed-imports.test.mjs");
  await writeFile(
    smokeTest,
    `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CAPTURE_DIAGNOSTIC_CODES,
  EXECUTION_RECORDER_ERROR_CODES,
  createExecutionRecorder,
} from "@jinn-network/execution-recorder";
import {
  describeExecutionProducerContract,
} from "@jinn-network/execution-recorder/testing";
import { test } from "vitest";

test("packed execution recorder exposes its public distribution contract", async () => {
  const repository = {
    async putRecord() { throw new Error("not used"); },
    async getRecord() { return null; },
    async putArtifact() { throw new Error("not used"); },
    async getArtifact() { return null; },
  };
  const recorder = createExecutionRecorder({ repository });
  assert.equal(typeof recorder.start, "function");
  assert.equal(typeof recorder.resume, "function");
  assert.deepEqual(CAPTURE_DIAGNOSTIC_CODES, [
    "NATIVE_TRACE_MISSING",
    "COMPLETED_RESULT_MISSING",
  ]);
  assert.ok(EXECUTION_RECORDER_ERROR_CODES.includes("WORKSPACE_CORRUPT"));
  assert.equal(typeof describeExecutionProducerContract, "function");

  const fixtureFiles = [
    "README.md",
    "completed.json",
    "failed.json",
    "abandoned.json",
    "result.txt",
    "runner.mjs",
    "runtime.json",
    "task.md",
    "trace.jsonl",
  ];
  for (const fixture of fixtureFiles) {
    const specifier =
      "@jinn-network/execution-recorder/fixtures/producer-contract-v1/" +
      fixture;
    const bytes = await readFile(new URL(import.meta.resolve(specifier)));
    assert.ok(bytes.byteLength > 0, "empty exported fixture: " + fixture);
  }

  const packageJson = JSON.parse(
    await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"),
  );
  assert.deepEqual(packageJson.dependencies, {
    "@jinn-network/evidence-protocol": "0.1.0",
    "@jinn-network/evidence-repository": "0.1.0",
  });
  assert.deepEqual(packageJson.peerDependencies, {
    vitest: "^4.1.8",
  });
  assert.deepEqual(packageJson.peerDependenciesMeta, {
    vitest: { optional: true },
  });
  await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
});
`,
  );
  const vitest = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "vitest.cmd" : "vitest",
  );
  await run(vitest, ["run", "packed-imports.test.mjs"], {
    cwd: consumer,
  });
  console.log(
    "Packed root/testing imports, fixtures, dependency boundary, and archive shape verified.",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
