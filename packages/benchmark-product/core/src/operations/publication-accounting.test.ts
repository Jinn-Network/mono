import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { canonicalJsonBytes, RFC3161_TSA_ANCHOR_PROFILE } from "@jinn-network/trust-core";
import { createFixtureAuthority, KIT_AUTHORITY_SEED } from "@jinn-network/trust-testing";
import {
  BENCHMARK_ACCOUNTING_MEDIA_TYPE,
  MATRIX_MEDIA_TYPE,
  cellIdempotencyKey,
  expectedCellSet,
  parseBenchmarkAccounting,
  parseMatrix,
  parseRun,
} from "@jinn-network/benchmarking-records";
import { RECORD_KINDS, type SourceHead } from "@jinn-network/record-discovery-protocol";
import { DELIVERY_MEDIA_TYPE, TASK_EXECUTION_PROTOCOL_URI, sealDelivery, sealSubmission } from "@jinn-network/task-execution-protocol";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { appendRunJournalEntry } from "../run/journal.js";
import { writeCancelMarker } from "../run/cancel-marker.js";
import { readEntryAnchorLedger } from "../run/entry-anchor-ledger.js";
import { recordPublicationOrigin, recordWorkspaceAuthorship } from "../run/publication-authority.js";
import { acquirePublicationLock } from "../run/publication-lock.js";
import {
  createWorkspacePublicationHttpHandler,
  createWorkspacePublicationSource,
  recordPath,
  refreshWorkspacePublicationHead,
  withWorkspacePublicationSourceLock,
  type WorkspacePublicationHeadRefresh,
} from "../run/publication-source.js";
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
import { artifactsDir, publicationServeRoot, workspaceMetadataPath } from "../workspace/layout.js";
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
/** When set and true for an archive path, the loopback mirror answers that request with 503. */
let refusePublicRead: ((archivePath: string) => boolean) | undefined;

beforeEach(() => { workspaceDir = mkdtempSync(join(tmpdir(), "pub13-accounting-")); });
afterEach(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  refusePublicRead = undefined;
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
    if (refusePublicRead?.(archivePath) === true) { response.writeHead(503).end(); return; }
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
    [HARBOR_JOB_RESULT_ROLE, "result.json", storeJson({ id: jobId, n_total_trials: 1, stats: { n_retries: 0 } })],
    [HARBOR_TRIAL_CONFIG_ROLE, "trial/config.json", storeJson({ task: manifest.source.jobInput, agent: selected.jobAgent })],
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

const anchorAuthority = createFixtureAuthority(KIT_AUTHORITY_SEED);

/**
 * Configures an RFC 3161 entry anchor provider for this workspace, answered in process. Each
 * substantive append on the source then obtains an anchor, and the next release of the source lock
 * announces it on its own entry at one millisecond after the head, then two, and so on.
 */
function configureEntryAnchoring(): void {
  const path = workspaceMetadataPath(workspaceDir);
  atomicWriteFileSync(path, JSON.stringify({
    ...JSON.parse(readFileSync(path, "utf8")),
    anchoring: [{ providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: "https://timestamp.invalid/tsr" }],
  }, null, 2));
  createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks", { sources: { [RFC3161_TSA_ANCHOR_PROFILE]: {
    profile: RFC3161_TSA_ANCHOR_PROFILE,
    // After every entry this fixture's clock produces, so the entry-anchor skew check accepts it.
    async obtainProof({ subjectSha256 }: { subjectSha256: string }) {
      return anchorAuthority.mintTimeStampToken({ subjectSha256, genTime: "20260813130000Z" }).tokenDer;
    },
  } } });
}

/** Another draft of the workspace announcing at this host's clock, far after the fixture's clock. */
async function announceAnotherRecord(): Promise<{ readonly sequence: string }> {
  const bytes = new TextEncoder().encode("another draft's record");
  return withWorkspacePublicationSourceLock(workspaceDir, async () => {
    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    await source.writer.recover();
    return source.writer.append({
      timestamp: new Date().toISOString(),
      announcement: { announcementId: "another-draft", action: "available", record: { kind: RECORD_KINDS.task, digest: `sha256:${sha256Hex(bytes)}`, mediaType: "text/plain" } },
      record: { bytes, contentType: "text/plain" },
    });
  });
}

