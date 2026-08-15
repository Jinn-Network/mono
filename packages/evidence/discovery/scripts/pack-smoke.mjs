// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(packageRoot, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-evidence-discovery-"));
const consumer = join(temporaryRoot, "consumer");
const archives = {
  protocol: join(temporaryRoot, "protocol.tgz"),
  repository: join(temporaryRoot, "repository.tgz"),
  discovery: join(temporaryRoot, "discovery.tgz"),
};

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
  await run("yarn", ["pack", "--out", archives.protocol], {
    cwd: join(packagesRoot, "protocol"),
  });
  await run("yarn", ["pack", "--out", archives.repository], {
    cwd: join(packagesRoot, "repository"),
  });
  await run("yarn", ["pack", "--out", archives.discovery], { cwd: packageRoot });

  const entries = (await output("tar", ["-tzf", archives.discovery]))
    .split(/\r?\n/u).filter(Boolean);
  for (const required of [
    "package/README.md",
    "package/docs/catalog.md",
    "package/docs/indexer.md",
    "package/docs/journal.md",
    "package/specifications/catalog.md",
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/dist/testing.d.ts",
    "package/dist/testing.js",
    "package/dist/indexer/index.d.ts",
    "package/dist/indexer/index.js",
    "package/dist/journal/index.d.ts",
    "package/dist/journal/index.js",
  ]) {
    if (!entries.includes(required)) throw new Error(`packed Discovery is missing ${required}`);
  }
  const leakedTests = entries.filter((entry) => /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry));
  if (leakedTests.length > 0) throw new Error(`tests leaked into Discovery tarball: ${leakedTests.join(", ")}`);

  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@jinn-network/evidence-protocol": `file:${archives.protocol}`,
      "@jinn-network/evidence-repository": `file:${archives.repository}`,
      "@jinn-network/evidence-discovery": `file:${archives.discovery}`,
      vitest: "4.1.8",
    },
  }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });

  const installed = join(consumer, "node_modules", "@jinn-network", "evidence-discovery");
  await writeFile(join(consumer, "smoke.mjs"), `
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryEvidenceCatalog } from "@jinn-network/evidence-discovery";
import { createCatalogContractFixtures } from "@jinn-network/evidence-discovery/testing";
import { createEvidenceIndexer } from "@jinn-network/evidence-discovery/indexer";
import { openFilesystemEvidenceAnnouncementJournal } from "@jinn-network/evidence-discovery/journal";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";

const catalog = new InMemoryEvidenceCatalog();
const fixtures = createCatalogContractFixtures();
await catalog.putRecordProjection(fixtures.privateExecution);
assert.deepEqual(await catalog.getRecord(fixtures.privateExecution.reference), fixtures.privateExecution);
const repository = new InMemoryEvidenceRepository();
const fixture = new URL(import.meta.resolve("@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/execution/ro-crate-metadata.json"));
const receipt = await repository.putRecord("execution-evidence", await readFile(fixture));
const indexed = await createEvidenceIndexer({ repositories: { async resolve(id) { return id === "packed" ? repository : null; } }, catalog }).index({ kind: "available", sourceId: "smoke", announcementId: "one", repositoryId: "packed", reference: receipt.reference });
assert.equal(indexed.status, "indexed");
const root = await mkdtemp(join(tmpdir(), "jinn-discovery-packed-"));
try {
  const journal = await openFilesystemEvidenceAnnouncementJournal({ rootDir: root, sourceId: "urn:uuid:11111111-1111-4111-8111-111111111111" });
  await journal.appendAvailable({ announcementId: "one", reference: receipt.reference, repositoryId: "packed" });
  assert.equal(await journal.getEntryCount(), 1);
  await journal.close();
} finally { await rm(root, { recursive: true, force: true }); }
const manifest = JSON.parse(await readFile(${JSON.stringify(join(installed, "package.json"))}, "utf8"));
assert.deepEqual(Object.keys(manifest.dependencies).filter((name) => name.startsWith("@jinn-network/")).sort(), ["@jinn-network/evidence-protocol", "@jinn-network/evidence-repository"]);
console.log("Packed discovery entrypoints and representative catalog, indexer, and journal flows verified.");
`);
  await run(process.execPath, [join(consumer, "smoke.mjs")], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
