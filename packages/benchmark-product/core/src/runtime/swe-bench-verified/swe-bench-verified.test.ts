import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cellKey, parseBenchmark } from "@jinn-network/benchmarking-records";
import { armAdd } from "../../operations/arms.js";
import { createDraft } from "../../operations/drafts.js";
import { exportSwebenchPredictions } from "../../operations/swebench-export.js";
import { initWorkspace } from "../../operations/init.js";
import { runLock } from "../../operations/run-lock.js";
import { runQuote } from "../../operations/run-quote.js";
import { selectSwebenchVerifiedRuntime } from "../../operations/swe-bench-verified.js";
import { requireRunState, writeRunState } from "../../run/state.js";
import { exportCompletenessCertification } from "../suite-protocol/comparability.js";
import { getSealedBytes } from "../../workspace/sealed-store.js";
import { namedSliceTaskNames } from "../suite-protocol/manifest.js";
import { suiteFactsFromAccountedSwebenchRun, suiteQuoteFromSwebench } from "../suite-protocol/from-swebench.js";
import { resolveSwebenchVerifiedSelection } from "./host.js";
import {
  launchSwebenchHarness,
  resolveSwebenchHarnessRunId,
  swebenchHarnessRunIdPath,
  swebenchModelNameOrPath,
  swebenchPredictionsPath,
  writePredictionsJsonl,
  swebenchRunId,
} from "./launcher.js";
import { SWE_BENCH_HARNESS_ADAPTER_ID, SWE_BENCH_VERIFIED_DATASET_ID, SWE_BENCH_VERIFIED_DATASET_REVISION, SwebenchVerifiedSelectionManifestSchema } from "./manifest.js";
import { harnessReportPath } from "./reports.js";

const names = ["inst00", "inst01", "inst02", "inst03", "inst04", "inst05", "inst06", "inst07", "inst08", "inst09", "inst10", "inst11"] as const;

let root: string;
let workspaceDir: string;
let executable: string;
let metadataPath: string;

