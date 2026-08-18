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
import { selectDeepSweV11Runtime } from "../../operations/deep-swe-v1.1.js";
import { requireRunState, writeRunState } from "../../run/state.js";
import { getSealedBytes } from "../../workspace/sealed-store.js";
import type { HarborSelectionManifest } from "../harbor/manifest.js";
import { namedSliceTaskNames } from "../suite-protocol/manifest.js";
import { resolveDeepSweV11Selection } from "./host.js";
import { DEEP_SWE_V11_GIT_SHA } from "./manifest.js";

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

function writeFixture(): void {
  mkdirSync(materialPath, { recursive: true });
  for (const name of names) {
    mkdirSync(join(materialPath, name), { recursive: true });
    writeFileSync(join(materialPath, name, "task.toml"), `[task]\nname = "${name}"\n[environment]\ndocker_image = "${image}"\n`);
    writeFileSync(join(materialPath, name, "instruction.md"), `solve ${name}\n`);
  }
}

function request(coverage?: "one_task" | "ten_task" | "full", taskNames?: readonly string[], extra?: Partial<Parameters<typeof resolveDeepSweV11Selection>[1]>) {
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
    ...extra,
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
  root = mkdtempSync(join(tmpdir(), "deep-swe-v1.1-"));
  workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir);
  executable = writeFakePier();
  materialPath = join(root, "tasks");
  writeFixture();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("DeepSWE v1.1 official-suite intake", () => {
  test("named slices are lexicographic first 1 / first 10 / all from the 12-task fixture", () => {
    expect(namedSliceTaskNames([...names], "one_task")).toEqual(["t00"]);
    expect(namedSliceTaskNames([...names], "ten_task")).toEqual([...names.slice(0, 10)]);
    expect(namedSliceTaskNames([...names], "full")).toEqual([...names]);
    const one = resolveDeepSweV11Selection(workspaceDir, request("one_task"));
    expect(one.coverage).toBe("one_task");
    expect(one.selectedTaskNames).toEqual(["t00"]);
    expect(one.profile.execution.maxRetries).toBe(3);
    expect(one.profile.execution.agent).toBe("mini-swe-agent");
    expect(one.harbor.engine).toBe("pier");
    expect(one.harbor.retryPolicy).toEqual({ nAttempts: 4, nConcurrent: 1, maxRetries: 3 });
    const ten = resolveDeepSweV11Selection(workspaceDir, request("ten_task"));
    expect(ten.coverage).toBe("ten_task");
    expect(ten.selectedTaskNames).toEqual([...names.slice(0, 10)]);
    const full = resolveDeepSweV11Selection(workspaceDir, request("full"));
    expect(full.coverage).toBe("full");
    expect(full.selectedTaskNames).toEqual([...names]);
    const custom = resolveDeepSweV11Selection(workspaceDir, request(undefined, ["t11"]));
    expect(custom.coverage).toBe("custom");
    expect(custom.selectedTaskNames).toEqual(["t11"]);
  });

  test("k=1, Harbor cousins, and non-mini-swe-agent cannot wear the name", () => {
    expect(() => resolveDeepSweV11Selection(workspaceDir, request("one_task", undefined, { replicates: 1 }))).toThrow(/k ≥ 4/u);
    expect(() => resolveDeepSweV11Selection(workspaceDir, request("one_task", undefined, { gitSha: "0".repeat(40) }))).toThrow(/sealed git commit pin/u);
    expect(() => resolveDeepSweV11Selection(workspaceDir, request("one_task", undefined, {
      arms: [{ armId: "one", agent: { id: "claude-code", configuration: {} }, model: { id: "openai/model-one", configuration: {} }, jobAgent: { name: "claude-code", model_name: "openai/model-one" } }],
    }))).toThrow(/mini-swe-agent/u);
  });

  test("select seals replicates=4 and one Task per selected name; quote shows 1 × 2 × 4 and two-axis bits", async () => {
    const context = await prepareDraft("one");
    const selected = await selectDeepSweV11Runtime(context, { draftId: "one", ...request("one_task") });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(selected.result.draft.spec.replicates).toBe(4);
    expect(selected.result.draft.spec.evaluationRuntime?.adapterId).toBe("pier");
    expect(selected.result.draft.spec.policy.replacement).toEqual({ allowed: true, maxPerCell: 3 });
    expect(selected.result.draft.spec.arms[0]?.pinning.harness).toEqual({ id: "pier", version: "0.3.1" });
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
      cellCount: "1 × 2 × 4",
      harborVersion: "0.3.1",
      selectedTaskCount: 1,
      armCount: 2,
      replicates: 4,
    });
    expect(requireRunState(workspaceDir, "one").suiteQuote?.leaderboardSubmitReady).toBe(false);
  }, 60_000);

  test("ten_task and full slices seal the named membership; custom cannot be leaderboard-ready", async () => {
    const tenContext = await prepareDraft("ten");
    const ten = await selectDeepSweV11Runtime(tenContext, { draftId: "ten", ...request("ten_task") });
    expect(ten.ok, JSON.stringify(ten)).toBe(true);
    if (!ten.ok) return;
    expect(parseBenchmark(getSealedBytes(workspaceDir, ten.result.benchmarkSha256)).items).toHaveLength(10);
    const tenQuoted = await runQuote(tenContext, { draftId: "ten" });
    expect(tenQuoted.ok, JSON.stringify(tenQuoted)).toBe(true);
    if (!tenQuoted.ok) return;
    expect(tenQuoted.result.presentation.suite).toMatchObject({ coverage: "ten_task", leaderboardSubmitReady: false, cellCount: "10 × 2 × 4" });

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir);
    const customContext = await prepareDraft("custom");
    const custom = await selectDeepSweV11Runtime(customContext, { draftId: "custom", ...request(undefined, ["t11"]) });
    expect(custom.ok, JSON.stringify(custom)).toBe(true);
    if (!custom.ok) return;
    const customQuoted = await runQuote(customContext, { draftId: "custom" });
    expect(customQuoted.ok, JSON.stringify(customQuoted)).toBe(true);
    if (!customQuoted.ok) return;
    expect(customQuoted.result.presentation.suite).toMatchObject({ coverage: "custom", leaderboardSubmitReady: false, cellCount: "1 × 2 × 4" });
  }, 120_000);

  test("full coverage quote is method-eligible and not leaderboard_submit_ready; lock without those quote bits refuses", async () => {
    const context = await prepareDraft("full");
    const selected = await selectDeepSweV11Runtime(context, { draftId: "full", ...request("full") });
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
      cellCount: "12 × 2 × 4",
    });
    expect(requireRunState(workspaceDir, "full").suiteQuote?.leaderboardSubmitReady).toBe(false);
    const locked = runLock(context, { draftId: "full" });
    expect(locked.ok, JSON.stringify(locked)).toBe(true);

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir);
    const refuseContext = await prepareDraft("full-refuse");
    const refuseSelected = await selectDeepSweV11Runtime(refuseContext, { draftId: "full-refuse", ...request("full") });
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
    expect(refused.error.detail).toMatch(/DeepSWE v1\.1/u);
    expect(refused.error.detail).not.toMatch(/Terminal-Bench|SWE-bench/u);
  }, 120_000);

  test("official suite refuses a replacement budget below Pier max_retries 3", async () => {
    const context = await prepareDraft("small-budget");
    expect(updateDraft(context, {
      draftId: "small-budget",
      patch: { policy: { completenessFloor: "1", cellWindowMs: 3_600_000, closeAfterMs: 86_400_000, replacement: { allowed: true, maxPerCell: 1 } } },
    }).ok).toBe(true);
    const selected = await selectDeepSweV11Runtime(context, { draftId: "small-budget", ...request("one_task") });
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
    const selected = await selectDeepSweV11Runtime(context, { draftId: "binary", ...request("one_task") });
    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.error.detail).toMatch(/binary-instrument/u);
  }, 30_000);

  test("one-task qualify refuses unless COLOPHON_DEEPSWE_ONE_TASK_QUALIFY=1", () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/deepswe-v1.1-one-task-qualify.mjs");
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, COLOPHON_DEEPSWE_ONE_TASK_QUALIFY: "" } });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/never downloads DeepSWE v1\.1/u);
  });
});
