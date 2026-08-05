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
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-task-execution-protocol-"));
const archive = join(temporaryRoot, "task-execution-protocol.tgz");
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
    "task-execution-protocol",
  );
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
import {
  TASK_EXECUTION_PROTOCOL_URI,
  validateTask,
  validateDelivery,
  mergeRequirements,
} from "@jinn-network/task-execution-protocol";

if (TASK_EXECUTION_PROTOCOL_URI !== "https://spec.jinn.network/profiles/task-execution/v1") {
  throw new Error("root import failed");
}
await readFile(new URL(import.meta.resolve("@jinn-network/task-execution-protocol/schemas/task.schema.json")));
const task = await readFile(new URL(import.meta.resolve("@jinn-network/task-execution-protocol/fixtures/golden-task-execution-v1/task.json")));
if (!validateTask(JSON.parse(task.toString("utf8"))).conforms) throw new Error("golden Task failed validation");
const delivery = await readFile(new URL(import.meta.resolve("@jinn-network/task-execution-protocol/fixtures/golden-task-execution-v1/local/delivery.json")));
if (!validateDelivery(JSON.parse(delivery.toString("utf8"))).conforms) throw new Error("golden Delivery failed validation");
const merged = mergeRequirements({ effort: "low" }, { effort: "high" }, { effort: "floor" });
if (!merged.ok || merged.effective.effort !== "high") throw new Error("mergeRequirements smoke failed");
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
