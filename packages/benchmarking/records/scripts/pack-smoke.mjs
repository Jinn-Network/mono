import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Cross-tree portal dependency (§7.8): task-execution-protocol resolves through a portal at
// development time; pack it locally too so the consumer graph resolves end-to-end without
// reaching the npm registry (benchmarking-records is not published there, and even if it were,
// its cross-tree dependency requires that package's own from-source build, not a registry
// fetch) -- record-discovery-protocol's pack-smoke.mjs precedent.
const taskExecutionProtocolRoot = join(packageRoot, "..", "..", "task-execution", "protocol");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-benchmarking-records-"));
const archive = join(temporaryRoot, "benchmarking-records.tgz");
const taskExecutionProtocolArchive = join(temporaryRoot, "task-execution-protocol.tgz");
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

try {
  await run("yarn", ["pack", "--out", taskExecutionProtocolArchive], { cwd: taskExecutionProtocolRoot });
  await run("yarn", ["pack", "--out", archive], { cwd: packageRoot });

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/task-execution-protocol": `file:${taskExecutionProtocolArchive}`,
        "@jinn-network/benchmarking-records": `file:${archive}`,
      },
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer },
  );

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "benchmarking-records");
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
import { BENCHMARKING_PROTOCOL, parseBenchmark } from "@jinn-network/benchmarking-records";

if (BENCHMARKING_PROTOCOL !== "https://spec.jinn.network/protocols/benchmarking/v1") {
  throw new Error("root import failed");
}
await readFile(new URL(import.meta.resolve("@jinn-network/benchmarking-records/schemas/benchmark.schema.json")));
const golden = await readFile(new URL(import.meta.resolve("@jinn-network/benchmarking-records/fixtures/benchmark/valid.json")));
parseBenchmark(new Uint8Array(golden.buffer, golden.byteOffset, golden.byteLength));
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/"));
const expectedJinnDependencies = ["@jinn-network/task-execution-protocol"];
if (jinnDependencies.length !== expectedJinnDependencies.length
    || jinnDependencies.some((name) => !expectedJinnDependencies.includes(name))) {
  throw new Error("unexpected Jinn coupling: " + jinnDependencies.join(", "));
}
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))});
if (distFiles.some((name) => name.includes(".test."))) throw new Error("test output leaked into dist");
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed package imports, assets, fixtures, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: temporaryRoot });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
