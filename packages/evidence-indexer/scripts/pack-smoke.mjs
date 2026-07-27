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
  indexer: packageRoot,
};
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-evidence-indexer-"));
const archives = Object.fromEntries(
  Object.keys(roots).map((name) => [
    name,
    join(temporaryRoot, `evidence-${name}.tgz`),
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
  const entries = (await output("tar", ["-tzf", archives.indexer]))
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const required of [
    "package/README.md",
    "package/dist/index.js",
    "package/dist/index.d.ts",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`packed Indexer is missing ${required}`);
    }
  }
  const leakedTests = entries.filter((entry) =>
    /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry),
  );
  if (leakedTests.length > 0) {
    throw new Error(`tests leaked into Indexer tarball: ${leakedTests.join(", ")}`);
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
        "@jinn-network/evidence-catalog": `file:${archives.catalog}`,
        "@jinn-network/evidence-indexer": `file:${archives.indexer}`,
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
    "evidence-indexer",
  );
  const smoke = join(consumer, "smoke.mjs");
  await writeFile(
    smoke,
    `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import { InMemoryEvidenceCatalog } from "@jinn-network/evidence-catalog";
import {
  createEvidenceIndexer,
  validateAndProjectEvidenceRecord,
} from "@jinn-network/evidence-indexer";

const root = new URL(".", import.meta.resolve(
  "@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/README.md",
));
const bytes = await readFile(new URL("execution/ro-crate-metadata.json", root));
const repository = new InMemoryEvidenceRepository();
const stored = await repository.putRecord("execution-evidence", bytes);
const pure = validateAndProjectEvidenceRecord(stored.reference, bytes);
assert.equal(pure.conforms, true);
const catalog = new InMemoryEvidenceCatalog();
const result = await createEvidenceIndexer({
  repositories: { async resolve(id) { return id === "packed" ? repository : null; } },
  catalog,
}).index({
  kind: "available",
  sourceId: "smoke",
  announcementId: "available",
  repositoryId: "packed",
  reference: stored.reference,
});
assert.equal(result.status, "indexed");
assert.ok(await catalog.getRecord(stored.reference));
const packageJson = JSON.parse(await readFile(${JSON.stringify(
      join(installedRoot, "package.json"),
    )}, "utf8"));
assert.deepEqual(Object.keys(packageJson.dependencies).filter((name) =>
  name.startsWith("@jinn-network/")).sort(), [
  "@jinn-network/evidence-catalog",
  "@jinn-network/evidence-protocol",
  "@jinn-network/evidence-repository",
]);
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Packed Indexer fixture, announcement round trip, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smoke], { cwd: consumer });

  const distFiles = await readdir(join(installedRoot, "dist"));
  if (distFiles.some((name) => /\.(?:test|spec)\./u.test(name))) {
    throw new Error("tests leaked into installed Indexer dist");
  }
  for (const name of distFiles.filter((entry) => entry.endsWith(".js"))) {
    const source = await readFile(join(installedRoot, "dist", name), "utf8");
    for (const forbidden of [
      "evidence-repository/fs",
      "evidence-repository-oci",
      "sqlite",
      "postgres",
      "ponder",
    ]) {
      if (source.toLowerCase().includes(forbidden)) {
        throw new Error(`undeclared binding import in ${name}: ${forbidden}`);
      }
    }
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
