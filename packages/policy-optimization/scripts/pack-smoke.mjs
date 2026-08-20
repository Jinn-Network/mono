import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile as readFileAsync, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(packageRoot, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-policy-optimization-"));
const consumer = join(temporaryRoot, "consumer");

// Cross-tree portal dependencies, packed locally so the consumer graph resolves end-to-end
// without reaching the registry. The private live host deliberately acquires concrete backend,
// evaluator, evidence, and trust edges, so the smoke consumer must materialize their complete
// local graph as archives too.
const PORTAL_PACKAGES = [
  ["@jinn-network/evidence-protocol", join(packagesRoot, "evidence", "protocol"), "evidence-protocol.tgz"],
  ["@jinn-network/evidence-repository", join(packagesRoot, "evidence", "repository"), "evidence-repository.tgz"],
  ["@jinn-network/evidence-discovery", join(packagesRoot, "evidence", "discovery"), "evidence-discovery.tgz"],
  ["@jinn-network/execution-evidence-builder", join(packagesRoot, "evidence", "execution-evidence-builder"), "execution-evidence-builder.tgz"],
  ["@jinn-network/execution-recorder", join(packagesRoot, "evidence", "execution-recorder"), "execution-recorder.tgz"],
  ["@jinn-network/attestation-issuer", join(packagesRoot, "evidence", "attestation-issuer"), "attestation-issuer.tgz"],
  ["@jinn-network/task-execution-protocol", join(packagesRoot, "task-execution", "protocol"), "task-execution-protocol.tgz"],
  ["@jinn-network/task-execution-profiles", join(packagesRoot, "task-execution", "profiles"), "task-execution-profiles.tgz"],
  ["@jinn-network/task-execution-backend", join(packagesRoot, "task-execution", "backend"), "task-execution-backend.tgz"],
  ["@jinn-network/task-execution-supervisor", join(packagesRoot, "task-execution", "backend-local", "supervisor"), "task-execution-supervisor.tgz"],
  ["@jinn-network/task-execution-workspace", join(packagesRoot, "task-execution", "backend-local", "workspace"), "task-execution-workspace.tgz"],
  ["@jinn-network/task-execution-launchers", join(packagesRoot, "task-execution", "backend-local", "launchers"), "task-execution-launchers.tgz"],
  ["@jinn-network/task-execution-evaluation-harness", join(packagesRoot, "task-execution", "evaluation-harness"), "task-execution-evaluation-harness.tgz"],
  ["@jinn-network/task-execution-evaluator-adapters", join(packagesRoot, "task-execution", "evaluator-adapters"), "task-execution-evaluator-adapters.tgz"],
  ["@jinn-network/task-execution-oci-grader", join(packagesRoot, "task-execution", "oci-grader"), "task-execution-oci-grader.tgz"],
  ["@jinn-network/task-execution-backend-local", join(packagesRoot, "task-execution", "backend-local", "assembly"), "task-execution-backend-local.tgz"],
  ["@jinn-network/trust-core", join(packagesRoot, "trust", "core"), "trust-core.tgz"],
  ["@jinn-network/benchmarking-records", join(packagesRoot, "benchmarking", "records"), "benchmarking-records.tgz"],
  ["@jinn-network/benchmarking-run", join(packagesRoot, "benchmarking", "run"), "benchmarking-run.tgz"],
  ["@jinn-network/benchmarking-aggregate", join(packagesRoot, "benchmarking", "aggregate"), "benchmarking-aggregate.tgz"],
  ["@jinn-network/benchmarking-local", join(packagesRoot, "benchmarking", "local"), "benchmarking-local.tgz"],
  ["@jinn-network/policy-identity", join(packagesRoot, "policy", "identity"), "policy-identity.tgz"],
  ["@jinn-network/policy-outcomes", join(packagesRoot, "policy", "outcomes"), "policy-outcomes.tgz"],
];

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
  ALLOCATION_POLICY_REFS,
  CAMPAIGN_FORMAT_TOKEN,
  CAMPAIGN_JOURNAL_EVENT_TYPES,
  NO_CELLS_COMMITTED,
  STOPPING_RULE_REFS,
  V0_MUTATION_SURFACE,
  committedCells,
  curateAnnouncements,
  decideAllocation,
  deriveOutcomeObservations,
  validateCampaign,
} from "@jinn-network/policy-optimization";

