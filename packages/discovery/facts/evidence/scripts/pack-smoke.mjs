import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Cross-tree portal dependencies (§7.8): facts/evidence's production
// dependencies on record-discovery-protocol and the evidence-discovery /
// evidence-repository pair pull in their own transitive Jinn dependencies
// (trust-core via protocol; evidence-protocol via both evidence packages).
// All must be packed and file:-mapped here for the consumer graph to
// resolve end-to-end (mirrors record-discovery-serve's pack-smoke.mjs).
const protocolRoot = join(packageRoot, "..", "..", "protocol");
const trustCoreRoot = join(packageRoot, "..", "..", "..", "trust", "core");
const evidenceProtocolRoot = join(packageRoot, "..", "..", "..", "evidence", "protocol");
const evidenceRepositoryRoot = join(packageRoot, "..", "..", "..", "evidence", "repository");
const evidenceDiscoveryRoot = join(packageRoot, "..", "..", "..", "evidence", "discovery");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-record-discovery-facts-evidence-"));
const archive = join(temporaryRoot, "record-discovery-facts-evidence.tgz");
const protocolArchive = join(temporaryRoot, "record-discovery-protocol.tgz");
const trustCoreArchive = join(temporaryRoot, "trust-core.tgz");
const evidenceProtocolArchive = join(temporaryRoot, "evidence-protocol.tgz");
const evidenceRepositoryArchive = join(temporaryRoot, "evidence-repository.tgz");
const evidenceDiscoveryArchive = join(temporaryRoot, "evidence-discovery.tgz");
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
  await run("yarn", ["pack", "--out", trustCoreArchive], { cwd: trustCoreRoot });
  await run("yarn", ["pack", "--out", protocolArchive], { cwd: protocolRoot });
  await run("yarn", ["pack", "--out", evidenceProtocolArchive], { cwd: evidenceProtocolRoot });
  await run("yarn", ["pack", "--out", evidenceRepositoryArchive], { cwd: evidenceRepositoryRoot });
  await run("yarn", ["pack", "--out", evidenceDiscoveryArchive], { cwd: evidenceDiscoveryRoot });
  await run("yarn", ["pack", "--out", archive], { cwd: packageRoot });

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/trust-core": `file:${trustCoreArchive}`,
        "@jinn-network/record-discovery-protocol": `file:${protocolArchive}`,
        "@jinn-network/evidence-protocol": `file:${evidenceProtocolArchive}`,
        "@jinn-network/evidence-repository": `file:${evidenceRepositoryArchive}`,
        "@jinn-network/evidence-discovery": `file:${evidenceDiscoveryArchive}`,
        "@jinn-network/record-discovery-facts-evidence": `file:${archive}`,
      },
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer },
  );

  const installedRoot = join(
    consumer,
    "node_modules",
    "@jinn-network",
    "record-discovery-facts-evidence",
  );
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
import * as recordDiscoveryFactsEvidence from "@jinn-network/record-discovery-facts-evidence";

if (typeof recordDiscoveryFactsEvidence !== "object") throw new Error("root import failed");
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/"));
const expectedJinnDependencies = ["@jinn-network/evidence-discovery", "@jinn-network/evidence-repository", "@jinn-network/record-discovery-protocol"];
if (jinnDependencies.length !== expectedJinnDependencies.length
    || jinnDependencies.some((name) => !expectedJinnDependencies.includes(name))) {
  throw new Error("unexpected Jinn coupling: " + jinnDependencies.join(", "));
}
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))});
if (distFiles.some((name) => name.includes(".test."))) throw new Error("test output leaked into dist");
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed package imports, dependency boundary, and dist shape verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: temporaryRoot });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