/** Two Submissions for one cell: its first dispatch, and the dispatch that replaced it. */
function captureReplacedDispatch(fixture: { runSha256: string; cells: readonly { cellKey: string; armId: string; replicate: number; taskDigest: string }[] }): [string, string] {
  const cell = fixture.cells[0]!;
  const first = capture(fixture.runSha256, cell, 1);
  appendRunJournalEntry(workspaceDir, "draft-1", { kind: "cell-event", at: "2026-08-13T13:00:02Z", event: { cellKey: cell.cellKey, armId: cell.armId, replicate: cell.replicate, dispatch: 1, kind: "error", replaceable: true, replaceableReason: "expired" } });
  return [first, capture(fixture.runSha256, cell, 2)];
}

/** Refuses the first public read of one record, as a mirror that has not synced it yet would. */
function refuseFirstPublicRead(digest: `sha256:${string}`): void {
  let refused = false;
  refusePublicRead = (archivePath) => {
    if (refused || archivePath.replace(/^\/+/u, "") !== recordPath(digest).replace(/^\/+/u, "")) return false;
    refused = true;
    return true;
  };
}

/** The source's receipt for the announcement of one record, if it has one. */
async function announcedReceipt(digestHex: string) {
  const state = await createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks").writer.readState();
  return Object.values(state?.announcements ?? {}).find((entry) => entry.receipt.record?.digest === `sha256:${digestHex}`)?.receipt;
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
  });

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
  });

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
  });

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
  });

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
  });

  // #5334. Accounting reads its time when the command starts, then waits for the draft lock and
  // enumerates and verifies every input before its first announcement. The writer refuses an
  // append that does not strictly advance the served head, so a head moved past that time in
  // between must not leave the stage unable to announce. The held draft lock puts the move inside
  // that phase deterministically: accounting has read its time and is waiting.
  test.each([
    "the idle-head heartbeat re-signs the source head",
    "another announcement lands on the source",
  ] as const)("finishes when %s after it has read its time and before it announces (#5334)", async (interleaving) => {
    const now = clock();
    const fixture = await registeredClosed(now);
    const submissionSha256 = capture(fixture.runSha256, fixture.cells[0]!);
    const draftLock = await acquirePublicationLock(workspaceDir, "draft-1");
    const pending = publicationAccounting(context(now), { draftId: "draft-1" });
    let passed: SourceHead;
    try {
      if (interleaving === "the idle-head heartbeat re-signs the source head") {
        // Registration signed the head at the fixture's 2026-08-13 clock, so it is past half its
        // window and the heartbeat re-signs it at this host's clock, far after accounting's time.
        expect((await refreshWorkspacePublicationHead(workspaceDir, "colophon-benchmarks")).status).toBe("refreshed");
      } else {
        const bytes = new TextEncoder().encode("another draft's record");
        await withWorkspacePublicationSourceLock(workspaceDir, async () => {
          const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
          await source.writer.recover();
          await source.writer.append({
            timestamp: new Date().toISOString(),
            announcement: { announcementId: "another-draft", action: "available", record: { kind: RECORD_KINDS.task, digest: `sha256:${sha256Hex(bytes)}`, mediaType: "text/plain" } },
            record: { bytes, contentType: "text/plain" },
          });
        });
      }
    } finally {
      // Read before the release: once accounting holds the draft lock it announces and moves the head.
      passed = (await createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks").head.getExact())!;
      draftLock.release();
    }

    const result = await pending;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const state = readRunState(workspaceDir, "draft-1")!;
    expect(state.publication!.accounting.state).toBe("complete");
    expect(state.publication!.matrixV2.state).toBe("complete");
    // The frozen time is strictly after the head served when the stage froze it.
    expect(Date.parse(state.publication!.accounting.announcedAt!)).toBeGreaterThan(Date.parse(passed.issuedAt));
    const durable = (await createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks").writer.readState())!;
    const input = Object.values(durable.announcements).find((entry) => entry.receipt.record?.digest === `sha256:${submissionSha256}`);
    expect(input).toBeDefined();
    expect(input!.receipt.sequence > passed.sequence).toBe(true);
  });

  // The other half of #5334: once accounting has frozen its time, the heartbeat leaves the head
  // alone until the stage has announced, and picks it up again after.
  test("withholds the idle-head heartbeat from its freeze until it has announced (#5334)", async () => {
    const now = clock();
    const fixture = await registeredClosed(now);
    capture(fixture.runSha256, fixture.cells[0]!);
    let during: WorkspacePublicationHeadRefresh | undefined;
    const result = await publicationAccounting(context(now), { draftId: "draft-1" }, { afterInputsBeforeCutoff: async () => {
      during = await refreshWorkspacePublicationHead(workspaceDir, "colophon-benchmarks");
    } });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(during).toEqual({ status: "withheld", drafts: ["draft-1"] });
    expect((await refreshWorkspacePublicationHead(workspaceDir, "colophon-benchmarks")).status).toBe("refreshed");
  });

  // #5348. Accounting announces its inputs in one source-lock hold and its own records in a later
  // one. Releasing the input hold announces one entry anchor per input appended, at one millisecond
  // after the head, then two, and so on, so with two inputs the anchors reach the time planned for
  // the Accounting record. No concurrency is involved.
  test("finishes with entry anchoring configured and two inputs to announce (#5348)", async () => {
    const now = clock();
    const fixture = await registeredClosed(now);
    const cell = fixture.cells[0]!;
    const first = capture(fixture.runSha256, cell, 1);
    appendRunJournalEntry(workspaceDir, "draft-1", { kind: "cell-event", at: "2026-08-13T13:00:02Z", event: { cellKey: cell.cellKey, armId: cell.armId, replicate: cell.replicate, dispatch: 1, kind: "error", replaceable: true, replaceableReason: "expired" } });
    const second = capture(fixture.runSha256, cell, 2);
    configureEntryAnchoring();

    const result = await publicationAccounting(context(now), { draftId: "draft-1" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const state = readRunState(workspaceDir, "draft-1")!;
    expect(state.publication!.accounting.state).toBe("complete");
    expect(state.publication!.matrixV2.state).toBe("complete");
    // The anchor over each input entry was announced after the inputs and before the Accounting record.
    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const durable = (await source.writer.readState())!;
    const ledger = readEntryAnchorLedger(workspaceDir, source.source.agent, "colophon-benchmarks");
    for (const submissionSha256 of [first, second]) {
      const input = Object.values(durable.announcements).find((entry) => entry.receipt.record?.digest === `sha256:${submissionSha256}`)!.receipt;
      const anchorId = ledger.rows.find((row) => row.sequence === input.sequence)?.announcedAnnouncementId;
      expect(anchorId).toBeDefined();
      expect(durable.announcements[anchorId!]!.receipt.sequence < state.publication!.accounting.receipt!.sourceSequence).toBe(true);
    }
  });

  // #5348. Another draft of the workspace can announce between accounting's input hold and the hold
  // that announces its own records, at a time far past the one planned for them.
  test("finishes when another announcement lands on the source between its inputs and its own records (#5348)", async () => {
    const now = clock();
    const fixture = await registeredClosed(now);
    capture(fixture.runSha256, fixture.cells[0]!);
    let other: { readonly sequence: string } | undefined;
    const result = await publicationAccounting(context(now), { draftId: "draft-1" }, { afterInputsBeforeCutoff: async () => {
      other = await announceAnotherRecord();
    } });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const state = readRunState(workspaceDir, "draft-1")!;
    expect(state.publication!.accounting.state).toBe("complete");
    expect(state.publication!.matrixV2.state).toBe("complete");
    expect(state.publication!.accounting.receipt!.sourceSequence > other!.sequence).toBe(true);
  });

  // #5348. The fault lands after the Accounting record is appended and before the plan journal
  // records it, so the retry asks to announce the Accounting record again and Matrix v2 for the
  // first time. Between the attempts the head moves past the time planned for Matrix v2: either the
  // heartbeat's withheld check releases the source lock, which announces the pending anchor over
  // the Accounting entry at the very millisecond planned for Matrix v2, or another draft announces.
  test.each([
    "a pending entry anchor is announced",
    "another announcement lands on the source",
  ] as const)("a retry after %s keeps the Accounting entry already announced and finishes (#5348)", async (move) => {
    const now = clock();
    const fixture = await registeredClosed(now);
    capture(fixture.runSha256, fixture.cells[0]!);
    if (move === "a pending entry anchor is announced") configureEntryAnchoring();
    let faulted = false;
    const first = await publicationAccounting(context(now), { draftId: "draft-1" }, { recordPlanFaults: { async at({ action }) {
      if (action === "announce" && !faulted) { faulted = true; throw new Error("fixture crash after the Accounting append"); }
    } } });
    expect(first.ok).toBe(false);
    expect(faulted).toBe(true);
    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const announced = Object.values((await source.writer.readState())!.announcements);
    const accounting = announced.filter((entry) => entry.receipt.record?.contentType === BENCHMARK_ACCOUNTING_MEDIA_TYPE).map((entry) => entry.receipt);
    expect(accounting).toHaveLength(1);
    expect(announced.some((entry) => entry.receipt.record?.contentType === MATRIX_MEDIA_TYPE)).toBe(false);

    let moved: string;
    if (move === "a pending entry anchor is announced") {
      expect((await refreshWorkspacePublicationHead(workspaceDir, "colophon-benchmarks")).status).toBe("withheld");
      const anchorId = readEntryAnchorLedger(workspaceDir, source.source.agent, "colophon-benchmarks").rows
        .find((row) => row.sequence === accounting[0]!.sequence)?.announcedAnnouncementId;
      expect(anchorId).toBeDefined();
      moved = (await source.writer.readState())!.announcements[anchorId!]!.receipt.sequence;
    } else {
      moved = (await announceAnotherRecord()).sequence;
    }

    const retried = await publicationAccounting(context(now), { draftId: "draft-1" });
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    if (!retried.ok) return;
    // The retry rebuilt the same Accounting record and left its one entry exactly as announced.
    const after = Object.values((await source.writer.readState())!.announcements);
    expect(after.filter((entry) => entry.receipt.record?.digest === `sha256:${retried.result.accountingSha256}`).map((entry) => entry.receipt)).toEqual(accounting);
    const state = readRunState(workspaceDir, "draft-1")!;
    expect(state.publication!.accounting.receipt).toEqual({ sourceSequence: accounting[0]!.sequence, entrySha256: accounting[0]!.entryDigest.slice(7) });
    expect(state.publication!.matrixV2.state).toBe("complete");
    expect(state.publication!.matrixV2.receipt!.sourceSequence > moved).toBe(true);
  });

  // #5349. Each input has its own slot after accounting's frozen time. A retry after a failure
  // between two input appends finds the first input announced and must announce the second in its
  // own slot, not in the first input's, which the head already holds.
  test("a retry after a failed probe between two input appends announces the second input in its own slot (#5349)", async () => {
    const now = clock();
    const fixture = await registeredClosed(now);
    const [first, second] = captureReplacedDispatch(fixture);
    refuseFirstPublicRead(`sha256:${first}`);
    const failed = await publicationAccounting(context(now), { draftId: "draft-1" });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.detail).toMatch(/probe returned 503/);
    const announced = await announcedReceipt(first);
    expect(announced).toBeDefined();
    expect(await announcedReceipt(second)).toBeUndefined();

    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    let inputsHead: SourceHead | undefined;
    const retried = await publicationAccounting(context(now), { draftId: "draft-1" }, { afterInputsBeforeCutoff: async () => {
      inputsHead = await source.head.getExact();
    } });
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    expect(await announcedReceipt(first)).toEqual(announced);
    const state = readRunState(workspaceDir, "draft-1")!;
    const frozenAt = Date.parse(state.publication!.accounting.announcedAt!);
    // The second input took its own slot, one millisecond after the first and below the records'.
    expect(inputsHead!.sequence).toBe((await announcedReceipt(second))!.sequence);
    expect(Date.parse(inputsHead!.issuedAt)).toBe(frozenAt + 1);
    // The Accounting and Matrix v2 records then took the slots planned for them: two inputs, plus 1 and plus 2.
    const head = (await source.head.getExact())!;
    expect(head.sequence).toBe(state.publication!.matrixV2.receipt!.sourceSequence);
    expect(Date.parse(head.issuedAt)).toBe(frozenAt + 2 + 2);
  });

  // #5349. Between the failed attempt and its retry the head can move past the second input's slot:
  // the heartbeat's withheld check releases the source lock, which announces the pending anchor over
  // the first input's entry in exactly that millisecond, or another draft announces.
  test.each([
    "a pending entry anchor is announced",
    "another announcement lands on the source",
  ] as const)("a retry after a failed probe between two input appends finishes when %s first (#5349)", async (move) => {
    const now = clock();
    const fixture = await registeredClosed(now);
    const [first, second] = captureReplacedDispatch(fixture);
    if (move === "a pending entry anchor is announced") configureEntryAnchoring();
    refuseFirstPublicRead(`sha256:${first}`);
    expect((await publicationAccounting(context(now), { draftId: "draft-1" })).ok).toBe(false);
    const announced = (await announcedReceipt(first))!;
    expect(announced).toBeDefined();

    let moved: string;
    if (move === "a pending entry anchor is announced") {
      expect((await refreshWorkspacePublicationHead(workspaceDir, "colophon-benchmarks")).status).toBe("withheld");
      const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
      const anchorId = readEntryAnchorLedger(workspaceDir, source.source.agent, "colophon-benchmarks").rows
        .find((row) => row.sequence === announced.sequence)?.announcedAnnouncementId;
      expect(anchorId).toBeDefined();
      moved = (await source.writer.readState())!.announcements[anchorId!]!.receipt.sequence;
    } else {
      moved = (await announceAnotherRecord()).sequence;
    }

    const retried = await publicationAccounting(context(now), { draftId: "draft-1" });
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    expect(await announcedReceipt(first)).toEqual(announced);
    expect((await announcedReceipt(second))!.sequence > moved).toBe(true);
    expect(readRunState(workspaceDir, "draft-1")!.publication!.matrixV2.state).toBe("complete");
  });

  // #5349. The input plan announces this workspace's own Deliveries before the Submissions. A retry
  // after it stops before or after announcing one, with another announcement in between, keeps
  // what was announced as it was and announces the rest after the head.
  test.each([
    ["before", "store"],
    ["after", "announce"],
  ] as const)("a retry after the input plan stops %s announcing an owned Delivery finishes after another announcement (#5349)", async (_when, action) => {
    const now = clock();
    const fixture = await registeredClosed(now);
    const cell = fixture.cells[0]!;
    const submission = capture(fixture.runSha256, cell);
    const delivery = addDelivery(cell.cellKey, "urn:uuid:00000000-0000-4000-8000-000000000444", "owned");
    let faulted = false;
    const failed = await publicationAccounting(context(now), { draftId: "draft-1" }, { inputPlanFaults: { async at(point) {
      if (point.action === action && !faulted) { faulted = true; throw new Error(`fixture crash after the first input plan ${action}`); }
    } } });
    expect(failed.ok).toBe(false);
    expect(faulted).toBe(true);
    const announced = await announcedReceipt(delivery);
    expect(announced === undefined).toBe(action === "store");
    expect(await announcedReceipt(submission)).toBeUndefined();

    const other = await announceAnotherRecord();
    const retried = await publicationAccounting(context(now), { draftId: "draft-1" });
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    if (announced !== undefined) expect(await announcedReceipt(delivery)).toEqual(announced);
    else expect((await announcedReceipt(delivery))!.sequence > other.sequence).toBe(true);
    expect((await announcedReceipt(submission))!.sequence > other.sequence).toBe(true);
    expect(readRunState(workspaceDir, "draft-1")!.publication!.matrixV2.state).toBe("complete");
  });

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
  });

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
  });

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
  });

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
  });
});
