/**
 * Test fixture: runs bound to each official suite protocol, driven through the production
 * operations up to `collect`, so a test can report and publish them (issues #4759, #4761, #4762).
 *
 * Terminal-Bench 2.1, Terminal-Bench 3.0 and DeepSWE v1.1 are launched against a fake Harbor or
 * Pier that writes a real-shaped jobs directory (trial `config.json`, ATIF files, `reward.json`).
 * SWE-bench Verified, APEX-Agents, APEX-SWE-dev and Inspect eval are brought with `run import`,
 * because their launchers need the real harness; a test writes the harness reports or grades core
 * reads where core reads them. Every selection is sealed by the same fixture drafts the runtime
 * tests use, with fake executables that answer the version probes.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectedCellSet, parseBenchmark, parseRun } from "@jinn-network/benchmarking-records";
import type { ExternalRunRecord } from "../../intake/external-run-records.js";
import { armAdd } from "../../operations/arms.js";
import type { OperationContext } from "../../operations/context.js";
import { createDraft, readDraftDocument } from "../../operations/drafts.js";
import { initWorkspace } from "../../operations/init.js";
import { selectInspectEvalRuntime } from "../../operations/inspect-eval.js";
import { runCollect } from "../../operations/run-collect.js";
import { importRunRecords } from "../../operations/run-import.js";
import { runLaunch } from "../../operations/run-launch.js";
import { runLock } from "../../operations/run-lock.js";
import { runQuote } from "../../operations/run-quote.js";
import type { OperationResult } from "../../operations/result.js";
import { readRunState } from "../../run/state.js";
import { APEX_AGENTS_DATASET_ID, APEX_AGENTS_DATASET_REVISION } from "../../runtime/apex-agents/manifest.js";
import { APEX_SWE_DEV_DATASET_ID, APEX_SWE_DEV_DATASET_REVISION } from "../../runtime/apex-swe-dev/manifest.js";
import { DEEP_SWE_V11_GIT_SHA } from "../../runtime/deep-swe-v1.1/manifest.js";
import type { HarborSelectionManifest } from "../../runtime/harbor/manifest.js";
import { createDefaultBenchmarkRuntimeHost } from "../../runtime/host-port.js";
import { harborArmJobsDir } from "../../runtime/harbor/arm-job.js";
import { harborArmJobName } from "../../runtime/harbor/launcher.js";
import {
  INSPECT_SELECTION_SCHEMA,
  InspectSelectionManifestSchema,
  SUPPORTED_INSPECT_VERSION,
  SUPPORTED_INSPECT_WHEEL_SHA256,
} from "../../runtime/inspect/manifest.js";
import { SWE_BENCH_VERIFIED_DATASET_ID, SWE_BENCH_VERIFIED_DATASET_REVISION } from "../../runtime/swe-bench-verified/manifest.js";
import { ARCHIPELAGO_COMMIT_PIN } from "../../runtime/suite-protocol/comparability.js";
import { computeHarbor021TaskContentHash } from "../../runtime/terminal-bench-2/host.js";
import { officialTerminalBench21TaskNames } from "../../intake/terminal-bench-2-1.js";
import { TERMINAL_BENCH_2_1_DATASET_ID, TERMINAL_BENCH_2_1_DATASET_REF } from "../../runtime/terminal-bench-2-1/manifest.js";
import {
  TERMINAL_BENCH_3_0_DATASET_ID,
  TERMINAL_BENCH_3_0_DATASET_REF,
  TERMINAL_BENCH_3_0_HUB_VERSION,
} from "../../runtime/terminal-bench-3-0/manifest.js";
import { prepareApexAgentsDraft } from "../../runtime/testing/apex-agents-draft.js";
import { prepareApexSweDevDraft } from "../../runtime/testing/apex-swe-dev-draft.js";
import { prepareDeepSweV11Draft } from "../../runtime/testing/deep-swe-v1.1-draft.js";
import { prepareSwebenchVerifiedDraft } from "../../runtime/testing/swe-bench-verified-draft.js";
import { prepareTerminalBench21Draft } from "../../runtime/testing/terminal-bench-2-1-draft.js";
import { prepareTerminalBench30Draft } from "../../runtime/testing/terminal-bench-3-0-draft.js";
import type { LocalVenue } from "../../venue/venue.js";
import { getSealedBytes } from "../../workspace/sealed-store.js";

export const SUITE_RUN_DRAFT_ID = "suite-run";

export interface SuiteRun {
  readonly context: OperationContext;
  readonly workspaceDir: string;
  readonly draftId: string;
}

function ok<T>(operation: string, result: OperationResult<T>): T {
  if (!result.ok) throw new Error(`${operation} refused: ${JSON.stringify(result.error)}`);
  return result.result;
}

function executable(path: string, body: string): string {
  writeFileSync(path, body, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

/** Wall-clock time: a launched run's dispatch deadlines are measured against it. */
function clock(): () => string {
  return () => new Date().toISOString();
}

