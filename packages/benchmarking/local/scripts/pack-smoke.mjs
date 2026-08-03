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
  ["@jinn-network/benchmarking-records", join(packageRoot, "..", "records")],
  ["@jinn-network/benchmarking-run", join(packageRoot, "..", "run")],
];
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-benchmarking-local-"));
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
    "@jinn-network/benchmarking-local",
    await packOne(packageRoot, "benchmarking-local.tgz"),
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
import * as local from "@jinn-network/benchmarking-local";
const expected = [
  "localAssemblyPorts",
  "localPinningObservation",
  "pinningObservationForCell",
  "pinningStatusForAxis",
  "corroborate",
  "corroborationForAxis",
  "effectiveRunPinning",
  "pinnedValueForAxis",
  "axisObservationsFromRuntimeObservations",
  "runPinningPropertyId",
  "integrityTierFromReceipt",
  "localAdmissionEvidence",
  "localInputScope",
  "localCloseBoundary",
  "localReportedCost",
  "failClosedTrustResolver",
  "unresolvedTrustResolver",
];
for (const name of expected) {
  if (typeof local[name] !== "function") {
    throw new Error("root import failed: " + name + " missing");
  }
}
if (!Array.isArray(local.PINNING_AXES) || local.PINNING_AXES.length !== 4) {
  throw new Error("root import failed: PINNING_AXES missing");
}
if (local.REQUIREMENT_KEY_FOR_AXIS.isolation !== "isolationPolicy") {
  throw new Error("root import failed: axis naming map missing");
}
if (local.LOCAL_AXIS_STRENGTH.isolation !== "vacuous") {
  throw new Error("root import failed: axis strength map missing");
}
console.log("Installed package imports and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: temporaryRoot });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
