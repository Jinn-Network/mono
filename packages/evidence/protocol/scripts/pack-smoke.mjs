import { spawn } from "node:child_process";
import {
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
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-evidence-protocol-"));
const archive = join(temporaryRoot, "evidence-protocol.tgz");
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
  await run("yarn", ["pack", "--out", archive], {
    cwd: packageRoot,
  });

  await writeFile(
    join(temporaryRoot, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      consumer,
      archive,
    ],
    { cwd: temporaryRoot },
  );

  const installedRoot = join(
    consumer,
    "node_modules",
    "@jinn-network",
    "evidence-protocol",
  );
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
import {
  EXECUTION_EVIDENCE_PROFILE_URI,
  validateExecutionEvidence,
  validateResultEvaluation,
} from "@jinn-network/evidence-protocol";

if (EXECUTION_EVIDENCE_PROFILE_URI !== "https://spec.jinn.network/profiles/execution-evidence/v1") {
  throw new Error("root import failed");
}
const profile = await readFile(new URL(import.meta.resolve("@jinn-network/evidence-protocol/profiles/execution-evidence/v1/specification.md")), "utf8");
if (!profile.includes("Jinn Execution Evidence Profile 1.0")) throw new Error("profile missing");
await readFile(new URL(import.meta.resolve("@jinn-network/evidence-protocol/schemas/execution-evidence-document.schema.json")));
const execution = await readFile(new URL(import.meta.resolve("@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/execution/ro-crate-metadata.json")));
if (!validateExecutionEvidence(execution).conforms) throw new Error("golden execution failed");
const evaluation = await readFile(new URL(import.meta.resolve("@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json")));
if (!validateResultEvaluation(evaluation).conforms) throw new Error("golden evaluation failed");
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/"));
if (jinnDependencies.length) throw new Error("undeclared Jinn coupling: " + jinnDependencies.join(", "));
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))});
if (distFiles.some((name) => name.includes(".test."))) throw new Error("test output leaked into dist");
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed package imports, assets, fixtures, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: temporaryRoot });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
