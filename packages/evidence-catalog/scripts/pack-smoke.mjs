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
const protocolRoot = join(packagesRoot, "evidence-protocol");
const repositoryRoot = join(packagesRoot, "evidence-repository");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-evidence-catalog-"));
const protocolArchive = join(temporaryRoot, "evidence-protocol.tgz");
const repositoryArchive = join(temporaryRoot, "evidence-repository.tgz");
const catalogArchive = join(temporaryRoot, "evidence-catalog.tgz");
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
    const chunks = [];
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "inherit"],
      ...options,
    });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

try {
  await run("yarn", ["pack", "--out", protocolArchive], { cwd: protocolRoot });
  await run("yarn", ["pack", "--out", repositoryArchive], {
    cwd: repositoryRoot,
  });
  await run("yarn", ["pack", "--out", catalogArchive], { cwd: packageRoot });

  const entries = (await output("tar", ["-tzf", catalogArchive]))
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const required of [
    "package/README.md",
    "package/specification.md",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/testing.js",
    "package/dist/testing.d.ts",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`packed Catalog is missing ${required}`);
    }
  }
  const leakedTests = entries.filter((entry) =>
    /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry),
  );
  if (leakedTests.length > 0) {
    throw new Error(`tests leaked into Catalog tarball: ${leakedTests.join(", ")}`);
  }

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/evidence-protocol": `file:${protocolArchive}`,
        "@jinn-network/evidence-repository": `file:${repositoryArchive}`,
        "@jinn-network/evidence-catalog": `file:${catalogArchive}`,
        vitest: "4.1.8",
      },
    }),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: consumer,
  });

  const installedRoot = join(
    consumer,
    "node_modules",
    "@jinn-network",
    "evidence-catalog",
  );
  const smoke = join(consumer, "smoke.mjs");
  await writeFile(
    smoke,
    `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { InMemoryEvidenceCatalog } from "@jinn-network/evidence-catalog";
import { createCatalogContractFixtures } from "@jinn-network/evidence-catalog/testing";

const catalog = new InMemoryEvidenceCatalog();
const { privateExecution } = createCatalogContractFixtures();
assert.equal((await catalog.putRecordProjection(privateExecution)).status, "created");
assert.equal((await catalog.observeRecordLocation(privateExecution.reference, {
  sourceId: "smoke",
  announcementId: "available",
  repositoryId: "packed",
})).status, "created");
assert.deepEqual(await catalog.getRecord(privateExecution.reference), privateExecution);
assert.deepEqual(await catalog.getRecordLocations(privateExecution.reference), [
  { repositoryId: "packed" },
]);
const packageJson = JSON.parse(await readFile(${JSON.stringify(
      join(installedRoot, "package.json"),
    )}, "utf8"));
assert.deepEqual(Object.keys(packageJson.dependencies).filter((name) =>
  name.startsWith("@jinn-network/")).sort(), [
  "@jinn-network/evidence-protocol",
  "@jinn-network/evidence-repository",
]);
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
await readFile(${JSON.stringify(join(installedRoot, "specification.md"))});
console.log("Packed Catalog imports, round trip, assets, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smoke], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
