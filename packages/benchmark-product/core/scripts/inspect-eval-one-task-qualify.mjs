#!/usr/bin/env node
/**
 * Fail-closed operator qualify for Inspect eval one_task on the in-repo hermetic Task.
 * Default `yarn test` does not run this. It never downloads GAIA, Cybench, or inspect_evals.
 *
 * See docs/runbooks/inspect-eval-one-task.md.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const colophonBin = join(packageRoot, "dist", "cli", "bin.js");
const fixtureProject = join(packageRoot, "test", "fixtures", "inspect-project");
const draftId = "inspect-one";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

if (process.env.COLOPHON_INSPECT_EVAL_ONE_TASK_QUALIFY !== "1") {
  fail("Refusing: set COLOPHON_INSPECT_EVAL_ONE_TASK_QUALIFY=1 and supply operator Python. See docs/runbooks/inspect-eval-one-task.md. This script never downloads Inspect eval datasets.");
}

const {
  INSPECT_EVAL_NOT_LEADERBOARD_READY_LIMITATION,
  INSPECT_EVAL_SUBMIT_CLOSED_SENTENCE,
  officialInspectEvalConformance,
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
      env: { ...process.env, DO_NOT_TRACK: "1" },
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
if (!existsSync(join(fixtureProject, "hermetic_eval.py"))) {
  fail(`missing in-repo Inspect fixture at ${fixtureProject}`);
}

const python = realpathSync(
  process.env.COLOPHON_INSPECT_PYTHON?.trim()
    || process.env.JINN_INSPECT_PYTHON?.trim()
    || requiredEnv("COLOPHON_INSPECT_PYTHON"),
);
const workspace = process.env.COLOPHON_INSPECT_EVAL_WORKSPACE?.trim()
  || "/tmp/colophon-inspect-eval-one-task";
if (existsSync(join(workspace, "workspace.json"))) {
  fail(`${workspace} is already a Colophon workspace; pick a new COLOPHON_INSPECT_EVAL_WORKSPACE`);
}

const inspectVersion = (await run(python, ["-c", "import inspect_ai; print(inspect_ai.__version__)"])).trim();
if (inspectVersion !== "0.3.255") {
  fail(`inspect-ai must be 0.3.255; got ${inspectVersion}`);
}

mkdirSync(workspace, { recursive: true });
const selectionPath = join(workspace, "selection.json");
writeFileSync(selectionPath, `${JSON.stringify({
  pythonPath: python,
  projectDir: fixtureProject,
  taskReference: "hermetic_eval.py@hermetic_eval",
  coverage: "one_task",
  arms: [
    { armId: "control", model: "mockllm/model" },
    { armId: "candidate", model: "mockllm/model" },
  ],
  scorer: { name: "match", passValue: "C" },
}, null, 2)}\n`);

const common = ["--workspace", workspace, "--principal", "operator"];
await colophon(["init", ...common]);
await colophon(["draft", "create", ...common, "--name", "Inspect eval one_task", "--id", draftId]);
const selected = parseEnvelope(await colophon([
  "runtime", "inspect", "eval", "select", ...common, "--draft", draftId, "--file", selectionPath, "--json",
]));
const quoted = parseEnvelope(await colophon(["quote", ...common, "--draft", draftId, "--json"]));
const suite = quoted.presentation?.suite;
if (suite?.executionConformance !== true || suite?.coverage !== "one_task" || suite?.leaderboardSubmitReady !== false) {
  fail(`quote suite bits were not one_task/conforming/not-leaderboard-ready: ${JSON.stringify(suite)}`);
}
if (suite?.cellCount !== "1 × 2 × 1") {
  fail(`quote cellCount was not 1 × 2 × 1: ${suite?.cellCount}`);
}
if (!officialInspectEvalConformance({
  k: suite.replicates,
  specifiedEpochs: suite.replicates,
  inspectVersion: suite.inspectVersion,
  adapterId: "inspect",
  solver: "task-default",
  sampleLimit: null,
  epochsInRunOptions: false,
})) {
  fail(`officialInspectEvalConformance was false: ${JSON.stringify(suite)}`);
}
await colophon(["lock", ...common, "--draft", draftId]);
await colophon(["launch", ...common, "--draft", draftId]);
await colophon(["collect", ...common, "--draft", draftId, "--json"]);
const exportControl = parseEnvelope(await colophon([
  "runtime", "inspect", "eval", "export", ...common, "--draft", draftId, "--arm", "control", "--json",
]));
const exportCandidate = parseEnvelope(await colophon([
  "runtime", "inspect", "eval", "export", ...common, "--draft", draftId, "--arm", "candidate", "--json",
]));
const reported = parseEnvelope(await colophon(["report", ...common, "--draft", draftId, "--json"]));
if (!Array.isArray(reported.claimPackage?.limitations)
  || !reported.claimPackage.limitations.includes(INSPECT_EVAL_NOT_LEADERBOARD_READY_LIMITATION)) {
  fail("report limitations missing the canonical Inspect eval not-ready sentence");
}
if (exportControl.mode !== "inspection-upload" || exportCandidate.mode !== "inspection-upload") {
  fail(`View export mode was not inspection-upload: ${exportControl.mode} / ${exportCandidate.mode}`);
}
if (!exportControl.instructions.includes(INSPECT_EVAL_SUBMIT_CLOSED_SENTENCE)) {
  fail("View export instructions missing Inspect Hub closed sentence");
}

const runState = JSON.parse(readFileSync(join(workspace, "runs", `${draftId}.json`), "utf8"));
const receipt = {
  inspectVersion,
  pythonPath: python,
  fixtureProject,
  selectedSample: "alpha",
  quote: suite,
  view: {
    control: { mode: exportControl.mode, exportDir: exportControl.exportDir, logCount: exportControl.logCount },
    candidate: { mode: exportCandidate.mode, exportDir: exportCandidate.exportDir, logCount: exportCandidate.logCount },
  },
  reportSha256: reported.reportSha256,
  reportLimitations: reported.claimPackage.limitations,
  notLeaderboardLimitation: INSPECT_EVAL_NOT_LEADERBOARD_READY_LIMITATION,
  submitClosedSentence: INSPECT_EVAL_SUBMIT_CLOSED_SENTENCE,
  selectionManifestSha256: selected.selectionManifestSha256,
  runSha256: runState.runSha256,
};
const receiptPath = join(workspace, "inspect-eval-one-task-qualify-receipt.json");
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, receiptPath, receipt }, null, 2)}\n`);
