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
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "jinn-evidence-catalog-sqlite-"),
);
const archives = {
  protocol: join(temporaryRoot, "evidence-protocol.tgz"),
  repository: join(temporaryRoot, "evidence-repository.tgz"),
  discovery: join(temporaryRoot, "evidence-discovery.tgz"),
  sqlite: join(temporaryRoot, "evidence-catalog-sqlite.tgz"),
};
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
  for (const [directory, archive] of [
    ["protocol", archives.protocol],
    ["repository", archives.repository],
    ["discovery", archives.discovery],
    ["catalog-sqlite", archives.sqlite],
  ]) {
    await run("yarn", ["pack", "--out", archive], {
      cwd: join(packagesRoot, directory),
    });
  }

  const entries = (await output("tar", ["-tzf", archives.sqlite]))
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const required of [
    "package/README.md",
    "package/dist/index.js",
    "package/dist/index.d.ts",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`packed SQLite Catalog is missing ${required}`);
    }
  }
  const leakedTests = entries.filter((entry) =>
    /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry),
  );
  if (leakedTests.length > 0) {
    throw new Error(
      `tests leaked into SQLite Catalog tarball: ${leakedTests.join(", ")}`,
    );
  }

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/evidence-protocol": `file:${archives.protocol}`,
        "@jinn-network/evidence-repository": `file:${archives.repository}`,
        "@jinn-network/evidence-discovery": `file:${archives.discovery}`,
        "@jinn-network/evidence-catalog-sqlite": `file:${archives.sqlite}`,
      },
    }),
  );
  await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: consumer });

  const installedRoot = join(
    consumer,
    "node_modules",
    "@jinn-network",
    "evidence-catalog-sqlite",
  );
  const smoke = join(consumer, "smoke.mjs");
  await writeFile(
    smoke,
    `
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSqliteEvidenceCatalog,
  openSqliteEvidenceCatalog,
} from "@jinn-network/evidence-catalog-sqlite";

const root = await mkdtemp(join(tmpdir(), "jinn-packed-catalog-sqlite-"));
const databasePath = join(root, "catalog.sqlite");
try {
  const digest = (character) => "sha256:" + character.repeat(64);
  const fixture = {
    family: "execution-evidence",
    reference: { family: "execution-evidence", digest: digest("1") },
    byteSize: 10,
    executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
    task: { entityId: "task.md", digest: digest("a") },
    executorId: "urn:uuid:22222222-2222-4222-8222-222222222222",
    runtime: { entityId: "runtime.json", digest: digest("b") },
    results: [{ entityId: "result.patch", digest: digest("c") }],
    nativeTrace: { entityId: "trace.jsonl", digest: digest("d") },
    outcome: "completed",
    startedAt: "2026-07-25T00:00:00Z",
    endedAt: "2026-07-25T00:00:01Z",
    publishedAt: "2026-07-25T00:00:02Z",
    declaredEntities: [],
    declaredRelationships: [],
  };
  const generation = {
    catalogSchemaVersion: "1.0.0",
    projectorVersion: "packed-smoke",
    createdAt: "2026-07-25T00:00:00Z",
  };
  const catalog = await createSqliteEvidenceCatalog({ databasePath, generation });
  assert.equal((await catalog.putRecordProjection(fixture)).status, "created");
  assert.equal((await catalog.observeRecordLocation(fixture.reference, {
    sourceId: "packed",
    announcementId: "available",
    repositoryId: "packed-repository",
  })).status, "created");
  assert.deepEqual((await catalog.findExecutions({})).items, [fixture]);
  await catalog.close();

  const reopened = await openSqliteEvidenceCatalog({ databasePath });
  assert.deepEqual(reopened.generation, generation);
  assert.deepEqual(await reopened.getRecord(fixture.reference), fixture);
  assert.deepEqual(await reopened.integrityCheck(), {
    valid: true,
    messages: [],
  });
  await reopened.close();

  const packageJson = JSON.parse(await readFile(${JSON.stringify(
    join(installedRoot, "package.json"),
  )}, "utf8"));
  assert.deepEqual(
    Object.keys(packageJson.dependencies)
      .filter((name) => name.startsWith("@jinn-network/"))
      .sort(),
    [
      "@jinn-network/evidence-discovery",
      "@jinn-network/evidence-repository",
    ],
  );
  assert.equal(packageJson.dependencies["better-sqlite3"], "13.0.1");
  await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
  console.log("Packed SQLite Catalog create, reopen, query, integrity, assets, and dependency boundary verified.");
} finally {
  await rm(root, { recursive: true, force: true });
}
`,
  );
  await run(process.execPath, [smoke], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
