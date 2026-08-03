import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(packageRoot, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-policy-optimization-"));
const consumer = join(temporaryRoot, "consumer");

// Cross-tree portal dependencies, packed locally so the consumer graph resolves end-to-end
// without reaching the registry. `task-execution-protocol` is not a dependency of this package —
// it is `benchmarking-records`' own runtime edge, and an unpacked transitive Jinn dependency
// makes `npm install` reach for a registry version that does not exist.
const PORTAL_PACKAGES = [
  ["@jinn-network/task-execution-protocol", join(packagesRoot, "task-execution", "protocol"), "task-execution-protocol.tgz"],
  ["@jinn-network/benchmarking-records", join(packagesRoot, "benchmarking", "records"), "benchmarking-records.tgz"],
  ["@jinn-network/policy-identity", join(packagesRoot, "policy", "identity"), "policy-identity.tgz"],
];

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
  const archives = new Map();
  for (const [name, directory, outName] of PORTAL_PACKAGES) {
    archives.set(name, await packOne(directory, outName));
  }
  const productArchive = await packOne(packageRoot, "policy-optimization.tgz");

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        ...Object.fromEntries([...archives].map(([name, archive]) => [name, `file:${archive}`])),
        "@jinn-network/policy-optimization": `file:${productArchive}`,
      },
    }),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "policy-optimization");
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile } from "node:fs/promises";
import {
  CAMPAIGN_FORMAT_TOKEN,
  CAMPAIGN_JOURNAL_EVENT_TYPES,
  V0_MUTATION_SURFACE,
  validateCampaign,
} from "@jinn-network/policy-optimization";

if (CAMPAIGN_FORMAT_TOKEN !== "network.jinn.policy-optimization.campaign/1.0") {
  throw new Error("campaign format token drifted");
}
if (V0_MUTATION_SURFACE.join(",") !== "loadout") throw new Error("v0 mutation surface drifted");
if (CAMPAIGN_JOURNAL_EVENT_TYPES.length !== 11) throw new Error("journal event list drifted");
const refused = validateCampaign({});
if (refused.ok) throw new Error("an empty document must not validate");

const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/")).sort();
const expectedJinnDependencies = ["@jinn-network/benchmarking-records", "@jinn-network/policy-identity"];
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
