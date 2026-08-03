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
  [join(packagesRoot, "protocol"), "evidence-protocol", "@jinn-network/evidence-protocol"],
  [join(packagesRoot, "repository"), "evidence-repository", "@jinn-network/evidence-repository"],
  [join(packagesRoot, "discovery"), "evidence-discovery", "@jinn-network/evidence-discovery"],
  [join(packagesRoot, "catalog-sqlite"), "evidence-catalog-sqlite", "@jinn-network/evidence-catalog-sqlite"],
  [join(packagesRoot, "local-runtime"), "evidence-local-runtime", "@jinn-network/evidence-local-runtime"],
  [join(packagesRoot, "..", "trust", "core"), "trust-core", "@jinn-network/trust-core"],
  [join(packagesRoot, "..", "discovery", "protocol"), "record-discovery-protocol", "@jinn-network/record-discovery-protocol"],
  [join(packagesRoot, "..", "discovery", "serve"), "record-discovery-serve", "@jinn-network/record-discovery-serve"],
  [join(packagesRoot, "..", "discovery", "sources", "evidence-journal"), "record-discovery-source-evidence-journal", "@jinn-network/record-discovery-source-evidence-journal"],
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
  for (const [directory, archiveName, name] of packages) {
    const archive = join(temporaryRoot, `${archiveName}.tgz`);
    await run("yarn", ["pack", "--out", archive], {
      cwd: directory,
    });
    archives.set(name, archive);
  }

  for (const directory of [
    "evidence-catalog-sqlite",
    "evidence-discovery",
    "evidence-local-runtime",
    "record-discovery-source-evidence-journal",
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
        ...packages.map(([, , name]) => [name, `file:${archives.get(name)}`]),
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
} from "@jinn-network/evidence-discovery/journal";
import {
  createSqliteEvidenceCatalog,
} from "@jinn-network/evidence-catalog-sqlite";
import {
  openLocalEvidenceRuntime,
} from "@jinn-network/evidence-local-runtime";
import {
  DISCOVERY_SIGNING_SCOPE,
  GENESIS_SEQUENCE,
  archivePagePath,
  headPath,
} from "@jinn-network/record-discovery-protocol";
import {
  createEvidenceJournalDurableBridge,
} from "@jinn-network/record-discovery-source-evidence-journal";

assert.equal(typeof openFilesystemEvidenceAnnouncementJournal, "function");
assert.equal(typeof createSqliteEvidenceCatalog, "function");
assert.equal(typeof openLocalEvidenceRuntime, "function");
assert.equal(typeof createEvidenceJournalDurableBridge, "function");

function equalBytes(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

class MemoryBlobs {
  values = new Map();
  async get(path) {
    const value = this.values.get(path);
    return value === undefined ? undefined : { bytes: value.bytes.slice(), contentType: value.contentType };
  }
  async put(path, bytes, contentType) {
    this.values.set(path, { bytes: bytes.slice(), contentType });
  }
  async putImmutable(path, bytes, contentType) {
    const existing = this.values.get(path);
    if (existing !== undefined && (!equalBytes(existing.bytes, bytes) || existing.contentType !== contentType)) {
      throw new Error("immutable packed bridge conflict at " + path);
    }
    if (existing === undefined) this.values.set(path, { bytes: bytes.slice(), contentType });
  }
}

const source = { agent: "did:key:zPackedEvidenceBridge", name: "evidence-journal" };
const signer = {
  keyId: "packed-evidence-bridge-key",
  scope: DISCOVERY_SIGNING_SCOPE,
  async sign(pae) { return [{ keyid: this.keyId, sig: pae.slice() }]; },
  verify(pae, signature) { return equalBytes(pae, signature); },
};
const bridgeFactory = (context) => createEvidenceJournalDurableBridge({
  source: context.source,
  evidenceSourceId: context.evidenceSourceId,
  journal: context.journal,
  withdrawals: context.withdrawals,
  records: context.records,
  writer: context.writer,
  writerIntents: context.writerIntents,
  states: context.openBridgeStateStore(),
  strategies: context.strategies,
  now: context.now,
});

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

  const publicRoot = await mkdtemp(join(tmpdir(), "jinn-packed-public-bridge-"));
  try {
    const blobs = new MemoryBlobs();
    const publicOptions = {
      source,
      signer,
      blobs,
      bridgeFactory,
      now: () => new Date("2026-08-03T12:00:00.000Z"),
    };
    const publicRuntime = await openLocalEvidenceRuntime({
      rootDir: publicRoot,
      publicDiscovery: publicOptions,
    });
    const publicReceipt = await publicRuntime.repository.putRecord(
      "execution-evidence",
      recordBytes,
    );
    await publicRuntime.sync();
    const page = await blobs.get(archivePagePath(source.name, GENESIS_SEQUENCE));
    assert.ok(page);
    const pageJson = JSON.parse(new TextDecoder().decode(page.bytes));
    assert.equal(
      pageJson.entries[0].entry.announcements[0].record.digest,
      publicReceipt.reference.digest,
    );
    const headBefore = (await blobs.get(headPath(source.name))).bytes;
    await publicRuntime.close();

    const restarted = await openLocalEvidenceRuntime({
      rootDir: publicRoot,
      publicDiscovery: publicOptions,
    });
    assert.deepEqual((await blobs.get(headPath(source.name))).bytes, headBefore);
    assert.equal((await restarted.publicDiscovery.readState()).pending, undefined);
    await restarted.close();
  } finally {
    await rm(publicRoot, { recursive: true, force: true });
  }

  for (const directory of [
    "evidence-catalog-sqlite",
    "evidence-discovery",
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
  assert.equal(
    runtimeManifest.dependencies?.["@jinn-network/record-discovery-source-evidence-journal"],
    undefined,
    "optional bridge adapter leaked into the ordinary local-runtime closure",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
`,
  );
  await run(process.execPath, [smokeTest], { cwd: consumer });
  console.log(
    "Packed local and bridge packages, exact-byte persistence, indexing, restart, " +
    "optional adapter injection, README, archive, and dependency boundaries verified.",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
