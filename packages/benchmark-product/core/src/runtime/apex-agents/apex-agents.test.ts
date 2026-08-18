import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cellKey, parseBenchmark } from "@jinn-network/benchmarking-records";
import { armAdd } from "../../operations/arms.js";
import { createDraft } from "../../operations/drafts.js";
import { exportApexAgentsInspection } from "../../operations/apex-agents-export.js";
import { initWorkspace } from "../../operations/init.js";
import { runLock } from "../../operations/run-lock.js";
import { runQuote } from "../../operations/run-quote.js";
import { selectApexAgentsRuntime } from "../../operations/apex-agents.js";
import { requireRunState, writeRunState } from "../../run/state.js";
import { getSealedBytes } from "../../workspace/sealed-store.js";
import { namedSliceTaskNames } from "../suite-protocol/manifest.js";
import { suiteFactsFromAccountedApexRun } from "../suite-protocol/from-apex.js";
import { resolveApexAgentsSelection } from "./host.js";
import {
  archipelagoModelId,
  archipelagoRunId,
  launchArchipelago,
  resolveArchipelagoRunId,
} from "./launcher.js";
import {
  ARCHIPELAGO_ADAPTER_ID,
  ARCHIPELAGO_COMMIT_PIN,
  APEX_AGENTS_DATASET_ID,
  APEX_AGENTS_DATASET_REVISION,
  APEX_AGENTS_DEFAULT_TIMEOUT_SECONDS,
  ApexAgentsSelectionManifestSchema,
} from "./manifest.js";
import { archipelagoGradePath } from "./grades.js";

const names = ["task_00", "task_01", "task_02", "task_03", "task_04", "task_05", "task_06", "task_07", "task_08", "task_09", "task_10", "task_11"] as const;

let root: string;
let workspaceDir: string;
let executable: string;
let metadataPath: string;

function writeFakeArchipelago(): string {
  const path = join(root, "archipelago");
  writeFileSync(path, `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version" && args.length === 1) {
  process.stdout.write("${ARCHIPELAGO_COMMIT_PIN}\\n");
  process.exit(0);
}
const ids = [];
const start = args.indexOf("--task-ids") + 1;
for (let i = start; i < args.length && !String(args[i]).startsWith("--"); i += 1) ids.push(args[i]);
const reportRoot = process.env.COLOPHON_APEX_REPORT_ROOT || process.cwd();
for (const taskId of ids) {
  const dir = join(reportRoot, "output", taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "grades.json"), JSON.stringify({ task_id: taskId, passed: false }));
}
process.exit(0);
`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function writeFixture(taskIds: readonly string[] = names): void {
  writeFileSync(metadataPath, JSON.stringify({
    name: APEX_AGENTS_DATASET_ID,
    revision: APEX_AGENTS_DATASET_REVISION,
    task_ids: [...taskIds],
  }));
}

function request(coverage?: "one_task" | "ten_task" | "full", taskIds?: readonly string[]) {
  return {
    executable,
    registryMetadataPath: metadataPath,
    arms: [
      { armId: "one", modelId: "one" },
      { armId: "two", modelId: "two" },
    ],
    ...(coverage === undefined ? {} : { coverage }),
    ...(taskIds === undefined ? {} : { taskIds }),
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
  root = mkdtempSync(join(tmpdir(), "apex-agents-"));
  workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir);
  executable = writeFakeArchipelago();
  metadataPath = join(root, "dataset-metadata.json");
  writeFixture();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("APEX-Agents official-suite intake", () => {
  test("named slices are lexicographic first 1 / first 10 / all from the 12-task fixture", () => {
    expect(namedSliceTaskNames([...names], "one_task")).toEqual(["task_00"]);
    expect(namedSliceTaskNames([...names], "ten_task")).toEqual([...names.slice(0, 10)]);
    expect(namedSliceTaskNames([...names], "full")).toEqual([...names]);
    const one = resolveApexAgentsSelection(workspaceDir, request("one_task"));
    expect(one.coverage).toBe("one_task");
    expect(one.selectedTaskIds).toEqual(["task_00"]);
    expect(one.archipelago.adapterId).toBe(ARCHIPELAGO_ADAPTER_ID);
    expect(one.archipelago.timeoutSeconds).toBe(APEX_AGENTS_DEFAULT_TIMEOUT_SECONDS);
    expect(one.archipelago.maxSteps).toBe(250);
    const ten = resolveApexAgentsSelection(workspaceDir, request("ten_task"));
    expect(ten.coverage).toBe("ten_task");
    expect(ten.selectedTaskIds).toEqual([...names.slice(0, 10)]);
    const full = resolveApexAgentsSelection(workspaceDir, request("full"));
    expect(full.coverage).toBe("full");
    expect(full.selectedTaskIds).toEqual([...names]);
    const custom = resolveApexAgentsSelection(workspaceDir, request(undefined, ["task_11"]));
    expect(custom.coverage).toBe("custom");
    expect(custom.selectedTaskIds).toEqual(["task_11"]);
  });

  test("select seals replicates=1 and archipelago; quote shows 1 × 2 × 1 and two-axis bits", async () => {
    const context = await prepareDraft("one");
    const selected = await selectApexAgentsRuntime(context, { draftId: "one", ...request("one_task") });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(selected.result.draft.spec.replicates).toBe(1);
    expect(selected.result.draft.spec.evaluationRuntime?.adapterId).toBe(ARCHIPELAGO_ADAPTER_ID);
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
      cellCount: "1 × 2 × 1",
      harnessVersion: ARCHIPELAGO_COMMIT_PIN,
      selectedTaskCount: 1,
      armCount: 2,
      replicates: 1,
    });
    expect(requireRunState(workspaceDir, "one").suiteQuote?.leaderboardSubmitReady).toBe(false);
  }, 60_000);

  test("full coverage quote is method-eligible and not leaderboard_submit_ready; lock without those quote bits refuses", async () => {
    const context = await prepareDraft("full");
    const selected = await selectApexAgentsRuntime(context, { draftId: "full", ...request("full") });
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
      cellCount: "12 × 2 × 1",
    });
    expect(requireRunState(workspaceDir, "full").suiteQuote?.leaderboardSubmitReady).toBe(false);
    const locked = runLock(context, { draftId: "full" });
    expect(locked.ok, JSON.stringify(locked)).toBe(true);

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir);
    const refuseContext = await prepareDraft("full-refuse");
    const refuseSelected = await selectApexAgentsRuntime(refuseContext, { draftId: "full-refuse", ...request("full") });
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
});