function workspace(root: string, armIds: readonly string[]): SuiteRun {
  const workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  const context: OperationContext = { workspaceDir, principal: "sponsor-1", clock: clock() };
  ok("initWorkspace", initWorkspace(context));
  ok("createDraft", createDraft(context, { draftId: SUITE_RUN_DRAFT_ID, name: "suite-bound run" }));
  for (const armId of armIds) {
    ok(`armAdd ${armId}`, armAdd(context, {
      draftId: SUITE_RUN_DRAFT_ID,
      armId,
      pinning: { harness: { id: "placeholder", version: "1" } },
    }));
  }
  return { context, workspaceDir, draftId: SUITE_RUN_DRAFT_ID };
}

// ── Harbor and Pier ───────────────────────────────────────────────────────────────────────────

/** A fake batched Harbor (or Pier) that writes one trial per task and attempt, each with ATIF files
 * and, when asked, a `verifier/reward.json`.
 *
 * The Harbor fake writes each trial as Harbor 0.21.0 does (#5245; see the committed record in
 * `test/fixtures/harbor-0.21-jobs-terminal-bench-2-1`): a directory named `<task>__<seven
 * characters>`, and a `config.json` that numbers no attempt, names the local task by its absolute
 * path, and records `trials_dir`, the jobs directory it was given plus the job name. A driven run
 * gives it a jobs directory inside the workspace, so those configs name the private workspace. */
function fakeBatchedHarbor(root: string, name: "harbor" | "pier", version: string, writeRewardJson: boolean): string {
  const harbor021 = name === "harbor";
  return executable(join(root, name), `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version" && args.length === 1) { process.stdout.write("${name} ${version}\\n"); process.exit(0); }
if (args[0] !== "run" || args[1] !== "-c" || args.length !== 3) process.exit(64);
const config = JSON.parse(readFileSync(args[2], "utf8"));
const names = config.datasets[0].task_names;
for (const taskName of names) {
  if (!existsSync(join(process.cwd(), config.datasets[0].path, taskName, "task.toml"))) throw new Error("unstaged DatasetConfig");
}
const job = join(config.jobs_dir, config.job_name);
mkdirSync(job, { recursive: true });
writeFileSync(join(job, "config.json"), JSON.stringify(config));
const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
let index = 0;
for (const taskName of names) {
  for (let attempt = 1; attempt <= config.n_attempts; attempt++) {
    index += 1;
    const trialName = ${harbor021
      ? 'taskName + "__" + createHash("sha256").update(config.job_name + ":" + index).digest("hex").slice(0, 7)'
      : '"trial-" + index'};
    const trial = join(job, trialName);
    mkdirSync(join(trial, "agent"), { recursive: true });
    mkdirSync(join(trial, "verifier"), { recursive: true });
    mkdirSync(join(trial, "artifacts"), { recursive: true });
    writeFileSync(join(trial, "config.json"), ${harbor021
      ? `JSON.stringify({
      task: { path: join(process.cwd(), config.datasets[0].path, taskName), source: "local" },
      trial_name: trialName,
      trials_dir: job,
      agent: config.agents[0],
      job_id: config.job_name,
    }, null, 4)`
      : "JSON.stringify({ task: { name: taskName }, attempt, agent: config.agents[0] })"});
    sleep(50);
    writeFileSync(join(trial, "result.json"), JSON.stringify({ id: "trial-" + index, status: "success", finished_at: new Date().toISOString() }));
    writeFileSync(join(trial, "agent", "recording.cast"), Buffer.from([0, 255, 1]));
    writeFileSync(join(trial, "agent", "trajectory.json"), JSON.stringify({ schema: "ATIF", attempt }));
    writeFileSync(join(trial, "verifier", "reward.txt"), "1\\n");
    writeFileSync(join(trial, "ctrf.json"), JSON.stringify({ results: [] }));
    ${writeRewardJson ? 'writeFileSync(join(trial, "verifier", "reward.json"), JSON.stringify({ reward: 1 }));' : ""}
    writeFileSync(join(trial, "artifacts", "manifest.json"), JSON.stringify({ files: ["prediction.json"] }));
    writeFileSync(join(trial, "artifacts", "prediction.json"), JSON.stringify({
      probabilityYes: "1.0",
      submittedAt: "2026-01-01T00:00:00Z",
      replicate: attempt,
      arm: config.agents[0].model_name,
    }));
  }
}
writeFileSync(join(job, "result.json"), JSON.stringify({
  id: config.job_name, status: "success", finished_at: new Date().toISOString(), n_total_trials: index, stats: { n_retries: 0 },
}));
process.stdout.write("fake ${name} completed\\n");
`);
}

