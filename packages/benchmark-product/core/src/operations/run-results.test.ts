import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseCellKey, parseReport } from "@jinn-network/benchmarking-records";
import type { AttemptUri, DeliveryRef, ObservationSnapshot, SubmissionAck, SubmissionUri } from "@jinn-network/task-execution-backend";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { VERDICT_DSSE_PAYLOAD_TYPE } from "@jinn-network/task-execution-profiles";
import { canonicalJsonBytes, dssePreAuthEncoding, sealDsseEnvelope } from "@jinn-network/trust-core";
import { atomicWriteFileSync } from "../fs/atomic.js";
import type { ProxiedBackend } from "../run/drive.js";
import { appendRunJournalEntry, readRunJournalEntries, type RunJournalEntry } from "../run/journal.js";
import { readRunState, writeRunState } from "../run/state.js";
import { claimPackageArtifactPath, resultsArtifactPath, runJournalPath } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import { LEGACY_VERDICT_EVALUATOR_ID, loadOrCreateVerdictSigningKey } from "../venue/signing.js";
import type { LocalVenue } from "../venue/venue.js";
import { armAdd } from "./arms.js";
import type { OperationContext } from "./context.js";
import { createDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { runCollect } from "./run-collect.js";
import { runLaunch } from "./run-launch.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { runReport } from "./report.js";
import { runResults } from "./run-results.js";
import { runVerify } from "./verify.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp12-run-results-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let ms = Date.parse("2026-08-05T00:00:00.000Z");
  return () => {
    const value = new Date(ms).toISOString();
    ms += 10;
    return value;
  };
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

function utf8(json: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(json));
}

/** An HONEST fixture verdict (BP-21): claims the workspace's legacy evaluator identity and is
 * genuinely signed with that identity's workspace-registered key, so the assembly trust
 * resolver's fail-closed DSSE signature verification resolves it — a fixture claiming a foreign
 * IRI or carrying a garbage signature would (correctly) resolve "unresolved". */
function buildVerdictEnvelope(input: { verdict?: "pass" | "fail"; evaluationSpecificationSha256: string }): Uint8Array {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: "subject-task.json", digest: { sha256: "a".repeat(64) } },
      { name: "prediction", digest: { sha256: "b".repeat(64) } },
    ],
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluator: { id: LEGACY_VERDICT_EVALUATOR_ID },
      verdict: input.verdict ?? "pass",
      evaluationSpecification: { digest: { sha256: input.evaluationSpecificationSha256 } },
      taskSubject: "subject-task.json",
      resultSubjects: ["prediction"],
      measurements: [
        { name: "integrity", value: true },
        { name: "resolved", value: true },
      ],
      evaluatedAt: "2026-01-01T00:00:00Z",
    },
  };
  const key = loadOrCreateVerdictSigningKey(workspaceDir);
  const payloadBytes = canonicalJsonBytes(statement);
  return sealDsseEnvelope({
    payloadBytes,
    payloadType: VERDICT_DSSE_PAYLOAD_TYPE,
    signatures: [{ signature: key.sign(dssePreAuthEncoding(VERDICT_DSSE_PAYLOAD_TYPE, payloadBytes)), keyid: key.keyId }],
  });
}

