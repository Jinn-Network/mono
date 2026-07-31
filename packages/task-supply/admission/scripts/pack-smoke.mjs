import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Cross-tree portal dependencies: pack every dependency this package resolves via a portal
// locally too, so the consumer graph resolves end-to-end without reaching the npm registry.
const environmentRecordRoot = join(packageRoot, "..", "..", "environments", "record");
const trustCoreRoot = join(packageRoot, "..", "..", "trust", "core");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-task-admission-"));
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
  // Sequential, not Promise.all: a concurrent `yarn pack` on cross-tree dependencies races their
  // `dist` wipe-and-rebuild prepack steps against each other's type-resolution reads.
  const trustCoreArchive = await packOne(trustCoreRoot, "trust-core.tgz");
  const environmentRecordArchive = await packOne(environmentRecordRoot, "environment-record.tgz");
  const admissionArchive = await packOne(packageRoot, "task-admission.tgz");

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/trust-core": `file:${trustCoreArchive}`,
        "@jinn-network/environment-record": `file:${environmentRecordArchive}`,
        "@jinn-network/task-admission": `file:${admissionArchive}`,
      },
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer },
  );

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "task-admission");
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile } from "node:fs/promises";
import { ADMISSION_REFUSAL_CODES, DIFFERENTIAL_ADMISSION_POLICY_V3 } from "@jinn-network/task-admission";
if (!ADMISSION_REFUSAL_CODES.includes("env-record-mismatch")) {
  throw new Error("root import failed: the refusal taxonomy is missing env-record-mismatch");
}
if (DIFFERENTIAL_ADMISSION_POLICY_V3.observationsPerSide !== 2) {
  throw new Error("root import failed: the policy is not the 2x2 policy");
}
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/")).sort();
const expectedJinnDependencies = ["@jinn-network/environment-record", "@jinn-network/trust-core"];
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
