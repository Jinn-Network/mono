import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const crossTree = [
  ["@jinn-network/task-execution-protocol", join(packageRoot, "..", "..", "task-execution", "protocol")],
  ["@jinn-network/task-execution-backend", join(packageRoot, "..", "..", "task-execution", "backend")],
  ["@jinn-network/task-execution-profiles", join(packageRoot, "..", "..", "task-execution", "profiles")],
  ["@jinn-network/trust-core", join(packageRoot, "..", "..", "trust", "core")],
  ["@jinn-network/trust-resolve", join(packageRoot, "..", "..", "trust", "resolve")],
  ["@jinn-network/record-discovery-protocol", join(packageRoot, "..", "..", "discovery", "protocol")],
  ["@jinn-network/record-discovery-serve", join(packageRoot, "..", "..", "discovery", "serve")],
  ["@jinn-network/benchmarking-records", join(packageRoot, "..", "records")],
  ["@jinn-network/benchmarking-run", join(packageRoot, "..", "run")],
  ["@jinn-network/marketplace-binding", join(packageRoot, "..", "..", "marketplace", "binding")],
  ["@jinn-network/marketplace-projector", join(packageRoot, "..", "..", "marketplace", "projector")],
];
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-benchmarking-marketplace-"));
const archivesRoot = join(temporaryRoot, "archives");
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
  const archive = join(archivesRoot, outName);
  await run("yarn", ["pack", "--out", archive], { cwd: directory });
  return archive;
}

try {
  await mkdir(archivesRoot, { recursive: true });
  const archives = new Map();
  for (const [name, root] of crossTree) {
    archives.set(name, await packOne(root, `${name.replace(/[@/]/g, "-")}.tgz`));
  }
  archives.set(
    "@jinn-network/benchmarking-marketplace",
    await packOne(packageRoot, "benchmarking-marketplace.tgz"),
  );

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: Object.fromEntries(
        [...archives.entries()].map(([name, archive]) => [name, `file:${archive}`]),
      ),
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer },
  );

  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import * as marketplace from "@jinn-network/benchmarking-marketplace";
const expected = [
  "marketplaceCloseBoundary",
  "projectorInputScope",
  "settledCostSource",
  "attestedPinningObservation",
  "marketplaceAdmissionEvidence",
  "marketplaceAssemblyPorts",
  "deriveEligibleObservations",
  "runOnMarketplace",
  "validateMarketplaceComposition",
  "resolveCoherentCloseAuthority",
  "enforceAnchoredOrderingGate",
  "AnchoredOrderingViolationError",
  "validateMarketplaceBudget",
];
for (const name of expected) {
  if (typeof marketplace[name] !== "function") {
    throw new Error("root import failed: " + name + " missing");
  }
}
console.log("Installed package imports and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: temporaryRoot });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
