import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const protocolRoot = join(packageRoot, "..", "protocol");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-task-execution-profiles-"));
const archivesRoot = join(temporaryRoot, "archives");
const protocolArchive = join(archivesRoot, "task-execution-protocol.tgz");
const profilesArchive = join(archivesRoot, "task-execution-profiles.tgz");
const consumer = join(temporaryRoot, "consumer");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

try {
  await mkdir(archivesRoot, { recursive: true });
  // profiles legitimately depends on the sibling protocol package (portal-resolved in the
  // workspace), so the throwaway npm consumer below must resolve it from a local tarball —
  // never the registry, which does not (yet) carry an unpublished @jinn-network package.
  await run("yarn", ["pack", "--out", protocolArchive], { cwd: protocolRoot });
  await run("yarn", ["pack", "--out", profilesArchive], { cwd: packageRoot });

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/task-execution-protocol": `file:${protocolArchive}`,
        "@jinn-network/task-execution-profiles": `file:${profilesArchive}`,
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
    "task-execution-profiles",
  );
  const smokeScript = join(consumer, "smoke.mjs");
  // Full Task 15 smoke: root import, both sealed-document assets resolved by digest through
  // import.meta.resolve, the ./testing subpath + its FIXTURE_FAMILIES manifest, the
  // @jinn-network/ dependency boundary, and no .test. leakage into dist.
  await writeFile(
    smokeScript,
    `
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  EVAL_SEMANTICS_VERSION,
  TASK_PROFILE_FORMAT_URI,
  sealDocument,
  verifyEvaluationSubject,
} from "@jinn-network/task-execution-profiles";
import {
  documentDigest,
  sealDelivery,
  sealTask,
} from "@jinn-network/task-execution-protocol";

// Root import: identifiers + the sealing entry point.
if (TASK_PROFILE_FORMAT_URI !== "https://jinn.network/profiles/task-profile/1.0") {
  throw new Error("root import failed");
}
if (EVAL_SEMANTICS_VERSION !== "4") throw new Error("semanticsVersion seed mismatch");
if (typeof sealDocument !== "function") throw new Error("sealDocument did not resolve from root import");
const probe = sealDocument({ smoke: "test" });
if (!probe.digest.startsWith("sha256:")) throw new Error("sealDocument did not return a sha256 digest");
const resultBytes = new TextEncoder().encode("packed exact Result");
const taskBytes = sealTask({
  protocol: "https://jinn.network/profiles/task-execution/1.0",
  profile: { digest: { sha256: "1".repeat(64) } },
  instructions: "packed exact-subject smoke",
  outputs: [{ name: "result", mediaType: "text/plain", required: true }],
  evaluation: {
    name: "evaluation-spec.json",
    digest: { sha256: "2".repeat(64) },
  },
});
const deliveryBytes = sealDelivery({
  protocol: "https://jinn.network/profiles/task-execution/1.0",
  attempt: "urn:uuid:33333333-3333-4333-8333-333333333333",
  task: documentDigest(taskBytes),
  outputs: [{
    name: "result",
    mediaType: "text/plain",
    digest: {
      sha256: documentDigest(resultBytes).slice("sha256:".length),
    },
  }],
  outcome: "fulfilled",
  createdAt: "2026-07-29T12:00:00.000Z",
});
const verified = verifyEvaluationSubject({
  taskBytes,
  deliveryBytes,
  results: [{ name: "result", bytes: resultBytes }],
});
if (
  verified.task.digest !== documentDigest(taskBytes)
  || verified.results[0]?.digest !== documentDigest(resultBytes)
) {
  throw new Error("packed evaluation exact-subject verifier returned the wrong view");
}

// The two sealed-document assets, resolved by subpath export — each matches its own
// profile.sha256 (program §7.1: profile.json is the exact raw sealed bytes on disk).
for (const profile of ["repository-work", "evaluation-task"]) {
  const jsonUrl = import.meta.resolve(
    \`@jinn-network/task-execution-profiles/profiles/task-profiles/\${profile}/1.0/profile.json\`,
  );
  const shaUrl = import.meta.resolve(
    \`@jinn-network/task-execution-profiles/profiles/task-profiles/\${profile}/1.0/profile.sha256\`,
  );
  const bytes = await readFile(fileURLToPath(jsonUrl));
  const pinned = (await readFile(fileURLToPath(shaUrl), "utf8")).trim();
  const actual = \`sha256:\${createHash("sha256").update(bytes).digest("hex")}\`;
  if (actual !== pinned) {
    throw new Error(\`\${profile}/1.0/profile.json does not match its profile.sha256: \${actual} !== \${pinned}\`);
  }
}

// The ./testing subpath + its FIXTURE_FAMILIES manifest.
const testingModule = await import("@jinn-network/task-execution-profiles/testing");
if (!Array.isArray(testingModule.FIXTURE_FAMILIES) || testingModule.FIXTURE_FAMILIES.length === 0) {
  throw new Error("FIXTURE_FAMILIES did not resolve from the ./testing subpath, or is empty");
}
if (typeof testingModule.loadFixtureFamily !== "function" || typeof testingModule.runStructuralCheck !== "function") {
  throw new Error("./testing did not export the structural runner");
}

// Dependency boundary + packaging hygiene.
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/"));
if (jinnDependencies.join(",") !== "@jinn-network/task-execution-protocol") {
  throw new Error("unexpected Jinn dependency boundary: " + jinnDependencies.join(", "));
}
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))}, { recursive: true });
if (distFiles.some((name) => name.includes(".test."))) throw new Error("test output leaked into dist");
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});

console.log(
  "Installed package root import, both sealed-document assets, ./testing + FIXTURE_FAMILIES, "
    + "dependency boundary, and dist packaging verified.",
);
`,
  );
  await run(process.execPath, [smokeScript], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