function makeStatefulFakeBackend(evaluationSpecSha256: string): { backend: ProxiedBackend } {
  const byUri = new Map<string, { attempt: string; submission: string; deliveryDigestHex: string }>();
  const byIdempotencyKey = new Map<string, { bytesHash: string; ack: SubmissionAck }>();
  const bytesByHex = new Map<string, Uint8Array>();
  let counter = 0;

  function store(bytes: Uint8Array): string {
    const hex = sha256Hex(bytes);
    bytesByHex.set(hex, bytes);
    return hex;
  }

  const backend: ProxiedBackend = {
    async capabilities() {
      throw new Error("not used");
    },
    async submit(_taskBytes, submissionBytes) {
      const doc = JSON.parse(new TextDecoder().decode(submissionBytes)) as {
        idempotencyKey: string;
        submission: string;
        requirements?: { harness?: { id?: string } };
      };
      const bytesHash = sha256Hex(submissionBytes);
      const prior = byIdempotencyKey.get(doc.idempotencyKey);
      if (prior !== undefined) return prior.ack;
      counter += 1;
      const attempt = `urn:uuid:00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      const isEval = doc.requirements?.harness?.id === "evaluation-harness";
      let artifactHex: string;
      if (isEval) {
        artifactHex = store(buildVerdictEnvelope({ evaluationSpecificationSha256: evaluationSpecSha256 }));
      } else {
        artifactHex = store(utf8({ probabilityYes: "0.5", submittedAt: "2026-01-01T00:00:00Z" }));
      }
      const outputName = isEval ? "verdict" : "prediction";
      const deliveryHex = store(utf8({ outputs: [{ name: outputName, digest: { sha256: artifactHex } }] }));
      byUri.set(doc.submission, { attempt, submission: doc.submission, deliveryDigestHex: deliveryHex });
      byUri.set(attempt, { attempt, submission: doc.submission, deliveryDigestHex: deliveryHex });
      const ack: SubmissionAck = { accepted: true, submission: doc.submission as SubmissionUri, digest: `sha256:${bytesHash}` };
      byIdempotencyKey.set(doc.idempotencyKey, { bytesHash, ack });
      return ack;
    },
    async observe(ref) {
      const found = byUri.get(ref as string);
      if (found === undefined) throw new Error(`fake: no attempt for ${String(ref)}`);
      const snapshot: ObservationSnapshot = {
        descriptor: {
          attempt: found.attempt as `urn:uuid:${string}`,
          task: `sha256:${"0".repeat(64)}`,
          submission: found.submission as `urn:uuid:${string}`,
          derived: { state: "delivered", terminal: true, contradictory: false, cancelRequested: false, executionIds: [], deliveries: [] },
        },
        cursor: { sequence: "0" },
        observations: [],
      };
      return snapshot;
    },
    async recover() {
      throw new Error("not used");
    },
    async deliveries(attempt) {
      const found = byUri.get(attempt as string);
      return found === undefined ? [] : [{ attempt: attempt as AttemptUri, digest: `sha256:${found.deliveryDigestHex}` } as DeliveryRef];
    },
    async fetchDelivery(ref) {
      const bytes = bytesByHex.get(ref.digest.slice("sha256:".length));
      if (bytes === undefined) throw new Error("fake: unknown delivery digest");
      return bytes;
    },
    async fetchArtifact(descriptor: ResourceDescriptor) {
      const sha256 = descriptor.digest?.["sha256"];
      const bytes = sha256 === undefined ? undefined : bytesByHex.get(sha256);
      if (bytes === undefined) throw new Error("fake: unknown artifact digest");
      return bytes;
    },
    async drain() {},
  };
  return { backend };
}

function fakeVenue(backend: ProxiedBackend): LocalVenue {
  return {
    backend: backend as unknown as LocalVenue["backend"],
    verdictKeyId: "fake-venue-verdict-key",
    evaluators: [{ id: "urn:jinn:benchmark-product:local-venue:evaluator-1", keyId: "fake-venue-verdict-key" }],
    prepareEvaluationCell: (input) => {
      const taskBytes = utf8({ fakeEvalTask: true, subjectDigest: sha256Hex(input.subjectTaskBytes) });
      return { taskBytes, taskSha256: sha256Hex(taskBytes) };
    },
    async shutdown() {},
  };
}

async function setUpClosedRun(clock: () => string, draftId = "draft-1"): Promise<void> {
  initWorkspace(contextFor(clock));
  createDraft(contextFor(clock), { draftId, name: "Results Test" });
  const sample = await sampleInit(contextFor(clock), { draftId });
  expect(sample.ok).toBe(true);
  if (!sample.ok) throw new Error("unreachable");
  armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
  const quoted = await runQuote(contextFor(clock), { draftId });
  expect(quoted.ok).toBe(true);
  const locked = runLock(contextFor(clock), { draftId });
  expect(locked.ok).toBe(true);

  const { backend } = makeStatefulFakeBackend(sample.result.evaluationSpecSha256);
  const launched = await runLaunch(contextFor(clock), { draftId }, { createVenue: () => fakeVenue(backend) });
  expect(launched.ok).toBe(true);

  const collected = await runCollect(contextFor(clock), { draftId });
  expect(collected.ok).toBe(true);
}

describe("runResults — guards", () => {
  test("refuses illegal-transition before the run has closed", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Not Closed" });

    const outcome = runResults(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
  });
});

describe("runResults — full document", () => {
  test("writes the results artifact and returns a complete, honest document", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);

    const outcome = runResults(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const results = outcome.result;

    expect(results.draftId).toBe("draft-1");
    expect(results.benchmarkSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(results.runSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(results.matrixSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(results.runOutcome).toBe("complete");
    expect(results.completeness).toMatchObject({ expected: 6, judged: 6 });
    expect(results.cells).toHaveLength(6);
    expect(results.dissentCells).toEqual([]);

    for (const cell of results.cells) {
      expect(cell.outcome, cell.cellKey).toBe("judged");
      expect(cell.verdicts, cell.cellKey).toHaveLength(1);
      expect(cell.verdicts[0]?.verdict).toBe("pass");
      expect(cell.verdicts[0]?.evaluator).toBe(LEGACY_VERDICT_EVALUATOR_ID);
      expect(cell.verdicts[0]?.measurements).toMatchObject({ integrity: true, resolved: true });
      expect(cell.verdicts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
      // validVerdicts is presented in the same bare-hex form as `verdicts` — here every stored
      // verdict is valid, so the two lists name the same digests.
      expect(cell.validVerdicts, cell.cellKey).toEqual([cell.verdicts[0]?.sha256]);
    }

    expect(results.venueHonesty.venue).toBe("self-run");
    expect(results.venueHonesty.preRegistration).toBe("structural-and-append-order-only");
    expect(results.venueHonesty.limits.length).toBeGreaterThan(0);
    for (const limit of results.venueHonesty.limits) {
      expect(limit).not.toMatch(/summon|bind|vow|vessel|wish|smoke|seer|wane/i);
      expect(limit).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
    expect(results.venueHonesty.unverifiableAxisCounts).toMatchObject({ model: 6, loadout: 6 });

    // The artifact was durably written to disk with identical content.
    const path = resultsArtifactPath(workspaceDir, "draft-1");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(results);
  }, 30_000);

  test("available from 'reported' and 'published-bundle' states too (the Matrix does not change once sealed)", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);

    const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(reported.ok).toBe(true);
    const reportedResults = runResults(contextFor(clock), { draftId: "draft-1" });
    expect(reportedResults.ok, "reported").toBe(true);

    // M4 owns the real publish transition; this narrow state fixture proves the immutable
    // Matrix + already-stored Report projection remain readable after that later transition.
    const document = JSON.parse(readFileSync(join(workspaceDir, "drafts", "draft-1.json"), "utf8")) as { state: string };
    atomicWriteFileSync(
      join(workspaceDir, "drafts", "draft-1.json"),
      JSON.stringify({ ...document, state: "published-bundle" }, null, 2),
    );
    const publishedResults = runResults(contextFor(clock), { draftId: "draft-1" });
    expect(publishedResults.ok, "published-bundle").toBe(true);
  }, 30_000);

  test("reloads the exact sealed Report and stored claim package after reporting without recomputing them", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);

    const beforeReport = runResults(contextFor(clock), { draftId: "draft-1" });
    expect(beforeReport.ok).toBe(true);
    if (!beforeReport.ok) return;
    expect(beforeReport.result.report).toBeUndefined();

    const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    if (!reported.ok) return;

    const reloaded = runResults(contextFor(clock), { draftId: "draft-1" });
    expect(reloaded.ok, JSON.stringify(reloaded)).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.result.report).toEqual({
      reportSha256: reported.result.reportSha256,
      reportEnvelopeSha256: reported.result.reportEnvelopeSha256,
      record: parseReport(getSealedBytes(workspaceDir, reported.result.reportSha256)),
      claimPackage: reported.result.claimPackage,
      verification: {
        status: "not-run",
        detail: "Run verification to authenticate the sealed envelope and independently re-derive its Matrix, Report, and claim facts.",
      },
    });

    expect(JSON.parse(readFileSync(resultsArtifactPath(workspaceDir, "draft-1"), "utf8"))).toEqual(reloaded.result);
  }, 30_000);

  test("fails closed when a reported draft's stored claim package no longer satisfies its schema", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(reported.ok).toBe(true);

    atomicWriteFileSync(claimPackageArtifactPath(workspaceDir, "draft-1"), JSON.stringify({ claimSchema: "wrong" }));
    const reloaded = runResults(contextFor(clock), { draftId: "draft-1" });
    expect(reloaded.ok).toBe(false);
    if (reloaded.ok) return;
    expect(reloaded.error).toMatchObject({ code: "record-integrity" });
  }, 30_000);
});

describe("runResults — an expected-but-never-dispatched cell", () => {
  test("reports dispatches 0, outcome 'expired', and counts its unverifiable axes", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Partial Results" });
    const sample = await sampleInit(contextFor(clock), { draftId: "draft-1" });
    expect(sample.ok).toBe(true);
    if (!sample.ok) return;
    armAdd(contextFor(clock), { draftId: "draft-1", armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
    armAdd(contextFor(clock), { draftId: "draft-1", armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
    const quoted = await runQuote(contextFor(clock), { draftId: "draft-1" });
    expect(quoted.ok).toBe(true);
    const locked = runLock(contextFor(clock), { draftId: "draft-1" });
    expect(locked.ok).toBe(true);

    const { backend } = makeStatefulFakeBackend(sample.result.evaluationSpecSha256);
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(launched.ok).toBe(true);

    const fullEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const deliveredCells = fullEntries
      .filter((entry) => entry.kind === "cell-event" && entry.event.kind === "delivered")
      .map((entry) => (entry.kind === "cell-event" ? entry.event.cellKey : ""));
    const [droppedCellKey] = deliveredCells;
    const truncated = fullEntries.filter((entry) => {
      if (entry.kind === "cell-event") return entry.event.cellKey !== droppedCellKey;
      if (entry.kind === "submission-accepted" || entry.kind === "delivery" || entry.kind === "evaluation") {
        return entry.cellKey !== droppedCellKey;
      }
      return true;
    });
    atomicWriteFileSync(runJournalPath(workspaceDir, "draft-1"), `${truncated.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const runState = readRunState(workspaceDir, "draft-1");
    expect(runState).toBeDefined();
    if (runState === undefined) return;
    writeRunState(workspaceDir, "draft-1", { ...runState, closeAt: "2020-01-01T00:00:00Z" });

    const collected = await runCollect(contextFor(clock), { draftId: "draft-1" });
    expect(collected.ok).toBe(true);

    const outcome = runResults(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.result.runOutcome).toBe("partial");
    const droppedCell = outcome.result.cells.find((cell) => cell.cellKey === droppedCellKey);
    expect(droppedCell).toBeDefined();
    expect(droppedCell?.outcome).toBe("expired");
    expect(droppedCell?.verdicts).toEqual([]);
    expect(droppedCell?.verification).toEqual({ harness: "unverifiable", model: "unverifiable", loadout: "unverifiable", isolation: "unverifiable", checksFailed: [] });

    // Every axis's unverifiable count includes this never-dispatched cell.
    expect(outcome.result.venueHonesty.unverifiableAxisCounts.harness).toBeGreaterThanOrEqual(1);
    expect(outcome.result.venueHonesty.unverifiableAxisCounts.isolation).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

describe("runResults — dissent visibility", () => {
  test("a cell whose stored verdicts disagree is named in dissentCells, with every verdict retained", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Dissent" });
    const sample = await sampleInit(contextFor(clock), { draftId: "draft-1" });
    expect(sample.ok).toBe(true);
    if (!sample.ok) return;
    armAdd(contextFor(clock), { draftId: "draft-1", armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
    armAdd(contextFor(clock), { draftId: "draft-1", armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
    const quoted = await runQuote(contextFor(clock), { draftId: "draft-1" });
    expect(quoted.ok).toBe(true);
    const locked = runLock(contextFor(clock), { draftId: "draft-1" });
    expect(locked.ok).toBe(true);

    const { backend } = makeStatefulFakeBackend(sample.result.evaluationSpecSha256);
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(launched.ok).toBe(true);

    // Manufacture controlled disagreement for exactly one cell: seal a second, disagreeing
    // (fail) verdict and journal it as that cell's second evaluation leg — the exact durable
    // facts a second leg would have left behind.
    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    const firstEvaluation = entries.find((entry) => entry.kind === "evaluation" && entry.verdictSha256 !== undefined);
    expect(firstEvaluation).toBeDefined();
    if (firstEvaluation === undefined || firstEvaluation.kind !== "evaluation") return;
    const failEnvelope = buildVerdictEnvelope({ verdict: "fail", evaluationSpecificationSha256: sample.result.evaluationSpecSha256 });
    const failSha256 = putSealedBytes(workspaceDir, failEnvelope);
    appendRunJournalEntry(workspaceDir, "draft-1", {
      kind: "evaluation",
      at: clock(),
      cellKey: firstEvaluation.cellKey,
      verdictSha256: failSha256,
      evaluator: LEGACY_VERDICT_EVALUATOR_ID,
      evalIndex: 2,
    });

    const collected = await runCollect(contextFor(clock), { draftId: "draft-1" });
    expect(collected.ok).toBe(true);

    const outcome = runResults(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Dissent = disagreeing STORED verdicts, retained and visible — never dropped.
    expect(outcome.result.dissentCells).toEqual([firstEvaluation.cellKey]);
    const dissenting = outcome.result.cells.find((cell) => cell.cellKey === firstEvaluation.cellKey);
    expect(dissenting).toBeDefined();
    expect(dissenting?.verdicts).toHaveLength(2);
    expect(new Set(dissenting?.verdicts.map((verdict) => verdict.verdict))).toEqual(new Set(["pass", "fail"]));

    // Multiplicity alone is not dissent: every other cell carries a single verdict and stays out.
    for (const cell of outcome.result.cells) {
      if (cell.cellKey === firstEvaluation.cellKey) continue;
      expect(cell.verdicts, cell.cellKey).toHaveLength(1);
    }
  }, 30_000);
});

describe("runResults — failure block, sourced from the run journal fold (BP-22)", () => {
  test("expired, subprocess-kill infrastructure failure, task failure, cancelled, and unscorable stay distinct and out of report denominators", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Failure Block" });
    const sample = await sampleInit(contextFor(clock), { draftId: "draft-1" });
    expect(sample.ok).toBe(true);
    if (!sample.ok) return;
    armAdd(contextFor(clock), { draftId: "draft-1", armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
    armAdd(contextFor(clock), { draftId: "draft-1", armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
    const quoted = await runQuote(contextFor(clock), { draftId: "draft-1" });
    expect(quoted.ok).toBe(true);
    const locked = runLock(contextFor(clock), { draftId: "draft-1" });
    expect(locked.ok).toBe(true);

    const { backend } = makeStatefulFakeBackend(sample.result.evaluationSpecSha256);
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(launched.ok).toBe(true);

    const fullEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const deliveredCells = fullEntries
      .filter((entry) => entry.kind === "cell-event" && entry.event.kind === "delivered")
      .map((entry) => (entry.kind === "cell-event" ? entry.event.cellKey : ""));
    expect(deliveredCells.length).toBeGreaterThanOrEqual(5);
    const [expiredCellKey, infrastructureCellKey, taskCellKey, cancelledCellKey, unscorableCellKey] = deliveredCells as [
      string,
      string,
      string,
      string,
      string,
    ];
    const solveTerminalKeys = new Set([expiredCellKey, infrastructureCellKey, taskCellKey, cancelledCellKey]);

    // Drop every journal entry naming the four solve-terminal target cells, then splice in
    // synthetic terminal cell-events — the exact durable shapes each real scenario would leave
    // behind. For the unscorable target retain its real solve dispatch + Delivery and remove
    // only the evaluation leg, then add the real could-not-grade terminal shape.
    const withoutTargets = fullEntries.filter((entry) => {
      if (entry.kind === "cell-event") return !solveTerminalKeys.has(entry.event.cellKey);
      if (entry.kind === "submission-accepted" || entry.kind === "delivery" || entry.kind === "evaluation") {
        if (solveTerminalKeys.has(entry.cellKey)) return false;
        if (entry.cellKey !== unscorableCellKey) return true;
        if (entry.kind === "evaluation") return false;
        if (entry.kind === "submission-accepted" && entry.leg === "evaluation") return false;
        return true;
      }
      return true;
    });
    const synthetic: RunJournalEntry[] = [
      {
        kind: "cell-event",
        at: clock(),
        event: {
          cellKey: expiredCellKey,
          armId: parseCellKey(expiredCellKey).armId,
          replicate: parseCellKey(expiredCellKey).replicate,
          dispatch: 1,
          kind: "error",
          replaceable: true,
          replaceableReason: "expired",
          detail: "expired",
        },
      },
      {
        kind: "cell-event",
        at: clock(),
        event: {
          cellKey: infrastructureCellKey,
          armId: parseCellKey(infrastructureCellKey).armId,
          replicate: parseCellKey(infrastructureCellKey).replicate,
          dispatch: 1,
          kind: "error",
          replaceable: false,
          detail: "SIGKILL",
        },
        blame: "infrastructure",
      },
      {
        kind: "cell-event",
        at: clock(),
        event: {
          cellKey: taskCellKey,
          armId: parseCellKey(taskCellKey).armId,
          replicate: parseCellKey(taskCellKey).replicate,
          dispatch: 1,
          kind: "error",
          replaceable: false,
          detail: "exit 7",
        },
        blame: "task",
      },
      {
        kind: "cell-event",
        at: clock(),
        event: {
          cellKey: cancelledCellKey,
          armId: parseCellKey(cancelledCellKey).armId,
          replicate: parseCellKey(cancelledCellKey).replicate,
          dispatch: 1,
          kind: "cancelled",
          detail: "drain-to-boundary",
          cancelledRun: true,
        },
      },
      {
        kind: "evaluation",
        at: clock(),
        cellKey: unscorableCellKey,
        evaluationTerminal: "could-not-grade",
        detail: "environment-setup-failure",
        evaluator: LEGACY_VERDICT_EVALUATOR_ID,
        evalIndex: 1,
      },
    ];
    atomicWriteFileSync(
      runJournalPath(workspaceDir, "draft-1"),
      `${[...withoutTargets, ...synthetic].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    // Force the close boundary into the past — collect must proceed despite the (now
    // journal-terminal-but-not-delivered) target cells still counting as outstanding.
    const runState = readRunState(workspaceDir, "draft-1");
    expect(runState).toBeDefined();
    if (runState === undefined) return;
    writeRunState(workspaceDir, "draft-1", { ...runState, closeAt: "2020-01-01T00:00:00Z" });

    const collected = await runCollect(contextFor(clock), { draftId: "draft-1" });
    expect(collected.ok).toBe(true);

    const outcome = runResults(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The sealed Matrix's own outcome vocabulary is untouched: none of these three cells were
    // ever delivered, so all three still read "expired" there — the failure block is what
    // distinguishes WHY, sourced from product state the Matrix schema carries no field for.
    const expiredCell = outcome.result.cells.find((cell) => cell.cellKey === expiredCellKey);
    expect(expiredCell?.outcome).toBe("expired");
    expect(expiredCell?.failure).toEqual({ kind: "expired", detail: "expired" });

    const infrastructureCell = outcome.result.cells.find((cell) => cell.cellKey === infrastructureCellKey);
    expect(infrastructureCell?.outcome).toBe("expired");
    expect(infrastructureCell?.failure).toEqual({ kind: "failed", blame: "infrastructure", detail: "SIGKILL" });

    const taskCell = outcome.result.cells.find((cell) => cell.cellKey === taskCellKey);
    expect(taskCell?.outcome).toBe("expired");
    expect(taskCell?.failure).toEqual({ kind: "failed", blame: "task", detail: "exit 7" });

    const cancelledCell = outcome.result.cells.find((cell) => cell.cellKey === cancelledCellKey);
    expect(cancelledCell?.outcome).toBe("expired");
    expect(cancelledCell?.failure).toEqual({ kind: "cancelled", detail: "drain-to-boundary" });

    const unscorableCell = outcome.result.cells.find((cell) => cell.cellKey === unscorableCellKey);
    expect(unscorableCell?.outcome).toBe("unscorable");
    expect(unscorableCell?.failure).toBeUndefined();

    // The one remaining cell is judged and carries no failure block at all.
    const nonJudgedKeys = new Set([...solveTerminalKeys, unscorableCellKey]);
    for (const cell of outcome.result.cells) {
      if (nonJudgedKeys.has(cell.cellKey)) continue;
      expect(cell.outcome, cell.cellKey).toBe("judged");
      expect(cell.failure, cell.cellKey).toBeUndefined();
    }

    // Report and claim remain honest about adverse outcomes, while the platform aggregate's
    // denominator includes only judged cells. Infrastructure failure, task failure, expiry,
    // cancellation, and could-not-grade attrition are never converted into scored failures.
    const matrix = outcome.result;
    const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    if (!reported.ok) return;
    expect(reported.result.claimPackage.completeness).toEqual(matrix.completeness);
    expect(reported.result.claimPackage.attrition).toEqual(matrix.attrition);
    expect(matrix.completeness).toMatchObject({ expected: 6, judged: 1, runOutcome: "partial" });
    const attritionTotals = Object.values(matrix.attrition.perArm).reduce(
      (total, arm) => ({
        judged: total.judged + arm.judged,
        unscorable: total.unscorable + arm.unscorable,
        expired: total.expired + arm.expired,
      }),
      { judged: 0, unscorable: 0, expired: 0 },
    );
    expect(attritionTotals).toEqual({ judged: 1, unscorable: 1, expired: 4 });
    for (const arm of Object.keys(matrix.attrition.perArm)) {
      const judgedForArm = matrix.cells.filter((cell) => cell.armId === arm && cell.outcome === "judged").length;
      expect(reported.result.claimPackage.headline[arm]?.n, arm).toBe(judgedForArm);
    }
    expect(Object.values(reported.result.claimPackage.headline).reduce((sum, arm) => sum + arm.n, 0)).toBe(1);

    const verified = await runVerify(contextFor(clock), { draftId: "draft-1" });
    expect(verified.ok, JSON.stringify(verified)).toBe(true);
    if (!verified.ok) return;
    expect(verified.result.checks).toEqual([
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
    ]);
  }, 30_000);
});
