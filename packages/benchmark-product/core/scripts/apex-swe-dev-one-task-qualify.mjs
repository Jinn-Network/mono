#!/usr/bin/env node
/**
 * Fail-closed operator qualify for APEX-SWE-dev one_task on the HuggingFace pin.
 * Default `yarn test` does not run this. It never downloads the dataset, Git LFS, or compose stacks.
 *
 * See docs/runbooks/apex-swe-dev-official-one-task.md.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const colophonBin = join(packageRoot, "dist", "cli", "bin.js");
const draftId = "apex-one";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

if (process.env.COLOPHON_APEX_SWE_DEV_ONE_TASK_QUALIFY !== "1") {
  fail("Refusing: set COLOPHON_APEX_SWE_DEV_ONE_TASK_QUALIFY=1 and supply operator paths. See docs/runbooks/apex-swe-dev-official-one-task.md. This script never downloads APEX-SWE.");
}

const {
  APEX_SWE_DEV_DATASET_REVISION,
  APEX_SWE_DEV_SUBMIT_CLOSED_SENTENCE,
  ApexSweDevSelectionManifestSchema,
  apexSweDevReportRoot,
  collectApexSweDevCells,
  getSealedBytes,
  isGitLfsPointerBytes,
  launchApexSweDev,
  namedSliceTaskNames,
  readApexSweDevHostBinding,
} = await import("../dist/index.js");

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") fail(`set ${name} to an existing operator path`);
  return value;
}

function run(command, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd: packageRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const stdout = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      if (code === 0) resolve(out);
      else reject(new Error(`${command} ${argv.join(" ")} exited ${code}\n${out}`));
    });
  });
}

function colophon(args) {
  return run(process.execPath, [colophonBin, ...args]);
}

function parseEnvelope(stdout) {
  const parsed = JSON.parse(stdout);
  if (parsed.ok !== true) throw new Error(`Colophon refused: ${stdout}`);
  return parsed.result;
}

if (!existsSync(colophonBin)) fail("build the core package first: yarn --cwd packages/benchmark-product/core build");

const apx = realpathSync(requiredEnv("COLOPHON_APEX_SWE_DEV_APX"));
const python = realpathSync(requiredEnv("COLOPHON_APEX_SWE_DEV_PYTHON"));
const registryMetadataPath = realpathSync(requiredEnv("COLOPHON_APEX_SWE_DEV_REGISTRY_METADATA"));
const integrationTasksDir = realpathSync(requiredEnv("COLOPHON_APEX_SWE_DEV_INTEGRATION_DIR"));
const observabilityProjectDir = realpathSync(requiredEnv("COLOPHON_APEX_SWE_DEV_OBSERVABILITY_DIR"));
const workspace = process.env.COLOPHON_APEX_SWE_DEV_WORKSPACE?.trim() || "/tmp/colophon-apex-swe-dev-one-task";
if (existsSync(join(workspace, "workspace.json"))) fail(`${workspace} is already a Colophon workspace; pick a new COLOPHON_APEX_SWE_DEV_WORKSPACE`);

const metadata = JSON.parse(readFileSync(registryMetadataPath, "utf8"));
if (metadata.revision !== APEX_SWE_DEV_DATASET_REVISION) {
  fail(`registry revision ${metadata.revision} is not the sealed pin ${APEX_SWE_DEV_DATASET_REVISION}`);
}
const one = namedSliceTaskNames(metadata.tasks.map((task) => task.taskId), "one_task");
if (one.length !== 1) fail("named one_task slice must be exactly one task id");

const pointerProbe = readFileSync(join(observabilityProjectDir, "run_e2e.py"));
if (isGitLfsPointerBytes(new Uint8Array(pointerProbe))) {
  fail("observability run_e2e.py is a Git LFS pointer; materialize the one_task harness before qualify");
}

mkdirSync(workspace, { recursive: true });
const common = ["--workspace", workspace, "--principal", "sponsor-1"];
parseEnvelope(await colophon(["init", ...common, "--json"]));
parseEnvelope(await colophon(["draft", "create", ...common, "--id", draftId, "--name", draftId, "--json"]));
parseEnvelope(await colophon(["arm", "add", ...common, "--draft", draftId, "--arm", "one", "--pinning", JSON.stringify({ harness: { id: "placeholder", version: "1" } }), "--json"]));

const selectionPath = join(workspace, "selection.json");
writeFileSync(selectionPath, JSON.stringify({
  apxExecutable: apx,
  pythonExecutable: python,
  registryMetadataPath,
  integrationTasksDir,
  observabilityProjectDir,
  coverage: "one_task",
  arms: [{ armId: "one", modelNameOrPath: "one" }],
}, null, 2));
const selected = parseEnvelope(await colophon(["runtime", "apex-swe-dev", "select", ...common, "--draft", draftId, "--file", selectionPath, "--json"]));
const quoted = parseEnvelope(await colophon(["quote", ...common, "--draft", draftId, "--json"]));
if (quoted.presentation?.suite?.coverage !== "one_task") fail(`expected one_task, got ${quoted.presentation?.suite?.coverage}`);
if (quoted.presentation?.suite?.executionConformance !== true) fail("expected executionConformance true");
if (quoted.presentation?.suite?.leaderboardSubmitReady !== false) fail("one_task must not be leaderboardSubmitReady");
parseEnvelope(await colophon(["lock", ...common, "--draft", draftId, "--json"]));
const manifest = ApexSweDevSelectionManifestSchema.parse(
  JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(workspace, selected.selectionManifestSha256))),
);
const reportRoot = apexSweDevReportRoot(join(workspace, "artifacts"), draftId);
launchApexSweDev({
  manifest,
  binding: readApexSweDevHostBinding(workspace, selected.selectionManifestSha256),
  reportRoot,
  modelNameOrPath: "one",
});
const cells = collectApexSweDevCells({ reportRoot, tasks: manifest.selectedTasks });
if (cells.length !== 1) fail(`one_task must map onto one cell, got ${cells.length}`);
if (cells[0].outcome !== "judged") fail("missing Mercor JSON after grade is unscorable, not skip");
const exported = parseEnvelope(await colophon(["apex-swe", "export", ...common, "--draft", draftId, "--arm", "one", "--json"]));
if (exported.mode !== "inspection-upload") fail(`expected inspection-upload, got ${exported.mode}`);
if (!String(exported.instructions).includes(APEX_SWE_DEV_SUBMIT_CLOSED_SENTENCE)) {
  fail("export instructions must say Colophon does not place a Mercor APEX-SWE leaderboard row");
}
const receipt = {
  oneTask: one[0],
  coverage: "one_task",
  executionConformance: true,
  leaderboardSubmitReady: false,
  cell: cells[0],
  exportMode: exported.mode,
  selectionManifestSha256: selected.selectionManifestSha256,
};
writeFileSync(join(workspace, "apex-swe-dev-one-task-qualify-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`ok one_task=${one[0]} conforming not-ready judged=${cells[0].passed}\n`);
