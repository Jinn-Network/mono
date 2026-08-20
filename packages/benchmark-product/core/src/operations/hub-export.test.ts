import { parseMatrix } from "@jinn-network/benchmarking-records";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { armAdd } from "./arms.js";
import { createDraft } from "./drafts.js";
import {
  COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE,
  exportCompletenessCertification,
} from "../runtime/suite-protocol/comparability.js";
import { harborArmJobName } from "../runtime/harbor/launcher.js";
import { harborArmJobsDir } from "../runtime/harbor/arm-job.js";
import { computeHarbor021TaskContentHash } from "../runtime/terminal-bench-2/host.js";
import { TERMINAL_BENCH_2_1_DATASET_ID, TERMINAL_BENCH_2_1_DATASET_REF } from "../runtime/terminal-bench-2-1/manifest.js";
import { TERMINAL_BENCH_3_0_DATASET_ID, TERMINAL_BENCH_3_0_DATASET_REF, TERMINAL_BENCH_3_0_HUB_VERSION } from "../runtime/terminal-bench-3-0/manifest.js";
import type { HarborSelectionManifest } from "../runtime/harbor/manifest.js";
import { initWorkspace } from "./init.js";
import { runCollect } from "./run-collect.js";
import { runLaunch } from "./run-launch.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { requireRunState } from "../run/state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { selectTerminalBench21Runtime } from "./terminal-bench-2-1.js";
import { selectTerminalBench30Runtime } from "./terminal-bench-3-0.js";
import {
  decideHarborHubExportMode,
  exportHarborHubPackage,
  harborHubExportInstructions,
} from "./hub-export.js";

