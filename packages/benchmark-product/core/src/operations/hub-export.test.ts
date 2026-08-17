import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { armAdd } from "./arms.js";
import { createDraft } from "./drafts.js";
import {
  COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE,
} from "../runtime/suite-protocol/comparability.js";
import { harborArmJobName } from "../runtime/harbor/launcher.js";
import { harborArmJobsDir } from "../runtime/harbor/arm-job.js";
import { computeHarbor021TaskContentHash } from "../runtime/terminal-bench-2/host.js";
import { TERMINAL_BENCH_2_1_DATASET_ID, TERMINAL_BENCH_2_1_DATASET_REF } from "../runtime/terminal-bench-2-1/manifest.js";
import type { HarborSelectionManifest } from "../runtime/harbor/manifest.js";
import { initWorkspace } from "./init.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { requireRunState } from "../run/state.js";
import { selectTerminalBench21Runtime } from "./terminal-bench-2-1.js";
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
    const inspection = harborHubExportInstructions("inspection-upload", "/tmp/job");
    expect(inspection).toContain("harbor upload --public /tmp/job");
    expect(inspection).toContain("Do not run `uv run lb submit`");
    expect(inspection).toContain(COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE);
    const ready = harborHubExportInstructions("leaderboard-submit", "/tmp/job");
    expect(ready).toContain("harbor upload --public /tmp/job");
    expect(ready).toContain("uv run lb submit <hub-url>");
    expect(ready).toContain(COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE);
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

  test("leaderboard_submit_ready packages upload and lb submit instructions without placing the row", async () => {
    const context = await prepareDraft("full");
    expect((await selectTerminalBench21Runtime(context, { draftId: "full", ...request("full") })).ok).toBe(true);
    expect((await runQuote(context, { draftId: "full" })).ok).toBe(true);
    expect(runLock(context, { draftId: "full" }).ok).toBe(true);
    stubArmJob("full", "two");
    const exported = exportHarborHubPackage(context, { draftId: "full", armId: "two" });
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    if (!exported.ok) return;
    expect(exported.result.mode).toBe("leaderboard-submit");
    expect(exported.result.instructions).toContain("harbor upload --public");
    expect(exported.result.instructions).toContain("uv run lb submit <hub-url>");
    expect(exported.result.instructions).toContain(COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE);
  }, 120_000);
});
