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
const trustCoreRoot = join(packageRoot, "..", "..", "trust", "core");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-benchmarking-aggregate-"));
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
  // Sequential, not Promise.all (benchmarking-testing/scripts/pack-smoke.mjs precedent): a
  // concurrent `yarn pack` on cross-tree dependencies races their `dist` wipe-and-rebuild
  // prepack steps against each other's type-resolution reads.
  const protocolArchive = await packOne(taskExecutionProtocolRoot, "task-execution-protocol.tgz");
  const trustCoreArchive = await packOne(trustCoreRoot, "trust-core.tgz");
  const recordsArchive = await packOne(benchmarkingRecordsRoot, "benchmarking-records.tgz");
  const aggregateArchive = await packOne(packageRoot, "benchmarking-aggregate.tgz");

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/task-execution-protocol": `file:${protocolArchive}`,
        "@jinn-network/trust-core": `file:${trustCoreArchive}`,
        "@jinn-network/benchmarking-records": `file:${recordsArchive}`,
        "@jinn-network/benchmarking-aggregate": `file:${aggregateArchive}`,
      },
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer },
  );

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "benchmarking-aggregate");
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile } from "node:fs/promises";
import { BENCHMARKING_METHOD_REGISTRY } from "@jinn-network/benchmarking-aggregate";
if (BENCHMARKING_METHOD_REGISTRY.get("jinn.benchmarking.method/wilson", "1") === undefined) {
  throw new Error("root import failed: wilson@1 not registered");
}
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/")).sort();
const expectedJinnDependencies = ["@jinn-network/benchmarking-records", "@jinn-network/trust-core"];
if (jinnDependencies.join(",") !== expectedJinnDependencies.join(",")) {
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
