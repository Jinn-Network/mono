import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { armAdd } from "../../operations/arms.js";
import { createDraft } from "../../operations/drafts.js";
import { initWorkspace } from "../../operations/init.js";
import { selectHarborRuntime } from "../../operations/harbor-runtime.js";
import { runLaunch } from "../../operations/run-launch.js";
import { runLock } from "../../operations/run-lock.js";
import { runQuote } from "../../operations/run-quote.js";
import { sampleInit } from "../../operations/sample.js";
import { readRunJournalEntries } from "../../run/journal.js";
import { createRuntimeEvidenceAdapter } from "../adapter.js";
import { artifactsDir } from "../../workspace/layout.js";
import { getSealedBytes } from "../../workspace/sealed-store.js";
import { recordHarborDispatchMapping } from "../../venue/provisioner.js";
import { HarborJobConfigSchema, harborJobSource, harborSelectionManifestBytes, normalizeHarborSavedJobConfig, type HarborSelectionManifest } from "./manifest.js";
import { HARBOR_ATIF_ROLE, HARBOR_LOGS_ROLE, HARBOR_SELECTION_ROLE, harborEvidenceContributionFromArchive, readHarborDispatchArchive } from "./venue.js";

const manifest: HarborSelectionManifest = {
  schema: "jinn.network/benchmark-product/harbor-selection/1", adapter: { id: "harbor", version: "1" },
  harbor: { version: "0.21.4", executableSha256: "a".repeat(64) },
  source: { kind: "task", input: { name: "demo/task", ref: "r2" }, jobInput: { path: ".jinn-harbor/task" }, resolved: { reference: "demo/task", revision: "r2", checksum: "c".repeat(64), files: [{ path: "task.toml", sha256: "b".repeat(64), bytes: 1 }] } },
  arms: [
    { armId: "one", agent: { id: "agent-one", configuration: { system: "pinned-one" } }, model: { id: "model-one", configuration: { temperature: 0 } }, jobAgent: { name: "agent-one", model_name: "model-one", kwargs: { system: "pinned-one", temperature: 0 } } },
    { armId: "two", agent: { id: "agent-two", configuration: { system: "pinned-two" } }, model: { id: "model-two", configuration: { temperature: 0 } }, jobAgent: { name: "agent-two", model_name: "model-two" } },
  ],
  environment: { type: "docker", image: `registry.example/env@sha256:${"d".repeat(64)}`, configuration: {} }, retryPolicy: { nAttempts: 1, nConcurrent: 1, maxRetries: 0 },
  outputs: [{ name: "prediction", mediaType: "application/json", artifact: { source: "/logs/artifacts/prediction.json", destination: "prediction.json" }, nativePath: "artifacts/prediction.json" }],
};

