import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const backendLocalRoot = join(packageRoot, "..");
const taskExecutionRoot = join(backendLocalRoot, "..");
const packagesRoot = join(taskExecutionRoot, "..");
const protocolRoot = join(taskExecutionRoot, "protocol");
const backendRoot = join(taskExecutionRoot, "backend");
const profilesRoot = join(taskExecutionRoot, "profiles");
const supervisorRoot = join(backendLocalRoot, "supervisor");
const workspaceRoot = join(backendLocalRoot, "workspace");
const launchersRoot = join(backendLocalRoot, "launchers");
const evidenceProtocolRoot = join(packagesRoot, "evidence", "protocol");
const evidenceRepositoryRoot = join(packagesRoot, "evidence", "repository");
const evidenceDiscoveryRoot = join(packagesRoot, "evidence", "discovery");
const executionRecorderRoot = join(packagesRoot, "evidence", "execution-recorder");

const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-task-execution-backend-local-"));
const archivesRoot = join(temporaryRoot, "archives");
const consumer = join(temporaryRoot, "consumer");

// [directory, archive filename] for every package the assembly's dependency graph reaches
// transitively — npm's flat resolution needs each one packed as a `file:` tarball so the
// synthetic consumer never reaches for the registry, which does not (yet) carry an unpublished
// @jinn-network package.
const packRoots = [
  [protocolRoot, "task-execution-protocol.tgz"],
  [backendRoot, "task-execution-backend.tgz"],
  [profilesRoot, "task-execution-profiles.tgz"],
  [supervisorRoot, "task-execution-supervisor.tgz"],
  [workspaceRoot, "task-execution-workspace.tgz"],
  [launchersRoot, "task-execution-launchers.tgz"],
  [evidenceProtocolRoot, "evidence-protocol.tgz"],
  [evidenceRepositoryRoot, "evidence-repository.tgz"],
  [evidenceDiscoveryRoot, "evidence-discovery.tgz"],
  [executionRecorderRoot, "execution-recorder.tgz"],
  [packageRoot, "task-execution-backend-local.tgz"],
];

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
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

function assertArchiveShape(entries) {
  for (const required of ["package/README.md", "package/dist/index.d.ts", "package/dist/index.js"]) {
    if (!entries.includes(required)) throw new Error(`assembly archive is missing ${required}`);
  }
  const leaked = entries.filter(
    (entry) => entry.startsWith("package/dist/") && /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry),
  );
  if (leaked.length > 0) throw new Error(`assembly archive contains tests: ${leaked.join(", ")}`);
}

try {
  await mkdir(archivesRoot, { recursive: true });
  const archives = new Map();
  for (const [root, filename] of packRoots) {
    const archive = join(archivesRoot, filename);
    await run("yarn", ["pack", "--out", archive], { cwd: root });
    archives.set(filename, archive);
  }
  const assemblyArchive = archives.get("task-execution-backend-local.tgz");
  assertArchiveShape((await output("tar", ["-tzf", assemblyArchive])).split(/\r?\n/u).filter(Boolean));

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/evidence-protocol": `file:${archives.get("evidence-protocol.tgz")}`,
        "@jinn-network/evidence-repository": `file:${archives.get("evidence-repository.tgz")}`,
        "@jinn-network/evidence-discovery": `file:${archives.get("evidence-discovery.tgz")}`,
        "@jinn-network/execution-recorder": `file:${archives.get("execution-recorder.tgz")}`,
        "@jinn-network/task-execution-protocol": `file:${archives.get("task-execution-protocol.tgz")}`,
        "@jinn-network/task-execution-backend": `file:${archives.get("task-execution-backend.tgz")}`,
        "@jinn-network/task-execution-profiles": `file:${archives.get("task-execution-profiles.tgz")}`,
        "@jinn-network/task-execution-supervisor": `file:${archives.get("task-execution-supervisor.tgz")}`,
        "@jinn-network/task-execution-workspace": `file:${archives.get("task-execution-workspace.tgz")}`,
        "@jinn-network/task-execution-launchers": `file:${archives.get("task-execution-launchers.tgz")}`,
        "@jinn-network/task-execution-backend-local": `file:${assemblyArchive}`,
        "@types/node": "^22.0.0",
        typescript: "5.9.3",
      },
    }),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "task-execution-backend-local");

  // Compile-time check: the assembly's `src/` is a Milestone-C stub through Milestone A (this
  // package's dependency edges + CI job register now per plan Task A1; `makeLocalTaskExecutionBackend`
  // lands in C1) — a namespace import is the honest check available at this stage.
  await writeFile(
    join(consumer, "packed-types.ts"),
    `
import type * as BackendLocal from "@jinn-network/task-execution-backend-local";

type _AssertModuleResolves = typeof BackendLocal;
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

  // Runtime check: the packed root import resolves, and the dependency boundary matches the
  // approved graph exactly (never evidence-local-runtime, never record-discovery-*, never an
  // application tree — program §7.18/plan A2 Step 4).
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
await import("@jinn-network/task-execution-backend-local");

const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/")).sort();
const expected = [
  "@jinn-network/evidence-discovery",
  "@jinn-network/evidence-repository",
  "@jinn-network/execution-recorder",
  "@jinn-network/task-execution-backend",
  "@jinn-network/task-execution-launchers",
  "@jinn-network/task-execution-profiles",
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
console.log("Installed assembly root import, assets, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
