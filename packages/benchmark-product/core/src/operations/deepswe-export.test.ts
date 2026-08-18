import { parseMatrix } from "@jinn-network/benchmarking-records";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { armAdd } from "./arms.js";
import { createDraft } from "./drafts.js";
import {
  DEEPSWE_CLOSED_SUBMIT_SENTENCE,
} from "../runtime/suite-protocol/comparability.js";
import { harborArmJobName } from "../runtime/harbor/launcher.js";
import { harborArmJobsDir } from "../runtime/harbor/arm-job.js";
import type { HarborSelectionManifest } from "../runtime/harbor/manifest.js";
import { initWorkspace } from "./init.js";
import { runCollect } from "./run-collect.js";
import { runLaunch } from "./run-launch.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { requireRunState } from "../run/state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { DEEP_SWE_V11_GIT_SHA } from "../runtime/deep-swe-v1.1/manifest.js";
import { selectDeepSweV11Runtime } from "./deep-swe-v1.1.js";
import { exportHarborHubPackage } from "./hub-export.js";
import {
  decideDeepSweExportMode,
  deepSweExportInstructions,
  exportDeepSwePackage,
} from "./deepswe-export.js";

const names = ["t00", "t01", "t02", "t03", "t04", "t05", "t06", "t07", "t08", "t09", "t10", "t11"] as const;
const image = `registry.example/deepswe@sha256:${"c".repeat(64)}`;
const arms: HarborSelectionManifest["arms"] = [
  { armId: "one", agent: { id: "mini-swe-agent", configuration: {} }, model: { id: "openai/model-one", configuration: {} }, jobAgent: { name: "mini-swe-agent", model_name: "openai/model-one" } },
  { armId: "two", agent: { id: "mini-swe-agent", configuration: {} }, model: { id: "openai/model-two", configuration: {} }, jobAgent: { name: "mini-swe-agent", model_name: "openai/model-two" } },
];
const outputs: HarborSelectionManifest["outputs"] = [{
  name: "prediction",
  mediaType: "application/json",
  artifact: { source: "/logs/artifacts/prediction.json", destination: "prediction.json" },
  nativePath: "artifacts/prediction.json",
}];

let root: string;
let workspaceDir: string;
let executable: string;
let materialPath: string;