if (CAMPAIGN_FORMAT_TOKEN !== "network.jinn.policy-optimization.campaign/1.0") {
  throw new Error("campaign format token drifted");
}
if (V0_MUTATION_SURFACE.join(",") !== "loadout") throw new Error("v0 mutation surface drifted");
if (CAMPAIGN_JOURNAL_EVENT_TYPES.length !== 11) throw new Error("journal event list drifted");
const refused = validateCampaign({});
if (refused.ok) throw new Error("an empty document must not validate");

if (ALLOCATION_POLICY_REFS.join(",") !== "uniform/1.0,drop-bottom-k/1.0,informativeness/1.0") {
  throw new Error("allocation policy list drifted");
}
if (STOPPING_RULE_REFS.join(",") !== "max-waves/1.0,budget-exhausted/1.0") {
  throw new Error("stopping rule list drifted");
}
if (committedCells([]).total !== NO_CELLS_COMMITTED.total) throw new Error("cell accounting drifted");
let allocationRefused = false;
try { decideAllocation({ campaign: {}, waveNumber: 1, population: [], taskDigests: [] }); }
catch { allocationRefused = true; }
if (!allocationRefused) throw new Error("an allocation over an empty population must refuse");

// The two observation adapters (product §8.2; program §1 C8) must be reachable post-pack, and
// must still refuse a record missing its required joins (fail-closed, not a lucky default).
const curated = curateAnnouncements([{
  record: { kind: "https://spec.jinn.network/records/delivery/v1", digest: "sha256:" + "0".repeat(64) },
  provenance: {
    source: { agent: "urn:jinn:agent:smoke", name: "smoke-source" },
    entry: "sha256:" + "1".repeat(64),
    announcementId: "smoke-1",
  },
  entryTimestamp: "2026-08-03T00:00:00Z",
  attemptUri: "urn:uuid:smoke",
}]);
if (curated.observations.length !== 0 || curated.refusals.length !== 1) {
  throw new Error("curation adapter fail-closed smoke check drifted");
}
const outcomes = deriveOutcomeObservations([]);
if (outcomes.observations.length !== 0) throw new Error("outcomes adapter smoke check drifted");

const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/")).sort();
const expectedJinnDependencies = [
  "@jinn-network/attestation-issuer",
  "@jinn-network/benchmarking-aggregate",
  "@jinn-network/benchmarking-local",
  "@jinn-network/benchmarking-records",
  "@jinn-network/benchmarking-run",
  "@jinn-network/evidence-protocol",
  "@jinn-network/policy-identity",
  "@jinn-network/policy-outcomes",
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

  // C7d: the `optimize` verb tree ships as this package's own bin. A `bin` entry pointing at a file
  // the tarball does not carry installs as a dangling symlink and fails on first use, which is the
  // one failure mode `yarn test` cannot see.
  //
  // Both `bin` spellings are accepted, because both are the same declaration: for a package named
  // `@scope/name`, npm and Yarn treat `"bin": "./x.js"` as exactly `{name: "./x.js"}`, and `yarn
  // install` NORMALISES the object form down to the string whenever the only key matches the
  // unscoped package name. A guard that insisted on the object form would pass on the branch that
  // authored it and fail on the next `yarn install` anyone ran -- which is what happened.
  const installedManifest = JSON.parse(await readFileAsync(join(installedRoot, "package.json"), "utf8"));
  const declaredBin = installedManifest.bin;
  const binTarget = typeof declaredBin === "string"
    ? declaredBin
    : declaredBin?.["jinn-optimize"];
  if (typeof binTarget !== "string") throw new Error("the policy-optimization bin entry is missing");
  const binPath = join(installedRoot, binTarget);
  await access(binPath);
  const binSource = await readFileAsync(binPath, "utf8");
  if (!binSource.startsWith("#!/usr/bin/env node")) {
    throw new Error("the packed bin lost its shebang");
  }
  // Run it: the verb tree must be reachable from the installed tree, not only present in it.
  const usage = await run(process.execPath, [binPath], { cwd: temporaryRoot, stdio: "pipe" });
  if (!usage.includes("jinn-optimize campaign prepare") || !usage.includes("Headless use never starts the guide")) {
    throw new Error("the packed bin does not expose the headless-safe guided journey");
  }
  console.log("Installed bin resolves, keeps its shebang, and exposes the headless-safe guided journey.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
