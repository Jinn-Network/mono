#!/usr/bin/env node
/**
 * Fail-closed operator qualify for DeepSWE v1.1 one_task on the git pin.
 * Default `yarn test` does not run this. It never clones the 113-task tree.
 *
 * See docs/runbooks/deepswe-v1.1-official-one-task.md.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const colophonBin = join(packageRoot, "dist", "cli", "bin.js");
const draftId = "deepswe-one";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

if (process.env.COLOPHON_DEEPSWE_ONE_TASK_QUALIFY !== "1") {
  fail("Refusing: set COLOPHON_DEEPSWE_ONE_TASK_QUALIFY=1 and supply operator paths. See docs/runbooks/deepswe-v1.1-official-one-task.md. This script never downloads DeepSWE v1.1.");
}

const {
  DEEP_SWE_V11_GIT_SHA,
  DEEPSWE_CLOSED_SUBMIT_SENTENCE,
  DEEPSWE_NOT_LEADERBOARD_READY_LIMITATION,
  harborImagePinMatchesTaskToml,
  namedSliceTaskNames,
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

const pier = realpathSync(requiredEnv("COLOPHON_DEEPSWE_PIER"));
const taskMaterialPath = realpathSync(requiredEnv("COLOPHON_DEEPSWE_TASK_MATERIAL"));
const image = requiredEnv("COLOPHON_DEEPSWE_IMAGE");
const model = requiredEnv("COLOPHON_DEEPSWE_MODEL");
const workspace = process.env.COLOPHON_DEEPSWE_WORKSPACE?.trim() || "/tmp/colophon-deepswe-one-task";
if (!/@sha256:[a-f0-9]{64}$/u.test(image)) fail("COLOPHON_DEEPSWE_IMAGE must be repo@sha256:<64 hex>");
if (existsSync(join(workspace, "workspace.json"))) fail(`${workspace} is already a Colophon workspace; pick a new COLOPHON_DEEPSWE_WORKSPACE`);

const version = (await run(pier, ["--version"])).trim();
if (!/^(?:pier\s+)?0\.3\.1(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
  fail(`Pier must be 0.3.1.x; got ${version}`);
}

const taskNames = readdirSync(taskMaterialPath, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(taskMaterialPath, entry.name, "task.toml")))
  .map((entry) => entry.name);
if (taskNames.length === 0) fail("COLOPHON_DEEPSWE_TASK_MATERIAL must contain at least one task directory with task.toml");
const slice = namedSliceTaskNames(taskNames, "one_task");
const taskName = slice[0];
const taskRoot = join(taskMaterialPath, taskName);
const toml = readFileSync(join(taskRoot, "task.toml"), "utf8");
const taskImage = /^\s*docker_image\s*=\s*["']([^"']+)["']/mu.exec(toml)?.[1];
if (!harborImagePinMatchesTaskToml(taskImage, image)) {
  fail(`task.toml docker_image ${taskImage} does not match COLOPHON_DEEPSWE_IMAGE ${image}`);
}

mkdirSync(workspace, { recursive: true });
const selectionPath = join(workspace, "selection.json");
writeFileSync(selectionPath, `${JSON.stringify({
  executable: pier,
  gitSha: DEEP_SWE_V11_GIT_SHA,
  taskMaterialPath,
  coverage: "one_task",
  nConcurrent: 1,
  arms: [
    { armId: "mini-a", agent: { id: "mini-swe-agent", configuration: {} }, model: { id: model, configuration: {} }, jobAgent: { name: "mini-swe-agent", model_name: model } },
    { armId: "mini-b", agent: { id: "mini-swe-agent", configuration: {} }, model: { id: model, configuration: {} }, jobAgent: { name: "mini-swe-agent", model_name: model } },
  ],
  environment: { type: "docker", image, configuration: {} },
  outputs: [{
    name: "prediction",
    mediaType: "application/json",
    artifact: { source: "/logs/artifacts/prediction.json", destination: "prediction.json" },
    nativePath: "artifacts/prediction.json",
  }],
}, null, 2)}\n`);

const common = ["--workspace", workspace, "--principal", "operator"];
await colophon(["init", ...common]);
await colophon(["draft", "create", ...common, "--name", "DeepSWE v1.1 one_task pin", "--id", draftId]);
await colophon(["arm", "add", ...common, "--draft", draftId, "--arm", "mini-a", "--pinning", JSON.stringify({ harness: { id: "pier-mini-a", version: "1.0.0" } })]);
await colophon(["arm", "add", ...common, "--draft", draftId, "--arm", "mini-b", "--pinning", JSON.stringify({ harness: { id: "pier-mini-b", version: "1.0.0" } })]);
const selected = parseEnvelope(await colophon(["runtime", "deep-swe-v1.1", "select", ...common, "--draft", draftId, "--file", selectionPath, "--json"]));
const quoted = parseEnvelope(await colophon(["quote", ...common, "--draft", draftId, "--json"]));
const suite = quoted.presentation?.suite;
if (suite?.executionConformance !== true || suite?.coverage !== "one_task" || suite?.leaderboardSubmitReady !== false || suite?.replicates !== 4) {
  fail(`quote suite bits were not one_task/conforming/k=4/not-leaderboard-ready: ${JSON.stringify(suite)}`);
}
await colophon(["lock", ...common, "--draft", draftId]);
await colophon(["launch", ...common, "--draft", draftId]);
await colophon(["collect", ...common, "--draft", draftId, "--json"]);
const exportA = parseEnvelope(await colophon(["deepswe", "export", ...common, "--draft", draftId, "--arm", "mini-a", "--json"]));
const exportB = parseEnvelope(await colophon(["deepswe", "export", ...common, "--draft", draftId, "--arm", "mini-b", "--json"]));
const reported = parseEnvelope(await colophon(["report", ...common, "--draft", draftId, "--json"]));
if (!Array.isArray(reported.claimPackage?.limitations) || !reported.claimPackage.limitations.includes(DEEPSWE_NOT_LEADERBOARD_READY_LIMITATION)) {
  fail("report limitations missing the canonical DeepSWE not-leaderboard sentence");
}

const runState = JSON.parse(readFileSync(join(workspace, "runs", `${draftId}.json`), "utf8"));
const runSha256 = runState.runSha256;
const mappingDir = join(workspace, "artifacts", "harbor", "mappings", "by-dispatch");
const mappingCount = existsSync(mappingDir) ? readdirSync(mappingDir).length : 0;
const plannedA = `jinn-${runSha256.slice(0, 24)}-mini-a`;
const plannedB = `jinn-${runSha256.slice(0, 24)}-mini-b`;
const jobA = join(workspace, "artifacts", "harbor", "jobs", runSha256, plannedA);
const jobConfig = JSON.parse(readFileSync(join(jobA, "config.json"), "utf8"));
if (jobConfig.n_attempts !== 4 || jobConfig.retry?.max_retries !== 3) {
  fail(`planned JobConfig was not n_attempts=4 max_retries=3: ${JSON.stringify({ n_attempts: jobConfig.n_attempts, retry: jobConfig.retry })}`);
}
if (jobConfig.agents?.[0]?.name !== "mini-swe-agent") {
  fail(`planned JobConfig agent was not mini-swe-agent: ${JSON.stringify(jobConfig.agents)}`);
}
if ((jobConfig.n_concurrent_trials ?? 1) !== 1) {
  fail(`planned JobConfig n_concurrent_trials was not 1: ${jobConfig.n_concurrent_trials}`);
}
if (!Array.isArray(jobConfig.datasets?.[0]?.task_names) || jobConfig.datasets[0].task_names.join() !== taskName) {
  fail(`planned JobConfig task_names were not [${taskName}]`);
}
const executableSha256 = createHash("sha256").update(readFileSync(pier)).digest("hex");

if (exportA.mode !== "inspection" || exportB.mode !== "inspection") {
  fail(`DeepSWE export mode was not inspection: ${exportA.mode} / ${exportB.mode}`);
}
if (!exportA.jobDir.endsWith(plannedA) || !exportB.jobDir.endsWith(plannedB)) {
  fail(`DeepSWE jobDir was not the planned job: ${exportA.jobDir} ${exportB.jobDir}`);
}
if (!exportA.instructions.includes(DEEPSWE_CLOSED_SUBMIT_SENTENCE) || exportA.instructions.includes("lb submit")) {
  fail("DeepSWE instructions missing Datacurve closed-submit sentence or mentioned Hub lb submit");
}

const receipt = {
  pierVersion: version.replace(/^pier\s+/iu, ""),
  executableSha256,
  gitSha: DEEP_SWE_V11_GIT_SHA,
  selectedTaskName: taskName,
  quote: suite,
  jobConfig: {
    n_attempts: jobConfig.n_attempts,
    max_retries: jobConfig.retry?.max_retries,
    n_concurrent_trials: jobConfig.n_concurrent_trials,
    task_names: jobConfig.datasets?.[0]?.task_names,
    agent: jobConfig.agents?.[0]?.name,
  },
  mappingCount,
  export: {
    miniA: { mode: exportA.mode, jobDir: exportA.jobDir },
    miniB: { mode: exportB.mode, jobDir: exportB.jobDir },
  },
  reportSha256: reported.reportSha256,
  reportLimitations: reported.claimPackage.limitations,
  notLeaderboardLimitation: DEEPSWE_NOT_LEADERBOARD_READY_LIMITATION,
  selectionManifestSha256: selected.selectionManifestSha256,
};
const receiptPath = join(workspace, "deepswe-v1.1-one-task-qualify-receipt.json");
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, receiptPath, receipt }, null, 2)}\n`);
