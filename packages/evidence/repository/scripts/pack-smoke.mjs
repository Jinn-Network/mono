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
const protocolRoot = join(packageRoot, "..", "protocol");
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "jinn-evidence-repository-"),
);
const repositoryArchive = join(temporaryRoot, "evidence-repository.tgz");
const protocolArchive = join(temporaryRoot, "evidence-protocol.tgz");
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
      reject(new Error(
        `${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`,
      ));
    });
  });
}

function assertArchiveShape(entries) {
  for (const required of [
    "package/README.md",
    "package/specification.md",
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/dist/testing.d.ts",
    "package/dist/testing.js",
    "package/dist/fs/index.d.ts",
    "package/dist/fs/index.js",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`repository archive is missing ${required}`);
    }
  }
  const leakedTests = entries.filter((entry) =>
    entry.startsWith("package/dist/") &&
    /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry)
  );
  if (leakedTests.length > 0) {
    throw new Error(`repository archive contains tests: ${leakedTests.join(", ")}`);
  }
}

try {
  await run("yarn", ["pack", "--out", protocolArchive], {
    cwd: protocolRoot,
  });
  await run("yarn", ["pack", "--out", repositoryArchive], {
    cwd: packageRoot,
  });
  assertArchiveShape(
    (await output("tar", ["-tzf", repositoryArchive]))
      .split(/\r?\n/u)
      .filter(Boolean),
  );

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/evidence-protocol": `file:${protocolArchive}`,
        "@jinn-network/evidence-repository": `file:${repositoryArchive}`,
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
    "evidence-repository",
  );
  const typeConsumer = join(consumer, "packed-types.ts");
  const typeConfig = join(consumer, "tsconfig.json");
  await writeFile(
    typeConsumer,
    `
import {
  type EvidenceRepository,
  type EvidenceRepositoryErrorCode,
} from "@jinn-network/evidence-repository";
import {
  createFilesystemEvidenceRepository,
} from "@jinn-network/evidence-repository/fs";

declare const repository: EvidenceRepository;
const limit: number | undefined = repository.capabilities.maxObjectBytes;
const code: EvidenceRepositoryErrorCode = "CONTENT_TOO_LARGE";
const filesystemRepository: EvidenceRepository =
  await createFilesystemEvidenceRepository({ rootDir: "/tmp/type-only" });
void limit;
void code;
void filesystemRepository;
`,
  );
  await writeFile(
    typeConfig,
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
    [join(consumer, "node_modules", "typescript", "bin", "tsc"), "-p", typeConfig],
    { cwd: consumer },
  );
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVIDENCE_RECORD_FAMILIES,
  EVIDENCE_REPOSITORY_ERROR_CODES,
  NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES,
  createArtifactReference,
  createRecordReference,
} from "@jinn-network/evidence-repository";
import { createFilesystemEvidenceRepository } from "@jinn-network/evidence-repository/fs";
import { describeEvidenceRepositoryContract } from "@jinn-network/evidence-repository/testing";

const bytes = new TextEncoder().encode("packed repository");
const record = createRecordReference("execution-evidence", bytes);
const artifact = createArtifactReference(bytes);
if (record.digest !== artifact.digest) throw new Error("root import failed");
if (EVIDENCE_RECORD_FAMILIES.length !== 3) throw new Error("families missing");
if (typeof describeEvidenceRepositoryContract !== "function") {
  throw new Error("testing subpath import failed");
}

const rootDir = await mkdtemp(join(tmpdir(), "jinn-packed-repository-fs-"));
try {
  const repository = await createFilesystemEvidenceRepository({ rootDir });
  if (repository.capabilities !== NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES) {
    throw new Error("filesystem capability object is not the shared no-limit object");
  }
  if (!EVIDENCE_REPOSITORY_ERROR_CODES.includes("CONTENT_TOO_LARGE")) {
    throw new Error("CONTENT_TOO_LARGE error code missing");
  }
  const receipt = await repository.putRecord("execution-evidence", bytes);
  const retrieved = await repository.getRecord(receipt.reference);
  if (!retrieved || !Buffer.from(retrieved).equals(Buffer.from(bytes))) {
    throw new Error("filesystem subpath exact-byte round trip failed");
  }
} finally {
  await rm(rootDir, { recursive: true, force: true });
}

const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/"));
if (jinnDependencies.join(",") !== "@jinn-network/evidence-protocol") {
  throw new Error("unexpected Jinn dependency boundary: " + jinnDependencies.join(", "));
}
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
await readFile(${JSON.stringify(join(installedRoot, "specification.md"))});
console.log("Installed repository root, testing, and filesystem subpaths, archive, exact-byte round trip, assets, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
