import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import {
  cellIdempotencyKey,
  expectedCellSet,
  parseBenchmarkAccounting,
  parseMatrix,
  parseRun,
} from "@jinn-network/benchmarking-records";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import { DELIVERY_MEDIA_TYPE, TASK_EXECUTION_PROTOCOL_URI, sealDelivery, sealSubmission } from "@jinn-network/task-execution-protocol";
import { appendRunJournalEntry } from "../run/journal.js";
import { writeCancelMarker } from "../run/cancel-marker.js";
import { recordPublicationOrigin, recordWorkspaceAuthorship } from "../run/publication-authority.js";
import { createWorkspacePublicationHttpHandler, createWorkspacePublicationSource, recordPath } from "../run/publication-source.js";
import { readRunState, writeRunState } from "../run/state.js";
import {
  HARBOR_CORRELATION_ROLE,
  HARBOR_INVOCATION_CONFIG_ROLE,
  HARBOR_JOB_CONFIG_ROLE,
  HARBOR_JOB_RESULT_ROLE,
  HARBOR_LOGS_ROLE,
  HARBOR_REWARD_ROLE,
  HARBOR_TRIAL_CONFIG_ROLE,
  HARBOR_TRIAL_RESULT_ROLE,
} from "../runtime/harbor/venue.js";
import { harborSelectionManifestBytes, type HarborSelectionManifest } from "../runtime/harbor/manifest.js";
import { artifactsDir, publicationServeRoot } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import { createLocalVenue } from "../venue/venue.js";
import { armAdd } from "./arms.js";
import type { OperationContext } from "./context.js";
import { createDraft, updateDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { publicationAccounting } from "./publication-accounting.js";
import { publicationConfigure, publicationRegister } from "./publication-register.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;
let server: Server | undefined;

beforeEach(() => { workspaceDir = mkdtempSync(join(tmpdir(), "pub13-accounting-")); });
afterEach(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  rmSync(workspaceDir, { recursive: true, force: true });
});

function clock(): () => string {
  let tick = 0;
  const epoch = Date.parse("2026-08-13T12:00:00Z");
  return () => new Date(epoch + tick++ * 1_000).toISOString();
}

function context(now: () => string): OperationContext {
  return { workspaceDir, principal: "sponsor-1", clock: now };
}

const HARBOR_EXECUTABLE_BYTES = new TextEncoder().encode("fixture Harbor executable");
const HARBOR_TASK_BYTES = new TextEncoder().encode("x");
const HARBOR_TASK_FILES = [{ path: "task.toml", sha256: sha256Hex(HARBOR_TASK_BYTES), bytes: HARBOR_TASK_BYTES.length }];

