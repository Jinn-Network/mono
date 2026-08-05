import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Cross-tree portal dependencies (§7.8): task-execution-protocol and benchmarking-records
// resolve through portals at development time; pack them locally too so the consumer graph
// resolves end-to-end without reaching the npm registry -- benchmarking-records/scripts/pack-smoke.mjs
// precedent. This package is `"private": true` (never published, per the platform manifest), and
// Yarn refuses to `yarn pack` a private package, so the product itself is packed with
// `npm pack --ignore-scripts` after an explicit build instead.
const taskExecutionProtocolRoot = join(packageRoot, "..", "..", "task-execution", "protocol");
const benchmarkingRecordsRoot = join(packageRoot, "..", "..", "benchmarking", "records");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-benchmark-product-core-"));
const taskExecutionProtocolArchive = join(temporaryRoot, "task-execution-protocol.tgz");
const benchmarkingRecordsArchive = join(temporaryRoot, "benchmarking-records.tgz");
const consumer = join(temporaryRoot, "consumer");

/** Resolves with the child's stdout when `stdio: "pipe"` is requested, and with `""` otherwise. */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    const chunks = [];
    child.stdout?.on("data", (chunk) => chunks.push(chunk));
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

try {
  // Sequential, not Promise.all: a concurrent `yarn pack` on cross-tree dependencies races their
  // `dist` wipe-and-rebuild prepack steps against each other's type-resolution reads.
  await run("yarn", ["pack", "--out", taskExecutionProtocolArchive], { cwd: taskExecutionProtocolRoot });
  await run("yarn", ["pack", "--out", benchmarkingRecordsArchive], { cwd: benchmarkingRecordsRoot });

  await run("yarn", ["build"], { cwd: packageRoot });
  const packJson = await run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot],
    { cwd: packageRoot, stdio: "pipe" },
  );
  const [packResult] = JSON.parse(packJson);
  const productArchive = join(temporaryRoot, packResult.filename);

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/task-execution-protocol": `file:${taskExecutionProtocolArchive}`,
        "@jinn-network/benchmarking-records": `file:${benchmarkingRecordsArchive}`,
        "@jinn-network/benchmark-product-core": `file:${productArchive}`,
      },
    }),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "benchmark-product-core");
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
import { BENCHMARKING_PROTOCOL, PRODUCT_BRANDING, PRODUCT_VERSION } from "@jinn-network/benchmark-product-core";

if (PRODUCT_VERSION !== "0.1.0") throw new Error("product version drifted");
if (BENCHMARKING_PROTOCOL !== "https://spec.jinn.network/protocols/benchmarking/v1") {
  throw new Error("platform seam import failed");
}
if (!PRODUCT_BRANDING.attribution.includes("independently verifiable")) {
  throw new Error("attribution copy drifted");
}
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/"));
const expectedJinnDependencies = ["@jinn-network/benchmarking-records"];
if (jinnDependencies.length !== expectedJinnDependencies.length
    || jinnDependencies.some((name) => !expectedJinnDependencies.includes(name))) {
  throw new Error("unexpected Jinn coupling: " + jinnDependencies.join(", "));
}
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))});
if (distFiles.some((name) => name.includes(".test."))) throw new Error("test output leaked into dist");
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed package imports, platform seam, branding, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: temporaryRoot });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