function writeFakePier(): string {
  const path = join(root, "pier");
  writeFileSync(path, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version" && args.length === 1) { process.stdout.write("pier 0.3.1\\n"); process.exit(0); }
process.exit(64);
`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function writeBatchedFakePier(): string {
  const path = join(root, "pier-batched");
  writeFileSync(path, `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version" && args.length === 1) { process.stdout.write("pier 0.3.1\\n"); process.exit(0); }
if (args[0] !== "run" || args[1] !== "-c" || args.length !== 3) process.exit(64);
writeFileSync(${JSON.stringify(join(root, "pier-invocations.log"))}, "run\\n", { flag: "a" });
const config = JSON.parse(readFileSync(args[2], "utf8"));
const job = join(config.jobs_dir, config.job_name);
try {
if (!Array.isArray(config.datasets) || config.datasets.length !== 1) throw new Error("one DatasetConfig required");
if (![0, 3].includes(config.retry?.max_retries)) throw new Error("hidden retry");
if (!Number.isInteger(config.n_attempts) || config.n_attempts < 1) throw new Error("planned attempts required");
if (config.agents?.[0]?.name !== "mini-swe-agent") throw new Error("mini-swe-agent required");
const names = config.datasets[0].task_names;
if (!Array.isArray(names) || names.length !== config.datasets[0].n_tasks) throw new Error("task filter mismatch");
for (const name of names) {
  if (!existsSync(join(process.cwd(), config.datasets[0].path, name, "task.toml"))) throw new Error("unstaged DatasetConfig");
}
mkdirSync(job, { recursive: true });
writeFileSync(join(job, "config.json"), JSON.stringify(config));
const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
function writeTrial(trialName, name, attempt) {
  const trial = join(job, trialName);
  mkdirSync(join(trial, "agent"), { recursive: true });
  mkdirSync(join(trial, "verifier"), { recursive: true });
  mkdirSync(join(trial, "artifacts"), { recursive: true });
  writeFileSync(join(trial, "config.json"), JSON.stringify({
    task: { name },
    attempt,
    agent: config.agents[0],
  }));
  writeFileSync(join(trial, "result.json"), JSON.stringify({ id: trialName, status: "success", finished_at: new Date().toISOString() }));
  writeFileSync(join(trial, "agent", "recording.cast"), Buffer.from([0, 255, 1]));
  writeFileSync(join(trial, "agent", "trajectory.json"), JSON.stringify({ schema: "ATIF", version: "1.7" }));
  writeFileSync(join(trial, "verifier", "reward.json"), JSON.stringify({ reward: 1 }));
  writeFileSync(join(trial, "ctrf.json"), JSON.stringify({ results: [] }));
  writeFileSync(join(trial, "artifacts", "manifest.json"), JSON.stringify({ files: ["prediction.json"] }));
  writeFileSync(join(trial, "artifacts", "prediction.json"), JSON.stringify({
    probabilityYes: "1.0",
    submittedAt: "2026-01-01T00:00:00Z",
    replicate: attempt,
    arm: config.agents[0].model_name,
  }));
}
let index = 0;
for (const name of names) {
  for (let attempt = 1; attempt <= config.n_attempts; attempt++) {
    index += 1;
    writeTrial("trial-" + index, name, attempt);
    sleep(50);
  }
}
writeFileSync(join(job, "result.json"), JSON.stringify({
  id: config.job_name,
  status: "success",
  finished_at: new Date().toISOString(),
  n_total_trials: index,
  stats: { n_retries: 0 },
}));
process.stdout.write("fake pier completed\\n");
} catch (cause) {
  try { writeFileSync(join(job, "pier-error.txt"), String(cause && cause.stack ? cause.stack : cause)); } catch {}
  throw cause;
}
`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function writeFixture(): void {
  mkdirSync(materialPath, { recursive: true });
  for (const name of names) {
    mkdirSync(join(materialPath, name), { recursive: true });
    writeFileSync(join(materialPath, name, "task.toml"), `[task]\nname = "${name}"\n[environment]\ndocker_image = "${image}"\n`);
    writeFileSync(join(materialPath, name, "instruction.md"), `solve ${name}\n`);
  }
}

function request(coverage?: "one_task" | "ten_task" | "full", taskNames?: readonly string[]) {
  return {
    executable,
    gitSha: DEEP_SWE_V11_GIT_SHA,
    taskMaterialPath: materialPath,
    nConcurrent: 1,
    arms,
    environment: { type: "docker" as const, image, configuration: {} },
    outputs,
    ...(coverage === undefined ? {} : { coverage }),
    ...(taskNames === undefined ? {} : { taskNames }),
  };
}

function clock(): () => string {
  return () => new Date().toISOString();
}

function stubArmJob(draftId: string, armId: string): string {
  const runSha256 = requireRunState(workspaceDir, draftId).runSha256!;
  const jobDir = join(harborArmJobsDir(workspaceDir, runSha256), harborArmJobName(runSha256, armId));
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, "result.json"), JSON.stringify({ id: harborArmJobName(runSha256, armId), status: "success", finished_at: "2026-01-01T00:00:00Z", n_total_trials: 4, stats: { n_retries: 0 } }));
  writeFileSync(join(jobDir, "config.json"), JSON.stringify({ job_name: harborArmJobName(runSha256, armId) }));
  return jobDir;
}

async function prepareDraft(draftId: string) {
  const context = { workspaceDir, principal: "sponsor-1", clock: clock() };
  expect(initWorkspace(context).ok).toBe(true);
  expect(createDraft(context, { draftId, name: draftId }).ok).toBe(true);
  expect(armAdd(context, { draftId, armId: "one", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
  expect(armAdd(context, { draftId, armId: "two", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
  return context;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deepswe-export-"));
  workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir);
  executable = writeFakePier();
  materialPath = join(root, "tasks");
  writeFixture();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("DeepSWE v1.1 Pier export", () => {
  test("decides inspection vs ready vs refuse without claiming a Datacurve row", () => {
    expect(decideDeepSweExportMode({ executionConformance: true, coverage: "one_task", leaderboardSubmitReady: false })).toBe("inspection");
    expect(decideDeepSweExportMode({ executionConformance: true, coverage: "ten_task", leaderboardSubmitReady: false })).toBe("inspection");
    expect(decideDeepSweExportMode({ executionConformance: true, coverage: "full", leaderboardSubmitReady: true })).toBe("ready");
    expect(decideDeepSweExportMode({ executionConformance: true, coverage: "custom", leaderboardSubmitReady: false })).toBe("refused");
    expect(decideDeepSweExportMode({ executionConformance: false, coverage: "full", leaderboardSubmitReady: false })).toBe("refused");
    const inspection = deepSweExportInstructions("inspection", "/tmp/job");
    expect(inspection).toContain("You may retain the Pier job for inspection: /tmp/job");
    expect(inspection).toContain("Do not email this package as a Datacurve leaderboard submission");
    expect(inspection).not.toMatch(/lb submit/u);
    expect(inspection).toContain(DEEPSWE_CLOSED_SUBMIT_SENTENCE);
    const ready = deepSweExportInstructions("ready", "/tmp/job");
    expect(ready).toContain("serena@datacurve.ai");
    expect(ready).not.toMatch(/lb submit/u);
    expect(ready).toContain(DEEPSWE_CLOSED_SUBMIT_SENTENCE);
  });

  test("refuses suite-named export without a Pier DeepSWE v1.1 lock", async () => {
    const context = await prepareDraft("none");
    const exported = exportDeepSwePackage(context, { draftId: "none", armId: "one" });
    expect(exported.ok).toBe(false);
    if (exported.ok) return;
    expect(exported.error.code).toBe("conflict");
    expect(exported.error.detail).toMatch(/locked Pier runtime/);
  });

  test("named-slice export is inspection-only and keeps the native job directory", async () => {
    const context = await prepareDraft("one");
    expect((await selectDeepSweV11Runtime(context, { draftId: "one", ...request("one_task") })).ok).toBe(true);
    expect((await runQuote(context, { draftId: "one" })).ok).toBe(true);
    expect(runLock(context, { draftId: "one" }).ok).toBe(true);
    const hub = exportHarborHubPackage(context, { draftId: "one", armId: "one" });
    expect(hub.ok).toBe(false);
    if (hub.ok) return;
    expect(hub.error.detail).toMatch(/locked Harbor runtime/);
    const jobDir = stubArmJob("one", "one");
    const exported = exportDeepSwePackage(context, { draftId: "one", armId: "one" });
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    if (!exported.ok) return;
    expect(exported.result.mode).toBe("inspection");
    expect(exported.result.jobDir).toBe(jobDir);
    expect(existsSync(join(jobDir, "result.json"))).toBe(true);
    expect(existsSync(join(exported.result.exportDir, "job", "result.json"))).toBe(true);
    expect(exported.result.instructions).toContain("Do not email this package as a Datacurve leaderboard submission");
    expect(exported.result.instructions).toContain(DEEPSWE_CLOSED_SUBMIT_SENTENCE);
    expect(readFileSync(join(exported.result.exportDir, "INSTRUCTIONS.txt"), "utf8")).toContain("serena@datacurve.ai");
  }, 60_000);

  test("custom coverage and missing jobs refuse suite-named DeepSWE export", async () => {
    const context = await prepareDraft("custom");
    expect((await selectDeepSweV11Runtime(context, { draftId: "custom", ...request(undefined, ["t11"]) })).ok).toBe(true);
    expect((await runQuote(context, { draftId: "custom" })).ok).toBe(true);
    expect(runLock(context, { draftId: "custom" }).ok).toBe(true);
    stubArmJob("custom", "one");
    const custom = exportDeepSwePackage(context, { draftId: "custom", armId: "one" });
    expect(custom.ok).toBe(false);
    if (custom.ok) return;
    expect(custom.error.code).toBe("conflict");
    expect(custom.error.detail).toMatch(/cannot wear the DeepSWE v1\.1 suite name/);

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir);
    const missing = await prepareDraft("missing");
    expect((await selectDeepSweV11Runtime(missing, { draftId: "missing", ...request("one_task") })).ok).toBe(true);
    expect((await runQuote(missing, { draftId: "missing" })).ok).toBe(true);
    expect(runLock(missing, { draftId: "missing" }).ok).toBe(true);
    const absent = exportDeepSwePackage(missing, { draftId: "missing", armId: "one" });
    expect(absent.ok).toBe(false);
    if (absent.ok) return;
    expect(absent.error.code).toBe("not-found");
  }, 60_000);

  test("named-slice coverage plus stubbed result.json without collect is inspection", async () => {
    const context = await prepareDraft("full");
    expect((await selectDeepSweV11Runtime(context, { draftId: "full", ...request("ten_task") })).ok).toBe(true);
    expect((await runQuote(context, { draftId: "full" })).ok).toBe(true);
    expect(runLock(context, { draftId: "full" }).ok).toBe(true);
    stubArmJob("full", "two");
    const exported = exportDeepSwePackage(context, { draftId: "full", armId: "two" });
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    if (!exported.ok) return;
    expect(exported.result.mode).toBe("inspection");
    expect(exported.result.instructions).toContain("Do not email this package as a Datacurve leaderboard submission");
    expect(exported.result.instructions).toContain(DEEPSWE_CLOSED_SUBMIT_SENTENCE);
  }, 120_000);

  test("a 1-task snapshot cannot claim full coverage; collected with reward.json and ATIF it is inspection, not ready", async () => {
    materialPath = join(root, "one-task");
    mkdirSync(join(materialPath, "t00"), { recursive: true });
    writeFileSync(join(materialPath, "t00", "task.toml"), `[task]\nname = "t00"\n[environment]\ndocker_image = "${image}"\n`);
    writeFileSync(join(materialPath, "t00", "instruction.md"), "solve t00\n");
    executable = writeBatchedFakePier();
    const context = { workspaceDir, principal: "sponsor-1", clock: clock() };
    expect(initWorkspace(context).ok).toBe(true);
    expect(createDraft(context, { draftId: "ready", name: "ready" }).ok).toBe(true);
    expect(armAdd(context, { draftId: "ready", armId: "one", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    expect(armAdd(context, { draftId: "ready", armId: "two", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    const claimedFull = await selectDeepSweV11Runtime(context, { draftId: "ready", ...request("full") });
    expect(claimedFull.ok).toBe(false);
    if (claimedFull.ok) return;
    expect(claimedFull.error.detail).toMatch(/113-task tree/u);
    const selected = await selectDeepSweV11Runtime(context, { draftId: "ready", ...request("one_task") });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    const quoted = await runQuote(context, { draftId: "ready" });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    expect(requireRunState(workspaceDir, "ready").suiteQuote).toMatchObject({
      coverage: "one_task",
      leaderboardSubmitReady: false,
      methodLeaderboardEligible: false,
      replicates: 4,
      harborVersion: "0.3.1",
    });
    const locked = runLock(context, { draftId: "ready" });
    expect(locked.ok, JSON.stringify(locked)).toBe(true);
    const launched = await runLaunch(context, { draftId: "ready" });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    const collected = await runCollect(context, { draftId: "ready" });
    expect(collected.ok, JSON.stringify(collected)).toBe(true);
    const collectedState = requireRunState(workspaceDir, "ready");
    const matrix = parseMatrix(getSealedBytes(workspaceDir, collectedState.matrixSha256!));
    expect(matrix.cells).toHaveLength(8);
    expect(matrix.cells.every((cell) => cell.outcome === "judged" || cell.outcome === "unscorable")).toBe(true);
    const runSha256 = collectedState.runSha256!;
    const jobConfig = JSON.parse(readFileSync(join(harborArmJobsDir(workspaceDir, runSha256), harborArmJobName(runSha256, "one"), "config.json"), "utf8")) as {
      n_attempts: number;
      retry?: { max_retries?: number };
      agents?: Array<{ name?: string }>;
    };
    expect(jobConfig.n_attempts).toBe(4);
    expect(jobConfig.retry?.max_retries).toBe(3);
    expect(jobConfig.agents?.[0]?.name).toBe("mini-swe-agent");
    expect(existsSync(join(harborArmJobsDir(workspaceDir, runSha256), harborArmJobName(runSha256, "one"), "trial-1", "verifier", "reward.json"))).toBe(true);
    expect(existsSync(join(harborArmJobsDir(workspaceDir, runSha256), harborArmJobName(runSha256, "one"), "trial-1", "ctrf.json"))).toBe(true);
    expect(readFileSync(join(root, "pier-invocations.log"), "utf8").trim().split("\n")).toEqual(["run", "run"]);
    const exported = exportDeepSwePackage(context, { draftId: "ready", armId: "two" });
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    if (!exported.ok) return;
    // Every completeness bit is present; only the official 113-task pin is missing, so this is never ready.
    expect(exported.result.mode).toBe("inspection");
    expect(exported.result.instructions).toContain("Do not email this package as a Datacurve leaderboard submission");
    expect(exported.result.instructions).not.toMatch(/lb submit/u);
    expect(exported.result.instructions).toContain(DEEPSWE_CLOSED_SUBMIT_SENTENCE);
    expect(statSync(join(exported.result.exportDir, "INSTRUCTIONS.txt")).mode & 0o777).toBe(0o600);
  }, 120_000);
});