const IMAGE = `registry.example/suite@sha256:${"c".repeat(64)}`;
const OUTPUTS: HarborSelectionManifest["outputs"] = [{
  name: "result",
  mediaType: "application/json",
  artifact: { source: "/logs/artifacts/prediction.json", destination: "prediction.json" },
  nativePath: "artifacts/prediction.json",
}];

function harborArms(agent: string): HarborSelectionManifest["arms"] {
  return [
    { armId: "one", agent: { id: agent, configuration: {} }, model: { id: "openai/model-one", configuration: {} }, jobAgent: { name: agent, model_name: "openai/model-one" } },
    { armId: "two", agent: { id: agent, configuration: {} }, model: { id: "openai/model-two", configuration: {} }, jobAgent: { name: agent, model_name: "openai/model-two" } },
  ];
}

function writeTaskMaterial(materialPath: string, names: readonly string[]): void {
  for (const name of names) {
    mkdirSync(join(materialPath, name), { recursive: true });
    writeFileSync(join(materialPath, name, "task.toml"), `[task]\nname = "${name}"\n[environment]\ndocker_image = "${IMAGE}"\n`);
    writeFileSync(join(materialPath, name, "instruction.md"), `solve ${name}\n`);
  }
}

/** Seals a Terminal-Bench 2.1 or 3.0 selection over a one-task registry snapshot, as its full
 * official dataset (the leaderboard pins the revision, not the size), so the method is
 * leaderboard-eligible. */
