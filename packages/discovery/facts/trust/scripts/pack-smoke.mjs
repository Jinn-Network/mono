import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Cross-tree portal dependencies (§7.8): facts/trust's production
// dependencies are record-discovery-protocol and trust-core directly;
// protocol's own transitive dependency on trust-core is the same package
// already packed here, so no further transitive packing is needed (mirrors
// record-discovery-serve's pack-smoke.mjs).
const protocolRoot = join(packageRoot, "..", "..", "protocol");
const trustCoreRoot = join(packageRoot, "..", "..", "..", "trust", "core");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-record-discovery-facts-trust-"));
const archive = join(temporaryRoot, "record-discovery-facts-trust.tgz");
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

async function packPortal(root, out) {
  await run("corepack", ["yarn@4.13.0", "install", "--immutable"], { cwd: root });
  await run("corepack", ["yarn@4.13.0", "pack", "--out", out], { cwd: root });
}

try {
  await packPortal(trustCoreRoot, trustCoreArchive);
  await packPortal(protocolRoot, protocolArchive);
  await packPortal(packageRoot, archive);

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/trust-core": `file:${trustCoreArchive}`,
        "@jinn-network/record-discovery-protocol": `file:${protocolArchive}`,
        "@jinn-network/record-discovery-facts-trust": `file:${archive}`,
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
    "record-discovery-facts-trust",
  );
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
import * as recordDiscoveryFactsTrust from "@jinn-network/record-discovery-facts-trust";

if (typeof recordDiscoveryFactsTrust !== "object") throw new Error("root import failed");
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/"));
const expectedJinnDependencies = ["@jinn-network/record-discovery-protocol", "@jinn-network/trust-core"];
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
