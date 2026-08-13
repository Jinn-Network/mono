import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseBenchmarkAccounting, parseMatrix, readRunPublicationExtension } from "@jinn-network/benchmarking-records";
import { armAdd } from "../../operations/arms.js";
import { createDraft } from "../../operations/drafts.js";
import { initWorkspace } from "../../operations/init.js";
import { publicationAccounting } from "../../operations/publication-accounting.js";
import { buildRegistrationClosure, publicationConfigure, publicationRegister } from "../../operations/publication-register.js";
import { runCollect } from "../../operations/run-collect.js";
import { runLaunch } from "../../operations/run-launch.js";
import { runLock } from "../../operations/run-lock.js";
import { runQuote } from "../../operations/run-quote.js";
import { sampleInit } from "../../operations/sample.js";
import { migrateTerminalBenchLegacyTask, selectTerminalBench2Runtime } from "../../operations/terminal-bench-2.js";
import { readRunJournalEntries } from "../../run/journal.js";
import { requireRunState } from "../../run/state.js";
import { createWorkspacePublicationHttpHandler, publicArchiveUrl, recordPath } from "../../run/publication-source.js";
import { readHarborDispatchArchive } from "../harbor/venue.js";
import { HarborSelectionManifestSchema, type HarborSelectionManifest } from "../harbor/manifest.js";
import { artifactsDir } from "../../workspace/layout.js";
import { getSealedBytes, sealedRecordPath } from "../../workspace/sealed-store.js";
import { computeHarbor021TaskContentHash, resolveTerminalBench2Selection } from "./host.js";
import { TERMINAL_BENCH_2_DATASET_ID, TERMINAL_BENCH_2_PROFILE, TERMINAL_BENCH_2_SELECTION_ROLE, TERMINAL_BENCH_MIGRATION_ROLE, TerminalBench2SelectionManifestSchema } from "./manifest.js";
import { HARBOR_SELECTION_ROLE } from "../harbor/venue.js";
import { createRuntimeEvidenceAdapter } from "../adapter.js";
import { terminalBench2ExternalReadiness } from "./external-readiness.js";

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
writeFileSync(${JSON.stringify(join(root, "harbor-runs.ndjson"))}, JSON.stringify({ job_name: config.job_name, datasets: config.datasets, agents: config.agents.length, n_attempts: config.n_attempts, n_concurrent_trials: config.n_concurrent_trials, max_retries: config.retry.max_retries }) + "\\n", { flag: "a" });
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

function clock(): () => string {
  let tick = 0;
  // The local backend's supervisor enforces Submission deadlines against the host clock.
  // Anchor this integration fixture to the live wall clock so it cannot become date-brittle.
  const epoch = Date.now();
  return () => new Date(epoch + tick++ * 1_000).toISOString();
}

function harborRunBytes(): string {
  try { return readFileSync(join(root, "harbor-runs.ndjson"), "utf8"); }
  catch { return ""; }
}

