import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseMatrix, sealMatrix } from "@jinn-network/benchmarking-records";
import type { AttemptUri, DeliveryRef, ObservationSnapshot, SubmissionAck, SubmissionUri } from "@jinn-network/task-execution-backend";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { canonicalJsonBytes, parseDsseEnvelope, sealDsseEnvelope } from "@jinn-network/trust-core";
import type { ProxiedBackend } from "../run/drive.js";
import { readRunState, writeRunState } from "../run/state.js";
import { claimPackageArtifactPath } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes, sealedRecordPath, sha256Hex } from "../workspace/sealed-store.js";
import { createVerdictDsseSigner, loadOrCreateVerdictSigningKey, sealVerdictStatement } from "../venue/signing.js";
import type { LocalVenue } from "../venue/venue.js";
import { readAuditEntries } from "../audit/journal.js";
import { armAdd } from "./arms.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { runCollect } from "./run-collect.js";
import { runLaunch } from "./run-launch.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { runReport } from "./report.js";
import { runVerify } from "./verify.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp13-verify-op-"));
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

/** A REPORT-GRADE Result Evaluation Statement — a full in-toto Statement sealed with the
 * workspace's real verdict-signing key via `sealVerdictStatement`, so the sealed store holds
 * authentic product-sealed envelopes `@jinn-network/benchmarking-aggregate`'s
 * `resolveVerdictOutcome` can genuinely accept. Mirrors `report.test.ts`'s own helper of the same
 * name — duplicated rather than imported (no test file in this package imports fixtures from a
 * sibling test file). */
async function buildReportGradeVerdictEnvelope(
  workspaceDirForKey: string,
  input: { evaluatorId: string; evaluationSpecificationSha256: string; verdict: "pass" | "fail" },
): Promise<Uint8Array> {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: "subject-task.json", digest: { sha256: "a".repeat(64) } },
      { name: "prediction", digest: { sha256: "b".repeat(64) } },
    ],
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluator: { id: input.evaluatorId },
      verdict: input.verdict,
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
  const key = loadOrCreateVerdictSigningKey(workspaceDirForKey);
  const signer = createVerdictDsseSigner(key);
  return sealVerdictStatement({
    statementBytes: canonicalJsonBytes(statement),
    evaluatorId: input.evaluatorId,
    expectedEvaluationSpecificationSha256: input.evaluationSpecificationSha256,
    signer,
  });
}

function makeStatefulFakeBackend(
  workspaceDirForKey: string,
  evaluationSpecSha256: string,
): { backend: ProxiedBackend } {
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
        const envelope = await buildReportGradeVerdictEnvelope(workspaceDirForKey, {
          evaluatorId: "urn:jinn:test:evaluator",
          evaluationSpecificationSha256: evaluationSpecSha256,
          verdict: "pass",
        });
        artifactHex = store(envelope);
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
    prepareEvaluationCell: (input) => {
      const taskBytes = utf8({ fakeEvalTask: true, subjectDigest: sha256Hex(input.subjectTaskBytes) });
      return { taskBytes, taskSha256: sha256Hex(taskBytes) };
    },
    async shutdown() {},
  };
}

async function setUpClosedRun(clock: () => string, draftId = "draft-1"): Promise<void> {
  initWorkspace(contextFor(clock));
  createDraft(contextFor(clock), { draftId, name: "Verify Test" });
  const sample = await sampleInit(contextFor(clock), { draftId });
  expect(sample.ok).toBe(true);
  if (!sample.ok) throw new Error("unreachable");
  armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
  const quoted = await runQuote(contextFor(clock), { draftId });
  expect(quoted.ok).toBe(true);
  const locked = runLock(contextFor(clock), { draftId });
  expect(locked.ok).toBe(true);

  const { backend } = makeStatefulFakeBackend(workspaceDir, sample.result.evaluationSpecSha256);
  const launched = await runLaunch(contextFor(clock), { draftId }, { createVenue: () => fakeVenue(backend) });
  expect(launched.ok).toBe(true);

  const collected = await runCollect(contextFor(clock), { draftId });
  expect(collected.ok).toBe(true);
  if (!collected.ok) throw new Error("unreachable");
  expect(readDraftDocument(workspaceDir, draftId).state).toBe("closed");
}

/** Closed + reported: the fixture every report-tamper and claim-tamper test starts from. */
async function setUpReportedRun(clock: () => string, draftId = "draft-1"): Promise<void> {
  await setUpClosedRun(clock, draftId);
  const reported = await runReport(contextFor(clock), { draftId });
  expect(reported.ok, JSON.stringify(reported)).toBe(true);
  if (!reported.ok) throw new Error("unreachable");
}