function writeFakeHarness(): string {
  const path = join(root, "swebench");
  writeFileSync(path, `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "-c" && args.length === 2) {
  if (!String(args[1]).includes("swebench.__version__")) process.exit(64);
  process.stdout.write("4.1.0\\n");
  process.exit(0);
}
// The documented executable is python3: --version reports the interpreter, never the harness.
if (args[0] === "--version" && args.length === 1) { process.stdout.write("Python 3.12.4\\n"); process.exit(0); }
const runId = args[args.indexOf("--run_id") + 1];
const ids = [];
const start = args.indexOf("--instance_ids") + 1;
for (let i = start; i < args.length && !String(args[i]).startsWith("--"); i += 1) ids.push(args[i]);
const reportRoot = process.env.COLOPHON_SWEBENCH_REPORT_ROOT || process.cwd();
for (const instanceId of ids) {
  const dir = join(reportRoot, "logs", "run_evaluation", runId, "one", instanceId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.json"), JSON.stringify({ instance_id: instanceId, resolved: false }));
}
process.exit(0);
`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function writeFixture(instanceIds: readonly string[] = names): void {
  writeFileSync(metadataPath, JSON.stringify({
    name: SWE_BENCH_VERIFIED_DATASET_ID,
    revision: SWE_BENCH_VERIFIED_DATASET_REVISION,
    instance_ids: [...instanceIds],
  }));
}

function request(coverage?: "one_task" | "ten_task" | "full", instanceIds?: readonly string[]) {
  return {
    executable,
    registryMetadataPath: metadataPath,
    arms: [
      { armId: "one", modelNameOrPath: "one" },
      { armId: "two", modelNameOrPath: "two" },
    ],
    ...(coverage === undefined ? {} : { coverage }),
    ...(instanceIds === undefined ? {} : { instanceIds }),
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
  root = mkdtempSync(join(tmpdir(), "swe-bench-verified-"));
  workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir);
  executable = writeFakeHarness();
  metadataPath = join(root, "dataset-metadata.json");
  writeFixture();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("SWE-bench Verified official-suite intake", () => {
  test("selection probes the swebench module, not the interpreter's --version", () => {
    const interpreterOnly = join(root, "python3-without-swebench");
    writeFileSync(interpreterOnly, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version" && args.length === 1) { process.stdout.write("Python 3.12.4\\n"); process.exit(0); }
process.stderr.write("ModuleNotFoundError: No module named 'swebench'\\n");
process.exit(1);
`, { mode: 0o700 });
    chmodSync(interpreterOnly, 0o700);
    expect(() => resolveSwebenchVerifiedSelection(workspaceDir, {
      ...request("one_task"),
      executable: interpreterOnly,
    })).toThrow();
  });

  test("named slices are lexicographic first 1 / first 10 / all from the 12-instance fixture", () => {
    expect(namedSliceTaskNames([...names], "one_task")).toEqual(["inst00"]);
    expect(namedSliceTaskNames([...names], "ten_task")).toEqual([...names.slice(0, 10)]);
    expect(namedSliceTaskNames([...names], "full")).toEqual([...names]);
    const one = resolveSwebenchVerifiedSelection(workspaceDir, request("one_task"));
    expect(one.coverage).toBe("one_task");
    expect(one.selectedInstanceIds).toEqual(["inst00"]);
    expect(one.harness.adapterId).toBe(SWE_BENCH_HARNESS_ADAPTER_ID);
    expect(one.harness.timeoutSeconds).toBe(1800);
    const ten = resolveSwebenchVerifiedSelection(workspaceDir, request("ten_task"));
    expect(ten.coverage).toBe("ten_task");
    expect(ten.selectedInstanceIds).toEqual([...names.slice(0, 10)]);
    const full = resolveSwebenchVerifiedSelection(workspaceDir, request("full"));
    expect(full.coverage).toBe("full");
    expect(full.selectedInstanceIds).toEqual([...names]);
    const custom = resolveSwebenchVerifiedSelection(workspaceDir, request(undefined, ["inst11"]));
    expect(custom.coverage).toBe("custom");
    expect(custom.selectedInstanceIds).toEqual(["inst11"]);
  });

  test("select seals replicates=1 and swebench-harness; quote shows 1 × 2 × 1 and two-axis bits", async () => {
    const context = await prepareDraft("one");
    const selected = await selectSwebenchVerifiedRuntime(context, { draftId: "one", ...request("one_task") });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(selected.result.draft.spec.replicates).toBe(1);
    expect(selected.result.draft.spec.evaluationRuntime?.adapterId).toBe(SWE_BENCH_HARNESS_ADAPTER_ID);
    const benchmark = parseBenchmark(getSealedBytes(workspaceDir, selected.result.benchmarkSha256));
    expect(benchmark.items).toHaveLength(1);
    const quoted = await runQuote(context, { draftId: "one" });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    if (!quoted.ok) return;
    expect(quoted.result.presentation.suite).toEqual({
      protocol: "swe-bench-verified",
      executionConformance: true,
      coverage: "one_task",
      leaderboardSubmitReady: false,
      methodLeaderboardEligible: false,
      cellCount: "1 × 2 × 1",
      harnessVersion: "4.1.0",
      selectedTaskCount: 1,
      armCount: 2,
      replicates: 1,
    });
    expect(requireRunState(workspaceDir, "one").suiteQuote?.leaderboardSubmitReady).toBe(false);
  }, 60_000);

  test("a 12-instance snapshot claiming full coverage is refused method eligibility; lock without those quote bits refuses", async () => {
    const context = await prepareDraft("full");
    const selected = await selectSwebenchVerifiedRuntime(context, { draftId: "full", ...request("full") });
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
      // 12 !== SWE_BENCH_VERIFIED_DATASET_INSTANCE_COUNT: "full" over a truncated snapshot is
      // not the official dataset, so it never earns leaderboard eligibility.
      methodLeaderboardEligible: false,
      cellCount: "12 × 2 × 1",
    });
    expect(requireRunState(workspaceDir, "full").suiteQuote?.leaderboardSubmitReady).toBe(false);
    const locked = runLock(context, { draftId: "full" });
    expect(locked.ok, JSON.stringify(locked)).toBe(true);

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir);
    const refuseContext = await prepareDraft("full-refuse");
    const refuseSelected = await selectSwebenchVerifiedRuntime(refuseContext, { draftId: "full-refuse", ...request("full") });
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

  test("eligibility keys off the sealed revision pin and sealed instance count, not manifest self-agreement", async () => {
    const context = await prepareDraft("pin");
    const selected = await selectSwebenchVerifiedRuntime(context, { draftId: "pin", ...request("full") });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    const manifest = SwebenchVerifiedSelectionManifestSchema.parse(
      JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(workspaceDir, selected.result.selectionManifestSha256))),
    );
    const base = { manifest, armCount: 2, itemCount: 12, replicates: 1 };
    expect(suiteQuoteFromSwebench(base).methodLeaderboardEligible).toBe(false);
    expect(suiteQuoteFromSwebench({ ...base, officialDatasetInstanceCount: 12 }).methodLeaderboardEligible).toBe(true);

    // Self-agreeing but drifted: dataset.revision === suite.datasetRevision, neither is the pin.
    const drifted: typeof manifest = {
      ...manifest,
      dataset: { ...manifest.dataset, revision: "f".repeat(40) },
      suite: { ...manifest.suite, datasetRevision: "f".repeat(40) },
    };
    expect(suiteQuoteFromSwebench({
      ...base,
      manifest: drifted,
      officialDatasetInstanceCount: 12,
    }).methodLeaderboardEligible).toBe(false);
  }, 60_000);
});

describe("SWE-bench Verified harness grade and export", () => {
  test("fake harness writes report.json; fixture-full collect bits become ready only with accounted cells and reports", async () => {
    writeFixture(["inst00"]);
    const context = await prepareDraft("ready");
    const selected = await selectSwebenchVerifiedRuntime(context, { draftId: "ready", ...request("full") });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect((await runQuote(context, { draftId: "ready" })).ok).toBe(true);
    expect(requireRunState(workspaceDir, "ready").suiteQuote?.leaderboardSubmitReady).toBe(false);
    const manifest = SwebenchVerifiedSelectionManifestSchema.parse(
      JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(workspaceDir, selected.result.selectionManifestSha256))),
    );
    const reportRoot = join(root, "harness-out");
    const predictionsPath = swebenchPredictionsPath(reportRoot);
    const predictionsSha256 = writePredictionsJsonl(predictionsPath, [{
      instance_id: "inst00",
      model_name_or_path: "one",
      model_patch: "",
    }]);
    const runId = swebenchRunId("a".repeat(64), predictionsSha256);
    launchSwebenchHarness({
      manifest,
      binding: { executable },
      reportRoot,
      predictionsPath,
      runId,
      instanceIds: ["inst00"],
    });
    expect(resolveSwebenchHarnessRunId(reportRoot, "a".repeat(64))).toBe(runId);
    writeFileSync(swebenchHarnessRunIdPath(reportRoot), `${"9".repeat(32)}\n`);
    expect(() => resolveSwebenchHarnessRunId(reportRoot, "a".repeat(64)))
      .toThrow(/does not equal the run_id derived/u);
    writeFileSync(swebenchHarnessRunIdPath(reportRoot), `${runId}\n`);
    expect(harnessReportPath({ reportRoot, runId, modelNameOrPath: "one", instanceId: "inst00" })).toMatch(/report\.json$/u);
    expect(swebenchModelNameOrPath({ armId: "solver", pinning: { model: { id: "acme-model" } } })).toBe("acme-model");
    expect(swebenchModelNameOrPath({ armId: "solver", pinning: { harness: { id: "swebench-harness" } } })).toBe("solver");
    const matrix = {
      cells: manifest.suite.items.flatMap((item) => ["one", "two"].map((armId) => ({
        cellKey: cellKey(item.taskSha256, armId, 1),
        taskDigest: item.taskSha256,
        armId,
        replicate: 1,
        outcome: "judged" as const,
      }))),
    };
    const withoutReports = suiteFactsFromAccountedSwebenchRun({
      manifest,
      armCount: 2,
      itemCount: 1,
      replicates: 1,
      matrix,
      armIds: ["one", "two"],
      reportRoot,
      runId,
      modelNameOrPathByArm: { one: "one", two: "missing" },
      officialDatasetInstanceCount: 1,
    });
    expect(withoutReports.quote.leaderboardSubmitReady).toBe(false);
    const twoReport = harnessReportPath({ reportRoot, runId, modelNameOrPath: "two", instanceId: "inst00" });
    mkdirSync(join(twoReport, ".."), { recursive: true });
    writeFileSync(twoReport, JSON.stringify({ instance_id: "inst00", resolved: false }));
    const ready = suiteFactsFromAccountedSwebenchRun({
      manifest,
      armCount: 2,
      itemCount: 1,
      replicates: 1,
      matrix,
      armIds: ["one", "two"],
      reportRoot,
      runId,
      modelNameOrPathByArm: { one: "one", two: "two" },
      officialDatasetInstanceCount: 1,
    });
    expect(ready.quote.leaderboardSubmitReady).toBe(true);
    expect(ready.limitation).toBeUndefined();
  }, 60_000);

  test("named-slice export is inspection-only; custom and cousin refuse the Verified name", async () => {
    const context = await prepareDraft("one");
    expect((await selectSwebenchVerifiedRuntime(context, { draftId: "one", ...request("one_task") })).ok).toBe(true);
    expect((await runQuote(context, { draftId: "one" })).ok).toBe(true);
    const unsealed = exportSwebenchPredictions(context, { draftId: "one", armId: "one" });
    expect(unsealed.ok).toBe(false);
    if (!unsealed.ok) expect(unsealed.error.detail).toMatch(/requires a sealed Run/u);
    expect(runLock(context, { draftId: "one" }).ok).toBe(true);
    const exported = exportSwebenchPredictions(context, { draftId: "one", armId: "one" });
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    if (!exported.ok) return;
    expect(exported.result.mode).toBe("inspection-upload");
    expect(exported.result.instructions.split("\n")[0]).toBe(exportCompletenessCertification({
      runSha256: requireRunState(workspaceDir, "one").runSha256!,
      completeness: undefined,
    }));
    expect(exported.result.instructions).toMatch(/SWE-bench Verified/u);
    expect(exported.result.instructions).not.toMatch(/Terminal-Bench/u);
    expect(exported.result.instructions).toContain("Do not run `sb submit`");

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir);
    const customContext = await prepareDraft("custom");
    expect((await selectSwebenchVerifiedRuntime(customContext, { draftId: "custom", ...request(undefined, ["inst11"]) })).ok).toBe(true);
    expect((await runQuote(customContext, { draftId: "custom" })).ok).toBe(true);
    expect(runLock(customContext, { draftId: "custom" }).ok).toBe(true);
    const custom = exportSwebenchPredictions(customContext, { draftId: "custom", armId: "one" });
    expect(custom.ok).toBe(false);
    if (custom.ok) return;
    expect(custom.error.detail).toMatch(/SWE-bench Verified suite name/u);

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir);
    const cousin = await prepareDraft("cousin");
    const refused = exportSwebenchPredictions(cousin, { draftId: "cousin", armId: "one" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.detail).toMatch(/swebench-harness|SWE-bench Verified/u);
  }, 120_000);
});