const names = ["t00", "t01", "t02", "t03", "t04", "t05", "t06", "t07", "t08", "t09", "t10", "t11"] as const;
const image = `registry.example/tb21@sha256:${"c".repeat(64)}`;
const arms: HarborSelectionManifest["arms"] = [
  { armId: "one", agent: { id: "terminus", configuration: {} }, model: { id: "openai/model-one", configuration: {} }, jobAgent: { name: "terminus", model_name: "openai/model-one" } },
  { armId: "two", agent: { id: "terminus", configuration: {} }, model: { id: "openai/model-two", configuration: {} }, jobAgent: { name: "terminus", model_name: "openai/model-two" } },
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
let metadataPath: string;
let materialPath: string;

function writeFakeHarbor(): string {
  const path = join(root, "harbor");
  writeFileSync(path, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version" && args.length === 1) { process.stdout.write("harbor 0.21.4\\n"); process.exit(0); }
process.exit(64);
`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function writeBatchedFakeHarbor(): string {
  const path = join(root, "harbor-batched");
  writeFileSync(path, `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version" && args.length === 1) { process.stdout.write("harbor 0.21.4\\n"); process.exit(0); }
if (args[0] !== "run" || args[1] !== "-c" || args.length !== 3) process.exit(64);
const config = JSON.parse(readFileSync(args[2], "utf8"));
if (!Array.isArray(config.datasets) || config.datasets.length !== 1) throw new Error("one DatasetConfig required");
if (![0, 3].includes(config.retry?.max_retries)) throw new Error("hidden retry");
if (!Number.isInteger(config.n_attempts) || config.n_attempts < 1) throw new Error("planned attempts required");
const names = config.datasets[0].task_names;
if (!Array.isArray(names) || names.length !== config.datasets[0].n_tasks) throw new Error("task filter mismatch");
for (const name of names) {
  if (!existsSync(join(process.cwd(), config.datasets[0].path, name, "task.toml"))) throw new Error("unstaged DatasetConfig");
}
const job = join(config.jobs_dir, config.job_name);
mkdirSync(job, { recursive: true });
writeFileSync(join(job, "config.json"), JSON.stringify(config));
const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
let index = 0;
for (const name of names) {
  for (let attempt = 1; attempt <= config.n_attempts; attempt++) {
    index += 1;
    const trialName = "trial-" + index;
    const trial = join(job, trialName);
    mkdirSync(join(trial, "agent"), { recursive: true });
    mkdirSync(join(trial, "verifier"), { recursive: true });
    mkdirSync(join(trial, "artifacts"), { recursive: true });
    writeFileSync(join(trial, "config.json"), JSON.stringify({
      task: { name },
      attempt,
      agent: config.agents[0],
    }));
    sleep(50);
    writeFileSync(join(trial, "result.json"), JSON.stringify({ id: trialName, status: "success" }));
    writeFileSync(join(trial, "agent", "recording.cast"), Buffer.from([0, 255, 1]));
    writeFileSync(join(trial, "agent", "trajectory.json"), JSON.stringify({ schema: "ATIF" }));
    writeFileSync(join(trial, "verifier", "reward.txt"), "1\\n");
    writeFileSync(join(trial, "ctrf.json"), JSON.stringify({ results: [] }));
    writeFileSync(join(trial, "artifacts", "manifest.json"), JSON.stringify({ files: ["prediction.json"] }));
    writeFileSync(join(trial, "artifacts", "prediction.json"), JSON.stringify({
      probabilityYes: "0.5",
      submittedAt: "2026-01-01T00:00:00Z",
      replicate: attempt,
      arm: config.agents[0].model_name,
    }));
  }
}
writeFileSync(join(job, "result.json"), JSON.stringify({
  id: config.job_name,
  status: "success",
  finished_at: new Date().toISOString(),
  n_total_trials: index,
  stats: { n_retries: 0 },
}));
process.stdout.write("fake harbor completed\\n");
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
  writeFileSync(metadataPath, JSON.stringify({
    name: TERMINAL_BENCH_2_1_DATASET_ID,
    dataset_version_content_hash: TERMINAL_BENCH_2_1_DATASET_REF,
    task_ids: names.map((name) => ({
      org: "terminal-bench",
      name,
      ref: `sha256:${computeHarbor021TaskContentHash(join(materialPath, name)).contentHash}`,
    })),
  }));
}

function request(coverage?: "one_task" | "ten_task" | "full", taskNames?: readonly string[]) {
  return {
    executable,
    registryMetadataPath: metadataPath,
    datasetRevision: TERMINAL_BENCH_2_1_DATASET_REF,
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

/** §8.2 clause 2: the certification renders the sealed Matrix's own completeness, or says none is sealed yet. */
function certificationFor(draftId: string): string {
  const state = requireRunState(workspaceDir, draftId);
  const completeness = state.matrixSha256 === undefined
    ? undefined
    : parseMatrix(getSealedBytes(workspaceDir, state.matrixSha256)).completeness;
  return exportCompletenessCertification({ runSha256: state.runSha256!, completeness });
}

function stubArmJob(draftId: string, armId: string): string {
  const runSha256 = requireRunState(workspaceDir, draftId).runSha256!;
  const jobDir = join(harborArmJobsDir(workspaceDir, runSha256), harborArmJobName(runSha256, armId));
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, "result.json"), JSON.stringify({ id: harborArmJobName(runSha256, armId), status: "success", n_total_trials: 5, stats: { n_retries: 0 } }));
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
  root = mkdtempSync(join(tmpdir(), "hub-export-"));
  workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir);
  executable = writeFakeHarbor();
  metadataPath = join(root, "dataset-metadata.json");
  materialPath = join(root, "selected-dataset");
  writeFixture();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Harbor Hub export", () => {
  test("decides inspection vs leaderboard vs refuse without claiming a Hub row", () => {
    expect(decideHarborHubExportMode({ executionConformance: true, coverage: "one_task", leaderboardSubmitReady: false })).toBe("inspection-upload");
    expect(decideHarborHubExportMode({ executionConformance: true, coverage: "ten_task", leaderboardSubmitReady: false })).toBe("inspection-upload");
    expect(decideHarborHubExportMode({ executionConformance: true, coverage: "full", leaderboardSubmitReady: true })).toBe("leaderboard-submit");
    expect(decideHarborHubExportMode({ executionConformance: true, coverage: "custom", leaderboardSubmitReady: false })).toBe("refused");
    expect(decideHarborHubExportMode({ executionConformance: false, coverage: "full", leaderboardSubmitReady: false })).toBe("refused");
    const certification = "complete run of the selection sealed at lock aaaa: 1 of 1 cells judged.";
    const inspection = harborHubExportInstructions(certification, "inspection-upload", "/tmp/job");
    expect(inspection.split("\n")[0]).toBe(certification);
    expect(inspection).toContain("harbor upload --public /tmp/job");
    expect(inspection).toContain("Do not run `uv run lb submit`");
    expect(inspection).toContain(COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE);
    const ready = harborHubExportInstructions(certification, "leaderboard-submit", "/tmp/job");
    expect(ready.split("\n")[0]).toBe(certification);
    expect(ready).toContain("harbor upload --public /tmp/job");
    expect(ready).toContain("uv run lb submit <hub-url>");
    expect(ready).toContain(COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE);
    const inspection30 = harborHubExportInstructions(certification, "inspection-upload", "/tmp/job", "terminal-bench-3.0");
    expect(inspection30.split("\n")[0]).toBe(certification);
    expect(inspection30).toContain("harbor upload --public /tmp/job");
    expect(inspection30).toContain("Terminal-Bench 3.0");
    expect(inspection30).not.toContain(COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE);
    expect(inspection30).not.toContain("uv run lb submit");
    const ready30 = harborHubExportInstructions(certification, "leaderboard-submit", "/tmp/job", "terminal-bench-3.0");
    expect(ready30.split("\n")[0]).toBe(certification);
    expect(ready30).toContain("harbor upload --public /tmp/job");
    expect(ready30).toContain("Terminal-Bench 3.0");
    expect(ready30).not.toContain(COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE);
    expect(ready30).not.toContain("uv run lb submit");
  });

  test("refuses suite-named export without a Harbor Terminal-Bench 2.1 lock", async () => {
    const context = await prepareDraft("none");
    const exported = exportHarborHubPackage(context, { draftId: "none", armId: "one" });
    expect(exported.ok).toBe(false);
    if (exported.ok) return;
    expect(exported.error.code).toBe("conflict");
    expect(exported.error.detail).toMatch(/locked Harbor runtime/);
  });

  test("named-slice export is inspection-only and keeps the native job directory", async () => {
    const context = await prepareDraft("one");
    expect((await selectTerminalBench21Runtime(context, { draftId: "one", ...request("one_task") })).ok).toBe(true);
    expect((await runQuote(context, { draftId: "one" })).ok).toBe(true);
    expect(runLock(context, { draftId: "one" }).ok).toBe(true);
    const jobDir = stubArmJob("one", "one");
    const exported = exportHarborHubPackage(context, { draftId: "one", armId: "one" });
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    if (!exported.ok) return;
    expect(exported.result.mode).toBe("inspection-upload");
    expect(exported.result.jobDir).toBe(jobDir);
    expect(existsSync(join(jobDir, "result.json"))).toBe(true);
    expect(existsSync(join(exported.result.exportDir, "job", "result.json"))).toBe(true);
    expect(exported.result.instructions.split("\n")[0]).toBe(certificationFor("one"));
    expect(exported.result.instructions).toContain("Do not run `uv run lb submit`");
    expect(exported.result.instructions).toContain(COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE);
    expect(readFileSync(join(exported.result.exportDir, "INSTRUCTIONS.txt"), "utf8")).toContain(COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE);
  }, 60_000);

  test("custom coverage and missing jobs refuse suite-named Hub export", async () => {
    const context = await prepareDraft("custom");
    expect((await selectTerminalBench21Runtime(context, { draftId: "custom", ...request(undefined, ["t11"]) })).ok).toBe(true);
    expect((await runQuote(context, { draftId: "custom" })).ok).toBe(true);
    expect(runLock(context, { draftId: "custom" }).ok).toBe(true);
    stubArmJob("custom", "one");
    const custom = exportHarborHubPackage(context, { draftId: "custom", armId: "one" });
    expect(custom.ok).toBe(false);
    if (custom.ok) return;
    expect(custom.error.code).toBe("conflict");
    expect(custom.error.detail).toMatch(/cannot wear the Terminal-Bench 2.1 Hub suite name/);

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir);
    const missing = await prepareDraft("missing");
    expect((await selectTerminalBench21Runtime(missing, { draftId: "missing", ...request("one_task") })).ok).toBe(true);
    expect((await runQuote(missing, { draftId: "missing" })).ok).toBe(true);
    expect(runLock(missing, { draftId: "missing" }).ok).toBe(true);
    const absent = exportHarborHubPackage(missing, { draftId: "missing", armId: "one" });
    expect(absent.ok).toBe(false);
    if (absent.ok) return;
    expect(absent.error.code).toBe("not-found");
  }, 60_000);

  test("full coverage plus stubbed result.json without collect is inspection-upload", async () => {
    const context = await prepareDraft("full");
    expect((await selectTerminalBench21Runtime(context, { draftId: "full", ...request("full") })).ok).toBe(true);
    expect((await runQuote(context, { draftId: "full" })).ok).toBe(true);
    expect(runLock(context, { draftId: "full" }).ok).toBe(true);
    stubArmJob("full", "two");
    const exported = exportHarborHubPackage(context, { draftId: "full", armId: "two" });
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    if (!exported.ok) return;
    expect(exported.result.mode).toBe("inspection-upload");
    expect(exported.result.instructions.split("\n")[0]).toBe(certificationFor("full"));
    expect(exported.result.instructions).toContain("Do not run `uv run lb submit`");
    expect(exported.result.instructions).toContain(COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE);
  }, 120_000);

  test("collect of a 1-task full snapshot with ATIF on the retained job is leaderboard-submit", async () => {
    writeFileSync(metadataPath, JSON.stringify({
      name: TERMINAL_BENCH_2_1_DATASET_ID,
      dataset_version_content_hash: TERMINAL_BENCH_2_1_DATASET_REF,
      task_ids: [{
        org: "terminal-bench",
        name: "t00",
        ref: `sha256:${computeHarbor021TaskContentHash(join(materialPath, "t00")).contentHash}`,
      }],
    }));
    executable = writeBatchedFakeHarbor();
    const context = await prepareDraft("ready");
    expect((await selectTerminalBench21Runtime(context, { draftId: "ready", ...request("full") })).ok).toBe(true);
    expect((await runQuote(context, { draftId: "ready" })).ok).toBe(true);
    expect(requireRunState(workspaceDir, "ready").suiteQuote).toMatchObject({
      coverage: "full",
      leaderboardSubmitReady: false,
      methodLeaderboardEligible: true,
    });
    expect(runLock(context, { draftId: "ready" }).ok).toBe(true);
    const launched = await runLaunch(context, { draftId: "ready" });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    const collected = await runCollect(context, { draftId: "ready" });
    expect(collected.ok, JSON.stringify(collected)).toBe(true);
    const collectedState = requireRunState(workspaceDir, "ready");
    const matrix = parseMatrix(getSealedBytes(workspaceDir, collectedState.matrixSha256!));
    expect(matrix.cells.map((cell) => `${cell.armId}/${cell.replicate}:${cell.outcome}`)).toEqual(
      expect.arrayContaining(["one/1:judged", "two/5:judged"]),
    );
    expect(matrix.cells.every((cell) => cell.outcome === "judged" || cell.outcome === "unscorable")).toBe(true);
    const exported = exportHarborHubPackage(context, { draftId: "ready", armId: "two" });
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    if (!exported.ok) return;
    expect(exported.result.mode).toBe("leaderboard-submit");
    expect(exported.result.instructions.split("\n")[0]).toBe(exportCompletenessCertification({
      runSha256: collectedState.runSha256!,
      completeness: matrix.completeness,
    }));
    expect(exported.result.instructions).toContain("harbor upload --public");
    expect(exported.result.instructions).toContain("uv run lb submit <hub-url>");
    expect(exported.result.instructions).toContain(COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE);
  }, 120_000);
});