async function prepareTerminalBenchRun(protocol: "terminal-bench-2.1" | "terminal-bench-3.0", root: string): Promise<SuiteRun> {
  const run = workspace(root, ["one", "two"]);
  const materialPath = join(root, "tasks");
  // Terminal-Bench 2.1 selects from its official slate by name; the material is the fixture's own.
  const names = protocol === "terminal-bench-2.1" ? [officialTerminalBench21TaskNames()[0]!] : ["task-alpha"];
  writeTaskMaterial(materialPath, names);
  const harbor = fakeBatchedHarbor(root, "harbor", "0.21.4", false);
  const metadataPath = join(root, "dataset-metadata.json");
  const terminalBench21 = protocol === "terminal-bench-2.1";
  writeFileSync(metadataPath, JSON.stringify({
    name: terminalBench21 ? TERMINAL_BENCH_2_1_DATASET_ID : TERMINAL_BENCH_3_0_DATASET_ID,
    ...(terminalBench21 ? {} : { version: TERMINAL_BENCH_3_0_HUB_VERSION }),
    dataset_version_content_hash: terminalBench21 ? TERMINAL_BENCH_2_1_DATASET_REF : TERMINAL_BENCH_3_0_DATASET_REF,
    task_ids: names.map((name) => ({
      org: "terminal-bench",
      name,
      ref: `sha256:${computeHarbor021TaskContentHash(join(materialPath, name)).contentHash}`,
    })),
  }));
  const request = {
    draftId: run.draftId,
    executable: harbor,
    registryMetadataPath: metadataPath,
    taskMaterialPath: materialPath,
    nConcurrent: 1,
    arms: harborArms("terminus"),
    environment: { type: "docker" as const, image: IMAGE, configuration: {} },
    outputs: OUTPUTS,
    coverage: "full" as const,
  };
  if (terminalBench21) {
    ok("prepareTerminalBench21Draft", await prepareTerminalBench21Draft(run.context, { ...request, datasetRevision: TERMINAL_BENCH_2_1_DATASET_REF }));
  } else {
    ok("prepareTerminalBench30Draft", await prepareTerminalBench30Draft(run.context, { ...request, datasetRevision: TERMINAL_BENCH_3_0_DATASET_REF }));
  }
  ok("runQuote", await runQuote(run.context, { draftId: run.draftId }));
  ok("runLock", runLock(run.context, { draftId: run.draftId }));
  return run;
}

/**
 * A run bound to Terminal-Bench 2.1 or DeepSWE v1.1, launched against the fake Harbor or Pier and
 * collected. The fake's trials are accounted unscorable (no verifier verdict), so no judged cell
 * asks for ATIF. DeepSWE v1.1 pins its 113-task tree, which a fixture cannot reproduce, so it
 * locks one task and is never eligible.
 */
export async function launchedHarborSuiteRun(
  protocol: "terminal-bench-2.1" | "deep-swe-v1.1",
  root: string,
): Promise<SuiteRun> {
  if (protocol === "terminal-bench-2.1") {
    const run = await prepareTerminalBenchRun(protocol, root);
    ok("runLaunch", await runLaunch(run.context, { draftId: run.draftId }));
    ok("runCollect", await runCollect(run.context, { draftId: run.draftId }));
    return run;
  }
  const run = workspace(root, ["one", "two"]);
  const materialPath = join(root, "tasks");
  writeTaskMaterial(materialPath, ["task-alpha"]);
  const pier = fakeBatchedHarbor(root, "pier", "0.3.1", true);
  ok("prepareDeepSweV11Draft", await prepareDeepSweV11Draft(run.context, {
    draftId: run.draftId,
    executable: pier,
    gitSha: DEEP_SWE_V11_GIT_SHA,
    taskMaterialPath: materialPath,
    nConcurrent: 1,
    arms: harborArms("mini-swe-agent"),
    environment: { type: "docker", image: IMAGE, configuration: {} },
    outputs: OUTPUTS,
    coverage: "one_task",
  }));
  ok("runQuote", await runQuote(run.context, { draftId: run.draftId }));
  ok("runLock", runLock(run.context, { draftId: run.draftId }));
  ok("runLaunch", await runLaunch(run.context, { draftId: run.draftId }));
  ok("runCollect", await runCollect(run.context, { draftId: run.draftId }));
  return run;
}

// ── Imported runs ─────────────────────────────────────────────────────────────────────────────

