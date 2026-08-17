import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HarborJobConfigSchema } from "./manifest.js";
import { observeHarborArmTrials } from "./arm-job.js";
import { artifactsDir } from "../../workspace/layout.js";
import { armAdd } from "../../operations/arms.js";
import { createDraft } from "../../operations/drafts.js";
import { initWorkspace } from "../../operations/init.js";
import { runCollect } from "../../operations/run-collect.js";
import { runLaunch } from "../../operations/run-launch.js";
import { runLock } from "../../operations/run-lock.js";
import { runQuote } from "../../operations/run-quote.js";
import { selectTerminalBench21Runtime } from "../../operations/terminal-bench-2-1.js";
import { readRunJournalEntries } from "../../run/journal.js";
import { getSealedBytes } from "../../workspace/sealed-store.js";
import { computeHarbor021TaskContentHash } from "../terminal-bench-2/host.js";
import { TERMINAL_BENCH_2_1_DATASET_ID, TERMINAL_BENCH_2_1_DATASET_REF } from "../terminal-bench-2-1/manifest.js";
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

function writeBatchedFakeHarbor(): string {
  const path = join(root, "harbor");
  writeFileSync(path, `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version" && args.length === 1) { process.stdout.write("harbor 0.21.4\\n"); process.exit(0); }
if (args[0] !== "run" || args[1] !== "-c" || args.length !== 3) process.exit(64);
writeFileSync(${JSON.stringify(join(root, "harbor-invocations.log"))}, "run\\n", { flag: "a" });
const config = JSON.parse(readFileSync(args[2], "utf8"));
if (!Array.isArray(config.datasets) || config.datasets.length !== 1) throw new Error("one DatasetConfig required");
if (config.retry?.max_retries !== 0) throw new Error("hidden retry");
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
  test("refuses Harbor inner retry on a planned multi-trial JobConfig", () => {
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

  test("1 named task × 2 arms × 5 trials is one Harbor process per arm", async () => {
    const context = { workspaceDir, principal: "sponsor-1", clock: clock() };
    expect(initWorkspace(context).ok).toBe(true);
    expect(createDraft(context, { draftId: "batched", name: "batched" }).ok).toBe(true);
    expect(armAdd(context, { draftId: "batched", armId: "one", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    expect(armAdd(context, { draftId: "batched", armId: "two", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    const selected = await selectTerminalBench21Runtime(context, { draftId: "batched", ...request() });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
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
  }, 120_000);
});
