import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Cross-tree portal dependencies (§7.8): pack every dependency this package resolves via a
// portal locally too, so the consumer graph resolves end-to-end without reaching the npm
// registry (benchmarking-records/pack-smoke.mjs precedent).
const benchmarkingRecordsRoot = join(packageRoot, "..", "records");
const taskExecutionProtocolRoot = join(packageRoot, "..", "..", "task-execution", "protocol");
const taskExecutionProfilesRoot = join(packageRoot, "..", "..", "task-execution", "profiles");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-benchmarking-testing-"));
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

async function packOne(directory, outName) {
  const archive = join(temporaryRoot, outName);
  await run("yarn", ["pack", "--out", archive], { cwd: directory });
  return archive;
}

try {
  // Sequential, not Promise.all: each `yarn pack` runs that package's `prepack` (a `dist` wipe +
  // rebuild); packing cross-tree dependencies concurrently races their `dist` directories against
  // each other's type-resolution reads (observed: records' build transiently failing to resolve
  // task-execution-protocol's types while protocol's own prepack was mid-rebuild).
  const protocolArchive = await packOne(taskExecutionProtocolRoot, "task-execution-protocol.tgz");
  const profilesArchive = await packOne(taskExecutionProfilesRoot, "task-execution-profiles.tgz");
  const recordsArchive = await packOne(benchmarkingRecordsRoot, "benchmarking-records.tgz");
  const testingArchive = await packOne(packageRoot, "benchmarking-testing.tgz");

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/task-execution-protocol": `file:${protocolArchive}`,
        "@jinn-network/task-execution-profiles": `file:${profilesArchive}`,
        "@jinn-network/benchmarking-records": `file:${recordsArchive}`,
        "@jinn-network/benchmarking-testing": `file:${testingArchive}`,
        // The kit's `describe...Conformance()` drivers import vitest at module load (evidence
        // `repository/testing` precedent, task-execution-testing/scripts/pack-smoke.mjs
        // precedent) -- an optional peer, but a real runtime import once any driver is loaded.
        vitest: "4.1.8",
      },
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer },
  );

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "benchmarking-testing");
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { describeRecordConformance } from "@jinn-network/benchmarking-testing";
if (typeof describeRecordConformance !== "function") {
  throw new Error("root import failed");
}
const packageJson = JSON.parse(
  await (await import("node:fs/promises")).readFile(
    ${JSON.stringify(join(installedRoot, "package.json"))},
    "utf8",
  ),
);
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/"));
const expectedJinnDependencies = ["@jinn-network/benchmarking-records", "@jinn-network/task-execution-profiles", "@jinn-network/task-execution-protocol"];
if (jinnDependencies.length !== expectedJinnDependencies.length
    || jinnDependencies.some((name) => !expectedJinnDependencies.includes(name))) {
  throw new Error("unexpected Jinn coupling: " + jinnDependencies.join(", "));
}
console.log("Installed package imports and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: temporaryRoot });

  const distFiles = await readdir(join(installedRoot, "dist"));
  if (distFiles.some((name) => name.includes(".test."))) {
    throw new Error("test output leaked into dist");
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
