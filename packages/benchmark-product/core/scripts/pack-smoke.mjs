import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Cross-tree portal dependencies (§7.8): the product's full RUNTIME @jinn-network closure resolves
// through portals at development time; pack each one locally too so the consumer graph resolves
// end-to-end without reaching the npm registry -- benchmarking-records/scripts/pack-smoke.mjs
// precedent. Listed in dependency order (dependencies before dependents) because `yarn pack`
// triggers each package's prepack build, whose type resolution reads the ones before it. The
// `task-execution-launchers` devDependency is deliberately absent: a packed consumer installs
// runtime dependencies only. This package is `"private": true` (never published, per the platform
// manifest), and Yarn refuses to `yarn pack` a private package, so the product itself is packed
// with `npm pack --ignore-scripts` after an explicit build instead.
const CROSS_TREE_DEPENDENCIES = [
  ["@jinn-network/task-execution-protocol", ["task-execution", "protocol"]],
  ["@jinn-network/trust-core", ["trust", "core"]],
  ["@jinn-network/environment-record", ["environments", "record"]],
  ["@jinn-network/task-execution-profiles", ["task-execution", "profiles"]],
  ["@jinn-network/benchmarking-records", ["benchmarking", "records"]],
  ["@jinn-network/record-discovery-protocol", ["discovery", "protocol"]],
  ["@jinn-network/record-discovery-serve", ["discovery", "serve"]],
  ["@jinn-network/record-publication", ["discovery", "publication"]],
  ["@jinn-network/benchmarking-publication", ["benchmarking", "publication"]],
  ["@jinn-network/benchmarking-aggregate", ["benchmarking", "aggregate"]],
  ["@jinn-network/task-admission", ["task-supply", "admission"]],
  ["@jinn-network/benchmarking-interop", ["benchmarking", "interop"]],
  ["@jinn-network/task-execution-backend", ["task-execution", "backend"]],
  ["@jinn-network/task-execution-supervisor", ["task-execution", "backend-local", "supervisor"]],
  ["@jinn-network/task-execution-workspace", ["task-execution", "backend-local", "workspace"]],
  ["@jinn-network/task-execution-launchers", ["task-execution", "backend-local", "launchers"]],
  ["@jinn-network/evidence-protocol", ["evidence", "protocol"]],
  ["@jinn-network/evidence-repository", ["evidence", "repository"]],
  ["@jinn-network/evidence-discovery", ["evidence", "discovery"]],
  ["@jinn-network/execution-recorder", ["evidence", "execution-recorder"]],
  ["@jinn-network/attestation-issuer", ["evidence", "attestation-issuer"]],
  ["@jinn-network/task-execution-evaluation-harness", ["task-execution", "evaluation-harness"]],
  ["@jinn-network/task-execution-evaluator-adapters", ["task-execution", "evaluator-adapters"]],
  ["@jinn-network/task-execution-oci-grader", ["task-execution", "oci-grader"]],
  ["@jinn-network/task-execution-backend-local", ["task-execution", "backend-local", "assembly"]],
  ["@jinn-network/benchmarking-run", ["benchmarking", "run"]],
  ["@jinn-network/benchmarking-local", ["benchmarking", "local"]],
];
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-benchmark-product-core-"));
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
  const productManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const localArchiveNames = new Set(CROSS_TREE_DEPENDENCIES.map(([name]) => name));
  const unpackedJinnDependencies = Object.keys(productManifest.dependencies ?? {})
    .filter((name) => name.startsWith("@jinn-network/") && !localArchiveNames.has(name));
  if (unpackedJinnDependencies.length > 0) {
    throw new Error(
      `pack smoke must install every Jinn runtime dependency from a local tarball: ${unpackedJinnDependencies.join(", ")}`,
    );
  }

  // Sequential, not Promise.all: a concurrent `yarn pack` on cross-tree dependencies races their
  // `dist` wipe-and-rebuild prepack steps against each other's type-resolution reads.
  const archives = new Map();
  for (const [name, segments] of CROSS_TREE_DEPENDENCIES) {
    const archive = join(temporaryRoot, `${segments.join("-")}.tgz`);
    await run("yarn", ["pack", "--out", archive], { cwd: join(packageRoot, "..", "..", ...segments) });
    archives.set(name, archive);
  }

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
        ...Object.fromEntries([...archives].map(([name, archive]) => [name, `file:${archive}`])),
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
import { createRequire } from "node:module";
import { BENCHMARKING_PROTOCOL, PRODUCT_BRANDING, PRODUCT_VERSION, buildSampleBenchmark, runCancel } from "@jinn-network/benchmark-product-core";

const require = createRequire(import.meta.url);
const requiredEntry = require("@jinn-network/benchmark-product-core");
if (typeof requiredEntry.runPreview !== "function") throw new Error("packed require entry lacks runPreview");
for (const name of ["runResults", "runReport", "runVerify"]) {
  if (typeof requiredEntry[name] !== "function") throw new Error("packed require entry lacks " + name);
}
if (requiredEntry.PRODUCT_BRANDING.displayName !== PRODUCT_BRANDING.displayName) {
  throw new Error("packed require/import branding entries diverged");
}

if (PRODUCT_VERSION !== "0.1.0") throw new Error("product version drifted");
if (typeof runCancel !== "function") throw new Error("runCancel missing from packed public entrypoint");
// The bundled sample must build from the PACKED graph: this proves the admission package ships
// its golden fixture in the tarball and the whole intake path works for an external consumer.
const sample = await buildSampleBenchmark();
if (sample.tasks.length < 2) throw new Error("sample benchmark must bundle at least two tasks");
if (!/^[a-f0-9]{64}$/.test(sample.benchmark.sha256)) throw new Error("sample benchmark digest malformed");
if (BENCHMARKING_PROTOCOL !== "https://spec.jinn.network/protocols/benchmarking/v1") {
  throw new Error("platform seam import failed");
}
if (PRODUCT_BRANDING.attribution !== "Built on Jinn." || PRODUCT_BRANDING.commandName !== "colophon") {
  throw new Error("attribution copy drifted");
}
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
if (packageJson.bin?.colophon !== "./dist/cli/bin.js" || packageJson.bin?.["benchmark-product"] !== "./dist/cli/bin.js") {
  throw new Error("preferred and compatibility CLI aliases are not both packed");
}
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/"));
const expectedJinnDependencies = [
  "@jinn-network/attestation-issuer",
  "@jinn-network/benchmarking-aggregate",
  "@jinn-network/benchmarking-interop",
  "@jinn-network/benchmarking-local",
  "@jinn-network/benchmarking-publication",
  "@jinn-network/benchmarking-records",
  "@jinn-network/benchmarking-run",
  "@jinn-network/task-admission",
  "@jinn-network/task-execution-backend",
  "@jinn-network/task-execution-backend-local",
  "@jinn-network/task-execution-evaluation-harness",
  "@jinn-network/task-execution-evaluator-adapters",
  "@jinn-network/task-execution-launchers",
  "@jinn-network/task-execution-oci-grader",
  "@jinn-network/task-execution-profiles",
  "@jinn-network/task-execution-protocol",
  "@jinn-network/task-execution-supervisor",
  "@jinn-network/task-execution-workspace",
  "@jinn-network/trust-core",
];
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
