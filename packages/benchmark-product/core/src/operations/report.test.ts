import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseReport } from "@jinn-network/benchmarking-records";
import type { AttemptUri, DeliveryRef, ObservationSnapshot, SubmissionAck, SubmissionUri } from "@jinn-network/task-execution-backend";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import type { ProxiedBackend } from "../run/drive.js";
import { readRunState, writeRunState } from "../run/state.js";
import { claimPackageArtifactPath } from "../workspace/layout.js";
import { getSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import { LEGACY_VERDICT_EVALUATOR_ID, createVerdictDsseSigner, loadOrCreateVerdictSigningKey, sealVerdictStatement } from "../venue/signing.js";
import type { LocalVenue } from "../venue/venue.js";
import { armAdd } from "./arms.js";
import { authorityGrant } from "./authority-ops.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { readAuditEntries } from "../audit/journal.js";
import { runCollect } from "./run-collect.js";
import { runLaunch } from "./run-launch.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { runReport } from "./report.js";
import { runVerify } from "./verify.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp13-report-op-"));
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

/** A REPORT-GRADE Result Evaluation Statement -- unlike run-collect.test.ts's own
 * `buildVerdictEnvelope`, this is a full in-toto Statement (subject/taskSubject/resultSubjects)
 * sealed with the workspace's real verdict-signing key via `sealVerdictStatement`, so the sealed
 * store holds authentic product-sealed envelopes that
 * `@jinn-network/benchmarking-aggregate`'s `resolveVerdictOutcome` can genuinely accept. */
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
          // The legacy evaluator identity is what the workspace's legacy verdict-signing key
          // maps to in the evaluator registry (BP-21) — claiming any other IRI over this key
          // would (correctly) resolve "unresolved" in the signature-verifying trust resolver.
          evaluatorId: LEGACY_VERDICT_EVALUATOR_ID,
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
  createDraft(contextFor(clock), { draftId, name: "Report Test" });
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

describe("runReport — happy path", () => {
  test(
    "seals a DSSE Report, derives preregistered=true, writes RunState + claim package, transitions to reported",
    async () => {
      const clock = makeClock();
      await setUpClosedRun(clock);

      const outcome = await runReport(contextFor(clock), { draftId: "draft-1" });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      if (!outcome.ok) return;

      expect(outcome.result.draft.state).toBe("reported");
      expect(outcome.result.preregistered).toBe(true);
      expect(outcome.result.reportSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(outcome.result.reportEnvelopeSha256).toMatch(/^[a-f0-9]{64}$/);

      // The sealed Report is genuinely readable back from the workspace's own sealed-bytes store.
      const reportBytes = getSealedBytes(workspaceDir, outcome.result.reportSha256);
      const reportRecord = parseReport(reportBytes);
      expect(reportRecord.preregistered).toBe(true);
      expect(reportRecord.disclosures.perSubject).toHaveLength(1);
      expect(reportRecord.limitations).toBeDefined();
      expect((reportRecord.limitations ?? []).length).toBeGreaterThan(0);

      // RunState carries the new report fields.
      const runState = readRunState(workspaceDir, "draft-1");
      expect(runState?.reportSha256).toBe(outcome.result.reportSha256);
      expect(runState?.reportEnvelopeSha256).toBe(outcome.result.reportEnvelopeSha256);
      expect(runState?.reportedAt).toBeDefined();

      // The claim package artifact exists and matches the operation's own return value.
      expect(existsSync(claimPackageArtifactPath(workspaceDir, "draft-1"))).toBe(true);
      expect(outcome.result.claimPackage.records.reportSha256).toBe(outcome.result.reportSha256);
      expect(outcome.result.claimPackage.scope.draftId).toBe("draft-1");

      // BP-21: the claim states the assurance preset AND the primitives the sealed Run carries,
      // plus the fixed agent-distinctness disclosure — never the preset label alone.
      expect(outcome.result.claimPackage.assurance.preset).toBe("direct-check");
      expect(outcome.result.claimPackage.assurance.resolved).toEqual({
        independence: "disclosed",
        minVerdicts: 1,
        distinctEvaluator: false,
        verdictRule: "sole",
      });
      expect(outcome.result.claimPackage.assurance.disclosure).toContain("agent-distinctness");
      expect(outcome.result.claimPackage.assurance.disclosure).toContain("party-independence");
    },
    30_000,
  );
});

describe("runReport — refusals", () => {
  test("refuses illegal-transition when the draft is not closed", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Never Run" });

    const outcome = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
  });

  test("refuses conflict when the draft is closed but has no sealed Matrix (doctored RunState)", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    const runState = readRunState(workspaceDir, "draft-1");
    expect(runState).toBeDefined();
    if (runState === undefined) return;
    const { matrixSha256: _matrixSha256, ...withoutMatrix } = runState;
    writeRunState(workspaceDir, "draft-1", withoutMatrix);

    const outcome = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("conflict");

    // The draft was NOT advanced to reported by a refused report attempt.
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("closed");
  }, 30_000);

  test("refuses authority-denied for a workspace member without the report grant, and audits it", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    const granted = authorityGrant(contextFor(clock), { principalId: "agent-1", operations: [] });
    expect(granted.ok).toBe(true);

    const outcome = await runReport(contextFor(clock, "agent-1"), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("authority-denied");

    const entries = readAuditEntries(workspaceDir);
    expect(entries[entries.length - 1]).toMatchObject({
      action: "report",
      actor: "agent-1",
      outcome: "authority-denied",
    });

    // The draft was NOT advanced to reported by a denied report attempt.
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("closed");
  }, 30_000);
});

describe("runReport — claim-package write failure does not strand the draft", () => {
  test(
    "a failure writing the claim package leaves the draft closed and retryable, not stranded at reported",
    async () => {
      const clock = makeClock();
      await setUpClosedRun(clock);

      // Obstruct the claim package's parent directory (`<ws>/artifacts/<draftId>`) with a FILE
      // in its place, so `writeClaimPackage`'s `atomicWriteFileSync` cannot `mkdirSync` it and
      // throws. Nothing has written into `artifacts/<draftId>/` yet at this point in the test
      // (only `run.collect` has run, not `run.results`), so the path is free to obstruct.
      const claimDir = join(workspaceDir, "artifacts", "draft-1");
      writeFileSync(claimDir, "obstruction");

      const failed = await runReport(contextFor(clock), { draftId: "draft-1" });
      expect(failed.ok).toBe(false);
      if (failed.ok) return;
      // A typed refusal via the operate boundary, not an uncaught crash.
      expect(typeof failed.error.code).toBe("string");

      // The draft is STILL "closed" — the irreversible transition never ran because the claim
      // package write (which now runs BEFORE it) failed first.
      expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("closed");
      expect(existsSync(claimPackageArtifactPath(workspaceDir, "draft-1"))).toBe(false);

      // Remove the obstruction and retry: `report` is fully replayable from "closed".
      rmSync(claimDir, { force: true });

      const retried = await runReport(contextFor(clock), { draftId: "draft-1" });
      expect(retried.ok, JSON.stringify(retried)).toBe(true);
      if (!retried.ok) return;
      expect(retried.result.draft.state).toBe("reported");
      expect(existsSync(claimPackageArtifactPath(workspaceDir, "draft-1"))).toBe(true);

      const verified = await runVerify(contextFor(clock), { draftId: "draft-1" });
      expect(verified.ok, JSON.stringify(verified)).toBe(true);
      if (!verified.ok) return;
      expect(verified.result.checks).toContain("claim-consistency");
    },
    30_000,
  );
});
