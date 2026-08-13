import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readRunPublicationExtension } from "@jinn-network/benchmarking-records";
import { armAdd } from "../../operations/arms.js";
import { createDraft } from "../../operations/drafts.js";
import { initWorkspace } from "../../operations/init.js";
import { runLaunch } from "../../operations/run-launch.js";
import { runLock } from "../../operations/run-lock.js";
import { runQuote } from "../../operations/run-quote.js";
import { sampleInit } from "../../operations/sample.js";
import { migrateTerminalBenchLegacyTask, selectTerminalBench2Runtime } from "../../operations/terminal-bench-2.js";
import { readRunJournalEntries } from "../../run/journal.js";
import { readHarborDispatchArchive } from "../harbor/venue.js";
import type { HarborSelectionManifest } from "../harbor/manifest.js";
import { artifactsDir } from "../../workspace/layout.js";
import { getSealedBytes } from "../../workspace/sealed-store.js";
import { computeHarbor021TaskContentHash, resolveTerminalBench2Selection } from "./host.js";
import { TERMINAL_BENCH_2_DATASET_ID, TERMINAL_BENCH_2_PROFILE, TERMINAL_BENCH_2_SELECTION_ROLE, TERMINAL_BENCH_MIGRATION_ROLE, TerminalBench2SelectionManifestSchema } from "./manifest.js";
import { HARBOR_SELECTION_ROLE } from "../harbor/venue.js";
import { createRuntimeEvidenceAdapter } from "../adapter.js";
import { terminalBench2SmokeReadiness } from "./smoke.js";

const datasetRevision = `sha256:${"a".repeat(64)}` as const;
const taskRevision = "sha256:f36995f8854db7fe68476fe10260b22729da0801627608d051e626b3dc555c2d" as const;
const image = `registry.example/tb2@sha256:${"c".repeat(64)}`;
const arms: HarborSelectionManifest["arms"] = [
  { armId: "one", agent: { id: "terminus", configuration: {} }, model: { id: "openai/model-one", configuration: {} }, jobAgent: { name: "terminus", model_name: "openai/model-one" } },
  { armId: "two", agent: { id: "terminus", configuration: {} }, model: { id: "openai/model-two", configuration: {} }, jobAgent: { name: "terminus", model_name: "openai/model-two" } },
];
const outputs: HarborSelectionManifest["outputs"] = [{ name: "prediction", mediaType: "application/json", artifact: { source: "/logs/artifacts/prediction.json", destination: "prediction.json" }, nativePath: "artifacts/prediction.json" }];

let root: string;
let workspaceDir: string;
let executable: string;
let metadataPath: string;
let materialPath: string;

