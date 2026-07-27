// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(packageRoot, "..");
const roots = {
  protocol: join(packagesRoot, "evidence-protocol"),
  repository: join(packagesRoot, "evidence-repository"),
  catalog: join(packagesRoot, "evidence-catalog"),
  journal: packageRoot,
};
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-journal-pack-"));
const archives = Object.fromEntries(
  Object.keys(roots).map((name) => [
    name,
    join(temporaryRoot, `${name}.tgz`),
  ]),
);
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
  for (const [name, root] of Object.entries(roots)) {
    await run("yarn", ["pack", "--out", archives[name]], { cwd: root });
  }
  const entries = (await output("tar", ["-tzf", archives.journal]))
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const required of [
    "package/README.md",
    "package/dist/index.js",
    "package/dist/index.d.ts",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`packed journal is missing ${required}`);
    }
  }
  if (entries.some((entry) => /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry))) {
    throw new Error("tests leaked into the packed announcement journal");
  }

  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@jinn-network/evidence-protocol": `file:${archives.protocol}`,
      "@jinn-network/evidence-repository": `file:${archives.repository}`,
      "@jinn-network/evidence-catalog": `file:${archives.catalog}`,
      "@jinn-network/evidence-announcement-journal": `file:${archives.journal}`,
    },
  }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: consumer,
  });

  const installedRoot = join(
    consumer,
    "node_modules",
    "@jinn-network",
    "evidence-announcement-journal",
  );
  const smoke = join(consumer, "smoke.mjs");
  await writeFile(smoke, `
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openFilesystemEvidenceAnnouncementJournal,
} from "@jinn-network/evidence-announcement-journal";

const root = await mkdtemp(join(tmpdir(), "jinn-packed-journal-"));
try {
  const journal = await openFilesystemEvidenceAnnouncementJournal({
    rootDir: root,
    sourceId: "urn:uuid:11111111-1111-4111-8111-111111111111",
  });
  const first = await journal.appendAvailable({
    announcementId: "event-1",
    reference: {
      family: "execution-evidence",
      digest: "sha256:" + "1".repeat(64),
    },
    repositoryId: "local:fixture",
  });
  const second = await journal.appendAvailable({
    announcementId: "event-2",
    reference: {
      family: "result-evaluation",
      digest: "sha256:" + "2".repeat(64),
    },
    repositoryId: "local:fixture",
  });
  const resumed = [];
  for await (const batch of journal.read({ after: first.cursor })) {
    resumed.push(batch);
  }
  assert.deepEqual(resumed, [{
    announcements: [second.announcement],
    cursor: second.cursor,
  }]);
  assert.equal(await journal.getEntryCount(), 2);
  await journal.close();

  const reopened = await openFilesystemEvidenceAnnouncementJournal({
    rootDir: root,
    sourceId: "urn:uuid:11111111-1111-4111-8111-111111111111",
  });
  assert.equal(await reopened.getHighWaterCursor(), second.cursor);
  await reopened.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

const packageJson = JSON.parse(await readFile(${JSON.stringify(
    join(installedRoot, "package.json"),
  )}, "utf8"));
assert.deepEqual(
  Object.keys(packageJson.dependencies)
    .filter((name) => name.startsWith("@jinn-network/"))
    .sort(),
  [
    "@jinn-network/evidence-catalog",
    "@jinn-network/evidence-repository",
  ],
);
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Packed journal append, resume, reopen, and dependency boundary verified.");
`);
  await run(process.execPath, [smoke], { cwd: consumer });
  const distFiles = await readdir(join(installedRoot, "dist"));
  if (distFiles.some((name) => /\.(?:test|spec)\./u.test(name))) {
    throw new Error("tests leaked into installed journal dist");
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
