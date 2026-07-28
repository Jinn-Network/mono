import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// This package's own source has no cross-tree Jinn dependency (plan Task 9:
// "no cross-tree deps") -- but its in-tree portal dependency on
// record-discovery-protocol itself depends on trust-core (a real
// `dependencies` entry, resolved for protocol via ITS OWN portal), so npm
// still needs trust-core packed and file:-mapped here for the consumer
// graph to resolve end-to-end (mirrors record-discovery-protocol's own
// pack-smoke.mjs, which packs trust-core for the identical reason).
const protocolRoot = join(packageRoot, "..", "protocol");
const trustCoreRoot = join(packageRoot, "..", "..", "trust", "core");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-record-discovery-testing-"));
const archive = join(temporaryRoot, "record-discovery-testing.tgz");
const protocolArchive = join(temporaryRoot, "record-discovery-protocol.tgz");
const trustCoreArchive = join(temporaryRoot, "trust-core.tgz");
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
        "@jinn-network/record-discovery-testing": `file:${archive}`,
        // The kit's exported run*Conformance functions call vitest's
        // describe/it/expect at module scope (they wrap `describe(...)`
        // blocks); vitest is an optional peer (satisfied by whatever
        // consumer devDependency supplies it, evidence/task-execution-
        // testing precedent), but the smoke consumer needs it present to
        // resolve the root import at all.
        vitest: "4.1.8",
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
    "record-discovery-testing",
  );
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
import * as recordDiscoveryTesting from "@jinn-network/record-discovery-testing";

if (typeof recordDiscoveryTesting !== "object") throw new Error("root import failed");
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/"));
const expectedJinnDependencies = ["@jinn-network/record-discovery-protocol"];
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
