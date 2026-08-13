import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { launchAndWatch, type CellStatusEvent } from "@jinn-network/benchmarking-run";
import { parseBenchmark, parseBenchmarkAccounting, parseRun } from "@jinn-network/benchmarking-records";
import { armAdd } from "../../operations/arms.js";
import { createDraft, getDraft, updateDraft } from "../../operations/drafts.js";
import { initWorkspace } from "../../operations/init.js";
import { selectHarborRuntime } from "../../operations/harbor-runtime.js";
import { runLaunch } from "../../operations/run-launch.js";
import { runCollect } from "../../operations/run-collect.js";
import { runLock } from "../../operations/run-lock.js";
import { runQuote } from "../../operations/run-quote.js";
import { sampleInit } from "../../operations/sample.js";
import { publicationAccounting } from "../../operations/publication-accounting.js";
import { publicationConfigure, publicationRegister } from "../../operations/publication-register.js";
import { readRunJournalEntries } from "../../run/journal.js";
import { createWorkspacePublicationHttpHandler, publicArchiveUrl, recordPath } from "../../run/publication-source.js";
import { readRunState } from "../../run/state.js";
import { createRuntimeEvidenceAdapter, createRuntimeVenue } from "../adapter.js";
import { artifactsDir } from "../../workspace/layout.js";
import { getSealedBytes } from "../../workspace/sealed-store.js";
import { recordHarborDispatchMapping } from "../../venue/provisioner.js";
import { HarborJobConfigSchema, harborJobSource, harborSelectionManifestBytes, normalizeHarborSavedJobConfig, type HarborSelectionManifest } from "./manifest.js";
import { HARBOR_ATIF_ROLE, HARBOR_LOGS_ROLE, HARBOR_REWARD_ROLE, HARBOR_SELECTION_ROLE, harborEvidenceContributionFromArchive, readHarborDispatchArchive } from "./venue.js";

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
writeFileSync(${JSON.stringify(join(root, "harbor-invocations.log"))}, "run\\n", { flag: "a" });
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
      environment: { ...manifest.environment, configuration: { import_path: null, force_build: false, delete: true, cpu_enforcement_policy: "auto", memory_enforcement_policy: "auto", override_cpus: null, override_memory_mb: null, override_storage_mb: null, override_gpus: null, override_tpu: null, mounts: null, extra_docker_compose: [], env: {}, kwargs: {} } },
      arms: [manifest.arms[0]!, { ...manifest.arms[1]!, jobAgent: { ...manifest.arms[1]!.jobAgent, kwargs: {} } }],
      outputs: [{ ...manifest.outputs[0]!, artifact: { ...manifest.outputs[0]!.artifact, exclude: [], service: null } }],
    } as never))) as HarborSelectionManifest;
    expect(canonicalSelection.environment.configuration).toEqual({});
    expect(canonicalSelection.arms[1]!.jobAgent).toEqual({ name: "agent-two", model_name: "model-two" });
    expect(canonicalSelection.outputs[0]!.artifact).toEqual({ source: "/logs/artifacts/prediction.json", destination: "prediction.json" });
    const selectionWithEnvironment = (configuration: unknown) => harborSelectionManifestBytes({ ...manifest, environment: { ...manifest.environment, configuration } } as never);
    expect(() => selectionWithEnvironment({ override_tpu: { type: "v6e", topology: "2x4" } })).not.toThrow();
    expect(() => selectionWithEnvironment({ override_tpu: { type: "v6e", topology: "2-by-4" } })).toThrow();
    expect(() => selectionWithEnvironment({ override_tpu: { type: "v6e", topology: "0x4" } })).toThrow();
    expect(() => selectionWithEnvironment({ extra_allowed_hosts: ["example.com"] })).toThrow();
    expect(() => selectionWithEnvironment({ mounts: [{ type: "bind", source: "/host", target: "/guest", read_only: false }] })).toThrow();
    expect(() => selectionWithEnvironment({ mounts: [{ type: "volume", source: "cache", target: "/guest", bind: { create_host_path: false } }] })).toThrow();
    const selectionWithArtifact = (artifact: unknown) => harborSelectionManifestBytes({ ...manifest, outputs: [{ ...manifest.outputs[0]!, artifact }] } as never);
    expect(() => selectionWithArtifact({ source: "/logs/output", destination: "bad\\path" })).toThrow();
    expect(() => selectionWithArtifact({ source: "/logs/output", destination: "manifest.json" })).toThrow();
    expect(() => selectionWithArtifact({ source: "/logs/output", destination: "manifest.json/" })).toThrow();
    expect(() => selectionWithArtifact({ source: "relative/output", destination: "output", service: "sidecar" })).toThrow();
    expect(() => selectionWithArtifact({ source: "/logs/output", destination: "output", service: "bad service" })).toThrow();
    expect(() => selectionWithArtifact({ source: "/logs/../secret", destination: "output" })).toThrow();
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

  test("PUB-15 case 7: a host-classified unscorable Harbor dispatch is visibly replaced without a Harbor retry", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "harbor-visible-replacement-"));
    try {
      // The fake executable refuses any config that could hide another Trial beneath this
      // dispatch. Its invocation log is consequently an external count of actual Harbor work.
      const executable = await fakeHarbor(workspaceDir);
      const taskMaterialPath = join(workspaceDir, "task-material");
      await mkdir(taskMaterialPath);
      await writeFile(join(taskMaterialPath, "task.toml"), `[task]\nname = "demo/task"\n[environment]\ndocker_image = "${manifest.environment.image}"\n`);
      const clock = () => "2026-08-13T12:00:00Z";
      const context = { workspaceDir, principal: "sponsor-1", clock };
      expect(initWorkspace(context).ok).toBe(true);
      expect(createDraft(context, { draftId: "replacement", name: "Visible Harbor replacement" }).ok).toBe(true);
      expect((await sampleInit(context, { draftId: "replacement" })).ok).toBe(true);
      const mutable = getDraft(context, { draftId: "replacement" });
      expect(mutable.ok).toBe(true);
      if (!mutable.ok) throw new Error("draft unexpectedly unavailable");
      // §7.4 replacement is opt-in and bounded. Generic failed/rejected/lost terminals stay
      // non-replaceable; the first completed Harbor attempt below is specifically unscorable.
      expect(updateDraft(context, {
        draftId: "replacement",
        patch: {
          policy: {
            ...mutable.result.draft.spec.policy,
            replacement: { allowed: true, maxPerCell: 1 },
          },
        },
      }).ok).toBe(true);
      for (const arm of manifest.arms) {
        expect(armAdd(context, {
          draftId: "replacement",
          armId: arm.armId,
          pinning: { harness: { id: "placeholder", version: "1" } },
        }).ok).toBe(true);
      }
      const selected = await selectHarborRuntime(context, {
        draftId: "replacement",
        executable,
        source: { kind: "task", input: { name: "demo/task", ref: "r2" }, materialPath: taskMaterialPath, revision: "r2" },
        arms: manifest.arms,
        environment: manifest.environment,
        outputs: manifest.outputs,
      });
      expect(selected.ok, JSON.stringify(selected)).toBe(true);
      expect((await runQuote(context, { draftId: "replacement" })).ok).toBe(true);
      expect(runLock(context, { draftId: "replacement" }).ok).toBe(true);

      const locked = getDraft(context, { draftId: "replacement" });
      expect(locked.ok).toBe(true);
      if (!locked.ok || locked.result.draft.spec.taskSet.kind !== "benchmark") {
        throw new Error("locked benchmark draft unexpectedly unavailable");
      }
      const runState = readRunState(workspaceDir, "replacement");
      expect(runState?.runSha256).toMatch(/^[a-f0-9]{64}$/u);
      if (runState?.runSha256 === undefined) throw new Error("lock did not retain the sealed Run");
      const benchmark = parseBenchmark(getSealedBytes(workspaceDir, locked.result.draft.spec.taskSet.benchmarkSha256));
      const run = parseRun(getSealedBytes(workspaceDir, runState.runSha256));
      const venue = createRuntimeVenue(locked.result.draft.spec.evaluationRuntime, {
        workspaceDir,
        now: clock,
        evaluatorCount: run.policy.evaluation?.minVerdicts ?? 1,
      });
      try {
        venue.assertRunOwnership?.();
        await venue.preflightRun?.();
        const events: CellStatusEvent[] = [];
        let firstTerminalClassified = false;
        for await (const event of launchAndWatch(benchmark, run, venue.backend, {
          runDigest: `sha256:${runState.runSha256}`,
          taskBytesFor: (digest) => getSealedBytes(workspaceDir, digest),
          clock: { now: () => new Date(clock()) },
          // This is an application-owned benchmark verdict: the Harbor process completed, but
          // its first result is unusable. It is deliberately not a generic TEP failure retry.
          hostTerminalFacts: () => {
            if (firstTerminalClassified) return undefined;
            firstTerminalClassified = true;
            return { unscorable: true };
          },
        })) {
          events.push(event);
          if (event.dispatch === 2 && event.kind === "delivered") break;
        }

        const firstCell = events[0]?.cellKey;
        expect(firstCell).toBeTruthy();
        const lineage = events.filter((event) => event.cellKey === firstCell);
        const firstDispatch = lineage.find((event) => event.dispatch === 1 && event.kind === "dispatch");
        const firstTerminal = lineage.find((event) => event.dispatch === 1 && event.kind === "error");
        const replacementDispatch = lineage.find((event) => event.dispatch === 2 && event.kind === "dispatch");
        const replacementTerminal = lineage.find((event) => event.dispatch === 2 && event.kind === "delivered");
        expect(firstTerminal).toMatchObject({ replaceable: true, replaceableReason: "unscorable", detail: "unscorable" });
        expect(firstDispatch?.submissionDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
        expect(replacementDispatch?.submissionDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
        expect(replacementDispatch?.submissionDigest).not.toBe(firstDispatch?.submissionDigest);
        expect(replacementDispatch?.attempt).toMatch(/^urn:uuid:/u);
        expect(replacementDispatch?.attempt).not.toBe(firstDispatch?.attempt);
        expect(replacementTerminal?.attempt).toBe(replacementDispatch?.attempt);

        // Two visible Jinn dispatches account for exactly two actual Harbor invocations. The
        // fake Harbor asserts n_attempts=1, n_concurrent_trials=1, and max_retries=0 each time.
        const invocations = (await readFile(join(workspaceDir, "harbor-invocations.log"), "utf8"))
          .trim().split("\n").filter(Boolean);
        expect(invocations).toHaveLength(2);
      } finally {
        await venue.shutdown();
      }
    } finally { await rm(workspaceDir, { recursive: true, force: true }); }
  }, 120_000);

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
      const collected = await runCollect(context, { draftId: "harbor-run" });
      expect(collected.ok, JSON.stringify(collected)).toBe(true);

      // This is deliberately post-hoc: the fake executable has completed before the product
      // configures its source. Registration/accounting must only read retained exact bytes; a
      // second Harbor invocation would be a hidden rerun and violate the profile.
      const invocationPath = join(workspaceDir, "harbor-invocations.log");
      const invocationsBeforePublication = await readFile(invocationPath, "utf8");
      let publicationServer: Server | undefined;
      try {
        const handler = createWorkspacePublicationHttpHandler(workspaceDir);
        publicationServer = createServer(async (request, response) => {
          const result = await handler(new Request(`http://127.0.0.1${request.url ?? "/"}`, { method: request.method }));
          response.writeHead(result.status, Object.fromEntries(result.headers));
          response.end(Buffer.from(await result.arrayBuffer()));
        });
        await new Promise<void>((resolve) => publicationServer!.listen(0, "127.0.0.1", resolve));
        const address = publicationServer.address();
        if (address === null || typeof address === "string") throw new Error("loopback source has no TCP address");
        const publicBaseUrl = `http://127.0.0.1:${address.port}`;
        expect((await publicationConfigure(context, { draftId: "harbor-run", publicBaseUrl })).ok).toBe(true);
        expect((await publicationRegister(context, { draftId: "harbor-run" })).ok).toBe(true);
        const published = await publicationAccounting(context, { draftId: "harbor-run" });
        expect(published.ok, JSON.stringify(published)).toBe(true);
        if (!published.ok) throw new Error("post-hoc accounting unexpectedly failed");
        expect(parseBenchmarkAccounting(getSealedBytes(workspaceDir, published.result.accountingSha256)).publicRegistration.status).toBe("post-hoc");
        const response = await fetch(publicArchiveUrl(publicBaseUrl, recordPath(`sha256:${published.result.accountingSha256}`)));
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(getSealedBytes(workspaceDir, published.result.accountingSha256));
        expect(await readFile(invocationPath, "utf8")).toBe(invocationsBeforePublication);
        expect(readRunState(workspaceDir, "harbor-run")?.publication?.accounting.state).toBe("complete");
      } finally {
        if (publicationServer !== undefined) await new Promise<void>((resolve) => publicationServer!.close(() => resolve()));
      }

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
      const recording = archive.nativeArtifacts.find((item) => item.path === "trial-1/agent/recording.cast")!;
      const trajectory = archive.nativeArtifacts.find((item) => item.path === "trial-1/agent/trajectory.json")!;
      const reward = archive.nativeArtifacts.find((item) => item.path === "trial-1/verifier/reward.txt")!;
      expect(recording.role).toBe(HARBOR_ATIF_ROLE);
      expect(getSealedBytes(workspaceDir, recording.sha256)).toEqual(new Uint8Array([0, 255, 1]));
      expect(trajectory.role).toBe(HARBOR_ATIF_ROLE);
      expect(getSealedBytes(workspaceDir, trajectory.sha256)).toEqual(new TextEncoder().encode(JSON.stringify({ schema: "ATIF" })));
      expect(reward.role).toBe(HARBOR_REWARD_ROLE);
      expect(getSealedBytes(workspaceDir, reward.sha256)).toEqual(new TextEncoder().encode("1\n"));
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
