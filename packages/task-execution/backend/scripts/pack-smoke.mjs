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
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-task-execution-backend-"));
const archivesRoot = join(temporaryRoot, "archives");
const protocolArchive = join(archivesRoot, "task-execution-protocol.tgz");
const backendArchive = join(archivesRoot, "task-execution-backend.tgz");
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
      throw new Error(`backend archive is missing ${required}`);
    }
  }
  const leakedTests = entries.filter(
    (entry) => entry.startsWith("package/dist/") && /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry),
  );
  if (leakedTests.length > 0) {
    throw new Error(`backend archive contains tests: ${leakedTests.join(", ")}`);
  }
}

try {
  await mkdir(archivesRoot, { recursive: true });
  await run("yarn", ["pack", "--out", protocolArchive], { cwd: protocolRoot });
  await run("yarn", ["pack", "--out", backendArchive], { cwd: packageRoot });
  assertArchiveShape(
    (await output("tar", ["-tzf", backendArchive])).split(/\r?\n/u).filter(Boolean),
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
        "@types/node": "^22.0.0",
        typescript: "5.9.3",
        vitest: "4.1.8",
      },
    }),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "task-execution-backend");

  // Compile-time check: the packed public surface resolves for a NodeNext-strict consumer.
  await writeFile(
    join(consumer, "packed-types.ts"),
    `
import type {
  BackendCapabilities,
  CancelAck,
  DeliveryRef,
  ObservationCursor,
  ObservationSnapshot,
  PreflightReport,
  PreflightRequest,
  ReconciliationReport,
  SubmissionAck,
  TaskExecutionBackend,
} from "@jinn-network/task-execution-backend";
import { TaskExecutionError } from "@jinn-network/task-execution-backend";

declare const backend: TaskExecutionBackend;
declare const capabilities: BackendCapabilities;
declare const ack: SubmissionAck;
declare const snapshot: ObservationSnapshot;
declare const cursor: ObservationCursor;
declare const report: ReconciliationReport;
declare const cancelAck: CancelAck;
declare const ref: DeliveryRef;
declare const preflightRequest: PreflightRequest;
declare const preflightReport: PreflightReport;
const error: TaskExecutionError = new TaskExecutionError("backend-unavailable");
void backend;
void capabilities;
void ack;
void snapshot;
void cursor;
void report;
void cancelAck;
void ref;
void preflightRequest;
void preflightReport;
void error;
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

  // Runtime check: the packed root import works, and the dependency boundary is exactly protocol.
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
import { TaskExecutionError } from "@jinn-network/task-execution-backend";

const unavailable = new TaskExecutionError("backend-unavailable");
if (unavailable.retryable !== true) throw new Error("backend-unavailable must default retryable=true");
const invalid = new TaskExecutionError("invalid-document");
if (invalid.retryable !== false) throw new Error("invalid-document must default retryable=false");

const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/"));
if (jinnDependencies.join(",") !== "@jinn-network/task-execution-protocol") {
  throw new Error("unexpected Jinn dependency boundary: " + jinnDependencies.join(", "));
}
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))});
if (distFiles.some((name) => name.includes(".test."))) throw new Error("test output leaked into dist");
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed backend root import, error defaults, assets, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