describe("APEX-Agents Archipelago grade and export", () => {
  test("fake Archipelago writes grades.json; fixture-full collect bits become ready only with accounted cells and grades", async () => {
    writeFixture(["task_00"]);
    const context = await prepareDraft("ready");
    const selected = await selectApexAgentsRuntime(context, { draftId: "ready", ...request("full") });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect((await runQuote(context, { draftId: "ready" })).ok).toBe(true);
    expect(requireRunState(workspaceDir, "ready").suiteQuote?.leaderboardSubmitReady).toBe(false);
    const manifest = ApexAgentsSelectionManifestSchema.parse(
      JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(workspaceDir, selected.result.selectionManifestSha256))),
    );
    const reportRoot = join(root, "archipelago-out");
    const taskIdsSha256 = "b".repeat(64);
    const runId = archipelagoRunId("a".repeat(64), taskIdsSha256);
    const matrix = {
      cells: manifest.suite.items.flatMap((item) => ["one", "two"].map((armId) => ({
        cellKey: cellKey(item.taskSha256, armId, 1),
        taskDigest: item.taskSha256,
        armId,
        replicate: 1,
        outcome: "judged" as const,
      }))),
    };
    const withoutGrades = suiteFactsFromAccountedApexRun({
      manifest,
      armCount: 2,
      itemCount: 1,
      replicates: 1,
      matrix,
      armIds: ["one", "two"],
      reportRoot,
    });
    expect(withoutGrades.quote.leaderboardSubmitReady).toBe(false);
    launchArchipelago({
      manifest,
      binding: { executable },
      reportRoot,
      runId,
      taskIds: ["task_00"],
    });
    expect(resolveArchipelagoRunId(reportRoot, "a".repeat(64))).toBe(runId);
    expect(archipelagoGradePath({ reportRoot, taskId: "task_00" })).toMatch(/grades\.json$/u);
    expect(archipelagoModelId({ armId: "solver", pinning: { model: { id: "acme-model" } } })).toBe("acme-model");
    expect(archipelagoModelId({ armId: "solver", pinning: { harness: { id: "archipelago" } } })).toBe("solver");
    const ready = suiteFactsFromAccountedApexRun({
      manifest,
      armCount: 2,
      itemCount: 1,
      replicates: 1,
      matrix,
      armIds: ["one", "two"],
      reportRoot,
    });
    expect(ready.quote.leaderboardSubmitReady).toBe(true);
    expect(ready.limitation).toBeUndefined();
  }, 60_000);

  test("named-slice export is inspection-only; custom and cousin refuse the APEX-Agents name", async () => {
    const context = await prepareDraft("one");
    expect((await selectApexAgentsRuntime(context, { draftId: "one", ...request("one_task") })).ok).toBe(true);
    expect((await runQuote(context, { draftId: "one" })).ok).toBe(true);
    const exported = exportApexAgentsInspection(context, { draftId: "one", armId: "one" });
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    if (!exported.ok) return;
    expect(exported.result.mode).toBe("inspection-upload");
    expect(exported.result.instructions).toMatch(/APEX-Agents/u);
    expect(exported.result.instructions).not.toMatch(/Terminal-Bench/u);
    expect(exported.result.instructions).not.toMatch(/SWE-bench/u);
    expect(exported.result.instructions).toContain("Colophon does not place the Mercor");

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir);
    const customContext = await prepareDraft("custom");
    expect((await selectApexAgentsRuntime(customContext, { draftId: "custom", ...request(undefined, ["task_11"]) })).ok).toBe(true);
    expect((await runQuote(customContext, { draftId: "custom" })).ok).toBe(true);
    const custom = exportApexAgentsInspection(customContext, { draftId: "custom", armId: "one" });
    expect(custom.ok).toBe(false);
    if (custom.ok) return;
    expect(custom.error.detail).toMatch(/APEX-Agents suite name/u);

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir);
    const cousin = await prepareDraft("cousin");
    const refused = exportApexAgentsInspection(cousin, { draftId: "cousin", armId: "one" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.detail).toMatch(/archipelago|APEX-Agents/u);
  }, 120_000);
});
