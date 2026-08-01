import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoots = [
  ["@jinn-network/evidence-protocol", join(packageRoot, "..", "..", "evidence", "protocol"), "evidence-protocol.tgz"],
  ["@jinn-network/trust-core", join(packageRoot, "..", "..", "trust", "core"), "trust-core.tgz"],
  ["@jinn-network/task-execution-protocol", join(packageRoot, "..", "..", "task-execution", "protocol"), "task-execution-protocol.tgz"],
  ["@jinn-network/task-execution-profiles", join(packageRoot, "..", "..", "task-execution", "profiles"), "task-execution-profiles.tgz"],
  ["@jinn-network/environment-record", join(packageRoot, "..", "..", "environments", "record"), "environment-record.tgz"],
  ["@jinn-network/chain-environment-record", join(packageRoot, "..", "..", "environments", "chain-record"), "chain-environment-record.tgz"],
  ["@jinn-network/task-admission", join(packageRoot, "..", "admission"), "task-admission.tgz"],
  ["@jinn-network/task-derivation", join(packageRoot, "..", "derivation"), "task-derivation.tgz"],
  ["@jinn-network/chain-scenarios", packageRoot, "chain-scenarios.tgz"],
];
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-chain-scenarios-"));
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
        ["vitest", "^4.1.8"],
      ]),
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer },
  );

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "chain-scenarios");
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile } from "node:fs/promises";
import "@jinn-network/chain-scenarios";
import "@jinn-network/chain-scenarios/testing";

const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/")).sort();
const expectedJinnDependencies = [
  "@jinn-network/chain-environment-record",
  "@jinn-network/task-admission",
  "@jinn-network/task-derivation",
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
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