describe("runVerify — happy path", () => {
  test(
    "green end-to-end on a reported run: all three checks pass",
    async () => {
      const clock = makeClock();
      await setUpReportedRun(clock);
      const runState = readRunState(workspaceDir, "draft-1");
      expect(runState).toBeDefined();
      if (runState === undefined) return;

      const outcome = await runVerify(contextFor(clock), { draftId: "draft-1" });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      if (!outcome.ok) return;

      expect(outcome.result.checks).toEqual(["matrix-rederivation", "report-verification", "claim-consistency"]);
      expect(outcome.result.matrixSha256).toBe(runState.matrixSha256);
      expect(outcome.result.reportEnvelopeSha256).toBe(runState.reportEnvelopeSha256);
    },
    30_000,
  );

  test(
    "green on a merely-closed run: only matrix-rederivation runs",
    async () => {
      const clock = makeClock();
      await setUpClosedRun(clock);

      const outcome = await runVerify(contextFor(clock), { draftId: "draft-1" });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      if (!outcome.ok) return;

      expect(outcome.result.checks).toEqual(["matrix-rederivation"]);
      expect(outcome.result.reportEnvelopeSha256).toBeUndefined();
    },
    30_000,
  );
});

describe("runVerify — matrix tamper detection", () => {
  test(
    "rejects a valid-but-different re-sealed Matrix (matrix-rederivation, strong tamper)",
    async () => {
      const clock = makeClock();
      await setUpClosedRun(clock);
      const runState = readRunState(workspaceDir, "draft-1");
      expect(runState?.matrixSha256).toBeDefined();
      if (runState?.matrixSha256 === undefined) return;

      // A genuinely valid Matrix that differs materially from the sealed one: the same record,
      // with the first cell's evaluator identity swapped for a different (still well-formed)
      // Agent IRI. This is NOT a bytes-level corruption — `sealMatrix` re-validates it, and the
      // sealed-store digest check on read passes fine, since the stored bytes genuinely match
      // their own (new) digest. Only re-derivation against durable state catches this.
      const originalMatrix = parseMatrix(getSealedBytes(workspaceDir, runState.matrixSha256));
      const [firstCell, ...restCells] = originalMatrix.cells;
      expect(firstCell).toBeDefined();
      if (firstCell === undefined) return;
      const tamperedMatrix = {
        ...originalMatrix,
        cells: [{ ...firstCell, evaluator: "urn:jinn:tampered:evaluator" }, ...restCells],
      };
      const tamperedSealed = sealMatrix(tamperedMatrix);
      expect(tamperedSealed.bytes).not.toEqual(getSealedBytes(workspaceDir, runState.matrixSha256));
      const tamperedMatrixSha256 = putSealedBytes(workspaceDir, tamperedSealed.bytes);
      writeRunState(workspaceDir, "draft-1", { ...runState, matrixSha256: tamperedMatrixSha256 });

      const outcome = await runVerify(contextFor(clock), { draftId: "draft-1" });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("record-integrity");
      expect(outcome.error.issues?.[0]?.path).toBe("matrix-rederivation");
      expect(outcome.error.detail).toContain("matrix-rederivation");
    },
    30_000,
  );

  test(
    "rejects an in-place corrupted Matrix file (sealed-store digest check, weak tamper)",
    async () => {
      const clock = makeClock();
      await setUpClosedRun(clock);
      const runState = readRunState(workspaceDir, "draft-1");
      expect(runState?.matrixSha256).toBeDefined();
      if (runState?.matrixSha256 === undefined) return;

      writeFileSync(sealedRecordPath(workspaceDir, runState.matrixSha256), Buffer.from("not the real matrix bytes"));

      const outcome = await runVerify(contextFor(clock), { draftId: "draft-1" });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("record-integrity");
      // Thrown by the sealed-store's own digest check on read (../workspace/sealed-store.ts),
      // not by this operation's own re-derivation refusal — a different check path than the
      // strong-tamper case above, on purpose (module header: two independent layers).
      expect(outcome.error.detail).toContain("stored bytes do not match their digest");
    },
    30_000,
  );
});

describe("runVerify — report tamper detection", () => {
  test(
    "rejects a report envelope with a tampered signature",
    async () => {
      const clock = makeClock();
      await setUpReportedRun(clock);
      const runState = readRunState(workspaceDir, "draft-1");
      expect(runState?.reportEnvelopeSha256).toBeDefined();
      if (runState?.reportEnvelopeSha256 === undefined) return;

      const envelopeBytes = getSealedBytes(workspaceDir, runState.reportEnvelopeSha256);
      const parsed = parseDsseEnvelope(envelopeBytes);
      const [signature] = parsed.signatures;
      expect(signature).toBeDefined();
      if (signature === undefined) return;
      const decoded = Buffer.from(signature.sig, "base64");
      const tampered = Buffer.from(decoded);
      tampered[0] = (tampered[0] ?? 0) ^ 0xff;
      const tamperedEnvelopeBytes = sealDsseEnvelope({
        payloadBytes: parsed.payloadBytes,
        payloadType: parsed.payloadType,
        signatures: [{ signature: new Uint8Array(tampered), ...(signature.keyid !== undefined ? { keyid: signature.keyid } : {}) }],
      });
      expect(tamperedEnvelopeBytes).not.toEqual(envelopeBytes);
      const tamperedEnvelopeSha256 = putSealedBytes(workspaceDir, tamperedEnvelopeBytes);
      writeRunState(workspaceDir, "draft-1", { ...runState, reportEnvelopeSha256: tamperedEnvelopeSha256 });

      const outcome = await runVerify(contextFor(clock), { draftId: "draft-1" });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("record-integrity");
      expect(outcome.error.issues?.[0]?.path).toBe("report-verification");
      expect(outcome.error.detail).toContain("report-authenticity");
    },
    30_000,
  );
});

