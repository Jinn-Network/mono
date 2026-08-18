import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseBenchmark } from "@jinn-network/benchmarking-records";
import { armAdd } from "../../operations/arms.js";
import { createDraft, updateDraft } from "../../operations/drafts.js";
import { initWorkspace } from "../../operations/init.js";
import { runLock } from "../../operations/run-lock.js";
import { runQuote } from "../../operations/run-quote.js";
import { selectTerminalBench21Runtime } from "../../operations/terminal-bench-2-1.js";
import { selectTerminalBench30Runtime } from "../../operations/terminal-bench-3-0.js";
import { requireRunState, writeRunState } from "../../run/state.js";
import { getSealedBytes } from "../../workspace/sealed-store.js";
import type { HarborSelectionManifest } from "../harbor/manifest.js";
import { computeHarbor021TaskContentHash } from "../terminal-bench-2/host.js";
import { namedSliceTaskNames, SuiteProtocolSelectionSchema } from "../suite-protocol/manifest.js";
import { SUITE_PROTOCOL_PROFILE } from "../suite-protocol/manifest.js";
import { HarborSelectionManifestSchema } from "../harbor/manifest.js";
import { resolveTerminalBench30Selection } from "./host.js";
import { TERMINAL_BENCH_3_0_DATASET_ID, TERMINAL_BENCH_3_0_DATASET_REF, TERMINAL_BENCH_3_0_HUB_VERSION } from "./manifest.js";
import { TERMINAL_BENCH_2_1_DATASET_ID, TERMINAL_BENCH_2_1_DATASET_REF } from "../terminal-bench-2-1/manifest.js";
import { createLocalVenue } from "../../venue/venue.js";
import { INSPECT_ADAPTER_ID } from "../inspect/manifest.js";

const names = ["t00", "t01", "t02", "t03", "t04", "t05", "t06", "t07", "t08", "t09", "t10", "t11"] as const;
const image = `registry.example/tb30@sha256:${"c".repeat(64)}`;
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

