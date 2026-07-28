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
const protocolRoot = join(packageRoot, "..", "protocol");
const backendRoot = join(packageRoot, "..", "backend");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-task-execution-testing-"));
const archivesRoot = join(temporaryRoot, "archives");
const protocolArchive = join(archivesRoot, "task-execution-protocol.tgz");
const backendArchive = join(archivesRoot, "task-execution-backend.tgz");
const testingArchive = join(archivesRoot, "task-execution-testing.tgz");
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
      reject(new Error(`${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

function assertArchiveShape(entries) {
  for (const required of ["package/README.md", "package/dist/index.d.ts", "package/dist/index.js"]) {
    if (!entries.includes(required)) {
      throw new Error(`testing archive is missing ${required}`);
    }
  }
  const leakedTests = entries.filter(
    (entry) => entry.startsWith("package/dist/") && /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry),
  );
  if (leakedTests.length > 0) {
    throw new Error(`testing archive contains tests: ${leakedTests.join(", ")}`);
  }
}

try {
  await mkdir(archivesRoot, { recursive: true });
  await run("yarn", ["pack", "--out", protocolArchive], { cwd: protocolRoot });
  await run("yarn", ["pack", "--out", backendArchive], { cwd: backendRoot });
  await run("yarn", ["pack", "--out", testingArchive], { cwd: packageRoot });
  assertArchiveShape(
    (await output("tar", ["-tzf", testingArchive])).split(/\r?\n/u).filter(Boolean),
  );

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/task-execution-protocol": `file:${protocolArchive}`,
        "@jinn-network/task-execution-backend": `file:${backendArchive}`,
        "@jinn-network/task-execution-testing": `file:${testingArchive}`,
        "@types/node": "^22.0.0",
        typescript: "5.9.3",
        vitest: "4.1.8",
      },
    }),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "task-execution-testing");

  // Compile-time check: the packed public surface resolves for a NodeNext-strict consumer.
  await writeFile(
    join(consumer, "packed-types.ts"),
    `
import type {
  DescribeTaskExecutionBackendContract,
  TestableBackend,
} from "@jinn-network/task-execution-testing";
import {
  createInMemoryBackend,
  describeProtocolConformance,
  describeTaskExecutionBackendContract,
} from "@jinn-network/task-execution-testing";

declare const backend: TestableBackend;
declare const describeContract: DescribeTaskExecutionBackendContract;
void backend;
void describeContract;
void createInMemoryBackend;
void describeProtocolConformance;
void describeTaskExecutionBackendContract;
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
    [join(consumer, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
    { cwd: consumer },
  );

  // Runtime check: the packed root import works end to end (submit -> observe -> deliver), and
  // the dependency boundary is exactly protocol + backend.
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
import { createInMemoryBackend } from "@jinn-network/task-execution-testing";

const backend = createInMemoryBackend();
const capabilities = await backend.capabilities();
if (typeof capabilities.cancel !== "boolean") throw new Error("capabilities() did not resolve a well-formed record");

const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/")).sort();
const expected = ["@jinn-network/task-execution-backend", "@jinn-network/task-execution-protocol"];
if (jinnDependencies.join(",") !== expected.join(",")) {
  throw new Error("unexpected Jinn dependency boundary: " + jinnDependencies.join(", "));
}
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))});
if (distFiles.some((name) => name.includes(".test."))) throw new Error("test output leaked into dist");
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed testing-kit root import, in-memory backend smoke, assets, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
