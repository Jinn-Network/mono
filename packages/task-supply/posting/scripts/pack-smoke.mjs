import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Cross-tree portal dependencies: pack every dependency this package resolves via a portal
// locally too — including the transitive ones (trust-core under trust/resolve, evidence-protocol
// under environments/record, task-admission under task-derivation) — so the consumer graph
// resolves end-to-end without reaching the npm registry.
const packageRoots = [
  ["@jinn-network/evidence-protocol", join(packageRoot, "..", "..", "evidence", "protocol"), "evidence-protocol.tgz"],
  ["@jinn-network/trust-core", join(packageRoot, "..", "..", "trust", "core"), "trust-core.tgz"],
  ["@jinn-network/trust-resolve", join(packageRoot, "..", "..", "trust", "resolve"), "trust-resolve.tgz"],
  ["@jinn-network/task-execution-protocol", join(packageRoot, "..", "..", "task-execution", "protocol"), "task-execution-protocol.tgz"],
  ["@jinn-network/task-execution-profiles", join(packageRoot, "..", "..", "task-execution", "profiles"), "task-execution-profiles.tgz"],
  ["@jinn-network/task-execution-backend", join(packageRoot, "..", "..", "task-execution", "backend"), "task-execution-backend.tgz"],
  ["@jinn-network/environment-record", join(packageRoot, "..", "..", "environments", "record"), "environment-record.tgz"],
  ["@jinn-network/task-admission", join(packageRoot, "..", "admission"), "task-admission.tgz"],
  ["@jinn-network/task-derivation", join(packageRoot, "..", "derivation"), "task-derivation.tgz"],
  ["@jinn-network/marketplace-binding", join(packageRoot, "..", "..", "marketplace", "binding"), "marketplace-binding.tgz"],
  ["@jinn-network/task-posting", packageRoot, "task-posting.tgz"],
];
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-task-posting-"));
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
        // task-derivation's `./testing` entrypoint declares vitest as an optional peer; npm
        // resolves the peer graph for every installed package, so supply it here.
        ["vitest", "^4.1.8"],
      ]),
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer },
  );

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "task-posting");
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile } from "node:fs/promises";
import {
  POSTING_SUBMISSION_NAMESPACE,
  PostingRefusedError,
  buildDispatchSubmission,
  executePosting,
  planPosting,
} from "@jinn-network/task-posting";

if (typeof planPosting !== "function" || typeof executePosting !== "function") {
  throw new Error("root import failed: the policy surface is not exported");
}
if (typeof buildDispatchSubmission !== "function" || typeof PostingRefusedError !== "function") {
  throw new Error("root import failed: the dispatch/refusal surface is not exported");
}
if (POSTING_SUBMISSION_NAMESPACE !== "jinn:task-posting:submission:v1") {
  throw new Error("root import failed: the submission namespace moved");
}

const plan = planPosting([], {
  terms: {
    solutionMaxDeliveryRateWei: 1n,
    verdictMaxDeliveryRateWei: 1n,
    responseTimeoutSeconds: 60n,
    allowSolverSelfEvaluation: false,
    maxClaims: 1,
  },
  creatorSafe: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
  requester: "urn:uuid:11111111-2222-3333-4444-555555555555",
  now: "2026-07-31T00:00:00Z",
  deadlineSeconds: 60,
  batchLimit: 1,
});
if (plan.entries.length !== 0 || plan.totalEscrowValueWei !== 0n || plan.approval !== "explicit") {
  throw new Error("planPosting did not plan an empty batch from an empty pool");
}

const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/")).sort();
const expectedJinnDependencies = [
  "@jinn-network/marketplace-binding",
  "@jinn-network/task-derivation",
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