async function serveWorkspace(): Promise<string> {
  const handler = createWorkspacePublicationHttpHandler(workspaceDir);
  server = createServer(async (request, response) => {
    const externalPath = request.url ?? "/";
    if (externalPath !== "/publication" && !externalPath.startsWith("/publication/")) { response.writeHead(404).end(); return; }
    const archivePath = externalPath.slice("/publication".length) || "/";
    const result = await handler(new Request(`http://127.0.0.1${archivePath}`, { method: request.method }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback server has no TCP address");
  return `http://127.0.0.1:${address.port}/publication`;
}

function harborManifest(): HarborSelectionManifest {
  return {
    schema: "jinn.network/benchmark-product/harbor-selection/1",
    adapter: { id: "harbor", version: "1" },
    harbor: { version: "0.21.4", executableSha256: sha256Hex(HARBOR_EXECUTABLE_BYTES) },
    source: {
      kind: "task", input: { name: "fixture/task", ref: "r1" }, jobInput: { path: ".jinn-harbor/task" },
      resolved: { reference: "fixture/task", revision: "r1", checksum: sha256Hex(canonicalJsonBytes(HARBOR_TASK_FILES as never)), files: HARBOR_TASK_FILES },
    },
    arms: ["a", "b"].map((armId) => ({
      armId, agent: { id: `agent-${armId}`, configuration: {} }, model: { id: `model-${armId}`, configuration: {} },
      jobAgent: { name: `agent-${armId}`, model_name: `model-${armId}` },
    })),
    environment: { type: "docker", image: `registry.example/test@sha256:${"d".repeat(64)}`, configuration: {} },
    outputs: [{ name: "prediction", mediaType: "application/json", artifact: { source: "/logs/prediction.json", destination: "prediction.json" }, nativePath: "prediction.json" }],
    retryPolicy: { nAttempts: 1, nConcurrent: 1, maxRetries: 0 },
  };
}

async function registeredClosed(now: () => string, harbor = false) {
  expect(initWorkspace(context(now)).ok).toBe(true);
  expect(createDraft(context(now), { draftId: "draft-1", name: "Accounting fixture" }).ok).toBe(true);
  expect((await sampleInit(context(now), { draftId: "draft-1" })).ok).toBe(true);
  expect(armAdd(context(now), { draftId: "draft-1", armId: "a", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } }).ok).toBe(true);
  expect(armAdd(context(now), { draftId: "draft-1", armId: "b", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } }).ok).toBe(true);
  let selectionSha256: string | undefined;
  if (harbor) {
    putSealedBytes(workspaceDir, HARBOR_EXECUTABLE_BYTES);
    putSealedBytes(workspaceDir, HARBOR_TASK_BYTES);
    selectionSha256 = putSealedBytes(workspaceDir, harborSelectionManifestBytes(harborManifest()));
    expect(updateDraft(context(now), { draftId: "draft-1", patch: { evaluationRuntime: { adapterId: "harbor", selectionManifestSha256: selectionSha256, isolationPolicy: "unrestricted" } } }).ok).toBe(true);
  }
  const quoted = await runQuote(context(now), { draftId: "draft-1" }, harbor ? { createVenue: (options) => createLocalVenue(options) } : {});
  expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
  const locked = runLock(context(now), { draftId: "draft-1" });
  expect(locked.ok, JSON.stringify(locked)).toBe(true);
  if (!locked.ok) throw new Error("lock failed");
  const state = readRunState(workspaceDir, "draft-1")!;
  writeRunState(workspaceDir, "draft-1", { ...state, closedAt: state.closeAt, matrixSha256: "f".repeat(64) });
  const base = await serveWorkspace();
  expect((await publicationConfigure(context(now), { draftId: "draft-1", publicBaseUrl: base })).ok).toBe(true);
  const registered = await publicationRegister(context(now), { draftId: "draft-1" });
  expect(registered.ok, JSON.stringify(registered)).toBe(true);
  const run = parseRun(getSealedBytes(workspaceDir, locked.result.runSha256));
  const benchmarkSha256 = readRunState(workspaceDir, "draft-1")!.publication!.registration.digests!;
  const benchmarkDigest = Object.entries(benchmarkSha256).find(([id]) => id.startsWith("benchmark:"))?.[1];
  if (benchmarkDigest === undefined) throw new Error("registration has no Benchmark");
  const cells = expectedCellSet(JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, benchmarkDigest))), run);
  return { run, runSha256: locked.result.runSha256, cells, selectionSha256 };
}