async function fakeHarbor(root: string, failWithPartial = false): Promise<string> {
  const executable = join(root, "fake-harbor.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("harbor 0.21.4\\n"); process.exit(0); }
if (args[0] !== "run" || args[1] !== "-c" || args.length !== 3) process.exit(64);
const config = JSON.parse(readFileSync(args[2], "utf8"));
const exactKeys = (value, keys, label) => { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label + " keys: " + actual.join(",")); };
const isTask = Array.isArray(config.tasks); const isDataset = Array.isArray(config.datasets); if (isTask === isDataset) throw new Error("exactly one Job source required");
exactKeys(config, ["job_name", "jobs_dir", "n_attempts", "n_concurrent_trials", "retry", "environment", "agents", "artifacts", isTask ? "tasks" : "datasets"], "JobConfig");
if (config.n_attempts !== 1 || config.n_concurrent_trials !== 1) throw new Error("hidden attempts/concurrency");
exactKeys(config.retry, ["max_retries"], "RetryConfig"); if (config.retry.max_retries !== 0) throw new Error("hidden retry");
exactKeys(config.environment, ["type"], "EnvironmentConfig"); if (config.environment.type !== "docker" || config.environment.type.includes("@sha256:")) throw new Error("invalid environment backend type");
if (!Array.isArray(config.agents) || config.agents.length !== 1) throw new Error("one AgentConfig required");
exactKeys(config.agents[0], config.agents[0].kwargs === undefined ? ["name", "model_name"] : ["name", "model_name", "kwargs"], "AgentConfig");
if (isTask) { if (config.tasks.length !== 1) throw new Error("one TaskConfig required"); exactKeys(config.tasks[0], ["path"], "TaskConfig"); if (config.tasks[0].path !== ".jinn-harbor/task" || !existsSync(join(process.cwd(), config.tasks[0].path, "task.toml"))) throw new Error("unstaged TaskConfig"); }
else { if (config.datasets.length !== 1) throw new Error("one DatasetConfig required"); exactKeys(config.datasets[0], ["path", "task_names", "n_tasks"], "DatasetConfig"); if (config.datasets[0].path !== ".jinn-harbor/dataset" || config.datasets[0].n_tasks !== 1 || config.datasets[0].task_names.length !== 1 || !existsSync(join(process.cwd(), config.datasets[0].path, "task.toml"))) throw new Error("unfiltered or unstaged DatasetConfig"); }
if (!Array.isArray(config.artifacts) || config.artifacts.length !== 1) throw new Error("native output ArtifactConfig required"); exactKeys(config.artifacts[0], ["source", "destination"], "ArtifactConfig");
const job = join(config.jobs_dir, config.job_name); const trial = join(job, "trial-1");
mkdirSync(join(trial, "agent"), { recursive: true }); mkdirSync(join(trial, "verifier"), { recursive: true }); mkdirSync(join(trial, "artifacts"), { recursive: true });
// Harbor 0.21 persists JobConfig with model_dump_json(exclude_defaults=True).
const savedConfig = structuredClone(config); delete savedConfig.n_attempts; delete savedConfig.retry; delete savedConfig.environment;
writeFileSync(join(job, "config.json"), JSON.stringify(savedConfig));
if (${String(failWithPartial)}) { writeFileSync(join(job, "result.json"), JSON.stringify({ id: config.job_name, status: "failed" })); writeFileSync(join(trial, "partial.log"), "partial evidence"); symlinkSync(join(trial, "partial.log"), join(trial, "unsafe-link")); process.stderr.write("fake Harbor partial failure\\n"); process.exit(2); }
writeFileSync(join(job, "result.json"), JSON.stringify({ id: config.job_name, status: "success" }));
writeFileSync(join(trial, "config.json"), JSON.stringify({ attempt_number: 1, task: isTask ? config.tasks[0] : { name: config.datasets[0].task_names[0] }, agent: config.agents[0] }));
writeFileSync(join(trial, "result.json"), JSON.stringify({ id: config.job_name + ":trial-1", status: "success" }));
writeFileSync(join(trial, "agent", "recording.cast"), Buffer.from([0, 255, 1]));
writeFileSync(join(trial, "agent", "trajectory.json"), JSON.stringify({ schema: "ATIF" }));
writeFileSync(join(trial, "verifier", "reward.txt"), "1\\n");
writeFileSync(join(trial, "ctrf.json"), JSON.stringify({ results: [] }));
writeFileSync(join(trial, "artifacts", "manifest.json"), JSON.stringify({ files: ["unknown.bin"] }));
writeFileSync(join(trial, "artifacts", "unknown.bin"), Buffer.from([7, 8, 9]));
writeFileSync(join(trial, "artifacts", "prediction.json"), JSON.stringify({ probabilityYes: "0.5", submittedAt: "2026-01-01T00:00:00Z" }));
process.stdout.write("fake harbor completed\\n");
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

describe("managed Harbor 0.21 lifecycle adapter", () => {
  test("selection is immutable and accepts only Harbor 0.21.x", () => {
    expect(manifest.retryPolicy).toEqual({ nAttempts: 1, nConcurrent: 1, maxRetries: 0 });
    expect(() => harborSelectionManifestBytes({ ...manifest, retryPolicy: { nAttempts: 2, nConcurrent: 1, maxRetries: 0 } } as never)).toThrow();
    expect(() => harborSelectionManifestBytes({ ...manifest, harbor: { ...manifest.harbor, version: "0.22.0" } })).toThrow();
    expect(() => harborSelectionManifestBytes({ ...manifest, environment: { ...manifest.environment, type: manifest.environment.image } } as never)).toThrow();
    expect(() => harborSelectionManifestBytes({ ...manifest, source: { ...manifest.source, input: { path: "/private/host/task" } } } as never)).toThrow();
    const canonicalSelection = JSON.parse(new TextDecoder().decode(harborSelectionManifestBytes({
      ...manifest,
      environment: { ...manifest.environment, configuration: { import_path: null, force_build: false, delete: true, cpu_enforcement_policy: "auto", memory_enforcement_policy: "auto", override_cpus: null, override_memory_mb: null, override_storage_mb: null, override_gpus: null, override_tpu: null, mounts: null, extra_docker_compose: [], env: {}, kwargs: {}, extra_allowed_hosts: [] } },
      arms: [manifest.arms[0]!, { ...manifest.arms[1]!, jobAgent: { ...manifest.arms[1]!.jobAgent, kwargs: {} } }],
      outputs: [{ ...manifest.outputs[0]!, artifact: { ...manifest.outputs[0]!.artifact, exclude: [], service: null } }],
    } as never))) as HarborSelectionManifest;
    expect(canonicalSelection.environment.configuration).toEqual({});
    expect(canonicalSelection.arms[1]!.jobAgent).toEqual({ name: "agent-two", model_name: "model-two" });
    expect(canonicalSelection.outputs[0]!.artifact).toEqual({ source: "/logs/artifacts/prediction.json", destination: "prediction.json" });
    expect(() => HarborJobConfigSchema.parse({ job_name: "job", jobs_dir: "jobs", n_attempts: 1, n_concurrent_trials: 1, retry: { max_retries: 0 }, environment: { type: manifest.environment.image }, agents: [manifest.arms[0]!.jobAgent], artifacts: manifest.outputs.map((output) => output.artifact), tasks: [manifest.source.jobInput] })).toThrow();
    const submitted = HarborJobConfigSchema.parse({ job_name: "job", jobs_dir: "jobs", n_attempts: 1, n_concurrent_trials: 1, retry: { max_retries: 0 }, environment: { type: "docker" }, agents: [manifest.arms[0]!.jobAgent], artifacts: manifest.outputs.map((output) => output.artifact), tasks: [manifest.source.jobInput] });
    expect(normalizeHarborSavedJobConfig({ ...submitted, n_attempts: undefined, retry: undefined, environment: undefined }, submitted)).toEqual(submitted);
    expect(() => normalizeHarborSavedJobConfig({ ...submitted, n_attempts: 2 }, submitted)).toThrow();
    expect(() => normalizeHarborSavedJobConfig({ ...submitted, retry: { max_retries: 1 } }, submitted)).toThrow();
    expect(() => normalizeHarborSavedJobConfig({ ...submitted, environment: { type: "daytona" } }, submitted)).toThrow(/contradicts/i);
    const submittedNondefaultEnvironment = { ...submitted, environment: { type: "docker" as const, force_build: true } };
    expect(() => normalizeHarborSavedJobConfig({ ...submittedNondefaultEnvironment, environment: undefined }, submittedNondefaultEnvironment)).toThrow();
    const canonicalSubmitted = HarborJobConfigSchema.parse({ ...submitted, environment: { type: "docker", force_build: false, delete: true, cpu_enforcement_policy: "auto" }, agents: [{ name: "agent-two", model_name: "model-two", kwargs: {} }], artifacts: [{ source: "/logs/output", exclude: [], destination: null, service: null }] });
    expect(canonicalSubmitted.environment).toEqual({ type: "docker" });
    expect(canonicalSubmitted.agents).toEqual([{ name: "agent-two", model_name: "model-two" }]);
    expect(canonicalSubmitted.artifacts).toEqual([{ source: "/logs/output" }]);
    expect(normalizeHarborSavedJobConfig({ ...canonicalSubmitted, n_attempts: undefined, retry: undefined, environment: undefined }, canonicalSubmitted)).toEqual(canonicalSubmitted);
    const datasetSource = harborJobSource({ ...manifest, source: { kind: "dataset", input: { name: "demo/dataset", version: "r1" }, jobInput: { path: ".jinn-harbor/dataset" }, resolved: manifest.source.resolved, taskName: "only-task" } });
    expect(datasetSource).toEqual({ datasets: [{ path: ".jinn-harbor/dataset", task_names: ["only-task"], n_tasks: 1 }] });
    expect(datasetSource).not.toHaveProperty("tasks");
  });

  test("append-only reverse indexes reject concurrent Harbor Job/Trial reuse", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "harbor-mapping-race-"));
    try {
      const settled = await Promise.allSettled([
        recordHarborDispatchMapping(workspaceDir, "jinn-dispatch-a", "job-shared", "trial-a"),
        recordHarborDispatchMapping(workspaceDir, "jinn-dispatch-b", "job-shared", "trial-b"),
      ]);
      expect(settled.filter((value) => value.status === "fulfilled")).toHaveLength(1);
      expect(settled.filter((value) => value.status === "rejected")).toHaveLength(1);
    } finally { await rm(workspaceDir, { recursive: true, force: true }); }
  });

  test("runLaunch uses the default host/backend, preserves solve output, and archives the official direct-root Trial tree", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "harbor-lifecycle-"));
    try {
      const executable = await fakeHarbor(workspaceDir);
      const taskMaterialPath = join(workspaceDir, "task-material");
      await mkdir(taskMaterialPath);
      await writeFile(join(taskMaterialPath, "task.toml"), `[task]\nname = "demo/task"\n[environment]\ndocker_image = "${manifest.environment.image}"\n`);
      const clock = () => new Date().toISOString();
      const context = { workspaceDir, principal: "sponsor-1", clock };
      expect(initWorkspace(context).ok).toBe(true);
      expect(createDraft(context, { draftId: "harbor-run", name: "Harbor run" }).ok).toBe(true);
      expect((await sampleInit(context, { draftId: "harbor-run" })).ok).toBe(true);
      expect(armAdd(context, { draftId: "harbor-run", armId: "one", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
      expect(armAdd(context, { draftId: "harbor-run", armId: "two", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
      const selected = await selectHarborRuntime(context, { draftId: "harbor-run", executable, source: { kind: "task", input: { name: "demo/task", ref: "r2" }, materialPath: taskMaterialPath, revision: "r2" }, arms: manifest.arms, environment: manifest.environment, outputs: manifest.outputs });
      expect(selected.ok).toBe(true);
      if (!selected.ok) throw new Error("Harbor selection unexpectedly failed");
      const quoted = await runQuote(context, { draftId: "harbor-run" });
      expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
      expect(runLock(context, { draftId: "harbor-run" }).ok).toBe(true);
      const launched = await runLaunch(context, { draftId: "harbor-run" });
      expect(launched.ok, JSON.stringify(launched)).toBe(true);

      const journal = readRunJournalEntries(workspaceDir, "harbor-run");
      const deliveries = journal.filter((entry) => entry.kind === "delivery");
      expect(deliveries.length, JSON.stringify(journal)).toBeGreaterThan(0);
      // The Task's declared solve output remains the Delivery contract; Harbor-native evidence
      // is separately reachable through the durable product archive index checked below.
      for (const delivery of deliveries) expect(delivery.outputs.map((output) => output.name)).toEqual(["prediction"]);
      expect(JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, deliveries[0]!.outputs[0]!.sha256)))).toEqual({ probabilityYes: "0.5", submittedAt: "2026-01-01T00:00:00Z" });
      expect(journal.some((entry) => entry.kind === "evaluation")).toBe(true);

      const indexRoot = join(artifactsDir(workspaceDir), "harbor", "archives", "by-dispatch");
      const indexes = await readdir(indexRoot);
      expect(indexes.length).toBe(deliveries.length);
      const index = JSON.parse(await readFile(join(indexRoot, indexes[0]!), "utf8")) as { archiveSha256: string };
      const archive = readHarborDispatchArchive(workspaceDir, index.archiveSha256);
      expect(archive.lineage).toMatchObject({ runSha256: expect.stringMatching(/^[a-f0-9]{64}$/), submissionSha256: expect.stringMatching(/^[a-f0-9]{64}$/), dispatchIndex: 1 });
      expect(archive.harbor).toMatchObject({ jobId: expect.any(String), trialId: expect.any(String), status: "completed" });
      expect(archive.nativeArtifacts.map((item) => item.path)).toEqual(expect.arrayContaining(["config.json", "result.json", "trial-1/config.json", "trial-1/result.json", "trial-1/ctrf.json", "trial-1/artifacts/unknown.bin"]));
      const effectiveJobConfig = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, archive.nativeArtifacts.find((item) => item.path === "config.json")!.sha256))) as Record<string, unknown>;
      expect(effectiveJobConfig).not.toHaveProperty("environment");
      expect(effectiveJobConfig).not.toHaveProperty("n_attempts");
      expect(effectiveJobConfig).not.toHaveProperty("retry");
      expect(effectiveJobConfig).not.toHaveProperty("orchestrator");
      expect(effectiveJobConfig).not.toHaveProperty("metadata");
      expect(effectiveJobConfig).not.toHaveProperty("datasets");
      const unknown = archive.nativeArtifacts.find((item) => item.path.endsWith("unknown.bin"))!;
      expect(getSealedBytes(workspaceDir, unknown.sha256)).toEqual(new Uint8Array([7, 8, 9]));
      const before = indexes.length;
      const contribution = harborEvidenceContributionFromArchive(workspaceDir, index.archiveSha256);
      expect(contribution.correlations).toHaveLength(2);
      expect(contribution.nativeArtifacts.filter((item) => item.role === HARBOR_ATIF_ROLE).length).toBeGreaterThanOrEqual(2);
      expect(contribution.nativeArtifacts.filter((item) => item.role === HARBOR_LOGS_ROLE).length).toBeGreaterThanOrEqual(2);
      const selectionBytes = getSealedBytes(workspaceDir, selected.result.selectionManifestSha256);
      const adapter = createRuntimeEvidenceAdapter(
        { adapterId: "harbor", selectionManifestSha256: selected.result.selectionManifestSha256 },
        { registrationArtifacts: [{ id: "harbor-selection.json", role: HARBOR_SELECTION_ROLE, digest: `sha256:${selected.result.selectionManifestSha256}`, bytes: selectionBytes, mediaType: "application/json", actions: ["store"] }] },
      );
      const checks = await adapter.verify({
        dispatch: {
          index: 1,
          submission: { kind: "https://spec.jinn.network/records/submission/v1", record: { name: "submission.json", mediaType: "application/json", digest: { sha256: archive.lineage.submissionSha256 } } },
          evidence: [], evaluations: [], ...contribution,
        },
        references: { async getExact({ digest }) { return getSealedBytes(workspaceDir, digest.slice("sha256:".length)); } },
      });
      expect(checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "runtime-evidence-unique-roles", status: "pass" }),
        expect.objectContaining({ name: "harbor-required-native-evidence", status: "pass" }),
        expect.objectContaining({ name: "harbor-job-trial-structure", status: "pass" }),
        expect.objectContaining({ name: "harbor-exact-native-evidence", status: "pass" }),
      ]));
      expect(await readdir(indexRoot)).toHaveLength(before);
    } finally { await rm(workspaceDir, { recursive: true, force: true }); }
  }, 120_000);

  test("dataset selection stages its sealed material and executes exactly one filtered task", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "harbor-dataset-"));
    try {
      const executable = await fakeHarbor(workspaceDir);
      const materialPath = join(workspaceDir, "private-dataset-material");
      await mkdir(materialPath);
      await Promise.all([
        writeFile(join(materialPath, "dataset.yaml"), "name: demo/dataset\n"),
        writeFile(join(materialPath, "task.toml"), `[task]\nname = "only-task"\n[environment]\ndocker_image = "${manifest.environment.image}"\n`),
      ]);
      const context = { workspaceDir, principal: "sponsor-1", clock: () => new Date().toISOString() };
      expect(initWorkspace(context).ok).toBe(true);
      expect(createDraft(context, { draftId: "harbor-dataset", name: "Harbor dataset" }).ok).toBe(true);
      expect((await sampleInit(context, { draftId: "harbor-dataset" })).ok).toBe(true);
      expect(armAdd(context, { draftId: "harbor-dataset", armId: "one", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
      expect(armAdd(context, { draftId: "harbor-dataset", armId: "two", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
      const selected = await selectHarborRuntime(context, {
        draftId: "harbor-dataset", executable,
        source: { kind: "dataset", input: { name: "demo/dataset", version: "r1" }, materialPath, revision: "r1", taskName: "only-task" },
        arms: manifest.arms, environment: manifest.environment, outputs: manifest.outputs,
      });
      expect(selected.ok, JSON.stringify(selected)).toBe(true);
      if (!selected.ok) throw new Error("Harbor dataset selection unexpectedly failed");
      const publicSelection = new TextDecoder().decode(getSealedBytes(workspaceDir, selected.result.selectionManifestSha256));
      expect(publicSelection).not.toContain(materialPath);
      expect(JSON.parse(publicSelection)).toMatchObject({
        source: { kind: "dataset", input: { name: "demo/dataset", version: "r1" }, jobInput: { path: ".jinn-harbor/dataset" }, taskName: "only-task", resolved: { revision: "r1", files: expect.any(Array) } },
      });
      const quoted = await runQuote(context, { draftId: "harbor-dataset" });
      expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
      expect(runLock(context, { draftId: "harbor-dataset" }).ok).toBe(true);
      expect((await runLaunch(context, { draftId: "harbor-dataset" })).ok).toBe(true);
      const journal = readRunJournalEntries(workspaceDir, "harbor-dataset");
      const delivery = journal.find((entry) => entry.kind === "delivery");
      expect(delivery).toBeDefined();
      if (delivery?.kind !== "delivery") throw new Error("Harbor dataset run produced no Delivery");
      expect(JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, delivery.outputs[0]!.sha256)))).toEqual({ probabilityYes: "0.5", submittedAt: "2026-01-01T00:00:00Z" });
      const indexRoot = join(artifactsDir(workspaceDir), "harbor", "archives", "by-dispatch");
      const indexes = await readdir(indexRoot);
      const index = JSON.parse(await readFile(join(indexRoot, indexes[0]!), "utf8")) as { archiveSha256: string };
      const archive = readHarborDispatchArchive(workspaceDir, index.archiveSha256);
      const configEntry = archive.nativeArtifacts.find((entry) => entry.path === "config.json")!;
      const jobConfig = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, configEntry.sha256)));
      expect(jobConfig).toMatchObject({ datasets: [{ path: ".jinn-harbor/dataset", task_names: ["only-task"], n_tasks: 1 }] });
      expect(jobConfig).not.toHaveProperty("tasks");
    } finally { await rm(workspaceDir, { recursive: true, force: true }); }
  }, 120_000);

  test("failed Harbor execution archives readable partial files and reports unsafe siblings before terminal failure", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "harbor-partial-"));
    try {
      const executable = await fakeHarbor(workspaceDir, true);
      const taskMaterialPath = join(workspaceDir, "task-material");
      await mkdir(taskMaterialPath);
      await writeFile(join(taskMaterialPath, "task.toml"), `[task]\nname = "demo/task"\n[environment]\ndocker_image = "${manifest.environment.image}"\n`);
      const context = { workspaceDir, principal: "sponsor-1", clock: () => new Date().toISOString() };
      expect(initWorkspace(context).ok).toBe(true);
      expect(createDraft(context, { draftId: "harbor-fail", name: "Harbor fail" }).ok).toBe(true);
      expect((await sampleInit(context, { draftId: "harbor-fail" })).ok).toBe(true);
      expect(armAdd(context, { draftId: "harbor-fail", armId: "one", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
      expect(armAdd(context, { draftId: "harbor-fail", armId: "two", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
      const selected = await selectHarborRuntime(context, { draftId: "harbor-fail", executable, source: { kind: "task", input: { name: "demo/task", ref: "r2" }, materialPath: taskMaterialPath, revision: "r2" }, arms: manifest.arms, environment: manifest.environment, outputs: manifest.outputs });
      expect(selected.ok, JSON.stringify(selected)).toBe(true);
      expect((await runQuote(context, { draftId: "harbor-fail" })).ok).toBe(true);
      expect(runLock(context, { draftId: "harbor-fail" }).ok).toBe(true);
      expect((await runLaunch(context, { draftId: "harbor-fail" })).ok).toBe(true);
      const journal = readRunJournalEntries(workspaceDir, "harbor-fail");
      expect(journal.some((entry) => entry.kind === "cell-event" && entry.event.kind === "error")).toBe(true);
      expect(journal.some((entry) => entry.kind === "delivery")).toBe(false);
      const indexRoot = join(artifactsDir(workspaceDir), "harbor", "archives", "by-dispatch");
      const indexes = await readdir(indexRoot);
      expect(indexes.length).toBeGreaterThan(0);
      const index = JSON.parse(await readFile(join(indexRoot, indexes[0]!), "utf8")) as { archiveSha256: string };
      const archive = readHarborDispatchArchive(workspaceDir, index.archiveSha256);
      expect(archive.harbor.status).toBe("failed");
      expect(archive.nativeArtifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "config.json", availability: "public" }),
        expect.objectContaining({ path: "result.json", availability: "public" }),
        expect.objectContaining({ path: "trial-1/partial.log", availability: "public" }),
        expect.objectContaining({ path: "trial-1/unsafe-link", availability: "collection-failed", reason: expect.stringContaining("symlink") }),
        expect.objectContaining({ path: "invocation/stderr.log", availability: "public" }),
      ]));
    } finally { await rm(workspaceDir, { recursive: true, force: true }); }
  }, 120_000);
});