describe("Terminal-Bench 3.0 Hub export", () => {
  function tb30Request(coverage?: "one_task" | "ten_task" | "full", taskNames?: readonly string[]) {
    return {
      executable,
      registryMetadataPath: metadataPath,
      datasetRevision: TERMINAL_BENCH_3_0_DATASET_REF,
      taskMaterialPath: materialPath,
      nConcurrent: 1,
      arms,
      environment: { type: "docker" as const, image, configuration: {} },
      outputs,
      ...(coverage === undefined ? {} : { coverage }),
      ...(taskNames === undefined ? {} : { taskNames }),
    };
  }

  beforeEach(() => {
    writeFileSync(metadataPath, JSON.stringify({
      name: TERMINAL_BENCH_3_0_DATASET_ID,
      version: TERMINAL_BENCH_3_0_HUB_VERSION,
      dataset_version_content_hash: TERMINAL_BENCH_3_0_DATASET_REF,
      task_ids: names.map((name) => ({
        org: "terminal-bench",
        name,
        ref: `sha256:${computeHarbor021TaskContentHash(join(materialPath, name)).contentHash}`,
      })),
    }));
  });

  test("named-slice export is inspection-only without the 2.1 closed-submissions sentence", async () => {
    const context = await prepareDraft("one");
    expect((await selectTerminalBench30Runtime(context, { draftId: "one", ...tb30Request("one_task") })).ok).toBe(true);
    expect((await runQuote(context, { draftId: "one" })).ok).toBe(true);
    expect(runLock(context, { draftId: "one" }).ok).toBe(true);
    stubArmJob("one", "one");
    const exported = exportHarborHubPackage(context, { draftId: "one", armId: "one" });
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    if (!exported.ok) return;
    expect(exported.result.mode).toBe("inspection-upload");
    expect(exported.result.instructions.split("\n")[0]).toBe(certificationFor("one"));
    expect(exported.result.instructions).toContain("Terminal-Bench 3.0");
    expect(exported.result.instructions).toContain("harbor upload --public");
    expect(exported.result.instructions).not.toContain(COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE);
    expect(exported.result.instructions).not.toContain("uv run lb submit");
  }, 60_000);

  test("custom coverage refuses the Terminal-Bench 3.0 Hub suite name", async () => {
    const context = await prepareDraft("custom");
    expect((await selectTerminalBench30Runtime(context, { draftId: "custom", ...tb30Request(undefined, ["t11"]) })).ok).toBe(true);
    expect((await runQuote(context, { draftId: "custom" })).ok).toBe(true);
    expect(runLock(context, { draftId: "custom" }).ok).toBe(true);
    stubArmJob("custom", "one");
    const custom = exportHarborHubPackage(context, { draftId: "custom", armId: "one" });
    expect(custom.ok).toBe(false);
    if (custom.ok) return;
    expect(custom.error.code).toBe("conflict");
    expect(custom.error.detail).toMatch(/cannot wear the Terminal-Bench 3\.0 Hub suite name/);
  }, 60_000);
});