function capture(runSha256: string, cell: { cellKey: string; armId: string; replicate: number; taskDigest: string }, index = 1): string {
  const bytes = sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: `urn:uuid:00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    task: { digest: { sha256: cell.taskDigest } }, requester: readRunState(workspaceDir, "draft-1")!.owner,
    idempotencyKey: cellIdempotencyKey(`sha256:${runSha256}`, cell.cellKey, index), nonce: `dispatch-${index}`,
    deadline: "2099-01-01T00:00:00Z", attempts: { maxTotal: 1, maxConcurrent: 1 },
    annotations: { run: `sha256:${runSha256}`, cellKey: cell.cellKey, armId: cell.armId },
  });
  const submissionSha256 = putSealedBytes(workspaceDir, bytes);
  appendRunJournalEntry(workspaceDir, "draft-1", { kind: "submission-captured", at: `2026-08-13T13:00:0${index}Z`, cellKey: cell.cellKey, armId: cell.armId, replicate: cell.replicate, dispatch: index, submissionSha256 });
  return submissionSha256;
}

function addDelivery(cellKey: string, attempt: string, origin: "owned" | "foreign" | "missing"): string {
  const bytes = sealDelivery({ protocol: TASK_EXECUTION_PROTOCOL_URI, attempt, task: `sha256:${"e".repeat(64)}`, outputs: [], outcome: "partial", createdAt: "2026-08-13T13:01:00Z" });
  const digest = putSealedBytes(workspaceDir, bytes);
  appendRunJournalEntry(workspaceDir, "draft-1", { kind: "delivery", at: "2026-08-13T13:01:01Z", cellKey, dispatch: 1, attempt, deliverySha256: digest, outputs: [] });
  if (origin === "owned") recordWorkspaceAuthorship({ workspaceDir, recordSha256: digest, recordKind: RECORD_KINDS.delivery, authoredAt: "2026-08-13T13:01:00Z" });
  if (origin === "foreign") recordPublicationOrigin(workspaceDir, `sha256:${digest}`, { source: { agent: "did:key:zExternalOperator", name: "deliveries" }, sequence: "0000000000000001", entryDigest: `sha256:${"1".repeat(64)}` });
  return digest;
}

function writeHarborArchive(input: { runSha256: string; cellKey: string; dispatch: number; submissionSha256: string; attempt: string; selectionSha256: string }): void {
  const manifest = harborManifest();
  const armId = input.cellKey.split("/")[1]!;
  const selected = manifest.arms.find((arm) => arm.armId === armId)!;
  const jobName = `jinn-${input.submissionSha256.slice(0, 24)}-d${input.dispatch}`;
  const jobId = "fixture-job";
  const trialId = "fixture-trial";
  const storeJson = (value: unknown) => putSealedBytes(workspaceDir, canonicalJsonBytes(value as never));
  const submittedJob = {
    job_name: jobName, jobs_dir: "jobs", n_attempts: 1, n_concurrent_trials: 1, retry: { max_retries: 0 },
    environment: { type: "docker" }, agents: [selected.jobAgent], artifacts: manifest.outputs.map((output) => output.artifact), tasks: [manifest.source.jobInput],
  };
  const native = [
    [HARBOR_INVOCATION_CONFIG_ROLE, "invocation.json", storeJson(submittedJob)],
    [HARBOR_JOB_CONFIG_ROLE, "config.json", storeJson(submittedJob)],
    [HARBOR_JOB_RESULT_ROLE, "result.json", storeJson({ id: jobId })],
    [HARBOR_TRIAL_CONFIG_ROLE, "trial/config.json", storeJson({ attempt_number: 1 })],
    [HARBOR_TRIAL_RESULT_ROLE, "trial/result.json", storeJson({ id: trialId })],
    [HARBOR_REWARD_ROLE, "trial/reward.json", storeJson({ reward: 1 })],
  ].map(([role, path, sha256]) => ({ role, path, sha256, bytes: getSealedBytes(workspaceDir, sha256).length, availability: "public" as const }));
  const missingBytes = new TextEncoder().encode("optional Harbor log was not produced");
  const missingSha256 = putSealedBytes(workspaceDir, missingBytes);
  const archiveSha256 = storeJson({
    schema: "jinn.network/benchmark-product/harbor-dispatch-archive/2", selectionManifestSha256: input.selectionSha256,
    lineage: { runSha256: input.runSha256, cellKey: input.cellKey, dispatchIndex: input.dispatch, submissionSha256: input.submissionSha256, attemptUri: input.attempt },
    harbor: { jobName, jobId, trialId, status: "completed" },
    nativeArtifacts: [...native, { role: HARBOR_LOGS_ROLE, path: "missing.log", sha256: missingSha256, bytes: missingBytes.length, availability: "collection-failed", reason: "optional Harbor log was not produced" }],
  });
  const indexPath = join(artifactsDir(workspaceDir), "harbor", "archives", "by-dispatch", `${sha256Hex(new TextEncoder().encode(`${input.runSha256}:${input.cellKey}:${input.dispatch}`))}.json`);
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, canonicalJsonBytes({ schema: "jinn.network/benchmark-product/harbor-archive-index/1", runSha256: input.runSha256, cellKey: input.cellKey, dispatchIndex: input.dispatch, submissionSha256: input.submissionSha256, attemptUri: input.attempt, archiveSha256 } as never));
}

describe("publication.accounting operation", () => {
  test("publishes partial Accounting and Matrix v2 post-hoc without executing a backend", async () => {
    const now = clock();
    await registeredClosed(now);
    const result = await publicationAccounting(context(now), { draftId: "draft-1" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const state = readRunState(workspaceDir, "draft-1")!;
    expect(state.matrixSha256).toBe("f".repeat(64));
    expect(parseMatrix(getSealedBytes(workspaceDir, result.result.matrixV2Sha256)).completeness.runOutcome).toBe("partial");
    expect(parseBenchmarkAccounting(getSealedBytes(workspaceDir, result.result.accountingSha256)).publicRegistration.status).toBe("post-hoc");
    expect(state.reportPayloadSha256).toBeUndefined();
    expect(state.reportRecordSha256).toBeUndefined();
    expect(state.publication!.report.state).toBe("not-started");
  }, 30_000);

  test("publishes accounting-only cancellation with no runtime execution", async () => {
    const now = clock();
    await registeredClosed(now);
    writeCancelMarker(workspaceDir, "draft-1", { requestedAt: "2026-08-13T13:00:00Z", principal: "sponsor-1" });
    const result = await publicationAccounting(context(now), { draftId: "draft-1" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      expect(parseMatrix(getSealedBytes(workspaceDir, result.result.matrixV2Sha256)).completeness.runOutcome).toBe("cancelled");
      const state = readRunState(workspaceDir, "draft-1")!;
      expect(state.reportPayloadSha256).toBeUndefined();
      expect(state.reportRecordSha256).toBeUndefined();
      expect(state.publication!.report.state).toBe("not-started");
    }
  }, 30_000);

  test("retains every replacement dispatch in Accounting lineage", async () => {
    const now = clock();
    const fixture = await registeredClosed(now);
    const cell = fixture.cells[0]!;
    capture(fixture.runSha256, cell, 1);
    appendRunJournalEntry(workspaceDir, "draft-1", { kind: "cell-event", at: "2026-08-13T13:00:02Z", event: { cellKey: cell.cellKey, armId: cell.armId, replicate: cell.replicate, dispatch: 1, kind: "error", replaceable: true, replaceableReason: "expired" } });
    capture(fixture.runSha256, cell, 2);
    const result = await publicationAccounting(context(now), { draftId: "draft-1" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const accounting = parseBenchmarkAccounting(getSealedBytes(workspaceDir, result.result.accountingSha256));
    expect(accounting.cells.find((candidate) => candidate.cellKey === cell.cellKey)!.dispatches.map((dispatch) => dispatch.index)).toEqual([1, 2]);
  }, 30_000);

  test("refuses a dispatched cell without exact capture before any source append", async () => {
    const now = clock();
    const fixture = await registeredClosed(now);
    const cell = fixture.cells[0]!;
    appendRunJournalEntry(workspaceDir, "draft-1", { kind: "cell-event", at: "2026-08-13T13:00:01Z", event: { cellKey: cell.cellKey, armId: cell.armId, replicate: cell.replicate, dispatch: 1, kind: "dispatch" } });
    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const head = (await source.writer.readState())!.last;
    const result = await publicationAccounting(context(now), { draftId: "draft-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail).toMatch(/missing pre-submit Submission capture|no pre-submit exact Submission capture/);
    expect((await source.writer.readState())!.last).toEqual(head);
  }, 30_000);

  test("replays identical input bytes and timestamps after a crash between append and cutoff checkpoint", async () => {
    const now = clock();
    const fixture = await registeredClosed(now);
    const submissionSha256 = capture(fixture.runSha256, fixture.cells[0]!);
    let crashed = false;
    const first = await publicationAccounting(context(now), { draftId: "draft-1" }, { afterInputsBeforeCutoff: async () => { crashed = true; throw new Error("fixture crash"); } });
    expect(first.ok).toBe(false);
    expect(crashed).toBe(true);
    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const before = Object.values((await source.writer.readState())!.announcements).find((entry) => entry.receipt.record?.digest === `sha256:${submissionSha256}`)!.receipt;
    const frozenAt = readRunState(workspaceDir, "draft-1")!.publication!.accounting.announcedAt;
    const retried = await publicationAccounting(context(now), { draftId: "draft-1" });
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    const after = Object.values((await source.writer.readState())!.announcements).find((entry) => entry.receipt.record?.digest === `sha256:${submissionSha256}`)!.receipt;
    expect(after.entryDigest).toBe(before.entryDigest);
    expect(readRunState(workspaceDir, "draft-1")!.publication!.accounting.announcedAt).toBe(frozenAt);
  }, 30_000);

  test("keeps Matrix v2 resumable when a writer-owned scope record becomes unavailable", async () => {
    const now = clock();
    const fixture = await registeredClosed(now);
    const submissionSha256 = capture(fixture.runSha256, fixture.cells[0]!);
    const result = await publicationAccounting(context(now), { draftId: "draft-1" }, { afterInputsBeforeCutoff: async () => {
      unlinkSync(join(publicationServeRoot(workspaceDir), recordPath(`sha256:${submissionSha256}`)));
    } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail).toMatch(/scope-cutoff-dispatch-completeness|source record/);
    const state = readRunState(workspaceDir, "draft-1")!;
    expect(state.publication!.accounting.state).toBe("in-progress");
    expect(state.publication!.matrixV2.state).toBe("in-progress");
    expect(state.matrixV2Sha256).toBeUndefined();
  }, 30_000);

  test.each(["entry", "source"] as const)("refuses a sealed accounting cutoff with a tampered %s", async (tamper) => {
    const now = clock();
    const fixture = await registeredClosed(now);
    capture(fixture.runSha256, fixture.cells[0]!);
    const result = await publicationAccounting(context(now), { draftId: "draft-1" }, {
      transformAccountingScope(stream) {
        if (stream.kind !== "record-discovery") return stream;
        return tamper === "entry"
          ? { ...stream, through: { ...stream.through, entry: `sha256:${"0".repeat(64)}` } }
          : { ...stream, source: { ...stream.source, agent: "did:key:zWrongAccountingSource" } };
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail).toMatch(/scope-cutoff-dispatch-completeness|declared accounting scope source|declared cutoff entry/);
    const state = readRunState(workspaceDir, "draft-1")!;
    expect(state.publication!.accounting.state).toBe("in-progress");
    expect(state.publication!.matrixV2.state).toBe("in-progress");
    expect(state.matrixV2Sha256).toBeUndefined();
  }, 30_000);

  test("refuses unproven third-party Delivery before append, then verifies its exact origin; workspace-authored Delivery needs no origin verifier", async () => {
    const now = clock();
    const fixture = await registeredClosed(now);
    capture(fixture.runSha256, fixture.cells[0]!);
    const attempt = "urn:uuid:00000000-0000-4000-8000-000000000111";
    const digest = addDelivery(fixture.cells[0]!.cellKey, attempt, "missing");
    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const head = (await source.writer.readState())!.last;
    const missing = await publicationAccounting(context(now), { draftId: "draft-1" });
    expect(missing.ok).toBe(false);
    expect((await source.writer.readState())!.last).toEqual(head);
    recordPublicationOrigin(workspaceDir, `sha256:${digest}`, { source: { agent: "did:key:zExternalOperator", name: "deliveries" }, sequence: "0000000000000001", entryDigest: `sha256:${"1".repeat(64)}` });
    const verified: string[] = [];
    const foreign = await publicationAccounting(context(now), { draftId: "draft-1" }, { verifyOrigin: { async verifyOrigin({ record }) { verified.push(record.digest); } } });
    expect(foreign.ok, JSON.stringify(foreign)).toBe(true);
    expect(verified).toEqual([`sha256:${digest}`]);
    if (foreign.ok) {
      const accounting = parseBenchmarkAccounting(getSealedBytes(workspaceDir, foreign.result.accountingSha256));
      expect(accounting.cells.flatMap((cell) => cell.dispatches).flatMap((dispatch) => dispatch.correlations)).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "https://product.jinn.network/artifact-roles/accounting-reference-authority/v1" }),
      ]));
    }

    await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined;
    rmSync(workspaceDir, { recursive: true, force: true });
    workspaceDir = mkdtempSync(join(tmpdir(), "pub13-accounting-owned-"));
    const ownedNow = clock();
    const ownedFixture = await registeredClosed(ownedNow);
    capture(ownedFixture.runSha256, ownedFixture.cells[0]!);
    addDelivery(ownedFixture.cells[0]!.cellKey, attempt, "owned");
    const owned = await publicationAccounting(context(ownedNow), { draftId: "draft-1" });
    expect(owned.ok, JSON.stringify(owned)).toBe(true);
  }, 60_000);

  test("loads the durable Harbor archive, preserves Attempt/native evidence, and accepts an honest missing optional artifact", async () => {
    const now = clock();
    const fixture = await registeredClosed(now, true);
    const cell = fixture.cells[0]!;
    const submissionSha256 = capture(fixture.runSha256, cell);
    const attempt = "urn:uuid:00000000-0000-4000-8000-000000000222";
    appendRunJournalEntry(workspaceDir, "draft-1", { kind: "cell-event", at: "2026-08-13T13:02:00Z", event: { cellKey: cell.cellKey, armId: cell.armId, replicate: cell.replicate, dispatch: 1, kind: "claimed", attempt } });
    writeHarborArchive({ runSha256: fixture.runSha256, cellKey: cell.cellKey, dispatch: 1, submissionSha256, attempt, selectionSha256: fixture.selectionSha256! });
    const result = await publicationAccounting(context(now), { draftId: "draft-1" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.result.runtimeChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "harbor-job-trial-structure", status: "pass" }),
      expect.objectContaining({ name: "harbor-exact-native-evidence", status: "pass" }),
    ]));
    const accounting = parseBenchmarkAccounting(getSealedBytes(workspaceDir, result.result.accountingSha256));
    const dispatch = accounting.cells.find((candidate) => candidate.cellKey === cell.cellKey)!.dispatches[0]!;
    expect(dispatch.attempt).toBe(attempt);
    expect(dispatch.nativeArtifacts).toEqual(expect.arrayContaining([expect.objectContaining({ role: HARBOR_LOGS_ROLE, availability: "collection-failed" })]));
  }, 30_000);

  test("reports missing required Harbor archive evidence as indeterminate and refuses before append", async () => {
    const now = clock();
    const fixture = await registeredClosed(now, true);
    const cell = fixture.cells[0]!;
    capture(fixture.runSha256, cell);
    const attempt = "urn:uuid:00000000-0000-4000-8000-000000000333";
    appendRunJournalEntry(workspaceDir, "draft-1", { kind: "cell-event", at: "2026-08-13T13:03:00Z", event: { cellKey: cell.cellKey, armId: cell.armId, replicate: cell.replicate, dispatch: 1, kind: "claimed", attempt } });
    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const head = (await source.writer.readState())!.last;
    const result = await publicationAccounting(context(now), { draftId: "draft-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail).toMatch(/harbor-(durable-dispatch-archive|required-native-evidence).*indeterminate|harbor-required-native-evidence is fail/);
    expect((await source.writer.readState())!.last).toEqual(head);
  }, 30_000);
});