describe("runVerify — claim package tamper detection", () => {
  test(
    "rejects a claim package whose records.matrixSha256 disagrees with RunState",
    async () => {
      const clock = makeClock();
      await setUpReportedRun(clock);
      const claimPath = claimPackageArtifactPath(workspaceDir, "draft-1");
      const claim = JSON.parse(readFileSync(claimPath, "utf8")) as { records: { matrixSha256: string } };
      const tamperedDigest = claim.records.matrixSha256.startsWith("f") ? "0".repeat(64) : "f".repeat(64);
      writeFileSync(claimPath, JSON.stringify({ ...claim, records: { ...claim.records, matrixSha256: tamperedDigest } }, null, 2));

      const outcome = await runVerify(contextFor(clock), { draftId: "draft-1" });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("record-integrity");
      expect(outcome.error.issues?.[0]?.path).toBe("claim-consistency");
      expect(outcome.error.detail).toContain("records.matrixSha256");
    },
    30_000,
  );

  test(
    "rejects a claim package whose results disagree with the verified Report",
    async () => {
      const clock = makeClock();
      await setUpReportedRun(clock);
      const claimPath = claimPackageArtifactPath(workspaceDir, "draft-1");
      const claim = JSON.parse(readFileSync(claimPath, "utf8")) as { results: Record<string, unknown> };
      writeFileSync(
        claimPath,
        JSON.stringify({ ...claim, results: { ...claim.results, tamperedMarker: true } }, null, 2),
      );

      const outcome = await runVerify(contextFor(clock), { draftId: "draft-1" });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("record-integrity");
      expect(outcome.error.issues?.[0]?.path).toBe("claim-consistency");
      expect(outcome.error.detail).toContain("results");
    },
    30_000,
  );
});

describe("runVerify — refusals", () => {
  test("refuses conflict when no Matrix has been sealed yet", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Never Collected" });
    const sample = await sampleInit(contextFor(clock), { draftId: "draft-1" });
    expect(sample.ok).toBe(true);
    armAdd(contextFor(clock), { draftId: "draft-1", armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
    armAdd(contextFor(clock), { draftId: "draft-1", armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
    const quoted = await runQuote(contextFor(clock), { draftId: "draft-1" });
    expect(quoted.ok).toBe(true);
    const locked = runLock(contextFor(clock), { draftId: "draft-1" });
    expect(locked.ok).toBe(true);

    const outcome = await runVerify(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("conflict");
  });

  test("refuses conflict when the draft is reported but RunState lost its reportEnvelopeSha256", async () => {
    const clock = makeClock();
    await setUpReportedRun(clock);
    const runState = readRunState(workspaceDir, "draft-1");
    expect(runState).toBeDefined();
    if (runState === undefined) return;
    const { reportEnvelopeSha256: _dropped, ...withoutEnvelope } = runState;
    writeRunState(workspaceDir, "draft-1", withoutEnvelope);
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("reported");

    const outcome = await runVerify(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("conflict");
  }, 30_000);
});

describe("runVerify — audit journal", () => {
  test("records run.verify with outcome ok on success and record-integrity on a tamper failure", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);

    const ok = await runVerify(contextFor(clock), { draftId: "draft-1" });
    expect(ok.ok).toBe(true);
    let entries = readAuditEntries(workspaceDir);
    expect(entries[entries.length - 1]).toMatchObject({ action: "run.verify", outcome: "ok" });

    const runState = readRunState(workspaceDir, "draft-1");
    expect(runState?.matrixSha256).toBeDefined();
    if (runState?.matrixSha256 === undefined) return;
    writeFileSync(sealedRecordPath(workspaceDir, runState.matrixSha256), Buffer.from("corrupted"));

    const failed = await runVerify(contextFor(clock), { draftId: "draft-1" });
    expect(failed.ok).toBe(false);
    entries = readAuditEntries(workspaceDir);
    expect(entries[entries.length - 1]).toMatchObject({ action: "run.verify", outcome: "record-integrity" });
  }, 30_000);
});
