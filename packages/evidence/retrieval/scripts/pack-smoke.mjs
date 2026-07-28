import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(packageRoot, "..");
const protocolRoot = join(packagesRoot, "protocol");
const repositoryRoot = join(packagesRoot, "repository");
const discoveryRoot = join(packagesRoot, "discovery");
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "jinn-evidence-retrieval-"),
);
const protocolArchive = join(temporaryRoot, "evidence-protocol.tgz");
const repositoryArchive = join(temporaryRoot, "evidence-repository.tgz");
const discoveryArchive = join(temporaryRoot, "evidence-discovery.tgz");
const retrievalArchive = join(temporaryRoot, "evidence-retrieval.tgz");
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

function assertArchiveShape(entries) {
  const required = [
    "package/README.md",
    "package/specification.md",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/testing.js",
    "package/dist/testing.d.ts",
  ];
  for (const entry of required) {
    if (!entries.includes(entry)) {
      throw new Error(`packed evidence-retrieval is missing ${entry}`);
    }
  }
  const leaked = entries.filter((entry) =>
    /^package\/dist\/.*\.(?:test|spec)\./u.test(entry),
  );
  if (leaked.length > 0) {
    throw new Error(
      `test files leaked into evidence-retrieval tarball: ${leaked.join(", ")}`,
    );
  }
}

try {
  await run("yarn", ["pack", "--out", protocolArchive], { cwd: protocolRoot });
  await run("yarn", ["pack", "--out", repositoryArchive], { cwd: repositoryRoot });
  await run("yarn", ["pack", "--out", discoveryArchive], { cwd: discoveryRoot });
  await run("yarn", ["pack", "--out", retrievalArchive], { cwd: packageRoot });

  const archiveEntries = (await output("tar", ["-tzf", retrievalArchive]))
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
        "@jinn-network/evidence-discovery": `file:${discoveryArchive}`,
        "@jinn-network/evidence-retrieval": `file:${retrievalArchive}`,
        typescript: "5.9.3",
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
    "evidence-retrieval",
  );

  await writeFile(
    join(consumer, "consumer.ts"),
    `
import {
  createEvidenceRetrieval,
  createFederatedCandidateSource,
  createSavedEvidenceQuery,
  type CandidateSource,
  type EvidenceRetrieval,
} from "@jinn-network/evidence-retrieval";
import {
  StaticCandidateSource,
  createSyntheticRetrievalFixture,
  describeCandidateSourceContract,
} from "@jinn-network/evidence-retrieval/testing";

void createEvidenceRetrieval;
void createFederatedCandidateSource;
void createSavedEvidenceQuery;
void StaticCandidateSource;
void createSyntheticRetrievalFixture;
void describeCandidateSourceContract;
declare const retrieval: EvidenceRetrieval;
declare const source: CandidateSource<{ readonly text: string }>;
void retrieval;
void source;
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
      include: ["consumer.ts"],
    }),
  );
  const typescript = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc",
  );
  await run(typescript, ["--project", "tsconfig.json"], { cwd: consumer });

  const smokeTest = join(consumer, "packed-imports.test.mjs");
  await writeFile(
    smokeTest,
    `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createEvidenceRetrieval,
} from "@jinn-network/evidence-retrieval";
import {
  createSyntheticRetrievalFixture,
} from "@jinn-network/evidence-retrieval/testing";
import { test } from "vitest";

test("packed evidence-retrieval performs a known-reference retrieval and a query", async () => {
  const fixture = await createSyntheticRetrievalFixture();
  assert.equal(typeof createEvidenceRetrieval, "function");
  const [firstRecord] = [...fixture.records.values()];
  const retrieveOutcome = await fixture.retrieval.retrieve({
    reference: firstRecord.reference,
  });
  assert.equal(retrieveOutcome.status, "validated");

  const queryOutcome = await fixture.retrieval.query({
    candidateSource: fixture.source,
    sourceQuery: { kind: "all" },
    resultLimit: fixture.records.size,
    candidateBudget: fixture.records.size,
  });
  assert.ok(queryOutcome.results.length > 0);
  await fixture.cleanup();

  const packageJson = JSON.parse(
    await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"),
  );
  assert.deepEqual(packageJson.dependencies, {
    "@jinn-network/evidence-discovery": "0.1.0",
    "@jinn-network/evidence-protocol": "0.1.0",
    "@jinn-network/evidence-repository": "0.1.0",
  });
  assert.deepEqual(packageJson.peerDependencies, { vitest: "^4.1.8" });
  assert.deepEqual(packageJson.peerDependenciesMeta, {
    vitest: { optional: true },
  });
  await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
  await readFile(${JSON.stringify(join(installedRoot, "specification.md"))});
});
`,
  );
  const vitest = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "vitest.cmd" : "vitest",
  );
  await run(vitest, ["run", "packed-imports.test.mjs"], { cwd: consumer });

  console.log(
    "Packed root/testing imports, archive shape, and dependency boundary verified.",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
