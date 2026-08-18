import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseBenchmark } from "@jinn-network/benchmarking-records";
import { armAdd } from "../../operations/arms.js";
import { createDraft, updateDraft } from "../../operations/drafts.js";
import { initWorkspace } from "../../operations/init.js";
import { runLock } from "../../operations/run-lock.js";
import { runQuote } from "../../operations/run-quote.js";
import { selectTerminalBench21Runtime } from "../../operations/terminal-bench-2-1.js";
import { requireRunState, writeRunState } from "../../run/state.js";
import { getSealedBytes } from "../../workspace/sealed-store.js";
import type { HarborSelectionManifest } from "../harbor/manifest.js";
import { computeHarbor021TaskContentHash } from "../terminal-bench-2/host.js";
import { namedSliceTaskNames } from "../suite-protocol/manifest.js";
import { resolveTerminalBench21Selection } from "./host.js";
import { TERMINAL_BENCH_2_1_DATASET_ID, TERMINAL_BENCH_2_1_DATASET_REF } from "./manifest.js";

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
  let tick = 0;
  const epoch = Date.now();
  return () => new Date(epoch + tick++ * 1_000).toISOString();
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
  root = mkdtempSync(join(tmpdir(), "terminal-bench-2-1-"));
  workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir);
  executable = writeFakeHarbor();
  metadataPath = join(root, "dataset-metadata.json");
  materialPath = join(root, "selected-dataset");
  writeFixture();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Terminal-Bench 2.1 official-suite intake", () => {
  test("named slices are lexicographic first 1 / first 10 / all from the 12-task fixture", () => {
    expect(namedSliceTaskNames([...names], "one_task")).toEqual(["t00"]);
    expect(namedSliceTaskNames([...names], "ten_task")).toEqual([...names.slice(0, 10)]);
    expect(namedSliceTaskNames([...names], "full")).toEqual([...names]);
    const one = resolveTerminalBench21Selection(workspaceDir, request("one_task"));
    expect(one.coverage).toBe("one_task");
    expect(one.selectedTaskNames).toEqual(["t00"]);
    expect(one.profile.execution.maxRetries).toBe(3);
    expect(one.harbor.retryPolicy).toEqual({ nAttempts: 5, nConcurrent: 1, maxRetries: 3 });
    const ten = resolveTerminalBench21Selection(workspaceDir, request("ten_task"));
    expect(ten.coverage).toBe("ten_task");
    expect(ten.selectedTaskNames).toEqual([...names.slice(0, 10)]);
    const full = resolveTerminalBench21Selection(workspaceDir, request("full"));
    expect(full.coverage).toBe("full");
    expect(full.selectedTaskNames).toEqual([...names]);
    const custom = resolveTerminalBench21Selection(workspaceDir, request(undefined, ["t11"]));
    expect(custom.coverage).toBe("custom");
    expect(custom.selectedTaskNames).toEqual(["t11"]);
  });

  test("select seals replicates=5 and one Task per selected name; quote shows 1 × 2 × 5 and two-axis bits", async () => {
    const context = await prepareDraft("one");
    const selected = await selectTerminalBench21Runtime(context, { draftId: "one", ...request("one_task") });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(selected.result.draft.spec.replicates).toBe(5);
    expect(selected.result.draft.spec.policy.replacement).toEqual({ allowed: true, maxPerCell: 3 });
    const benchmark = parseBenchmark(getSealedBytes(workspaceDir, selected.result.benchmarkSha256));
    expect(benchmark.items).toHaveLength(1);
    const quoted = await runQuote(context, { draftId: "one" });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    if (!quoted.ok) return;
    expect(quoted.result.presentation.suite).toEqual({
      executionConformance: true,
      coverage: "one_task",
      leaderboardSubmitReady: false,
      methodLeaderboardEligible: false,
      cellCount: "1 × 2 × 5",
      harborVersion: "0.21.4",
      selectedTaskCount: 1,
      armCount: 2,
      replicates: 5,
    });
    expect(requireRunState(workspaceDir, "one").suiteQuote?.leaderboardSubmitReady).toBe(false);
  }, 60_000);

  test("ten_task and full slices seal the named membership; custom cannot be leaderboard-ready", async () => {
    const tenContext = await prepareDraft("ten");
    const ten = await selectTerminalBench21Runtime(tenContext, { draftId: "ten", ...request("ten_task") });
    expect(ten.ok, JSON.stringify(ten)).toBe(true);
    if (!ten.ok) return;
    expect(parseBenchmark(getSealedBytes(workspaceDir, ten.result.benchmarkSha256)).items).toHaveLength(10);
    const tenQuoted = await runQuote(tenContext, { draftId: "ten" });
    expect(tenQuoted.ok, JSON.stringify(tenQuoted)).toBe(true);
    if (!tenQuoted.ok) return;
    expect(tenQuoted.result.presentation.suite).toMatchObject({ coverage: "ten_task", leaderboardSubmitReady: false, cellCount: "10 × 2 × 5" });

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir);
    const customContext = await prepareDraft("custom");
    const custom = await selectTerminalBench21Runtime(customContext, { draftId: "custom", ...request(undefined, ["t11"]) });
    expect(custom.ok, JSON.stringify(custom)).toBe(true);
    if (!custom.ok) return;
    const customQuoted = await runQuote(customContext, { draftId: "custom" });
    expect(customQuoted.ok, JSON.stringify(customQuoted)).toBe(true);
    if (!customQuoted.ok) return;
    expect(customQuoted.result.presentation.suite).toMatchObject({ coverage: "custom", leaderboardSubmitReady: false, cellCount: "1 × 2 × 5" });
  }, 120_000);

  test("full coverage quote is method-eligible and not leaderboard_submit_ready; lock without those quote bits refuses", async () => {
    const context = await prepareDraft("full");
    const selected = await selectTerminalBench21Runtime(context, { draftId: "full", ...request("full") });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(parseBenchmark(getSealedBytes(workspaceDir, selected.result.benchmarkSha256)).items).toHaveLength(12);
    const quoted = await runQuote(context, { draftId: "full" });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    if (!quoted.ok) return;
    expect(quoted.result.presentation.suite).toMatchObject({
      coverage: "full",
      executionConformance: true,
      leaderboardSubmitReady: false,
      methodLeaderboardEligible: true,
      cellCount: "12 × 2 × 5",
    });
    expect(requireRunState(workspaceDir, "full").suiteQuote?.leaderboardSubmitReady).toBe(false);
    const locked = runLock(context, { draftId: "full" });
    expect(locked.ok, JSON.stringify(locked)).toBe(true);

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir);
    const refuseContext = await prepareDraft("full-refuse");
    const refuseSelected = await selectTerminalBench21Runtime(refuseContext, { draftId: "full-refuse", ...request("full") });
    expect(refuseSelected.ok, JSON.stringify(refuseSelected)).toBe(true);
    if (!refuseSelected.ok) return;
    const refuseQuoted = await runQuote(refuseContext, { draftId: "full-refuse" });
    expect(refuseQuoted.ok, JSON.stringify(refuseQuoted)).toBe(true);
    const quotedState = requireRunState(workspaceDir, "full-refuse");
    const { suiteQuote: _omitted, ...withoutQuote } = quotedState;
    writeRunState(workspaceDir, "full-refuse", withoutQuote);
    const refused = runLock(refuseContext, { draftId: "full-refuse" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.detail).toMatch(/comparability bits/u);
  }, 120_000);

  test("lock refuses when replicates was edited after select away from the sealed suite k", async () => {
    const context = await prepareDraft("edited-k");
    const selected = await selectTerminalBench21Runtime(context, { draftId: "edited-k", ...request("one_task") });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(selected.result.draft.spec.replicates).toBe(5);
    expect(updateDraft(context, { draftId: "edited-k", patch: { replicates: 1 } }).ok).toBe(true);
    const quoted = await runQuote(context, { draftId: "edited-k" });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    const locked = runLock(context, { draftId: "edited-k" });
    expect(locked.ok).toBe(false);
    if (locked.ok) return;
    expect(locked.error.code).toBe("conflict");
    expect(locked.error.detail).toMatch(/replicates/u);
  }, 60_000);

  test("official suite refuses a replacement budget below Harbor max_retries 3", async () => {
    const context = await prepareDraft("small-budget");
    expect(updateDraft(context, {
      draftId: "small-budget",
      patch: { policy: { completenessFloor: "1", cellWindowMs: 3_600_000, closeAfterMs: 86_400_000, replacement: { allowed: true, maxPerCell: 1 } } },
    }).ok).toBe(true);
    const selected = await selectTerminalBench21Runtime(context, { draftId: "small-budget", ...request("one_task") });
    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.error.detail).toMatch(/maxPerCell of at least 3/u);
  }, 30_000);

  test("official suite refuses binary-instrument majority-k", async () => {
    const context = await prepareDraft("binary");
    expect(updateDraft(context, {
      draftId: "binary",
      patch: { analysis: { method: "jinn.benchmarking.method/binary-instrument", version: "1" } },
    }).ok).toBe(true);
    const selected = await selectTerminalBench21Runtime(context, { draftId: "binary", ...request("one_task") });
    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.error.detail).toMatch(/binary-instrument/u);
  }, 30_000);

  test("explicit full coverage on a 1-task snapshot stays full and is not quote-ready", async () => {
    writeFileSync(metadataPath, JSON.stringify({
      name: TERMINAL_BENCH_2_1_DATASET_ID,
      dataset_version_content_hash: TERMINAL_BENCH_2_1_DATASET_REF,
      task_ids: [{
        org: "terminal-bench",
        name: "t00",
        ref: `sha256:${computeHarbor021TaskContentHash(join(materialPath, "t00")).contentHash}`,
      }],
    }));
    const context = await prepareDraft("mini-full");
    const selected = await selectTerminalBench21Runtime(context, { draftId: "mini-full", ...request("full") });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(parseBenchmark(getSealedBytes(workspaceDir, selected.result.benchmarkSha256)).items).toHaveLength(1);
    const quoted = await runQuote(context, { draftId: "mini-full" });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    if (!quoted.ok) return;
    expect(quoted.result.presentation.suite).toMatchObject({
      coverage: "full",
      executionConformance: true,
      leaderboardSubmitReady: false,
      methodLeaderboardEligible: true,
      selectedTaskCount: 1,
      cellCount: "1 × 2 × 5",
    });
  }, 60_000);
});
