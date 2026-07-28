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
  // Minimal root-import smoke for Task 1: proves the packed tarball installs and its root entry
  // resolves against the packed protocol dependency. The sealed-document + /testing assertions
  // land with Task 15 (out of scope here) — this script is rewritten there, not extended
  // piecemeal.
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
import { EVAL_SEMANTICS_VERSION, TASK_PROFILE_FORMAT_URI } from "@jinn-network/task-execution-profiles";

if (TASK_PROFILE_FORMAT_URI !== "https://jinn.network/profiles/task-profile/1.0") {
  throw new Error("root import failed");
}
if (EVAL_SEMANTICS_VERSION !== "4") throw new Error("semanticsVersion seed mismatch");
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/"));
if (jinnDependencies.join(",") !== "@jinn-network/task-execution-protocol") {
  throw new Error("unexpected Jinn dependency boundary: " + jinnDependencies.join(", "));
}
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))});
if (distFiles.some((name) => name.includes(".test."))) throw new Error("test output leaked into dist");
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed package root import, dist packaging, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
