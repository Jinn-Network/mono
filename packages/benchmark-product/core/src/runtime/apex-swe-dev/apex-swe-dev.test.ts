import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cellKey, parseBenchmark } from "@jinn-network/benchmarking-records";
import { armAdd } from "../../operations/arms.js";
import { createDraft } from "../../operations/drafts.js";
import { exportApexSwePackage, decideApexSweExportMode } from "../../operations/apex-swe-export.js";
import { initWorkspace } from "../../operations/init.js";
import { runLock } from "../../operations/run-lock.js";
import { runQuote } from "../../operations/run-quote.js";
import { selectApexSweDevRuntime } from "../../operations/apex-swe-dev.js";
import { requireRunState, writeRunState } from "../../run/state.js";
import { getSealedBytes } from "../../workspace/sealed-store.js";
import { namedSliceTaskNames } from "../suite-protocol/manifest.js";
import { suiteFactsFromAccountedApexSweDevRun } from "../suite-protocol/from-apex.js";
import { isGitLfsPointerBytes, resolveApexSweDevSelection } from "./host.js";
import { collectApexSweDevCells, launchApexSweDev } from "./launcher.js";
import {
  APEX_SWE_DEV_ADAPTER_ID,
  APEX_SWE_DEV_DATASET_ID,
  APEX_SWE_DEV_DATASET_REVISION,
  ApexSweDevSelectionManifestSchema,
} from "./manifest.js";
import { harnessReportPath } from "./reports.js";

function officialFifty(): { taskId: string; taskType: "integration" | "observability" }[] {
  const observability = Array.from({ length: 25 }, (_, index) => ({
    taskId: `0xobs-${String(index).padStart(2, "0")}`,
    taskType: "observability" as const,
  }));
  const integration = Array.from({ length: 25 }, (_, index) => ({
    taskId: `1-int-${String(index).padStart(2, "0")}`,
    taskType: "integration" as const,
  }));
  return [...observability, ...integration];
}

const fifty = officialFifty();
const names = fifty.map((task) => task.taskId);

let root: string;
let workspaceDir: string;
let apx: string;
let python: string;
let metadataPath: string;
let integrationTasksDir: string;
let observabilityProjectDir: string;

