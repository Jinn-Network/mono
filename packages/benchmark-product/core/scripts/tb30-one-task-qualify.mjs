#!/usr/bin/env node
/**
 * Fail-closed operator qualify for Terminal-Bench 3.0 one_task on the Hub pin.
 * Default `yarn test` does not run this. It never downloads the dataset.
 *
 * See docs/runbooks/tb30-official-one-task.md.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const colophonBin = join(packageRoot, "dist", "cli", "bin.js");
const draftId = "tb30-one";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

if (process.env.COLOPHON_TB30_ONE_TASK_QUALIFY !== "1") {
  fail("Refusing: set COLOPHON_TB30_ONE_TASK_QUALIFY=1 and supply operator paths. See docs/runbooks/tb30-official-one-task.md. This script never downloads Terminal-Bench 3.0.");
}

// Before the dynamic import — an unbuilt tree must get this message and exit 2, not
// ERR_MODULE_NOT_FOUND from `../dist/index.js`.
if (!existsSync(colophonBin)) fail("build the core package first: yarn --cwd packages/benchmark-product/core build");

const {
  COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE,
  SUITE_NOT_LEADERBOARD_READY_LIMITATION_3_0,
  TERMINAL_BENCH_3_0_DATASET_REF,
  computeHarbor021TaskContentHash,
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
      env: { ...process.env, HARBOR_TELEMETRY: "0", DO_NOT_TRACK: "1" },
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

const harbor = realpathSync(requiredEnv("COLOPHON_TB30_HARBOR"));
const registryMetadataPath = realpathSync(requiredEnv("COLOPHON_TB30_REGISTRY_METADATA"));
const taskMaterialPath = realpathSync(requiredEnv("COLOPHON_TB30_TASK_MATERIAL"));
const image = requiredEnv("COLOPHON_TB30_IMAGE");
const workspace = process.env.COLOPHON_TB30_WORKSPACE?.trim() || "/tmp/colophon-tb30-one-task";
if (!/@sha256:[a-f0-9]{64}$/u.test(image)) fail("COLOPHON_TB30_IMAGE must be repo@sha256:<64 hex>");
if (existsSync(join(workspace, "workspace.json"))) fail(`${workspace} is already a Colophon workspace; pick a new COLOPHON_TB30_WORKSPACE`);

const version = (await run(harbor, ["--version"])).trim();
if (!/^harbor\s+0\.21\.\d+/u.test(version) && !/^0\.21\.\d+/u.test(version)) {
  fail(`Harbor must be 0.21.x; got ${version}`);
}

const metadata = JSON.parse(readFileSync(registryMetadataPath, "utf8"));
if (metadata.dataset_version_content_hash.replace(/^sha256:/u, "") !== TERMINAL_BENCH_3_0_DATASET_REF.slice("sha256:".length)) {
  fail("registry snapshot is not TERMINAL_BENCH_3_0_DATASET_REF");
}
const slice = namedSliceTaskNames(metadata.task_ids.map((task) => task.name), "one_task");
const taskName = slice[0];
const taskRoot = join(taskMaterialPath, taskName);
const toml = readFileSync(join(taskRoot, "task.toml"), "utf8");
const taskImage = /^\s*docker_image\s*=\s*["']([^"']+)["']/mu.exec(toml)?.[1];
if (!harborImagePinMatchesTaskToml(taskImage, image)) {
  fail(`task.toml docker_image ${taskImage} does not match COLOPHON_TB30_IMAGE ${image}`);
}
const packageHash = `sha256:${computeHarbor021TaskContentHash(taskRoot).contentHash}`;
const registryRef = metadata.task_ids.find((task) => task.name === taskName)?.ref;
if (packageHash !== registryRef) fail(`Packager hash ${packageHash} does not equal registry ref ${registryRef}`);

mkdirSync(workspace, { recursive: true });
const selectionPath = join(workspace, "selection.json");
writeFileSync(selectionPath, `${JSON.stringify({
  executable: harbor,
  registryMetadataPath,
  datasetRevision: TERMINAL_BENCH_3_0_DATASET_REF,
  taskMaterialPath,
  coverage: "one_task",
  nConcurrent: 1,
  arms: [
    { armId: "oracle-a", agent: { id: "oracle", configuration: {} }, model: { id: "oracle-a", configuration: {} }, jobAgent: { name: "oracle", model_name: "oracle-a" } },
    { armId: "oracle-b", agent: { id: "oracle", configuration: {} }, model: { id: "oracle-b", configuration: {} }, jobAgent: { name: "oracle", model_name: "oracle-b" } },
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
await colophon(["draft", "create", ...common, "--name", "TB30 one_task pin", "--id", draftId]);
await colophon(["arm", "add", ...common, "--draft", draftId, "--arm", "oracle-a", "--pinning", JSON.stringify({ harness: { id: "harbor-oracle-a", version: "1.0.0" } })]);
await colophon(["arm", "add", ...common, "--draft", draftId, "--arm", "oracle-b", "--pinning", JSON.stringify({ harness: { id: "harbor-oracle-b", version: "1.0.0" } })]);
const selected = parseEnvelope(await colophon(["runtime", "terminal-bench-3-0", "select", ...common, "--draft", draftId, "--file", selectionPath, "--json"]));
const quoted = parseEnvelope(await colophon(["quote", ...common, "--draft", draftId, "--json"]));
const suite = quoted.presentation?.suite;
if (suite?.protocol !== "terminal-bench-3.0" || suite?.executionConformance !== true || suite?.coverage !== "one_task" || suite?.leaderboardSubmitReady !== false) {
  fail(`quote suite bits were not 3.0/one_task/conforming/not-leaderboard-ready: ${JSON.stringify(suite)}`);
}
await colophon(["lock", ...common, "--draft", draftId]);
await colophon(["launch", ...common, "--draft", draftId]);
await colophon(["collect", ...common, "--draft", draftId, "--json"]);
const exportA = parseEnvelope(await colophon(["hub", "export", ...common, "--draft", draftId, "--arm", "oracle-a", "--json"]));
const exportB = parseEnvelope(await colophon(["hub", "export", ...common, "--draft", draftId, "--arm", "oracle-b", "--json"]));
const reported = parseEnvelope(await colophon(["report", ...common, "--draft", draftId, "--json"]));
if (!Array.isArray(reported.claimPackage?.limitations) || !reported.claimPackage.limitations.includes(SUITE_NOT_LEADERBOARD_READY_LIMITATION_3_0)) {
  fail("report limitations missing the canonical Terminal-Bench 3.0 not-leaderboard sentence");
}

const runState = JSON.parse(readFileSync(join(workspace, "runs", `${draftId}.json`), "utf8"));
const runSha256 = runState.runSha256;
const mappingDir = join(workspace, "artifacts", "harbor", "mappings", "by-dispatch");
const mappingCount = existsSync(mappingDir) ? readdirSync(mappingDir).length : 0;
const plannedA = `jinn-${runSha256.slice(0, 24)}-oracle-a`;
const plannedB = `jinn-${runSha256.slice(0, 24)}-oracle-b`;
const jobA = join(workspace, "artifacts", "harbor", "jobs", runSha256, plannedA);
const jobConfig = JSON.parse(readFileSync(join(jobA, "config.json"), "utf8"));
if (jobConfig.n_attempts !== 5 || jobConfig.retry?.max_retries !== 3) {
  fail(`planned JobConfig was not n_attempts=5 max_retries=3: ${JSON.stringify({ n_attempts: jobConfig.n_attempts, retry: jobConfig.retry })}`);
}
if ((jobConfig.n_concurrent_trials ?? 1) !== 1) {
  fail(`planned JobConfig n_concurrent_trials was not 1: ${jobConfig.n_concurrent_trials}`);
}
if (!Array.isArray(jobConfig.datasets?.[0]?.task_names) || jobConfig.datasets[0].task_names.join() !== taskName) {
  fail(`planned JobConfig task_names were not [${taskName}]`);
}
const executableSha256 = createHash("sha256").update(readFileSync(harbor)).digest("hex");
const registrySnapshotSha256 = createHash("sha256").update(readFileSync(registryMetadataPath)).digest("hex");

if (exportA.mode !== "inspection-upload" || exportB.mode !== "inspection-upload") {
  fail(`Hub export mode was not inspection-upload: ${exportA.mode} / ${exportB.mode}`);
}
if (!exportA.jobDir.endsWith(plannedA) || !exportB.jobDir.endsWith(plannedB)) {
  fail(`Hub jobDir was not the planned job: ${exportA.jobDir} ${exportB.jobDir}`);
}
if (exportA.instructions.includes(COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE) || exportA.instructions.includes("uv run lb submit")) {
  fail("Hub instructions must not copy Terminal-Bench 2.1 closed-submissions or lb submit copy");
}
if (!exportA.instructions.includes("harbor upload")) {
  fail("Hub instructions missing harbor upload");
}

const receipt = {
  harborVersion: version.replace(/^harbor\s+/iu, ""),
  executableSha256,
  registrySnapshotSha256,
  datasetTaskCount: metadata.task_ids.length,
  selectedTaskName: taskName,
  packagerRef: packageHash,
  quote: suite,
  jobConfig: {
    n_attempts: jobConfig.n_attempts,
    max_retries: jobConfig.retry?.max_retries,
    n_concurrent_trials: jobConfig.n_concurrent_trials,
    task_names: jobConfig.datasets?.[0]?.task_names,
  },
  mappingCount,
  hub: {
    oracleA: { mode: exportA.mode, jobDir: exportA.jobDir },
    oracleB: { mode: exportB.mode, jobDir: exportB.jobDir },
  },
  reportSha256: reported.reportSha256,
  reportLimitations: reported.claimPackage.limitations,
  notLeaderboardLimitation: SUITE_NOT_LEADERBOARD_READY_LIMITATION_3_0,
  selectionManifestSha256: selected.selectionManifestSha256,
};
const receiptPath = join(workspace, "tb30-one-task-qualify-receipt.json");
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, receiptPath, receipt }, null, 2)}\n`);
