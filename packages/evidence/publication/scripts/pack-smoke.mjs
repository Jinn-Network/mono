// SPDX-License-Identifier: Apache-2.0
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
  join(tmpdir(), "jinn-evidence-publication-"),
);
const consumer = join(temporaryRoot, "consumer");
const archives = {
  protocol: join(temporaryRoot, "protocol.tgz"),
  repository: join(temporaryRoot, "repository.tgz"),
  trust: join(temporaryRoot, "trust.tgz"),
  recordDiscoveryProtocol: join(temporaryRoot, "record-discovery-protocol.tgz"),
  recordDiscoveryServe: join(temporaryRoot, "record-discovery-serve.tgz"),
  recordPublication: join(temporaryRoot, "record-publication.tgz"),
  publication: join(temporaryRoot, "publication.tgz"),
};

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
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      } else {
        reject(new Error(`${command} exited with ${code}`));
      }
    });
  });
}

try {
  await run("yarn", ["pack", "--out", archives.protocol], {
    cwd: join(packagesRoot, "protocol"),
  });
  await run("yarn", ["pack", "--out", archives.repository], {
    cwd: join(packagesRoot, "repository"),
  });
  await run("yarn", ["pack", "--out", archives.trust], {
    cwd: join(packagesRoot, "..", "trust", "core"),
  });
  await run("yarn", ["pack", "--out", archives.recordDiscoveryProtocol], {
    cwd: join(packagesRoot, "..", "discovery", "protocol"),
  });
  await run("yarn", ["pack", "--out", archives.recordDiscoveryServe], {
    cwd: join(packagesRoot, "..", "discovery", "serve"),
  });
  await run("yarn", ["pack", "--out", archives.recordPublication], {
    cwd: join(packagesRoot, "..", "discovery", "publication"),
  });
  await run("yarn", ["pack", "--out", archives.publication], {
    cwd: packageRoot,
  });

  const entries = (await output("tar", ["-tzf", archives.publication]))
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const required of [
    "package/README.md",
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/dist/testing.d.ts",
    "package/dist/testing.js",
    "package/dist/fs/index.d.ts",
    "package/dist/fs/index.js",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`packed Publication is missing ${required}`);
    }
  }
  const leakedTests = entries.filter((entry) =>
    /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry)
  );
  if (leakedTests.length > 0) {
    throw new Error(
      `tests leaked into Publication tarball: ${leakedTests.join(", ")}`,
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
        "@jinn-network/trust-core": `file:${archives.trust}`,
        "@jinn-network/record-discovery-protocol": `file:${archives.recordDiscoveryProtocol}`,
        "@jinn-network/record-discovery-serve": `file:${archives.recordDiscoveryServe}`,
        "@jinn-network/record-publication": `file:${archives.recordPublication}`,
        "@jinn-network/evidence-publication": `file:${archives.publication}`,
        typescript: "5.9.3",
        vite: "6.4.3",
        vitest: "4.1.8",
      },
    }),
  );
  await run(
    "npm",
    ["install", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer },
  );

  await writeFile(
    join(consumer, "packed-types.ts"),
    `
import {
  type AnnouncementSink,
  type PublicationJournalStore,
  type PublishInput,
} from "@jinn-network/evidence-publication";
// @ts-expect-error Internal placement continuation is not a public export.
import type { continuePublicationPlacements } from "@jinn-network/evidence-publication";
import {
  describeAnnouncementSinkContract,
  InMemoryPublicationJournalStore,
} from "@jinn-network/evidence-publication/testing";
import {
  createFilesystemPublicationJournalStore,
  FILESYSTEM_PUBLICATION_JOURNAL_MAX_REVISION_BYTES,
} from "@jinn-network/evidence-publication/fs";

declare const sink: AnnouncementSink;
declare const input: PublishInput;
const journal: PublicationJournalStore = new InMemoryPublicationJournalStore();
const filesystem: Promise<PublicationJournalStore> =
  createFilesystemPublicationJournalStore({ rootDir: "/tmp/type-only" });
const maximumRevisionBytes: number =
  FILESYSTEM_PUBLICATION_JOURNAL_MAX_REVISION_BYTES;
void sink;
void input;
void journal;
void filesystem;
void maximumRevisionBytes;
void describeAnnouncementSinkContract;
void (null as unknown as typeof continuePublicationPlacements);
`,
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ES2022",
      },
      include: ["packed-types.ts"],
    }),
  );
  await run(
    process.execPath,
    [
      join(consumer, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      join(consumer, "tsconfig.json"),
    ],
    { cwd: consumer },
  );

  const installed = join(
    consumer,
    "node_modules",
    "@jinn-network",
    "evidence-publication",
  );
  await writeFile(
    join(consumer, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as root from "@jinn-network/evidence-publication";
import {
  InMemoryAnnouncementSink,
  InMemoryPublicationJournalStore,
} from "@jinn-network/evidence-publication/testing";
import {
  createFilesystemPublicationJournalStore,
  FILESYSTEM_PUBLICATION_JOURNAL_MAX_REVISION_BYTES,
} from "@jinn-network/evidence-publication/fs";
import { createRecordReference } from "@jinn-network/evidence-repository";

assert.equal("createFilesystemPublicationJournalStore" in root, false);
assert.equal("continuePublicationPlacements" in root, false);
assert.equal(FILESYSTEM_PUBLICATION_JOURNAL_MAX_REVISION_BYTES, 8 * 1024 * 1024);
const sink = new InMemoryAnnouncementSink({
  medium: "https://publication.test/medium",
  profile: "https://publication.test/profile/v1",
});
const recordBytes = new Uint8Array([1]);
const member = {
  reference: createRecordReference(
    "execution-evidence",
    recordBytes,
  ),
};
const prepared = await sink.prepare([member], {
  destination: "urn:jinn:publication-destination:packed-smoke",
  partitionOrdinal: 0,
});
assert.equal(prepared.medium, sink.medium);
assert.equal(prepared.profile, sink.profile);
assert.equal(prepared.frameSize, prepared.frameBytes.byteLength);
assert.ok(new InMemoryPublicationJournalStore());

const directory = await mkdtemp(
  join(tmpdir(), "jinn-publication-packed-"),
);
try {
  const journal = await createFilesystemPublicationJournalStore({
    rootDir: directory,
  });
  const normalized = root.normalizePublishInput({
    records: [{ reference: member.reference, bytes: recordBytes }],
    destination: "urn:jinn:publication-destination:packed-smoke",
  });
  const entry = {
    schemaVersion: 1,
    bundleKey: normalized.bundleKey,
    payloadFingerprint: normalized.payloadFingerprint,
    destination: normalized.destination,
    repositoryCapabilities: {},
    artifacts: [],
    records: normalized.records.map(({ reference }) => reference),
    storedArtifacts: [],
    storedRecords: [],
    completed: false,
  };
  const created = await journal.create(entry);
  assert.equal((await journal.load(entry.bundleKey)).revision, created.revision);
} finally {
  await rm(directory, { recursive: true, force: true });
}
`,
  );
  await run(process.execPath, [join(consumer, "smoke.mjs")], {
    cwd: consumer,
  });

  const manifest = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  );
  const jinnRuntimeDependencies = Object.keys(manifest.dependencies ?? {})
    .filter((name) => name.startsWith("@jinn-network/"));
  if (
    jinnRuntimeDependencies.join(",") !==
      "@jinn-network/evidence-repository,@jinn-network/record-publication"
  ) {
    throw new Error(
      `unexpected Publication dependency boundary: ${
        jinnRuntimeDependencies.join(", ")
      }`,
    );
  }
  const distFiles = entries
    .filter((entry) => entry.startsWith("package/dist/") && entry.endsWith(".js"))
    .map((entry) => entry.slice("package/".length));
  for (const file of distFiles) {
    const source = await readFile(join(installed, file), "utf8");
    for (const forbidden of [
      "@jinn-network/evidence-protocol",
      "@jinn-network/evidence-discovery",
      "@jinn-network/evidence-repository/fs",
      "@jinn-network/evidence-repository-oci",
      "@jinn-network/evidence-repository-ipfs",
    ]) {
      if (source.includes(forbidden)) {
        throw new Error(`${file} leaked forbidden import ${forbidden}`);
      }
    }
  }
  console.log(
    "Packed publication root, testing, filesystem, types, and boundaries verified.",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