function writeFixture(
  datasetId: string = TERMINAL_BENCH_3_0_DATASET_ID,
  datasetRevision: string = TERMINAL_BENCH_3_0_DATASET_REF,
): void {
  mkdirSync(materialPath, { recursive: true });
  for (const name of names) {
    mkdirSync(join(materialPath, name), { recursive: true });
    writeFileSync(join(materialPath, name, "task.toml"), `[task]\nname = "${name}"\n[environment]\ndocker_image = "${image}"\n`);
    writeFileSync(join(materialPath, name, "instruction.md"), `solve ${name}\n`);
  }
  writeFileSync(metadataPath, JSON.stringify({
    name: datasetId,
    version: TERMINAL_BENCH_3_0_HUB_VERSION,
    dataset_version_content_hash: datasetRevision,
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

function tb21Request(coverage: "one_task" = "one_task") {
  return {
    executable,
    registryMetadataPath: metadataPath,
    datasetRevision: TERMINAL_BENCH_2_1_DATASET_REF,
    taskMaterialPath: materialPath,
    nConcurrent: 1,
    arms,
    environment: { type: "docker" as const, image, configuration: {} },
    outputs,
    coverage,
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
  root = mkdtempSync(join(tmpdir(), "terminal-bench-3-0-"));
  workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir);
  executable = writeFakeHarbor();
  metadataPath = join(root, "dataset-metadata.json");
  materialPath = join(root, "selected-dataset");
  writeFixture();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Terminal-Bench 3.0 official-suite intake", () => {
  test("refuses @latest and a drifted content hash", () => {
    expect(() => resolveTerminalBench30Selection(workspaceDir, { ...request("one_task"), datasetRevision: "@latest" as never })).toThrow(/@latest/u);
    expect(() => resolveTerminalBench30Selection(workspaceDir, { ...request("one_task"), datasetRevision: "latest" as never })).toThrow(/@latest|immutable sha256/u);
    expect(() => resolveTerminalBench30Selection(workspaceDir, { ...request("one_task"), datasetRevision: `sha256:${"d".repeat(64)}` })).toThrow(/drifted/u);
  });

  test("named slices are lexicographic first 1 / first 10 / all from this 12-task fixture, not 2.1 names", () => {
    expect(namedSliceTaskNames([...names], "one_task")).toEqual(["t00"]);
    expect(namedSliceTaskNames([...names], "ten_task")).toEqual(["t00", "t01", "t02", "t03", "t04", "t05", "t06", "t07", "t08", "t09"]);
    expect(namedSliceTaskNames([...names], "full")).toEqual([...names]);
    const one = resolveTerminalBench30Selection(workspaceDir, request("one_task"));
    expect(one.coverage).toBe("one_task");
    expect(one.selectedTaskNames).toEqual(["t00"]);
    expect(one.profile.dataset.id).toBe(TERMINAL_BENCH_3_0_DATASET_ID);
    expect(one.profile.dataset.hubVersion).toBe(TERMINAL_BENCH_3_0_HUB_VERSION);
    expect(one.profile.execution.maxRetries).toBe(3);
    expect(one.harbor.retryPolicy).toEqual({ nAttempts: 5, nConcurrent: 1, maxRetries: 3 });
    expect(one.selectedTaskNames).not.toContain("adaptive-rejection-sampler");
    const ten = resolveTerminalBench30Selection(workspaceDir, request("ten_task"));
    expect(ten.coverage).toBe("ten_task");
    expect(ten.selectedTaskNames).toEqual(["t00", "t01", "t02", "t03", "t04", "t05", "t06", "t07", "t08", "t09"]);
    const full = resolveTerminalBench30Selection(workspaceDir, request("full"));
    expect(full.coverage).toBe("full");
    expect(full.selectedTaskNames).toEqual([...names]);
    const custom = resolveTerminalBench30Selection(workspaceDir, request(undefined, ["t11"]));
    expect(custom.coverage).toBe("custom");
  });

  test("select seals protocol terminal-bench-3.0, replicates=5, harbor adapter; quote one_task is not leaderboard-ready", async () => {
    const context = await prepareDraft("one");
    const selected = await selectTerminalBench30Runtime(context, { draftId: "one", ...request("one_task") });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(selected.result.draft.spec.replicates).toBe(5);
    expect(selected.result.draft.spec.evaluationRuntime?.adapterId).toBe("harbor");
    const benchmark = parseBenchmark(getSealedBytes(workspaceDir, selected.result.benchmarkSha256));
    expect(benchmark.items).toHaveLength(1);
    const manifest = HarborSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(workspaceDir, selected.result.selectionManifestSha256))));
    const suite = SuiteProtocolSelectionSchema.parse(manifest.profiles?.[SUITE_PROTOCOL_PROFILE]);
    expect(suite.protocol).toBe("terminal-bench-3.0");
    expect(suite.datasetId).toBe(TERMINAL_BENCH_3_0_DATASET_ID);
    const quoted = await runQuote(context, { draftId: "one" });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    if (!quoted.ok) return;
    expect(quoted.result.presentation.suite).toMatchObject({
      protocol: "terminal-bench-3.0",
      executionConformance: true,
      coverage: "one_task",
      leaderboardSubmitReady: false,
      cellCount: "1 × 2 × 5",
      harborVersion: "0.21.4",
    });
    expect(requireRunState(workspaceDir, "one").suiteQuote?.leaderboardSubmitReady).toBe(false);
  }, 60_000);

  test("full coverage quote is method-eligible and not leaderboard_submit_ready", async () => {
    const context = await prepareDraft("full");
    const selected = await selectTerminalBench30Runtime(context, { draftId: "full", ...request("full") });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(parseBenchmark(getSealedBytes(workspaceDir, selected.result.benchmarkSha256)).items).toHaveLength(12);
    const quoted = await runQuote(context, { draftId: "full" });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    if (!quoted.ok) return;
    expect(quoted.result.presentation.suite).toMatchObject({
      protocol: "terminal-bench-3.0",
      coverage: "full",
      executionConformance: true,
      leaderboardSubmitReady: false,
      methodLeaderboardEligible: true,
    });
    expect(runLock(context, { draftId: "full" }).ok).toBe(true);

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir);
    const refuseContext = await prepareDraft("full-refuse");
    expect((await selectTerminalBench30Runtime(refuseContext, { draftId: "full-refuse", ...request("full") })).ok).toBe(true);
    expect((await runQuote(refuseContext, { draftId: "full-refuse" })).ok).toBe(true);
    const quotedState = requireRunState(workspaceDir, "full-refuse");
    const { suiteQuote: _omitted, ...withoutQuote } = quotedState;
    writeRunState(workspaceDir, "full-refuse", withoutQuote);
    const refused = runLock(refuseContext, { draftId: "full-refuse" });
    expect(refused.ok).toBe(false);
  }, 120_000);

  test("2.1 select cannot emit 3.0; 3.0 select cannot emit 2.1", async () => {
    const context = await prepareDraft("tb30");
    const selected = await selectTerminalBench30Runtime(context, { draftId: "tb30", ...request("one_task") });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    const suite30 = SuiteProtocolSelectionSchema.parse(HarborSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(workspaceDir, selected.result.selectionManifestSha256)))).profiles?.[SUITE_PROTOCOL_PROFILE]);
    expect(suite30.protocol).toBe("terminal-bench-3.0");

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir);
    writeFixture(TERMINAL_BENCH_2_1_DATASET_ID, TERMINAL_BENCH_2_1_DATASET_REF);
    const tb21Context = await prepareDraft("tb21");
    const tb21 = await selectTerminalBench21Runtime(tb21Context, { draftId: "tb21", ...tb21Request() });
    expect(tb21.ok, JSON.stringify(tb21)).toBe(true);
    if (!tb21.ok) return;
    const suite21 = SuiteProtocolSelectionSchema.parse(HarborSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(workspaceDir, tb21.result.selectionManifestSha256)))).profiles?.[SUITE_PROTOCOL_PROFILE]);
    expect(suite21.protocol).toBe("terminal-bench-2.1");
    expect(suite21.protocol).not.toBe("terminal-bench-3.0");
  }, 60_000);

  test("venue refuses swe-rebench and Inspect evaluators on a 3.0 lock", async () => {
    const context = await prepareDraft("eval");
    const selected = await selectTerminalBench30Runtime(context, { draftId: "eval", ...request("one_task") });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(() => createLocalVenue({
      workspaceDir,
      now: () => "2026-08-18T00:00:00.000Z",
      evaluationRuntime: { adapterId: "swe-rebench-v2", selectionManifestSha256: selected.result.selectionManifestSha256 },
    })).toThrow(/unsupported evaluation runtime/u);
    expect(() => createLocalVenue({
      workspaceDir,
      now: () => "2026-08-18T00:00:00.000Z",
      evaluationRuntime: { adapterId: INSPECT_ADAPTER_ID, selectionManifestSha256: selected.result.selectionManifestSha256 },
    })).toThrow();
  }, 60_000);

  test("qualify script exits non-zero without COLOPHON_TB30_ONE_TASK_QUALIFY=1", () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/tb30-one-task-qualify.mjs");
    const env = { ...process.env };
    delete env.COLOPHON_TB30_ONE_TASK_QUALIFY;
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", env });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toMatch(/COLOPHON_TB30_ONE_TASK_QUALIFY=1/u);
  });

  test("official suite refuses binary-instrument majority-k", async () => {
    const context = await prepareDraft("binary");
    expect(updateDraft(context, {
      draftId: "binary",
      patch: { analysis: { method: "jinn.benchmarking.method/binary-instrument", version: "1" } },
    }).ok).toBe(true);
    const selected = await selectTerminalBench30Runtime(context, { draftId: "binary", ...request("one_task") });
    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.error.detail).toMatch(/binary-instrument/u);
  }, 30_000);
});
