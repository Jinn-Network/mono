import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Cross-tree portal dependencies: pack every dependency this package resolves via a portal
// locally too — including the transitive ones (evidence-protocol under environments/record,
// trust-core under task-admission) — so the consumer graph resolves end-to-end without
// reaching the npm registry.
const packageRoots = [
  ["@jinn-network/evidence-protocol", join(packageRoot, "..", "..", "evidence", "protocol"), "evidence-protocol.tgz"],
  ["@jinn-network/trust-core", join(packageRoot, "..", "..", "trust", "core"), "trust-core.tgz"],
  ["@jinn-network/task-execution-protocol", join(packageRoot, "..", "..", "task-execution", "protocol"), "task-execution-protocol.tgz"],
  ["@jinn-network/task-execution-profiles", join(packageRoot, "..", "..", "task-execution", "profiles"), "task-execution-profiles.tgz"],
  ["@jinn-network/environment-record", join(packageRoot, "..", "..", "environments", "record"), "environment-record.tgz"],
  ["@jinn-network/task-admission", join(packageRoot, "..", "admission"), "task-admission.tgz"],
  ["@jinn-network/task-derivation", packageRoot, "task-derivation.tgz"],
];
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-task-derivation-"));
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
  // Sequential, not Promise.all: a concurrent `yarn pack` on cross-tree dependencies races
  // their `dist` wipe-and-rebuild prepack steps against each other's type-resolution reads.
  const archives = new Map();
  for (const [name, directory, outName] of packageRoots) {
    archives.set(name, await packOne(directory, outName));
  }

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: Object.fromEntries([
        ...[...archives].map(([name, archive]) => [name, `file:${archive}`]),
        // `./testing` exports the SupplyPool/GoldStore conformance kits, which call vitest's
        // describe/it at module scope. vitest is an OPTIONAL peer of this package precisely
        // because the root entrypoint never touches it — but a consumer that imports
        // `./testing` must supply it, and the smoke proves that contract rather than hiding it.
        ["vitest", "^4.1.8"],
      ]),
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer },
  );

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "task-derivation");
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile } from "node:fs/promises";
import {
  ENVIRONMENT_RECORD_EXTENSION_KEY,
  IMPORT_STRATEGY_ID,
  SOURCE_COMMITMENT_RULE,
  importStrategy,
  runDerivation,
} from "@jinn-network/task-derivation";
import { createStubAdmissionPort } from "@jinn-network/task-derivation/testing";

if (ENVIRONMENT_RECORD_EXTENSION_KEY !== "network.jinn.environment.record") {
  throw new Error("root import failed: the namespaced extension key is not the pinned string");
}
if (SOURCE_COMMITMENT_RULE !== "network.jinn.source-commitment/1") {
  throw new Error("root import failed: the source-commitment rule id moved");
}
if (importStrategy.id !== IMPORT_STRATEGY_ID || typeof runDerivation !== "function") {
  throw new Error("root import failed: the strategy seam is not exported");
}
if (typeof createStubAdmissionPort !== "function") {
  throw new Error("./testing import failed: the stub admission port is missing");
}

const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/")).sort();
const expectedJinnDependencies = [
  "@jinn-network/environment-record",
  "@jinn-network/task-admission",
  "@jinn-network/task-execution-profiles",
  "@jinn-network/task-execution-protocol",
];
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
  const fixtureFiles = await readdir(join(installedRoot, "fixtures"));
  if (!fixtureFiles.includes("rows") || !fixtureFiles.includes("environment")) {
    throw new Error("the published fixtures the ./testing loaders read are missing");
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
