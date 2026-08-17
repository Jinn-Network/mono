import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cellKey } from "@jinn-network/benchmarking-records";
import { HarborJobConfigSchema } from "./manifest.js";
import { harborArmJobsDir, observeHarborArmTrials, waitForHarborArmReplacementGrain } from "./arm-job.js";
import { artifactsDir } from "../../workspace/layout.js";
import { armAdd } from "../../operations/arms.js";
import { createDraft } from "../../operations/drafts.js";
import { initWorkspace } from "../../operations/init.js";
import { runCollect } from "../../operations/run-collect.js";
import { runLaunch } from "../../operations/run-launch.js";
import { runLock } from "../../operations/run-lock.js";
import { runQuote } from "../../operations/run-quote.js";
import { selectTerminalBench21Runtime } from "../../operations/terminal-bench-2-1.js";
import { exportHarborHubPackage } from "../../operations/hub-export.js";
import { readRunJournalEntries } from "../../run/journal.js";
import { readRunState } from "../../run/state.js";
import { getSealedBytes } from "../../workspace/sealed-store.js";
import { computeHarbor021TaskContentHash } from "../terminal-bench-2/host.js";
import { TERMINAL_BENCH_2_1_DATASET_ID, TERMINAL_BENCH_2_1_DATASET_REF } from "../terminal-bench-2-1/manifest.js";
import { harborArmFollowUpJobName, harborArmJobName } from "./launcher.js";
import { harborRetrySnapshotDir } from "./retry-bind.js";
import { readHarborDispatchArchive } from "./venue.js";
import type { HarborSelectionManifest } from "./manifest.js";

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