/** Every expected cell imported with one outcome, or with `outcomeFor` deciding per cell. */
async function importEveryCell(
  run: SuiteRun,
  root: string,
  outcomeFor: (index: number) => ImportOutcome,
  source: { readonly harness: string; readonly version: string },
  namedReader?: "harbor" | "inspect",
): Promise<void> {
  const document = readDraftDocument(run.workspaceDir, run.draftId);
  if (document.spec.taskSet.kind !== "benchmark") throw new Error("draft has no attached benchmark");
  const cells = expectedCellSet(
    parseBenchmark(getSealedBytes(run.workspaceDir, document.spec.taskSet.benchmarkSha256)),
    parseRun(getSealedBytes(run.workspaceDir, readRunState(run.workspaceDir, run.draftId)!.runSha256!)),
  );
  const evidenceRoot = join(root, "import-evidence");
  mkdirSync(evidenceRoot, { recursive: true });
  const lockedAt = readRunState(run.workspaceDir, run.draftId)!.lockedAt!;
  const records: ExternalRunRecord[] = cells.map((cell, index) => {
    const outcome = outcomeFor(index);
    if (outcome === "unrun") return { row: index + 1, cellKey: cell.cellKey, outcome, reason: "this slot was never driven" };
    if (outcome === "graded") {
      // The prediction-forecast EvaluationSpec's verdict rule reads `integrity` and `resolved`.
      writeFileSync(join(evidenceRoot, `cell-${index}.json`), JSON.stringify({ probabilityYes: "0.5", cell: cell.cellKey }));
      return {
        row: index + 1,
        cellKey: cell.cellKey,
        outcome,
        startedAt: lockedAt,
        endedAt: lockedAt,
        durationMs: 0,
        evidence: [{ name: "prediction", path: `cell-${index}.json` }],
        measurements: { integrity: true, resolved: true },
      };
    }
    // An ungradeable slot carries the output the harness could not grade.
    writeFileSync(join(evidenceRoot, `cell-${index}.txt`), `harness output for slot ${index}\n`);
    return {
      row: index + 1,
      cellKey: cell.cellKey,
      outcome,
      reason: "the harness could not grade this slot",
      evidence: [{ name: "harness-output", path: `cell-${index}.txt` }],
    };
  });
  ok("importRunRecords", await importRunRecords(run.context, {
    draftId: run.draftId,
    records,
    source,
    evidenceRoot,
    ...(namedReader === undefined ? {} : { namedReader }),
  }));
}

type ImportOutcome = "graded" | "ungradeable" | "unrun";

export interface ImportedSuiteRunOptions {
  /** How many dataset tasks the fixture's registry snapshot lists; the selection takes all of them
   * when `coverage` is `full`. */
  readonly datasetSize?: number;
  readonly coverage?: "one_task" | "full";
  /** Defaults to every cell imported as `ungradeable`, which the Matrix accounts as unscorable. */
  readonly outcomeFor?: (index: number) => ImportOutcome;
}

/**
 * A run bound to Terminal-Bench 3.0 over a one-task full snapshot, with every cell imported as
 * graded, so every cell is judged and each judged cell's trial must carry ATIF on the retained
 * Harbor job. The job is the test's to write: {@link writeRetainedHarborTrials}.
 */
export async function importedTerminalBench30Run(root: string): Promise<SuiteRun> {
  const run = await prepareTerminalBenchRun("terminal-bench-3.0", root);
  await importEveryCell(run, root, () => "graded", { harness: "harbor", version: "0.21.4" });
  ok("runCollect", await runCollect(run.context, { draftId: run.draftId }));
  return run;
}

/** Seven-character trial suffixes, as Harbor 0.21.0 draws them, in code-point order. */
const RETAINED_TRIAL_SUFFIXES = ["0Bq7HwA", "4kZx9Lm", "Gm2pQrT", "Wb8sVcE", "q3NdYfK"] as const;

/** The trial directory {@link writeRetainedHarborTrials} writes for a task's attempt. Harbor numbers
 * no attempt, so attempt `n` is the `n`th of the task's directories in code-point order, which is
 * how `run import --from harbor` numbers them. */
export function retainedHarborTrialDirectory(taskName: string, attempt: number): string {
  return `${taskName}__${RETAINED_TRIAL_SUFFIXES[attempt - 1]!}`;
}

/**
 * Writes each arm's retained Harbor job where core reads it, as Harbor 0.21.0 writes a job (#5245):
 * one unnumbered trial directory per task and attempt whose `config.json` names the task with its
 * dataset prefix and records `trials_dir`, here a path inside the workspace; plus
 * `agent/trajectory.json` unless `withoutAtif` names it, and a `result.json` that no reader of the
 * flag consults.
 */
