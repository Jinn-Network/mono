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
const taskExecutionRoot = join(packageRoot, "..");
const packagesRoot = join(taskExecutionRoot, "..");
const backendLocalRoot = join(taskExecutionRoot, "backend-local");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-task-execution-testing-"));
const archivesRoot = join(temporaryRoot, "archives");
const consumer = join(temporaryRoot, "consumer");

// [directory, archive filename] for every package the testing kit's `./backend-local` slice
// reaches transitively (program §7.5/Finding (a); the assembly's own evidence-contract edges,
// program §7.7) — npm's flat resolution needs each one packed as a `file:` tarball so the
// synthetic consumer never reaches for the (unpublished) registry.
const packRoots = [
  [join(taskExecutionRoot, "protocol"), "task-execution-protocol.tgz"],
  [join(taskExecutionRoot, "backend"), "task-execution-backend.tgz"],
  [join(taskExecutionRoot, "profiles"), "task-execution-profiles.tgz"],
  [join(backendLocalRoot, "supervisor"), "task-execution-supervisor.tgz"],
  [join(backendLocalRoot, "workspace"), "task-execution-workspace.tgz"],
  [join(backendLocalRoot, "launchers"), "task-execution-launchers.tgz"],
  [join(backendLocalRoot, "assembly"), "task-execution-backend-local.tgz"],
  [join(packagesRoot, "evidence", "protocol"), "evidence-protocol.tgz"],
  [join(packagesRoot, "evidence", "repository"), "evidence-repository.tgz"],
  [join(packagesRoot, "evidence", "discovery"), "evidence-discovery.tgz"],
  [join(packagesRoot, "evidence", "execution-recorder"), "execution-recorder.tgz"],
  [packageRoot, "task-execution-testing.tgz"],
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
      reject(new Error(`${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

function assertArchiveShape(entries) {
  for (const required of [
    "package/README.md",
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/dist/backend-local/index.d.ts",
    "package/dist/backend-local/index.js",
    "package/fixtures/backend-local/reconciliation-table.json",
    "package/fixtures/backend-local/expected-digests.json",
  ]) {
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
  const archives = new Map();
  for (const [directory, filename] of packRoots) {
    const archive = join(archivesRoot, filename);
    await run("yarn", ["pack", "--out", archive], { cwd: directory });
    archives.set(filename, archive);
  }
  const testingArchive = archives.get("task-execution-testing.tgz");
  assertArchiveShape((await output("tar", ["-tzf", testingArchive])).split(/\r?\n/u).filter(Boolean));

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/task-execution-protocol": `file:${archives.get("task-execution-protocol.tgz")}`,
        "@jinn-network/task-execution-backend": `file:${archives.get("task-execution-backend.tgz")}`,
        "@jinn-network/task-execution-profiles": `file:${archives.get("task-execution-profiles.tgz")}`,
        "@jinn-network/task-execution-supervisor": `file:${archives.get("task-execution-supervisor.tgz")}`,
        "@jinn-network/task-execution-workspace": `file:${archives.get("task-execution-workspace.tgz")}`,
        "@jinn-network/task-execution-launchers": `file:${archives.get("task-execution-launchers.tgz")}`,
        "@jinn-network/task-execution-backend-local": `file:${archives.get("task-execution-backend-local.tgz")}`,
        "@jinn-network/evidence-protocol": `file:${archives.get("evidence-protocol.tgz")}`,
        "@jinn-network/evidence-repository": `file:${archives.get("evidence-repository.tgz")}`,
        "@jinn-network/evidence-discovery": `file:${archives.get("evidence-discovery.tgz")}`,
        "@jinn-network/execution-recorder": `file:${archives.get("execution-recorder.tgz")}`,
        "@jinn-network/task-execution-testing": `file:${testingArchive}`,
        "@types/node": "^22.0.0",
        typescript: "5.9.3",
        vitest: "4.1.8",
      },
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps"],
    { cwd: consumer },
  );

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "task-execution-testing");

  // Compile-time check: the packed public surface — root AND the ./backend-local subpath —
  // resolves for a NodeNext-strict consumer.
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
import type {
  AttemptSupervisorUnderTest,
  FakeLaunchOutcome,
  FakeLaunchScript,
  LocalBackendConformanceSubject,
  LocalBackendContractFactory,
} from "@jinn-network/task-execution-testing/backend-local";
import {
  describeAttemptSupervisorContract,
  describeLauncherContract,
  describeLocalBackendContract,
  describeWorkspaceContract,
  makeFakeLauncher,
} from "@jinn-network/task-execution-testing/backend-local";

declare const backend: TestableBackend;
declare const describeContract: DescribeTaskExecutionBackendContract;
declare const script: FakeLaunchScript;
declare const outcome: FakeLaunchOutcome;
declare const supervisorUnderTest: AttemptSupervisorUnderTest;
declare const localSubject: LocalBackendConformanceSubject;
declare const localFactory: LocalBackendContractFactory;
void backend;
void describeContract;
void createInMemoryBackend;
void describeProtocolConformance;
void describeTaskExecutionBackendContract;
void script;
void outcome;
void supervisorUnderTest;
void localSubject;
void localFactory;
void makeFakeLauncher;
void describeAttemptSupervisorContract;
void describeLauncherContract;
void describeWorkspaceContract;
void describeLocalBackendContract;
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

  // Runtime check: the packed root AND ./backend-local imports work, a fake launcher built from
  // the packed subpath conforms, fixture assets are present, and the dependency boundary is
  // exactly the approved graph (program §7.5/§7.7).
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
import { createInMemoryBackend } from "@jinn-network/task-execution-testing";
import { loadReconciliationTable, makeFakeLauncher } from "@jinn-network/task-execution-testing/backend-local";

const backend = createInMemoryBackend();
const capabilities = await backend.capabilities();
if (typeof capabilities.cancel !== "boolean") throw new Error("capabilities() did not resolve a well-formed record");

const table = await loadReconciliationTable();
if (table.rows.length !== 11) throw new Error("expected all 11 §6.4 reconciliation rows, got " + table.rows.length);

const fakeLauncher = makeFakeLauncher({
  plan: { validExitCodes: [0], resultContract: { envelopeFormat: "smoke" }, interruptionBehavior: "repeatable" },
  capabilities: {
    taskProfiles: [], inputMediaTypes: [], outputMediaTypes: [], structuredOutput: false, resume: false,
    interruptionBehaviorDefault: "repeatable", runPinning: { keys: [] },
  },
  onRun: () => ({ exitCode: 0 }),
});
if (typeof fakeLauncher.plan !== "function") throw new Error("packed fake launcher missing plan()");

const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
if (packageJson.peerDependencies?.vitest !== "^4.1.8"
    || packageJson.peerDependenciesMeta?.vitest?.optional !== true) {
  throw new Error("packed optional Vitest peer contract changed");
}
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/")).sort();
const expected = [
  "@jinn-network/task-execution-backend",
  "@jinn-network/task-execution-backend-local",
  "@jinn-network/task-execution-launchers",
  "@jinn-network/task-execution-protocol",
  "@jinn-network/task-execution-supervisor",
  "@jinn-network/task-execution-workspace",
].sort();
if (jinnDependencies.join(",") !== expected.join(",")) {
  throw new Error("unexpected Jinn dependency boundary: " + jinnDependencies.join(", "));
}
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))});
if (distFiles.some((name) => name.includes(".test."))) throw new Error("test output leaked into dist");
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed testing-kit root + ./backend-local imports, fixture assets, fake launcher, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
