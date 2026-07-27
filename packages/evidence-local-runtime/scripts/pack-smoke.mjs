// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import {
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
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-local-runtime-"));
const consumer = join(temporaryRoot, "consumer");

const packages = [
  ["evidence-protocol", "@jinn-network/evidence-protocol"],
  ["evidence-repository", "@jinn-network/evidence-repository"],
  ["evidence-catalog", "@jinn-network/evidence-catalog"],
  ["evidence-indexer", "@jinn-network/evidence-indexer"],
  ["evidence-catalog-sqlite", "@jinn-network/evidence-catalog-sqlite"],
  [
    "evidence-announcement-journal",
    "@jinn-network/evidence-announcement-journal",
  ],
  ["evidence-local-runtime", "@jinn-network/evidence-local-runtime"],
];

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
      reject(new Error(
        `${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`,
      ));
    });
  });
}

function assertArchiveShape(packageName, entries) {
  for (const required of [
    "package/README.md",
    "package/dist/index.d.ts",
    "package/dist/index.js",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`${packageName} archive is missing ${required}`);
    }
  }
  const leakedTests = entries.filter((entry) =>
    entry.startsWith("package/dist/") &&
    /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry)
  );
  if (leakedTests.length > 0) {
    throw new Error(
      `${packageName} archive contains tests: ${leakedTests.join(", ")}`,
    );
  }
}

try {
  const archives = new Map();
  for (const [directory, name] of packages) {
    const archive = join(temporaryRoot, `${directory}.tgz`);
    await run("yarn", ["pack", "--out", archive], {
      cwd: join(packagesRoot, directory),
    });
    archives.set(name, archive);
  }

  for (const directory of [
    "evidence-catalog-sqlite",
    "evidence-announcement-journal",
    "evidence-local-runtime",
  ]) {
    const entries = (
      await output("tar", ["-tzf", join(temporaryRoot, `${directory}.tgz`)])
    ).split(/\r?\n/u).filter(Boolean);
    assertArchiveShape(directory, entries);
  }

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: Object.fromEntries([
        ...packages.map(([, name]) => [name, `file:${archives.get(name)}`]),
        ["better-sqlite3", "13.0.1"],
      ]),
    }),
  );
  await run("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: consumer,
  });

  const installedRoot = join(
    consumer,
    "node_modules",
    "@jinn-network",
  );
  const smokeTest = join(consumer, "packed-smoke.mjs");
  await writeFile(
    smokeTest,
    `
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openFilesystemEvidenceAnnouncementJournal,
} from "@jinn-network/evidence-announcement-journal";
import {
  createSqliteEvidenceCatalog,
} from "@jinn-network/evidence-catalog-sqlite";
import {
  openLocalEvidenceRuntime,
} from "@jinn-network/evidence-local-runtime";

assert.equal(typeof openFilesystemEvidenceAnnouncementJournal, "function");
assert.equal(typeof createSqliteEvidenceCatalog, "function");
assert.equal(typeof openLocalEvidenceRuntime, "function");

const root = await mkdtemp(join(tmpdir(), "jinn-packed-runtime-"));
try {
  const fixture = new URL(
    import.meta.resolve(
      "@jinn-network/evidence-protocol/fixtures/" +
      "golden-execution-evidence-v1/execution/ro-crate-metadata.json",
    ),
  );
  const recordBytes = await readFile(fixture);
  const artifactBytes = new TextEncoder().encode("packed artifact");

  const runtime = await openLocalEvidenceRuntime({ rootDir: root });
  const artifactReceipt = await runtime.repository.putArtifact(artifactBytes);
  assert.deepEqual(
    await runtime.repository.getArtifact(artifactReceipt.reference),
    new Uint8Array(artifactBytes),
  );

  const recordReceipt = await runtime.repository.putRecord(
    "execution-evidence",
    recordBytes,
  );
  const outcome = await runtime.awaitIndexed(recordReceipt.reference);
  assert.equal(outcome.status, "indexed");
  const projection = await runtime.catalog.getRecord(recordReceipt.reference);
  assert.equal(projection?.family, "execution-evidence");
  assert.deepEqual(
    await runtime.repository.getRecord(recordReceipt.reference),
    new Uint8Array(recordBytes),
  );
  await runtime.close();

  const reopened = await openLocalEvidenceRuntime({ rootDir: root });
  assert.equal(
    (await reopened.catalog.getRecord(recordReceipt.reference))?.family,
    "execution-evidence",
  );
  assert.deepEqual(
    await reopened.repository.getRecord(recordReceipt.reference),
    new Uint8Array(recordBytes),
  );
  await reopened.close();

  for (const directory of [
    "evidence-catalog-sqlite",
    "evidence-announcement-journal",
    "evidence-local-runtime",
  ]) {
    await readFile(
      join(
        ${JSON.stringify(installedRoot)},
        directory,
        "README.md",
      ),
    );
  }

  const runtimeManifest = JSON.parse(
    await readFile(
      join(
        ${JSON.stringify(installedRoot)},
        "evidence-local-runtime",
        "package.json",
      ),
      "utf8",
    ),
  );
  const prohibited = /(?:plugin|autopilot|marketplace|oci|ipfs|network|execution-recorder|attestation-issuer)/iu;
  for (const dependency of Object.keys(runtimeManifest.dependencies ?? {})) {
    const packageName = dependency.split("/").at(-1) ?? dependency;
    assert.equal(
      prohibited.test(packageName),
      false,
      "prohibited runtime dependency: " + dependency,
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
`,
  );
  await run(process.execPath, [smokeTest], { cwd: consumer });
  console.log(
    "Packed local packages, exact-byte persistence, indexing, restart, " +
    "README, archive, and dependency boundaries verified.",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