export function writeRetainedHarborTrials(
  run: SuiteRun,
  taskName: string,
  replicates: number,
  withoutAtif: (armId: string, attempt: number) => boolean = () => false,
): void {
  const runSha256 = readRunState(run.workspaceDir, run.draftId)!.runSha256!;
  for (const armId of ["one", "two"]) {
    const job = join(harborArmJobsDir(run.workspaceDir, runSha256), harborArmJobName(runSha256, armId));
    for (let attempt = 1; attempt <= replicates; attempt += 1) {
      const directory = retainedHarborTrialDirectory(taskName, attempt);
      const trial = join(job, directory);
      mkdirSync(join(trial, "agent"), { recursive: true });
      writeFileSync(join(trial, "config.json"), JSON.stringify({
        task: { name: `terminal-bench/${taskName}`, ref: `sha256:${"d".repeat(64)}`, source: "terminal-bench/terminal-bench" },
        trial_name: directory,
        trials_dir: job,
        agent: { name: "terminus", model_name: `openai/model-${armId}` },
        job_id: harborArmJobName(runSha256, armId),
      }, null, 4));
      writeFileSync(join(trial, "result.json"), JSON.stringify({ id: directory, status: "success" }));
      if (!withoutAtif(armId, attempt)) writeFileSync(join(trial, "agent", "trajectory.json"), JSON.stringify({ schema: "ATIF", attempt }));
    }
  }
}

function names(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(3, "0")}`);
}

/** A run bound to SWE-bench Verified with arms `one` and `two`, imported and collected. */
export async function importedSwebenchRun(root: string, options: ImportedSuiteRunOptions = {}): Promise<SuiteRun> {
  const run = workspace(root, ["one", "two"]);
  const harness = executable(join(root, "swebench"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "-c" && args.length === 2 && String(args[1]).includes("swebench.__version__")) { process.stdout.write("4.1.0\\n"); process.exit(0); }
if (args[0] === "--version" && args.length === 1) { process.stdout.write("Python 3.12.4\\n"); process.exit(0); }
process.exit(64);
`);
  const metadataPath = join(root, "swebench-metadata.json");
  writeFileSync(metadataPath, JSON.stringify({
    name: SWE_BENCH_VERIFIED_DATASET_ID,
    revision: SWE_BENCH_VERIFIED_DATASET_REVISION,
    instance_ids: names("instance-", options.datasetSize ?? 12),
  }));
  ok("prepareSwebenchVerifiedDraft", await prepareSwebenchVerifiedDraft(run.context, {
    draftId: run.draftId,
    executable: harness,
    registryMetadataPath: metadataPath,
    arms: [{ armId: "one", modelNameOrPath: "one" }, { armId: "two", modelNameOrPath: "two" }],
    coverage: options.coverage ?? "one_task",
  }));
  ok("runQuote", await runQuote(run.context, { draftId: run.draftId }));
  ok("runLock", runLock(run.context, { draftId: run.draftId }));
  await importEveryCell(run, root, options.outcomeFor ?? (() => "ungradeable"), { harness: "swebench", version: "4.1.0" });
  ok("runCollect", await runCollect(run.context, { draftId: run.draftId }));
  return run;
}