function writeBatchedFakeHarbor(mode: "success" | "retry-first" | "timeout-first" = "success"): string {
  const path = join(root, "harbor");
  writeFileSync(path, `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
if (args[0] === "--version" && args.length === 1) { process.stdout.write("harbor 0.21.4\\n"); process.exit(0); }
if (args[0] !== "run" || args[1] !== "-c" || args.length !== 3) process.exit(64);
writeFileSync(${JSON.stringify(join(root, "harbor-invocations.log"))}, "run\\n", { flag: "a" });
const config = JSON.parse(readFileSync(args[2], "utf8"));
writeFileSync(${JSON.stringify(join(root, "harbor-job-configs.jsonl"))}, JSON.stringify({
  job_name: config.job_name,
  n_attempts: config.n_attempts,
  n_concurrent_trials: config.n_concurrent_trials,
  max_retries: config.retry?.max_retries,
  task_names: config.datasets?.[0]?.task_names,
}) + "\\n", { flag: "a" });
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
try {
function writeTrial(trialName, name, attempt, status, extra = {}) {
  const trial = join(job, trialName);
  mkdirSync(join(trial, "agent"), { recursive: true });
  mkdirSync(join(trial, "verifier"), { recursive: true });
  mkdirSync(join(trial, "artifacts"), { recursive: true });
  writeFileSync(join(trial, "config.json"), JSON.stringify({
    task: { name },
    attempt,
    agent: config.agents[0],
  }));
  writeFileSync(join(trial, "result.json"), JSON.stringify({ id: trialName, status, ...extra }));
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
let index = 0;
let nRetries = 0;
const planned = config.n_attempts > 1;
for (const name of names) {
  for (let attempt = 1; attempt <= config.n_attempts; attempt++) {
    index += 1;
    const trialName = "trial-" + index;
    if (planned && index === 1 && mode === "timeout-first") {
      const once = ${JSON.stringify(join(root, "timeout-once.marker"))};
      try {
        writeFileSync(once, "1", { flag: "wx" });
        writeTrial(trialName, name, attempt, "error", { exception_type: "AgentTimeoutError" });
        sleep(50);
        continue;
      } catch (cause) {
        if (cause.code !== "EEXIST") throw cause;
      }
    }
    if (planned && index === 1 && mode === "retry-first") {
      const once = ${JSON.stringify(join(root, "retry-once.marker"))};
      try {
        writeFileSync(once, "1", { flag: "wx" });
        writeTrial(trialName, name, attempt, "error");
        sleep(200);
        rmSync(join(job, trialName), { recursive: true, force: true });
        nRetries += 1;
        writeTrial(trialName, name, attempt, "success");
        sleep(50);
        continue;
      } catch (cause) {
        if (cause.code !== "EEXIST") throw cause;
      }
    }
    writeTrial(trialName, name, attempt, "success");
    sleep(50);
  }
}
writeFileSync(join(job, "result.json"), JSON.stringify({
  id: config.job_name,
  status: "success",
  finished_at: new Date().toISOString(),
  n_total_trials: index,
  stats: { n_retries: nRetries },
}));
process.stdout.write("fake harbor completed\\n");
} catch (cause) {
  try { writeFileSync(join(job, "harbor-error.txt"), String(cause && cause.stack ? cause.stack : cause)); } catch {}
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

function request() {
  return {
    executable,
    registryMetadataPath: metadataPath,
    datasetRevision: TERMINAL_BENCH_2_1_DATASET_REF,
    taskMaterialPath: materialPath,
    nConcurrent: 1,
    coverage: "one_task" as const,
    arms,
    environment: { type: "docker" as const, image, configuration: {} },
    outputs,
  };
}

function clock(): () => string {
  return () => new Date().toISOString();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harbor-batched-"));
  workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir);
  executable = writeBatchedFakeHarbor();
  metadataPath = join(root, "dataset-metadata.json");
  materialPath = join(root, "selected-dataset");
  writeFixture();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Harbor per-arm batched Job", () => {
  test("refuses Harbor inner retry values other than 0 or 3", () => {
    expect(() => HarborJobConfigSchema.parse({
      job_name: "job",
      jobs_dir: "jobs",
      n_attempts: 5,
      n_concurrent_trials: 1,
      retry: { max_retries: 1 },
      environment: { type: "docker" },
      agents: [{ name: "terminus", model_name: "openai/model-one" }],
      artifacts: [{ source: "/logs/artifacts/prediction.json", destination: "prediction.json" }],
      datasets: [{ path: ".jinn-harbor/dataset", task_names: ["t00"], n_tasks: 1 }],
    })).toThrow();
    expect(HarborJobConfigSchema.parse({
      job_name: "job",
      jobs_dir: "jobs",
      n_attempts: 5,
      n_concurrent_trials: 1,
      retry: { max_retries: 3 },
      environment: { type: "docker" },
      agents: [{ name: "terminus", model_name: "openai/model-one" }],
      artifacts: [{ source: "/logs/artifacts/prediction.json", destination: "prediction.json" }],
      datasets: [{ path: ".jinn-harbor/dataset", task_names: ["t00"], n_tasks: 1 }],
    }).retry.max_retries).toBe(3);
  });

  test("observe-as-start records a Trial mapping when config.json appears", async () => {
    const runSha256 = "ab".repeat(32);
    const selection = "cd".repeat(32);
    const jobName = "jinn-observe";
    const jobRoot = join(root, "job");
    mkdirSync(join(jobRoot, "trial-1"), { recursive: true });
    writeFileSync(join(jobRoot, "trial-1", "config.json"), JSON.stringify({ task: { name: "t00" }, attempt: 2 }));
    writeFileSync(join(jobRoot, "result.json"), JSON.stringify({ id: jobName, n_total_trials: 1, stats: { n_retries: 0 } }));
    await observeHarborArmTrials({
      workspaceDir,
      selectionManifestSha256: selection,
      runSha256,
      armId: "one",
      jobName,
      jobRoot,
      fallbackTaskDigest: "ef".repeat(32),
      taskNameByDigest: { ["ef".repeat(32)]: "t00" },
      timeoutMs: 2_000,
    });
    const mapped = await readdir(join(artifactsDir(workspaceDir), "harbor", "mappings", "by-dispatch"));
    expect(mapped).toHaveLength(1);
  });

  test("observe-as-start binds a wipe-and-recreate retry to dispatch 2 and snapshots dispatch 1", async () => {
    const runSha256 = "ab".repeat(32);
    const selection = "cd".repeat(32);
    const jobName = "jinn-observe-retry";
    const jobRoot = join(root, "job-retry");
    const trial = join(jobRoot, "trial-1");
    const mappingDir = join(artifactsDir(workspaceDir), "harbor", "mappings", "by-dispatch");
    const snapshotPath = join(harborRetrySnapshotDir(workspaceDir, runSha256, cellKey("ef".repeat(32), "one", 1), 1), "retry.json");
    mkdirSync(trial, { recursive: true });
    writeFileSync(join(jobRoot, "config.json"), JSON.stringify({ retry: { max_retries: 3 } }));
    writeFileSync(join(trial, "config.json"), JSON.stringify({ task: { name: "t00" }, attempt: 1 }));
    const observing = observeHarborArmTrials({
      workspaceDir,
      selectionManifestSha256: selection,
      runSha256,
      armId: "one",
      jobName,
      jobRoot,
      fallbackTaskDigest: "ef".repeat(32),
      taskNameByDigest: { ["ef".repeat(32)]: "t00" },
      timeoutMs: 5_000,
    });
    const waitUntil = async (predicate: () => boolean): Promise<void> => {
      const deadline = Date.now() + 3_000;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("timed out waiting for Harbor observer");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitUntil(() => existsSync(mappingDir) && readdirSync(mappingDir).length >= 1);
    writeFileSync(join(trial, "result.json"), JSON.stringify({ id: "trial-1", status: "error" }));
    await waitUntil(() => existsSync(snapshotPath));
    rmSync(trial, { recursive: true, force: true });
    mkdirSync(trial, { recursive: true });
    writeFileSync(join(trial, "config.json"), JSON.stringify({ task: { name: "t00" }, attempt: 1 }));
    writeFileSync(join(trial, "result.json"), JSON.stringify({ id: "trial-1", status: "success" }));
    await waitUntil(() => existsSync(mappingDir) && readdirSync(mappingDir).length >= 2);
    writeFileSync(join(jobRoot, "result.json"), JSON.stringify({ id: jobName, n_total_trials: 1, stats: { n_retries: 1 } }));
    await observing;
    const mapped = await readdir(mappingDir);
    expect(mapped).toHaveLength(2);
    const docs = await Promise.all(mapped.map(async (name) => JSON.parse(await readFile(join(artifactsDir(workspaceDir), "harbor", "mappings", "by-dispatch", name), "utf8")) as { trialId: string; jinnIdentity: string }));
    expect([...docs.map((doc) => doc.trialId)].sort()).toEqual(["trial-1.g1", "trial-1.g2"]);
    expect(docs.some((doc) => doc.jinnIdentity.split(":").at(-1) === "2")).toBe(true);
    expect(existsSync(snapshotPath)).toBe(true);
  });

  test("replacement grain is in-job-retry once dispatch 2 is mapped, else follow-up after the planned job finishes", async () => {
    const plannedRoot = join(root, "planned-job");
    const mappingPath = join(root, "dispatch-2.json");
    mkdirSync(plannedRoot, { recursive: true });
    const pending = waitForHarborArmReplacementGrain({ plannedRoot, mappingPath, timeoutMs: 1_000 });
    writeFileSync(mappingPath, JSON.stringify({ trialId: "trial-1.g2" }));
    await expect(pending).resolves.toBe("in-job-retry");
    const afterJob = waitForHarborArmReplacementGrain({
      plannedRoot,
      mappingPath: join(root, "missing-dispatch-2.json"),
      timeoutMs: 1_000,
    });
    writeFileSync(join(plannedRoot, "result.json"), JSON.stringify({ stats: { n_retries: 0 } }));
    await expect(afterJob).resolves.toBe("follow-up");
  });

  test("1 named task × 2 arms × 5 trials is one Harbor process per arm", async () => {
    const context = { workspaceDir, principal: "sponsor-1", clock: clock() };
    expect(initWorkspace(context).ok).toBe(true);
    expect(createDraft(context, { draftId: "batched", name: "batched" }).ok).toBe(true);
    expect(armAdd(context, { draftId: "batched", armId: "one", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    expect(armAdd(context, { draftId: "batched", armId: "two", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    const selected = await selectTerminalBench21Runtime(context, { draftId: "batched", ...request() });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(selected.result.draft.spec.policy.replacement).toEqual({ allowed: true, maxPerCell: 3 });
    expect((await runQuote(context, { draftId: "batched" })).ok).toBe(true);
    expect(runLock(context, { draftId: "batched" }).ok).toBe(true);
    const launched = await runLaunch(context, { draftId: "batched" });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    const collected = await runCollect(context, { draftId: "batched" });
    expect(collected.ok, JSON.stringify(collected)).toBe(true);

    const invocations = (await readFile(join(root, "harbor-invocations.log"), "utf8")).trim().split("\n").filter(Boolean);
    expect(invocations).toEqual(["run", "run"]);

    const deliveries = readRunJournalEntries(workspaceDir, "batched").filter((entry) => entry.kind === "delivery");
    expect(deliveries).toHaveLength(10);
    const predictions = new Set(deliveries.map((entry) => new TextDecoder().decode(getSealedBytes(workspaceDir, entry.outputs[0]!.sha256))));
    expect(predictions.size).toBe(10);

    const mapped = await readdir(join(artifactsDir(workspaceDir), "harbor", "mappings", "by-dispatch"));
    expect(mapped).toHaveLength(10);

    const indexes = await readdir(join(artifactsDir(workspaceDir), "harbor", "archives", "by-dispatch"));
    expect(indexes).toHaveLength(10);
    for (const name of indexes) {
      const index = JSON.parse(await readFile(join(artifactsDir(workspaceDir), "harbor", "archives", "by-dispatch", name), "utf8")) as { archiveSha256: string };
      const archive = readHarborDispatchArchive(workspaceDir, index.archiveSha256);
      const trialConfigs = archive.nativeArtifacts.filter((item) => /^[^/]+\/config\.json$/u.test(item.path));
      expect(trialConfigs, archive.lineage.cellKey).toHaveLength(1);
    }

    const exported = exportHarborHubPackage(context, { draftId: "batched", armId: "one" });
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    if (!exported.ok) return;
    expect(exported.result.mode).toBe("inspection-upload");
  }, 120_000);

  test("a Harbor-excluded timeout is a new Submission filled by a follow-up Harbor job", async () => {
    executable = writeBatchedFakeHarbor("timeout-first");
    const context = { workspaceDir, principal: "sponsor-1", clock: clock() };
    expect(initWorkspace(context).ok).toBe(true);
    expect(createDraft(context, { draftId: "salvage", name: "salvage" }).ok).toBe(true);
    expect(armAdd(context, { draftId: "salvage", armId: "one", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    expect(armAdd(context, { draftId: "salvage", armId: "two", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    const selected = await selectTerminalBench21Runtime(context, { draftId: "salvage", ...request() });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect((await runQuote(context, { draftId: "salvage" })).ok).toBe(true);
    expect(runLock(context, { draftId: "salvage" }).ok).toBe(true);

    const launched = await runLaunch(context, { draftId: "salvage" });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);

    const events = readRunJournalEntries(workspaceDir, "salvage").filter((entry) => entry.kind === "cell-event");
    const firstError = events.find((entry) => entry.kind === "cell-event" && entry.event.kind === "error" && entry.event.dispatch === 1);
    const firstDispatch = events.find((entry) => entry.kind === "cell-event" && entry.event.kind === "dispatch" && entry.event.dispatch === 1
      && firstError?.kind === "cell-event" && entry.event.cellKey === firstError.event.cellKey);
    const replacementDispatch = events.find((entry) => entry.kind === "cell-event" && entry.event.kind === "dispatch" && entry.event.dispatch === 2);
    const replacementDelivered = events.find((entry) => entry.kind === "cell-event" && entry.event.kind === "delivered" && entry.event.dispatch === 2);
    expect(firstError?.kind === "cell-event" ? firstError.event : undefined).toMatchObject({
      replaceable: true,
      replaceableReason: "unscorable",
    });
    expect(replacementDispatch?.kind === "cell-event" ? replacementDispatch.event.submissionDigest : undefined).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(replacementDispatch?.kind === "cell-event" ? replacementDispatch.event.submissionDigest : undefined)
      .not.toBe(firstDispatch?.kind === "cell-event" ? firstDispatch.event.submissionDigest : undefined);
    expect(replacementDelivered?.kind === "cell-event" ? replacementDelivered.event.attempt : undefined)
      .toBe(replacementDispatch?.kind === "cell-event" ? replacementDispatch.event.attempt : undefined);

    const invocations = (await readFile(join(root, "harbor-invocations.log"), "utf8")).trim().split("\n").filter(Boolean);
    expect(invocations).toHaveLength(3);

    const configs = (await readFile(join(root, "harbor-job-configs.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      job_name: string;
      n_attempts: number;
      n_concurrent_trials: number;
      max_retries: number;
      task_names: string[];
    });
    const runSha256 = readRunState(workspaceDir, "salvage")?.runSha256;
    expect(runSha256).toMatch(/^[a-f0-9]{64}$/u);
    const plannedNames = new Set(arms.map((arm) => harborArmJobName(runSha256!, arm.armId)));
    expect(configs.filter((config) => plannedNames.has(config.job_name))).toHaveLength(2);
    expect(configs.filter((config) => plannedNames.has(config.job_name)).every((config) => config.max_retries === 3)).toBe(true);
    const followUp = configs.find((config) => !plannedNames.has(config.job_name));
    expect(followUp).toMatchObject({
      n_attempts: 1,
      n_concurrent_trials: 1,
      max_retries: 0,
      task_names: ["t00"],
    });
    const submissionSha256 = replacementDispatch?.kind === "cell-event"
      ? replacementDispatch.event.submissionDigest?.slice("sha256:".length)
      : undefined;
    const followUpArm = firstError?.kind === "cell-event" ? firstError.event.armId : "one";
    expect(followUp?.job_name).toBe(harborArmFollowUpJobName(runSha256!, followUpArm, submissionSha256 ?? "", 2));

    const jobsDir = harborArmJobsDir(workspaceDir, runSha256!);
    expect(existsSync(join(jobsDir, harborArmJobName(runSha256!, followUpArm), "result.json"))).toBe(true);
    expect(followUp?.job_name).toBeDefined();
    expect(existsSync(join(jobsDir, followUp!.job_name, "result.json"))).toBe(true);
    expect(readdirSync(jobsDir).filter((name) => !name.endsWith(".leader") && !name.endsWith(".started"))).toEqual(expect.arrayContaining([
      ...plannedNames,
      followUp!.job_name,
    ]));

    const collected = await runCollect(context, { draftId: "salvage" });
    expect(collected.ok, JSON.stringify(collected)).toBe(true);
    const exported = exportHarborHubPackage(context, { draftId: "salvage", armId: followUpArm });
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    if (!exported.ok) return;
    expect(exported.result.mode).toBe("inspection-upload");
    expect(exported.result.jobDir).toBe(join(jobsDir, harborArmJobName(runSha256!, followUpArm)));
  }, 120_000);

  test("a Harbor in-job retry is the next cell dispatch in the planned job", async () => {
    executable = writeBatchedFakeHarbor("retry-first");
    const context = { workspaceDir, principal: "sponsor-1", clock: clock() };
    expect(initWorkspace(context).ok).toBe(true);
    expect(createDraft(context, { draftId: "retry", name: "retry" }).ok).toBe(true);
    expect(armAdd(context, { draftId: "retry", armId: "one", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    expect(armAdd(context, { draftId: "retry", armId: "two", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    const selected = await selectTerminalBench21Runtime(context, { draftId: "retry", ...request() });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect((await runQuote(context, { draftId: "retry" })).ok).toBe(true);
    expect(runLock(context, { draftId: "retry" }).ok).toBe(true);

    const launched = await runLaunch(context, { draftId: "retry" });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);

    const events = readRunJournalEntries(workspaceDir, "retry").filter((entry) => entry.kind === "cell-event");
    const firstError = events.find((entry) => entry.kind === "cell-event" && entry.event.kind === "error" && entry.event.dispatch === 1);
    const firstDispatch = events.find((entry) => entry.kind === "cell-event" && entry.event.kind === "dispatch" && entry.event.dispatch === 1
      && firstError?.kind === "cell-event" && entry.event.cellKey === firstError.event.cellKey);
    const replacementDispatch = events.find((entry) => entry.kind === "cell-event" && entry.event.kind === "dispatch" && entry.event.dispatch === 2);
    const replacementDelivered = events.find((entry) => entry.kind === "cell-event" && entry.event.kind === "delivered" && entry.event.dispatch === 2);
    expect(firstError?.kind === "cell-event" ? firstError.event : undefined).toMatchObject({
      replaceable: true,
      replaceableReason: "unscorable",
    });
    expect(replacementDispatch?.kind === "cell-event" ? replacementDispatch.event.submissionDigest : undefined).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(replacementDispatch?.kind === "cell-event" ? replacementDispatch.event.submissionDigest : undefined)
      .not.toBe(firstDispatch?.kind === "cell-event" ? firstDispatch.event.submissionDigest : undefined);
    expect(replacementDelivered?.kind === "cell-event" ? replacementDelivered.event.attempt : undefined)
      .toBe(replacementDispatch?.kind === "cell-event" ? replacementDispatch.event.attempt : undefined);
    expect(replacementDispatch?.kind === "cell-event" ? replacementDispatch.event.cellKey : undefined)
      .toBe(firstError?.kind === "cell-event" ? firstError.event.cellKey : undefined);
    expect(firstDispatch?.kind === "cell-event" && replacementDispatch?.kind === "cell-event"
      ? firstDispatch.event.replicate === replacementDispatch.event.replicate
      : false).toBe(true);

    const invocations = (await readFile(join(root, "harbor-invocations.log"), "utf8")).trim().split("\n").filter(Boolean);
    expect(invocations).toEqual(["run", "run"]);

    const configs = (await readFile(join(root, "harbor-job-configs.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      job_name: string;
      max_retries: number;
    });
    const runSha256 = readRunState(workspaceDir, "retry")?.runSha256;
    expect(runSha256).toMatch(/^[a-f0-9]{64}$/u);
    const plannedNames = new Set(arms.map((arm) => harborArmJobName(runSha256!, arm.armId)));
    expect(configs.every((config) => plannedNames.has(config.job_name))).toBe(true);
    expect(configs.every((config) => config.max_retries === 3)).toBe(true);

    const jobsDir = harborArmJobsDir(workspaceDir, runSha256!);
    const retryArm = firstError?.kind === "cell-event" ? firstError.event.armId : "one";
    const retryCellKey = firstError?.kind === "cell-event" ? firstError.event.cellKey : "";
    const plannedJob = harborArmJobName(runSha256!, retryArm);
    const jobResult = JSON.parse(await readFile(join(jobsDir, plannedJob, "result.json"), "utf8")) as { stats: { n_retries: number } };
    expect(jobResult.stats.n_retries).toBe(1);
    expect(existsSync(join(harborRetrySnapshotDir(workspaceDir, runSha256!, retryCellKey, 1), "retry.json"))).toBe(true);

    const mapped = await readdir(join(artifactsDir(workspaceDir), "harbor", "mappings", "by-dispatch"));
    const docs = await Promise.all(mapped.map(async (name) => JSON.parse(await readFile(join(artifactsDir(workspaceDir), "harbor", "mappings", "by-dispatch", name), "utf8")) as {
      jinnIdentity: string;
      jobId: string;
      trialId: string;
    }));
    const dispatch2 = docs.filter((doc) => doc.jinnIdentity.split(":").at(-1) === "2");
    expect(dispatch2.length).toBeGreaterThan(0);
    expect(plannedNames.has(dispatch2[0]!.jobId)).toBe(true);
    expect(dispatch2[0]!.trialId).toMatch(/\.g2$/u);

    const collected = await runCollect(context, { draftId: "retry" });
    expect(collected.ok, JSON.stringify(collected)).toBe(true);
    const exported = exportHarborHubPackage(context, { draftId: "retry", armId: retryArm });
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    if (!exported.ok) return;
    expect(exported.result.mode).toBe("inspection-upload");
    expect(exported.result.jobDir).toBe(join(jobsDir, plannedJob));
  }, 120_000);
});