function parseHarborRuns(bytes = harborRunBytes()): Array<Record<string, unknown>> {
  return bytes.trim() === "" ? [] : bytes.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function startPublicationSource(): Promise<{ readonly base: string; readonly close: () => Promise<void> }> {
  const handler = createWorkspacePublicationHttpHandler(workspaceDir);
  const server = createServer(async (request, response) => {
    const result = await handler(new Request(`http://127.0.0.1${request.url ?? "/"}`, { method: request.method }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback source has no address");
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function expectExactPublicBytes(base: string, path: string, expected: Uint8Array): Promise<void> {
  const response = await fetch(publicArchiveUrl(base, path));
  expect(response.ok, `${path} returned ${response.status}`).toBe(true);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
}

async function expectPublishedRuntimeDependencies(base: string, draftId: string, expectedDigests: readonly string[]): Promise<void> {
  const registered = Object.entries(requireRunState(workspaceDir, draftId).publication!.registration.digests ?? {});
  for (const digest of new Set(expectedDigests)) {
    expect(registered.some(([id, value]) => id.startsWith("runtime-material:") && value === digest), `registration state omitted runtime dependency ${digest}`).toBe(true);
    await expectExactPublicBytes(base, `/publication-artifacts/sha256/${digest}`, getSealedBytes(workspaceDir, digest));
  }
}

function expectTransitiveRuntimeDependencies(runBytes: Uint8Array, runSha256: string, expectedDigests: readonly string[]): void {
  const members = buildRegistrationClosure(workspaceDir, runBytes, runSha256, "2026-08-13T00:00:00.000Z");
  const byId = new Map(members.map((member) => [member.id, member]));
  const benchmark = members.find((member) => member.id.startsWith("benchmark:"));
  expect(benchmark).toBeDefined();
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
  };
  visit(benchmark!.id);
  for (const digest of new Set(expectedDigests)) {
    expect(members.some((member) => member.id.startsWith("runtime-material:") && member.digest === `sha256:${digest}` && reachable.has(member.id)), `Benchmark closure omitted runtime dependency ${digest}`).toBe(true);
  }
}
function expectOneFilteredTrialPerDispatch(invocations: readonly Record<string, unknown>[], dispatchCount: number): void {
  expect(invocations).toHaveLength(dispatchCount);
  for (const invocation of invocations) expect(invocation).toMatchObject({
    datasets: [{ path: ".jinn-harbor/dataset", task_names: ["echo"], n_tasks: 1 }],
    agents: 1,
    n_attempts: 1,
    n_concurrent_trials: 1,
    max_retries: 0,
  });
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
    await expect(terminalBench2ExternalReadiness({ optIn: false, dockerExecutable: "/missing/docker", registryMetadataPath: "/missing/metadata", taskMaterialPath: "/missing/task" })).resolves.toMatchObject({ ready: false, reason: "opt-in-required" });
    await expect(terminalBench2ExternalReadiness({ optIn: true, dockerExecutable: "/missing/docker", registryMetadataPath: metadataPath, taskMaterialPath: materialPath })).resolves.toMatchObject({ ready: false, reason: "docker-unavailable" });
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

  test("publishes depth-first nested material with a same-prefix sibling before running it", async () => {
    const context = { workspaceDir, principal: "sponsor-1", clock: clock() };
    expect(initWorkspace(context).ok).toBe(true);
    expect(createDraft(context, { draftId: "nested", name: "Nested TB2" }).ok).toBe(true);
    expect((await sampleInit(context, { draftId: "nested" })).ok).toBe(true);
    expect(armAdd(context, { draftId: "nested", armId: "one", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    expect(armAdd(context, { draftId: "nested", armId: "two", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    mkdirSync(join(materialPath, "echo", "tests", "assets"), { recursive: true });
    writeFileSync(join(materialPath, "echo", "tests", "assets", "file.txt"), "nested asset\n");
    writeFileSync(join(materialPath, "echo", "tests", "assets.json"), "{\"sibling\":true}\n");
    const nestedTaskRevision = `sha256:${computeHarbor021TaskContentHash(join(materialPath, "echo")).contentHash}` as const;
    writeFileSync(metadataPath, JSON.stringify({
      name: TERMINAL_BENCH_2_DATASET_ID,
      dataset_version_content_hash: datasetRevision,
      task_ids: [{ org: "terminal-bench", name: "echo", ref: nestedTaskRevision }],
    }));
    const selected = await selectTerminalBench2Runtime(context, { draftId: "nested", ...request(), taskRevision: nestedTaskRevision });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    const outer = HarborSelectionManifestSchema.parse(JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, selected.result.selectionManifestSha256))));
    const profile = TerminalBench2SelectionManifestSchema.parse(outer.profiles?.[TERMINAL_BENCH_2_PROFILE]);
    expect(profile.selectedTask.material.files.map((file) => file.path)).toEqual([
      "instruction.md", "task.toml", "tests/assets/file.txt", "tests/assets.json",
    ]);
    expect((await runQuote(context, { draftId: "nested" })).ok).toBe(true);
    const locked = runLock(context, { draftId: "nested" });
    expect(locked.ok, JSON.stringify(locked)).toBe(true);
    if (!locked.ok) return;
    const runtimeDependencyDigests = [
      outer.harbor.executableSha256,
      ...outer.source.resolved.files.map((file) => file.sha256),
      profile.dataset.registrySnapshotSha256,
      ...profile.selectedTask.material.files.map((file) => file.sha256),
    ];
    const source = await startPublicationSource();
    try {
      expect((await publicationConfigure(context, { draftId: "nested", publicBaseUrl: source.base })).ok).toBe(true);
      expect((await publicationRegister(context, { draftId: "nested" })).ok).toBe(true);
      await expectPublishedRuntimeDependencies(source.base, "nested", runtimeDependencyDigests);
      const beforeLaunch = harborRunBytes();
      const launch = await runLaunch(context, { draftId: "nested" });
      expect(launch.ok, JSON.stringify(launch)).toBe(true);
      const deliveries = readRunJournalEntries(workspaceDir, "nested").filter((entry) => entry.kind === "delivery");
      expectOneFilteredTrialPerDispatch(parseHarborRuns(), deliveries.length);
      expect(harborRunBytes()).not.toBe(beforeLaunch);
    } finally {
      await source.close();
    }
  }, 120_000);

  test("one Jinn dispatch creates one filtered Harbor Trial through the normal lifecycle", async () => {
    const context = { workspaceDir, principal: "sponsor-1", clock: clock() };
    expect(initWorkspace(context).ok).toBe(true);
    expect(createDraft(context, { draftId: "tb2", name: "TB2" }).ok).toBe(true);
    expect((await sampleInit(context, { draftId: "tb2" })).ok).toBe(true);
    expect(armAdd(context, { draftId: "tb2", armId: "one", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    expect(armAdd(context, { draftId: "tb2", armId: "two", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
    const selected = await selectTerminalBench2Runtime(context, { draftId: "tb2", ...request() });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    const outer = HarborSelectionManifestSchema.parse(JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, selected.result.selectionManifestSha256))));
    const profile = TerminalBench2SelectionManifestSchema.parse(outer.profiles?.[TERMINAL_BENCH_2_PROFILE]);
    expect(profile.execution).toEqual({ source: "dataset", nTasks: 1, nAttempts: 1, nConcurrent: 1, maxRetries: 0 });
    const quoted = await runQuote(context, { draftId: "tb2" });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    const locked = runLock(context, { draftId: "tb2" });
    expect(locked.ok, JSON.stringify(locked)).toBe(true);
    if (!locked.ok) return;
    const runBytes = getSealedBytes(workspaceDir, locked.result.runSha256);
    const runtimeDependencyDigests = [
      outer.harbor.executableSha256,
      ...outer.source.resolved.files.map((file) => file.sha256),
      profile.dataset.registrySnapshotSha256,
      ...profile.selectedTask.material.files.map((file) => file.sha256),
    ];
    const registryBytes = getSealedBytes(workspaceDir, profile.dataset.registrySnapshotSha256);
    rmSync(sealedRecordPath(workspaceDir, profile.dataset.registrySnapshotSha256));
    expect(() => buildRegistrationClosure(workspaceDir, runBytes, locked.result.runSha256, "2026-08-13T00:00:00.000Z")).toThrow(/no sealed record/u);
    writeFileSync(sealedRecordPath(workspaceDir, profile.dataset.registrySnapshotSha256), "tampered registry");
    expect(() => buildRegistrationClosure(workspaceDir, runBytes, locked.result.runSha256, "2026-08-13T00:00:00.000Z")).toThrow(/do not match their digest/u);
    writeFileSync(sealedRecordPath(workspaceDir, profile.dataset.registrySnapshotSha256), registryBytes);
    expectTransitiveRuntimeDependencies(runBytes, locked.result.runSha256, runtimeDependencyDigests);
    const registration = readRunPublicationExtension(JSON.parse(new TextDecoder().decode(runBytes)) as Record<string, unknown>)!.registrationArtifacts;
    expect(registration.map((entry) => entry.role)).toEqual([HARBOR_SELECTION_ROLE, TERMINAL_BENCH_2_SELECTION_ROLE].sort());
    expect(registration).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: HARBOR_SELECTION_ROLE, artifact: expect.objectContaining({ digest: { sha256: selected.result.selectionManifestSha256 } }) }),
      expect.objectContaining({ role: TERMINAL_BENCH_2_SELECTION_ROLE, artifact: expect.objectContaining({ digest: { sha256: selected.result.terminalBench2ProfileSha256 } }) }),
    ]));
    const source = await startPublicationSource();
    try {
      expect((await publicationConfigure(context, { draftId: "tb2", publicBaseUrl: source.base })).ok).toBe(true);
      expect((await publicationRegister(context, { draftId: "tb2" })).ok).toBe(true);
      await expectExactPublicBytes(source.base, recordPath(`sha256:${locked.result.runSha256}`), runBytes);
      for (const entry of registration) await expectExactPublicBytes(
        source.base,
        `/publication-artifacts/sha256/${entry.artifact.digest.sha256}`,
        getSealedBytes(workspaceDir, entry.artifact.digest.sha256),
      );
      await expectPublishedRuntimeDependencies(source.base, "tb2", runtimeDependencyDigests);

      const launch = await runLaunch(context, { draftId: "tb2" });
      expect(launch.ok, JSON.stringify(launch)).toBe(true);
      const collected = await runCollect(context, { draftId: "tb2" });
      expect(collected.ok, JSON.stringify(collected)).toBe(true);
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
      const invocationBytes = harborRunBytes();
      expectOneFilteredTrialPerDispatch(parseHarborRuns(invocationBytes), deliveries.length);
      const published = await publicationAccounting(context, { draftId: "tb2" });
      expect(published.ok, JSON.stringify(published)).toBe(true);
      if (!published.ok) return;
      expect(published.result.runtimeChecks.every((check) => check.status === "pass")).toBe(true);
      const accountingBytes = getSealedBytes(workspaceDir, published.result.accountingSha256);
      const matrixBytes = getSealedBytes(workspaceDir, published.result.matrixV2Sha256);
      expect(parseBenchmarkAccounting(accountingBytes).publicRegistration.status).toBe("pre-dispatch");
      expect(parseBenchmarkAccounting(accountingBytes).cells.flatMap((cell) => cell.dispatches)).toHaveLength(deliveries.length);
      expect(parseMatrix(matrixBytes).cells).toHaveLength(deliveries.length);
      await expectExactPublicBytes(source.base, recordPath(`sha256:${published.result.accountingSha256}`), accountingBytes);
      await expectExactPublicBytes(source.base, recordPath(`sha256:${published.result.matrixV2Sha256}`), matrixBytes);
      expect(harborRunBytes()).toBe(invocationBytes);
    } finally {
      await source.close();
    }
  }, 120_000);

  test("legacy migration uses official argv and discloses distinct source/transformed bytes", async () => {
    const context = { workspaceDir, principal: "sponsor-1", clock: clock() };
    expect(initWorkspace(context).ok).toBe(true);
    const legacy = join(root, "legacy"); mkdirSync(legacy); writeFileSync(join(legacy, "instruction.md"), "legacy task\n"); writeFileSync(join(legacy, "empty.txt"), "");
    const migrated = await migrateTerminalBenchLegacyTask(context, { executable, sourcePath: legacy, manualAdjustment: { status: "none" } });
    expect(migrated.ok, JSON.stringify(migrated)).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.result.manifest.command.argv).toEqual(["task", "migrate", "-i", "source", "-o", "transformed"]);
    expect(migrated.result.manifest.relationship).toBe("source-transformed-by-harbor-mapper");
    expect(migrated.result.manifest.source.checksum).not.toBe(migrated.result.manifest.transformed.checksum);
    expect(migrated.result.manifest.manualAdjustment).toEqual({ status: "none" });
    for (const entry of [...migrated.result.manifest.source.files, ...migrated.result.manifest.transformed.files, ...migrated.result.manifest.runnable.files]) {
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
    const outer = HarborSelectionManifestSchema.parse(JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, selected.result.selectionManifestSha256))));
    const profile = TerminalBench2SelectionManifestSchema.parse(outer.profiles?.[TERMINAL_BENCH_2_PROFILE]);
    expect(profile.migrationManifestSha256).toBe(migrated.result.manifestSha256);
    expect(profile.selectedTask.material.checksum).toBe(migrated.result.manifest.runnable.checksum);
    expect((await runQuote(context, { draftId: "migrated" })).ok).toBe(true);
    const locked = runLock(context, { draftId: "migrated" });
    expect(locked.ok, JSON.stringify(locked)).toBe(true);
    if (!locked.ok) return;
    const runBytes = getSealedBytes(workspaceDir, locked.result.runSha256);
    const runtimeDependencyDigests = [
      outer.harbor.executableSha256,
      ...outer.source.resolved.files.map((file) => file.sha256),
      profile.dataset.registrySnapshotSha256,
      ...profile.selectedTask.material.files.map((file) => file.sha256),
      migrated.result.manifest.harbor.executableSha256,
      migrated.result.manifest.command.stdoutSha256,
      migrated.result.manifest.command.stderrSha256,
      ...migrated.result.manifest.source.files.map((file) => file.sha256),
      ...migrated.result.manifest.transformed.files.map((file) => file.sha256),
      ...migrated.result.manifest.runnable.files.map((file) => file.sha256),
    ];
    expectTransitiveRuntimeDependencies(runBytes, locked.result.runSha256, runtimeDependencyDigests);
    const emptyDependencyMembers = buildRegistrationClosure(workspaceDir, runBytes, locked.result.runSha256, "2026-08-13T00:00:00.000Z")
      .filter((member) => member.id.startsWith("runtime-material:") && member.digest === `sha256:${migrated.result.manifest.command.stderrSha256}`);
    expect(emptyDependencyMembers.length).toBeGreaterThan(3);
    expect(new Set(emptyDependencyMembers.map((member) => member.mediaType))).toEqual(new Set(["application/octet-stream"]));
    const run = JSON.parse(new TextDecoder().decode(runBytes)) as Record<string, unknown>;
    const registration = readRunPublicationExtension(run)!.registrationArtifacts;
    expect(registration.map((entry) => entry.role)).toEqual([
      HARBOR_SELECTION_ROLE,
      TERMINAL_BENCH_MIGRATION_ROLE,
      TERMINAL_BENCH_2_SELECTION_ROLE,
    ].sort());
    expect(registration).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: HARBOR_SELECTION_ROLE, artifact: expect.objectContaining({ digest: { sha256: selected.result.selectionManifestSha256 } }) }),
      expect.objectContaining({ role: TERMINAL_BENCH_MIGRATION_ROLE, artifact: expect.objectContaining({ digest: { sha256: migrated.result.manifestSha256 } }) }),
      expect.objectContaining({ role: TERMINAL_BENCH_2_SELECTION_ROLE, artifact: expect.objectContaining({ digest: { sha256: selected.result.terminalBench2ProfileSha256 } }) }),
    ]));
    const adapter = createRuntimeEvidenceAdapter(
      { adapterId: "harbor", selectionManifestSha256: selected.result.selectionManifestSha256 },
      { registrationArtifacts: registration.map((entry, index) => ({
        id: `tb2-registration-${index}.json`, role: entry.role, digest: `sha256:${entry.artifact.digest.sha256}`,
        bytes: getSealedBytes(workspaceDir, entry.artifact.digest.sha256), mediaType: "application/json", actions: ["store"],
      })) },
    );
    expect(adapter.registrationArtifacts()).toHaveLength(3);
    const source = await startPublicationSource();
    try {
      expect((await publicationConfigure(context, { draftId: "migrated", publicBaseUrl: source.base })).ok).toBe(true);
      expect((await publicationRegister(context, { draftId: "migrated" })).ok).toBe(true);
      await expectExactPublicBytes(source.base, recordPath(`sha256:${locked.result.runSha256}`), runBytes);
      for (const entry of registration) await expectExactPublicBytes(
        source.base,
        `/publication-artifacts/sha256/${entry.artifact.digest.sha256}`,
        getSealedBytes(workspaceDir, entry.artifact.digest.sha256),
      );
      await expectPublishedRuntimeDependencies(source.base, "migrated", runtimeDependencyDigests);

      const launch = await runLaunch(context, { draftId: "migrated" });
      expect(launch.ok, JSON.stringify(launch)).toBe(true);
      const collected = await runCollect(context, { draftId: "migrated" });
      expect(collected.ok, JSON.stringify(collected)).toBe(true);
      const journal = readRunJournalEntries(workspaceDir, "migrated");
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
      const invocationBytes = harborRunBytes();
      expectOneFilteredTrialPerDispatch(parseHarborRuns(invocationBytes), deliveries.length);
      const published = await publicationAccounting(context, { draftId: "migrated" });
      expect(published.ok, JSON.stringify(published)).toBe(true);
      if (!published.ok) return;
      expect(published.result.runtimeChecks.every((check) => check.status === "pass")).toBe(true);
      const accountingBytes = getSealedBytes(workspaceDir, published.result.accountingSha256);
      const matrixBytes = getSealedBytes(workspaceDir, published.result.matrixV2Sha256);
      expect(parseBenchmarkAccounting(accountingBytes).publicRegistration.status).toBe("pre-dispatch");
      expect(parseBenchmarkAccounting(accountingBytes).cells.flatMap((cell) => cell.dispatches)).toHaveLength(deliveries.length);
      expect(parseMatrix(matrixBytes).cells).toHaveLength(deliveries.length);
      await expectExactPublicBytes(source.base, recordPath(`sha256:${published.result.accountingSha256}`), accountingBytes);
      await expectExactPublicBytes(source.base, recordPath(`sha256:${published.result.matrixV2Sha256}`), matrixBytes);
      expect(harborRunBytes()).toBe(invocationBytes);
    } finally {
      await source.close();
    }
  }, 120_000);
});