function writeFakeApx(): string {
  const path = join(root, "apx");
  writeFileSync(path, `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version" && args.length === 1) { process.stdout.write("apx 0.0.0-test\\n"); process.exit(0); }
const nTrials = args[args.indexOf("--n-trials") + 1];
const timeout = args[args.indexOf("--timeout") + 1];
if (nTrials !== "1" || timeout !== "3600") process.exit(2);
const taskId = args[args.indexOf("--tasks") + 1];
const reportRoot = process.env.COLOPHON_APEX_SWE_DEV_REPORT_ROOT || process.cwd();
const dir = join(reportRoot, "integration", taskId);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "results.json"), JSON.stringify({ passed: true, task_id: taskId }));
process.exit(0);
`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function writeFakePython(): string {
  const path = join(root, "python");
  writeFileSync(path, `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "-c" && String(args[1]).includes("inspect_ai")) { process.stdout.write("0.3.160\\n"); process.exit(0); }
const trial = args[args.indexOf("--trial") + 1];
const timeLimit = args[args.indexOf("--time-limit") + 1];
const messageLimit = args[args.indexOf("--message-limit") + 1];
if (trial !== "1" || timeLimit !== "3600" || messageLimit !== "250") process.exit(2);
const output = args[args.indexOf("--output") + 1];
if (!output || output.startsWith("--")) process.exit(2);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ passed: true, f2p_passed: 1, p2p_passed: 1 }));
process.exit(0);
`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function writeFixture(): void {
  writeFileSync(metadataPath, JSON.stringify({
    name: APEX_SWE_DEV_DATASET_ID,
    revision: APEX_SWE_DEV_DATASET_REVISION,
    tasks: fifty,
  }));
  mkdirSync(integrationTasksDir, { recursive: true });
  mkdirSync(observabilityProjectDir, { recursive: true });
  writeFileSync(join(observabilityProjectDir, "run_e2e.py"), "# mercor observability entry\n");
}

function request(coverage?: "one_task" | "ten_task" | "full", taskIds?: readonly string[]) {
  return {
    apxExecutable: apx,
    pythonExecutable: python,
    registryMetadataPath: metadataPath,
    integrationTasksDir,
    observabilityProjectDir,
    arms: [
      { armId: "one", modelNameOrPath: "one" },
      { armId: "two", modelNameOrPath: "two" },
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
  root = mkdtempSync(join(tmpdir(), "apex-swe-dev-"));
  workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir);
  apx = writeFakeApx();
  python = writeFakePython();
  metadataPath = join(root, "dataset-metadata.json");
  integrationTasksDir = join(root, "Integration");
  observabilityProjectDir = join(root, "observability");
  writeFixture();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("APEX-SWE-dev official-suite intake", () => {
  test("named slices are lexicographic first 1 / first 10 / all from the 50-task public pin", () => {
    expect(namedSliceTaskNames(names, "one_task")).toEqual(["0xobs-00"]);
    expect(namedSliceTaskNames(names, "ten_task")).toEqual(names.slice(0, 10));
    expect(namedSliceTaskNames(names, "full")).toEqual([...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
    const one = resolveApexSweDevSelection(workspaceDir, request("one_task"));
    expect(one.coverage).toBe("one_task");
    expect(one.selectedTasks).toEqual([{ taskId: "0xobs-00", taskType: "observability" }]);
    expect(one.harness.adapterId).toBe(APEX_SWE_DEV_ADAPTER_ID);
    expect(one.harness.timeoutSeconds).toBe(3600);
    expect(one.harness.nTrials).toBe(1);
    const ten = resolveApexSweDevSelection(workspaceDir, request("ten_task"));
    expect(ten.coverage).toBe("ten_task");
    expect(ten.selectedTasks.map((task) => task.taskId)).toEqual(names.slice(0, 10));
    const full = resolveApexSweDevSelection(workspaceDir, request("full"));
    expect(full.coverage).toBe("full");
    expect(full.selectedTasks).toHaveLength(50);
    const custom = resolveApexSweDevSelection(workspaceDir, request(undefined, ["1-int-24"]));
    expect(custom.coverage).toBe("custom");
    expect(custom.selectedTasks).toEqual([{ taskId: "1-int-24", taskType: "integration" }]);
  });

  test("Git LFS pointers and cousin executables fail closed", () => {
    writeFileSync(join(integrationTasksDir, "pointer.bin"), "version https://git-lfs.github.com/spec/v1\noid sha256:aa\nsize 1\n");
    expect(isGitLfsPointerBytes(new TextEncoder().encode("version https://git-lfs.github.com/spec/v1\n"))).toBe(true);
    expect(() => resolveApexSweDevSelection(workspaceDir, request("one_task"))).toThrow(/Git LFS pointer/u);
    rmSync(join(integrationTasksDir, "pointer.bin"));
    const harbor = join(root, "harbor-cousin");
    writeFileSync(harbor, `#!/usr/bin/env node
process.stdout.write("harbor 0.21.4\\n");
`, { mode: 0o700 });
    chmodSync(harbor, 0o700);
    expect(() => resolveApexSweDevSelection(workspaceDir, { ...request("one_task"), apxExecutable: harbor })).toThrow(/Harbor/u);
    const inspect = join(root, "inspect");
    writeFileSync(inspect, `#!/usr/bin/env node
process.stdout.write("0.3.255\\n");
`, { mode: 0o700 });
    chmodSync(inspect, 0o700);
    expect(() => resolveApexSweDevSelection(workspaceDir, { ...request("one_task"), pythonExecutable: inspect })).toThrow(/Inspect/u);
  });

  test("select seals replicates=1 and apex-swe-dev; quote shows 1 × 2 × 1 and never leaderboard-ready", async () => {
    const context = await prepareDraft("one");
    const selected = await selectApexSweDevRuntime(context, { draftId: "one", ...request("one_task") });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(selected.result.draft.spec.replicates).toBe(1);
    expect(selected.result.draft.spec.evaluationRuntime?.adapterId).toBe(APEX_SWE_DEV_ADAPTER_ID);
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
      harborVersion: "0.0.0-test",
      selectedTaskCount: 1,
      armCount: 2,
      replicates: 1,
    });
    expect(requireRunState(workspaceDir, "one").suiteQuote?.leaderboardSubmitReady).toBe(false);
  }, 60_000);

  test("full coverage quote is never method-eligible; lock without quote bits refuses", async () => {
    const context = await prepareDraft("full");
    const selected = await selectApexSweDevRuntime(context, { draftId: "full", ...request("full") });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(parseBenchmark(getSealedBytes(workspaceDir, selected.result.benchmarkSha256)).items).toHaveLength(50);
    const quoted = await runQuote(context, { draftId: "full" });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    if (!quoted.ok) return;
    expect(quoted.result.presentation.suite).toMatchObject({
      coverage: "full",
      executionConformance: true,
      leaderboardSubmitReady: false,
      methodLeaderboardEligible: false,
      cellCount: "50 × 2 × 1",
    });
    expect(requireRunState(workspaceDir, "full").suiteQuote?.leaderboardSubmitReady).toBe(false);
    const locked = runLock(context, { draftId: "full" });
    expect(locked.ok, JSON.stringify(locked)).toBe(true);

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir);
    const refuseContext = await prepareDraft("full-refuse");
    const refuseSelected = await selectApexSweDevRuntime(refuseContext, { draftId: "full-refuse", ...request("full") });
    expect(refuseSelected.ok, JSON.stringify(refuseSelected)).toBe(true);
    if (!refuseSelected.ok) return;
    const refuseQuoted = await runQuote(refuseContext, { draftId: "full-refuse" });
    expect(refuseQuoted.ok).toBe(true);
    const quotedState = requireRunState(workspaceDir, "full-refuse");
    const { suiteQuote: _omitted, ...withoutQuote } = quotedState;
    writeRunState(workspaceDir, "full-refuse", withoutQuote);
    const refused = runLock(refuseContext, { draftId: "full-refuse" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.detail).toMatch(/comparability bits/u);
  }, 180_000);
});

describe("APEX-SWE-dev dual harness and export", () => {
  test("fake apx and run_e2e write passed JSON; missing JSON is unscorable; export is inspection-upload never submit", async () => {
    const context = await prepareDraft("grade");
    const selected = await selectApexSweDevRuntime(context, { draftId: "grade", ...request(undefined, ["1-int-00", "0xobs-00"]) });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect((await runQuote(context, { draftId: "grade" })).ok).toBe(true);
    const manifest = ApexSweDevSelectionManifestSchema.parse(
      JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(workspaceDir, selected.result.selectionManifestSha256))),
    );
    expect(manifest.suite.coverage).toBe("custom");
    const reportRoot = join(root, "harness-out");
    launchApexSweDev({
      manifest,
      binding: { apxExecutable: apx, pythonExecutable: python, integrationTasksDir, observabilityProjectDir },
      reportRoot,
      modelNameOrPath: "one",
    });
    expect(harnessReportPath({ reportRoot, taskId: "1-int-00", taskType: "integration" })).toMatch(/results\.json$/u);
    const cells = collectApexSweDevCells({ reportRoot, tasks: manifest.selectedTasks });
    expect(cells).toEqual([
      { taskId: "1-int-00", passed: true, outcome: "judged" },
      { taskId: "0xobs-00", passed: true, outcome: "judged" },
    ]);
    expect(collectApexSweDevCells({ reportRoot, tasks: [{ taskId: "missing", taskType: "integration" }] })).toEqual([
      { taskId: "missing", passed: undefined, outcome: "unscorable" },
    ]);
    const matrix = {
      cells: manifest.suite.items.flatMap((item) => ["one", "two"].map((armId) => ({
        cellKey: cellKey(item.taskSha256, armId, 1),
        taskDigest: item.taskSha256,
        armId,
        replicate: 1,
        outcome: "judged" as const,
      }))),
    };
    const facts = suiteFactsFromAccountedApexSweDevRun({
      manifest,
      armCount: 2,
      itemCount: 2,
      replicates: 1,
      matrix,
      armIds: ["one", "two"],
      reportRoot,
    });
    expect(facts.quote.leaderboardSubmitReady).toBe(false);
    expect(facts.limitation).toMatch(/200-task APEX-SWE leaderboard/u);
    expect(decideApexSweExportMode({
      executionConformance: true,
      coverage: "full",
      leaderboardSubmitReady: true,
    })).toBe("refused");
    expect(decideApexSweExportMode({
      executionConformance: true,
      coverage: "one_task",
      leaderboardSubmitReady: false,
    })).toBe("inspection-upload");
    expect(decideApexSweExportMode({
      executionConformance: true,
      coverage: "custom",
      leaderboardSubmitReady: false,
    })).toBe("refused");

    const namedContext = { workspaceDir, principal: "sponsor-1", clock: clock() };
    expect(createDraft(namedContext, { draftId: "named-export", name: "named-export" }).ok).toBe(true);
    expect(armAdd(namedContext, { draftId: "named-export", armId: "one", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    expect(armAdd(namedContext, { draftId: "named-export", armId: "two", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    const namedSelected = await selectApexSweDevRuntime(namedContext, { draftId: "named-export", ...request("one_task") });
    expect(namedSelected.ok, JSON.stringify(namedSelected)).toBe(true);
    if (!namedSelected.ok) return;
    expect((await runQuote(namedContext, { draftId: "named-export" })).ok).toBe(true);
    const exported = exportApexSwePackage(namedContext, { draftId: "named-export", armId: "one" });
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    if (!exported.ok) return;
    expect(exported.result.mode).toBe("inspection-upload");
    expect(exported.result.instructions).toMatch(/do not claim a Mercor APEX-SWE leaderboard row/i);

    const customExport = exportApexSwePackage(context, { draftId: "grade", armId: "one" });
    expect(customExport.ok).toBe(false);
  }, 120_000);

  test("operator qualify script fails closed without COLOPHON_APEX_SWE_DEV_ONE_TASK_QUALIFY=1", () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/apex-swe-dev-one-task-qualify.mjs");
    const source = readFileSync(script, "utf8");
    expect(source).not.toMatch(/huggingface-cli|git lfs pull|docker compose|huggingface\.co\/datasets/iu);
    const spawned = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, COLOPHON_APEX_SWE_DEV_ONE_TASK_QUALIFY: "" },
    });
    expect(spawned.status).toBe(2);
    expect(`${spawned.stderr}${spawned.stdout}`).toMatch(/COLOPHON_APEX_SWE_DEV_ONE_TASK_QUALIFY/u);
    expect(`${spawned.stderr}${spawned.stdout}`).not.toMatch(/huggingface-cli|git lfs pull|compose/iu);
  });
});