function writeFakeHarbor(): string {
  const path = join(root, "harbor");
  writeFileSync(path, `#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version" && args.length === 1) { process.stdout.write("harbor 0.21.4\\n"); process.exit(0); }
if (args[0] === "task") {
  if (JSON.stringify(args) !== JSON.stringify(["task","migrate","-i","source","-o","transformed"])) process.exit(65);
  mkdirSync("transformed", { recursive: true });
  cpSync("source", "transformed", { recursive: true });
  writeFileSync(join("transformed", "task.toml"), ${JSON.stringify(`[task]\nname = "echo"\n[environment]\ndocker_image = "${image}"\n`)});
  process.stdout.write("migrated\\n"); process.exit(0);
}
if (args[0] !== "run" || args[1] !== "-c" || args.length !== 3) process.exit(64);
const config = JSON.parse(readFileSync(args[2], "utf8"));
if (config.tasks !== undefined || !Array.isArray(config.datasets) || config.datasets.length !== 1) throw new Error("TB2 must use exactly one dataset source");
const source = config.datasets[0];
if (source.path !== ".jinn-harbor/dataset" || source.n_tasks !== 1 || source.task_names.length !== 1 || source.task_names[0] !== "echo") throw new Error("TB2 must filter exactly one selected task");
if (!existsSync(join(process.cwd(), source.path, "echo", "task.toml"))) throw new Error("selected task package was not staged");
if (config.n_attempts !== 1 || config.n_concurrent_trials !== 1 || config.retry.max_retries !== 0) throw new Error("hidden attempts/retries");
const job = join(config.jobs_dir, config.job_name); const trial = join(job, "trial-1");
mkdirSync(join(trial, "verifier"), { recursive: true }); mkdirSync(join(trial, "artifacts"), { recursive: true });
writeFileSync(join(job, "config.json"), JSON.stringify(config));
writeFileSync(join(job, "result.json"), JSON.stringify({ id: config.job_name, status: "success" }));
writeFileSync(join(trial, "config.json"), JSON.stringify({ attempt_number: 1, task: { name: "echo" }, agent: config.agents[0] }));
writeFileSync(join(trial, "result.json"), JSON.stringify({ id: config.job_name + ":trial-1", status: "success" }));
writeFileSync(join(trial, "verifier", "reward.txt"), "1\\n");
writeFileSync(join(trial, "artifacts", "prediction.json"), JSON.stringify({ probabilityYes: "0.5", submittedAt: "2026-08-13T00:00:00Z" }));
`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function request() {
  return {
    executable,
    registryMetadataPath: metadataPath,
    datasetRevision,
    taskMaterialPath: materialPath,
    taskName: "echo",
    taskRevision,
    arms,
    environment: { type: "docker" as const, image, configuration: {} },
    outputs,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "terminal-bench-2-"));
  workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir);
  executable = writeFakeHarbor();
  metadataPath = join(root, "dataset-metadata.json");
  writeFileSync(metadataPath, JSON.stringify({
    name: TERMINAL_BENCH_2_DATASET_ID,
    version: datasetRevision,
    dataset_version_content_hash: datasetRevision,
    task_ids: [{ org: "terminal-bench", name: "echo", ref: taskRevision }],
  }));
  materialPath = join(root, "selected-dataset");
  mkdirSync(join(materialPath, "echo"), { recursive: true });
  writeFileSync(join(materialPath, "echo", "task.toml"), `[task]\nname = "echo"\n[environment]\ndocker_image = "${image}"\n`);
  writeFileSync(join(materialPath, "echo", "instruction.md"), "produce the declared result\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Terminal-Bench 2 product profile", () => {
  test("real smoke is opt-in and transparently refuses missing prerequisites", async () => {
    await expect(terminalBench2SmokeReadiness({ optIn: false, dockerExecutable: "/missing/docker", registryMetadataPath: "/missing/metadata", taskMaterialPath: "/missing/task" })).resolves.toMatchObject({ ready: false, reason: "opt-in-required" });
    await expect(terminalBench2SmokeReadiness({ optIn: true, dockerExecutable: "/missing/docker", registryMetadataPath: metadataPath, taskMaterialPath: materialPath })).resolves.toMatchObject({ ready: false, reason: "docker-unavailable" });
  });

  test("requires immutable official registry/task resolution and rejects drift", () => {
    expect(computeHarbor021TaskContentHash(join(materialPath, "echo"))).toEqual({
      contentHash: taskRevision.slice("sha256:".length),
      files: ["instruction.md", "task.toml"],
    });
    mkdirSync(join(materialPath, "echo", "tests"));
    writeFileSync(join(materialPath, "echo", "tests", ".DS_Store"), "ignored");
    writeFileSync(join(materialPath, "echo", "tests", "cached.pyc"), "ignored");
    writeFileSync(join(materialPath, "echo", "unrelated.bin"), "outside Packager collection");
    expect(computeHarbor021TaskContentHash(join(materialPath, "echo")).contentHash).toBe(taskRevision.slice("sha256:".length));
    const resolved = resolveTerminalBench2Selection(workspaceDir, request());
    expect(resolved.profile.dataset).toMatchObject({ id: TERMINAL_BENCH_2_DATASET_ID, revision: datasetRevision });
    expect(resolved.profile.selectedTask).toMatchObject({ package: { name: "terminal-bench/echo", ref: taskRevision }, filter: "echo" });
    expect(resolved.harbor.source).toMatchObject({ kind: "dataset", input: { name: TERMINAL_BENCH_2_DATASET_ID, ref: datasetRevision }, taskName: "echo" });
    expect(resolved.harbor.profiles?.[TERMINAL_BENCH_2_PROFILE]).toEqual(resolved.profile);
    expect(() => resolveTerminalBench2Selection(workspaceDir, { ...request(), datasetRevision: `sha256:${"d".repeat(64)}` })).toThrow(/drifted/i);
    expect(() => resolveTerminalBench2Selection(workspaceDir, { ...request(), taskRevision: `sha256:${"e".repeat(64)}` })).toThrow(/exactly once/i);
    writeFileSync(metadataPath, JSON.stringify({ name: TERMINAL_BENCH_2_DATASET_ID, dataset_version_content_hash: datasetRevision, task_ids: [{ org: "terminal-bench", name: "echo", ref: `sha256:${"b".repeat(64)}` }] }));
    expect(() => resolveTerminalBench2Selection(workspaceDir, { ...request(), taskRevision: `sha256:${"b".repeat(64)}` })).toThrow(/Packager\.compute_content_hash/i);
    writeFileSync(metadataPath, JSON.stringify({ name: TERMINAL_BENCH_2_DATASET_ID, dataset_version_content_hash: datasetRevision, task_ids: [{ org: "terminal-bench", name: "echo", ref: taskRevision }] }));
    writeFileSync(join(materialPath, "echo", ".gitignore"), "ignored.txt\n");
    expect(() => resolveTerminalBench2Selection(workspaceDir, request())).toThrow(/custom \.gitignore/i);
    rmSync(join(materialPath, "echo", ".gitignore"));
    symlinkSync("instruction.md", join(materialPath, "echo", "README.md"));
    expect(() => resolveTerminalBench2Selection(workspaceDir, request())).toThrow(/symlink/i);
    rmSync(join(materialPath, "echo", "README.md"));
    rmSync(join(materialPath, "echo", "tests"), { recursive: true });
    rmSync(join(materialPath, "echo", "unrelated.bin"));
    mkdirSync(join(materialPath, "other"));
    writeFileSync(join(materialPath, "other", "task.toml"), "");
    expect(() => resolveTerminalBench2Selection(workspaceDir, request())).toThrow(/exactly the selected task/i);
  });

  test("matches official Harbor 0.21 pathspec ancestor ignores and Python Unicode ordering", () => {
    const taskPath = join(materialPath, "echo");
    mkdirSync(join(taskPath, "tests", "a.pyc"), { recursive: true });
    writeFileSync(join(taskPath, "tests", "a.pyc", "payload"), "ignored ancestor\n");
    writeFileSync(join(taskPath, "tests", "\uE000"), "bmp private\n");
    writeFileSync(join(taskPath, "tests", "\u{10000}"), "astral\n");

    // Golden produced by Harbor v0.21.0 Packager at commit 64afbbcb62165950301e1a6407c729aa26d844ff.
    expect(computeHarbor021TaskContentHash(taskPath)).toEqual({
      contentHash: "a0d9eb7015d4c0bce447931bb76f17256748b53a35e4ea509b9261e61e784e5a",
      files: ["instruction.md", "task.toml", "tests/\uE000", "tests/\u{10000}"],
    });
  });

  test("one Jinn dispatch creates one filtered Harbor Trial through the normal lifecycle", async () => {
    const context = { workspaceDir, principal: "sponsor-1", clock: () => new Date().toISOString() };
    expect(initWorkspace(context).ok).toBe(true);
    expect(createDraft(context, { draftId: "tb2", name: "TB2" }).ok).toBe(true);
    expect((await sampleInit(context, { draftId: "tb2" })).ok).toBe(true);
    expect(armAdd(context, { draftId: "tb2", armId: "one", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    expect(armAdd(context, { draftId: "tb2", armId: "two", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    const selected = await selectTerminalBench2Runtime(context, { draftId: "tb2", ...request() });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    const outer = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, selected.result.selectionManifestSha256))) as { profiles: Record<string, unknown> };
    expect(TerminalBench2SelectionManifestSchema.parse(outer.profiles[TERMINAL_BENCH_2_PROFILE]).execution).toEqual({ source: "dataset", nTasks: 1, nAttempts: 1, nConcurrent: 1, maxRetries: 0 });
    const quoted = await runQuote(context, { draftId: "tb2" });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    expect(runLock(context, { draftId: "tb2" }).ok).toBe(true);
    const launch = await runLaunch(context, { draftId: "tb2" });
    expect(launch.ok, JSON.stringify(launch)).toBe(true);
    const journal = readRunJournalEntries(workspaceDir, "tb2");
    const deliveries = journal.filter((entry) => entry.kind === "delivery");
    expect(deliveries.length).toBeGreaterThan(0);
    const indexes = readdirSync(join(artifactsDir(workspaceDir), "harbor", "archives", "by-dispatch"));
    expect(indexes).toHaveLength(deliveries.length);
    for (const indexName of indexes) {
      const index = JSON.parse(readFileSync(join(artifactsDir(workspaceDir), "harbor", "archives", "by-dispatch", indexName), "utf8")) as { archiveSha256: string };
      const archive = readHarborDispatchArchive(workspaceDir, index.archiveSha256);
      expect(archive.harbor.trialId).toMatch(/:trial-1$/u);
      expect(archive.nativeArtifacts.filter((entry) => /^[^/]+\/config\.json$/u.test(entry.path))).toHaveLength(1);
    }
  }, 120_000);

  test("legacy migration uses official argv and discloses distinct source/transformed bytes", async () => {
    const context = { workspaceDir, principal: "sponsor-1", clock: () => "2026-08-13T00:00:00.000Z" };
    expect(initWorkspace(context).ok).toBe(true);
    const legacy = join(root, "legacy"); mkdirSync(legacy); writeFileSync(join(legacy, "instruction.md"), "legacy task\n");
    const migrated = await migrateTerminalBenchLegacyTask(context, { executable, sourcePath: legacy, manualAdjustment: { status: "none" } });
    expect(migrated.ok, JSON.stringify(migrated)).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.result.manifest.command.argv).toEqual(["task", "migrate", "-i", "source", "-o", "transformed"]);
    expect(migrated.result.manifest.relationship).toBe("source-transformed-by-harbor-mapper");
    expect(migrated.result.manifest.source.checksum).not.toBe(migrated.result.manifest.transformed.checksum);
    expect(migrated.result.manifest.manualAdjustment).toEqual({ status: "none" });
    for (const entry of [...migrated.result.manifest.source.files, ...migrated.result.manifest.transformed.files]) {
      expect(getSealedBytes(workspaceDir, entry.sha256)).toHaveLength(entry.bytes);
    }

    const selectedDataset = join(root, "migrated-selection");
    mkdirSync(selectedDataset);
    cpSync(migrated.result.runnableMaterialPath, join(selectedDataset, "echo"), { recursive: true });
    const migratedTaskRevision = `sha256:${computeHarbor021TaskContentHash(join(selectedDataset, "echo")).contentHash}` as const;
    writeFileSync(metadataPath, JSON.stringify({ name: TERMINAL_BENCH_2_DATASET_ID, dataset_version_content_hash: datasetRevision, task_ids: [{ org: "terminal-bench", name: "echo", ref: migratedTaskRevision }] }));
    expect(createDraft(context, { draftId: "migrated", name: "Migrated TB2" }).ok).toBe(true);
    expect((await sampleInit(context, { draftId: "migrated" })).ok).toBe(true);
    expect(armAdd(context, { draftId: "migrated", armId: "one", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    expect(armAdd(context, { draftId: "migrated", armId: "two", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    const selected = await selectTerminalBench2Runtime(context, { draftId: "migrated", ...request(), taskMaterialPath: selectedDataset, taskRevision: migratedTaskRevision, migrationManifestSha256: migrated.result.manifestSha256 });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    const profile = TerminalBench2SelectionManifestSchema.parse((JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, selected.result.selectionManifestSha256))) as { profiles: Record<string, unknown> }).profiles[TERMINAL_BENCH_2_PROFILE]);
    expect(profile.migrationManifestSha256).toBe(migrated.result.manifestSha256);
    expect(profile.selectedTask.material.checksum).toBe(migrated.result.manifest.runnable.checksum);
    expect((await runQuote(context, { draftId: "migrated" })).ok).toBe(true);
    const locked = runLock(context, { draftId: "migrated" });
    expect(locked.ok, JSON.stringify(locked)).toBe(true);
    if (!locked.ok) return;
    const run = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, locked.result.runSha256))) as Record<string, unknown>;
    const registration = readRunPublicationExtension(run)!.registrationArtifacts;
    expect(registration.map((entry) => entry.role)).toEqual([
      HARBOR_SELECTION_ROLE,
      TERMINAL_BENCH_MIGRATION_ROLE,
      TERMINAL_BENCH_2_SELECTION_ROLE,
    ].sort());
    const adapter = createRuntimeEvidenceAdapter(
      { adapterId: "harbor", selectionManifestSha256: selected.result.selectionManifestSha256 },
      { registrationArtifacts: registration.map((entry, index) => ({
        id: `tb2-registration-${index}.json`, role: entry.role, digest: `sha256:${entry.artifact.digest.sha256}`,
        bytes: getSealedBytes(workspaceDir, entry.artifact.digest.sha256), mediaType: "application/json", actions: ["store"],
      })) },
    );
    await expect(adapter.registration({ runDigest: `sha256:${locked.result.runSha256}` })).resolves.toHaveLength(3);
  });
});