/** A run bound to APEX-Agents with arms `one` and `two`, imported and collected. */
export async function importedApexAgentsRun(root: string, options: ImportedSuiteRunOptions = {}): Promise<SuiteRun> {
  const run = workspace(root, ["one", "two"]);
  const archipelago = executable(join(root, "archipelago"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version" && args.length === 1) { process.stdout.write("${ARCHIPELAGO_COMMIT_PIN}\\n"); process.exit(0); }
process.exit(64);
`);
  const metadataPath = join(root, "apex-metadata.json");
  writeFileSync(metadataPath, JSON.stringify({
    name: APEX_AGENTS_DATASET_ID,
    revision: APEX_AGENTS_DATASET_REVISION,
    task_ids: names("task_", options.datasetSize ?? 12),
  }));
  ok("prepareApexAgentsDraft", await prepareApexAgentsDraft(run.context, {
    draftId: run.draftId,
    executable: archipelago,
    registryMetadataPath: metadataPath,
    arms: [{ armId: "one", modelId: "one" }, { armId: "two", modelId: "two" }],
    coverage: options.coverage ?? "one_task",
  }));
  ok("runQuote", await runQuote(run.context, { draftId: run.draftId }));
  ok("runLock", runLock(run.context, { draftId: run.draftId }));
  await importEveryCell(run, root, options.outcomeFor ?? (() => "ungradeable"), { harness: "archipelago", version: ARCHIPELAGO_COMMIT_PIN });
  ok("runCollect", await runCollect(run.context, { draftId: run.draftId }));
  return run;
}

/** A run bound to APEX-SWE-dev with arms `one` and `two`, imported and collected. */
export async function importedApexSweDevRun(root: string): Promise<SuiteRun> {
  const run = workspace(root, ["one", "two"]);
  const apx = executable(join(root, "apx"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version" && args.length === 1) { process.stdout.write("apx 0.0.0-test\\n"); process.exit(0); }
process.exit(64);
`);
  const observabilityProjectDir = join(root, "observability");
  const pythonDir = join(observabilityProjectDir, "venv", "bin");
  mkdirSync(pythonDir, { recursive: true });
  const python = executable(join(pythonDir, "python"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "-c" && String(args[1]).includes("inspect_ai")) { process.stdout.write("0.3.160\\n"); process.exit(0); }
process.exit(64);
`);
  writeFileSync(join(observabilityProjectDir, "run_e2e.py"), "# observability entry\n");
  const integrationTasksDir = join(root, "integration");
  mkdirSync(integrationTasksDir, { recursive: true });
  const metadataPath = join(root, "apex-swe-metadata.json");
  const tasks = [
    ...Array.from({ length: 25 }, (_, index) => ({ taskId: `0xobs-${String(index).padStart(2, "0")}`, taskType: "observability" })),
    ...Array.from({ length: 25 }, (_, index) => ({ taskId: `1-int-${String(index).padStart(2, "0")}`, taskType: "integration" })),
  ];
  writeFileSync(metadataPath, JSON.stringify({ name: APEX_SWE_DEV_DATASET_ID, revision: APEX_SWE_DEV_DATASET_REVISION, tasks }));
  ok("prepareApexSweDevDraft", await prepareApexSweDevDraft(run.context, {
    draftId: run.draftId,
    apxExecutable: apx,
    pythonExecutable: python,
    registryMetadataPath: metadataPath,
    integrationTasksDir,
    observabilityProjectDir,
    arms: [{ armId: "one", modelNameOrPath: "one" }, { armId: "two", modelNameOrPath: "two" }],
    coverage: "one_task",
  }));
  ok("runQuote", await runQuote(run.context, { draftId: run.draftId }));
  ok("runLock", runLock(run.context, { draftId: run.draftId }));
  await importEveryCell(run, root, () => "ungradeable", { harness: "apex-swe", version: "0.0.0-test" });
  ok("runCollect", await runCollect(run.context, { draftId: run.draftId }));
  return run;
}

// ── Inspect eval ──────────────────────────────────────────────────────────────────────────────

const INSPECT_SAMPLE_IDS = ["sample-0", "sample-1"] as const;

const inspectManifest = InspectSelectionManifestSchema.parse({
  schema: INSPECT_SELECTION_SCHEMA,
  runtime: {
    adapterVersion: "1",
    workerSha256: "c".repeat(64),
    inspectVersion: SUPPORTED_INSPECT_VERSION,
    inspectWheelSha256: SUPPORTED_INSPECT_WHEEL_SHA256,
    pythonVersion: "3.11.9",
    pythonExecutableSha256: "a".repeat(64),
    pythonEnvironmentSha256: "d".repeat(64),
    inspectDistributionSha256: "e".repeat(64),
  },
  task: {
    reference: "eval.py@hermetic",
    args: {},
    resolvedName: "hermetic",
    resolvedVersion: "1.0",
    resolvedSandbox: null,
    source: { kind: "project-file", path: "eval.py", sha256: "b".repeat(64), projectTreeSha256: "f".repeat(64) },
    dataset: { name: "hermetic", location: null, samples: INSPECT_SAMPLE_IDS.length },
  },
  arms: [
    { armId: "control", model: "mockllm/control" },
    { armId: "candidate", model: "mockllm/candidate" },
  ],
  scorer: { name: "match", passValue: "C", definition: { name: "match", options: {}, metrics: [] } },
  runOptions: { maxSamples: 1 },
});

function inspectRuntimeHost() {
  const runtimeHost = createDefaultBenchmarkRuntimeHost();
  return {
    ...runtimeHost,
    assessAgentReadiness: () => [],
    catalogInspectTask: async () => ({
      sampleIds: [...INSPECT_SAMPLE_IDS],
      specifiedEpochs: 1,
      datasetName: "hermetic",
      datasetLocation: null,
      datasetSampleCount: INSPECT_SAMPLE_IDS.length,
    }),
    resolveInspectSelection: async () => ({
      manifest: inspectManifest,
      binding: { pythonPath: "/usr/bin/python3", projectDir: "/tmp/inspect-project" },
    }),
  };
}

function inspectQuoteVenue(): LocalVenue {
  return {
    backend: {
      async capabilities() {
        return {
          taskProfiles: [],
          inputMediaTypes: [],
          outputMediaTypes: [],
          cancel: false,
          watch: false,
          preflight: false,
          fetchArtifact: false,
          confidentialInputs: false,
          signedObservations: false,
          signedDeliveries: false,
          evidenceCapture: "none",
          deadlineEnforcement: false,
          isolation: ["unrestricted"],
          attempts: {},
          runPinning: {
            keys: [
              { key: "harness", inventory: ["inspect-ai"], posture: "enforced" },
              { key: "model", inventory: ["mockllm/control", "mockllm/candidate"], posture: "enforced" },
              { key: "jinn.network/inspect-arm", inventory: ["control", "candidate"], posture: "enforced" },
              { key: "isolationPolicy", inventory: ["unrestricted"], posture: "enforced" },
            ],
          },
        };
      },
      submit: async () => { throw new Error("not used by runQuote"); },
      observe: async () => { throw new Error("not used by runQuote"); },
      recover: async () => { throw new Error("not used by runQuote"); },
      deliveries: async () => [],
      fetchDelivery: async () => { throw new Error("not used by runQuote"); },
    } as unknown as LocalVenue["backend"],
    verdictKeyId: "stub-key",
    evaluators: [{ id: "urn:jinn:benchmark-product:local-venue:evaluator-1", keyId: "stub-key" }],
    prepareEvaluationCell: () => { throw new Error("not used by runQuote"); },
    async shutdown() {},
  };
}

/**
 * A run bound to Inspect eval over a two-sample catalog, imported and collected. Every slot is
 * imported as `unrun` by default: a delivered Inspect eval cell carries no `inspect-summary`, and
 * the checker's per-cell Inspect delivery check still refuses it (a known gap, not this fixture's).
 */
export async function importedInspectEvalRun(root: string, options: ImportedSuiteRunOptions = {}): Promise<SuiteRun> {
  const base = workspace(root, []);
  const context: OperationContext = { ...base.context, runtimeHost: inspectRuntimeHost() as never };
  const run = { ...base, context };
  ok("selectInspectEvalRuntime", await selectInspectEvalRuntime(context, {
    draftId: run.draftId,
    coverage: options.coverage ?? "one_task",
    pythonPath: "/usr/bin/python3",
    projectDir: "/tmp/inspect-project",
    taskReference: "eval.py@hermetic",
    arms: inspectManifest.arms,
    scorer: { name: "match", passValue: "C" },
  }));
  ok("runQuote", await runQuote(context, { draftId: run.draftId }, { createVenue: () => inspectQuoteVenue() }));
  ok("runLock", runLock(context, { draftId: run.draftId }));
  await importEveryCell(run, root, options.outcomeFor ?? (() => "unrun"), { harness: "inspect", version: SUPPORTED_INSPECT_VERSION }, "inspect");
  ok("runCollect", await runCollect(context, { draftId: run.draftId }));
  return run;
}
