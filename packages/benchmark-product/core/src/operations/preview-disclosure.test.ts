/**
 * BP-20 deliverable A (spec §7.2, "preview = disclosed rehearsal"): "When any preview of a
 * benchmark preceded the official run, the official report's limitations name that fact."
 * Exercises `runReport`'s preview-log read (`../operations/report.ts`) and `buildClaimPackage`'s
 * optional `rehearsal` block (`../report/claim.ts`) end to end, on both a previewed and an
 * un-previewed workspace.
 *
 * Adapted from `./report.test.ts`'s own `makeStatefulFakeBackend` + `fakeVenue` +
 * `setUpClosedRun` pattern. The SAME fake venue/backend is passed through both `runPreview`'s and
 * `runLaunch`'s `deps.createVenue` — the stateful backend already handles the solve leg
 * (preview's only leg) and the evaluation leg (the official launch's second leg) identically, so
 * there is no need for a second, preview-only backend here.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseReport } from "@jinn-network/benchmarking-records";
import type { AttemptUri, DeliveryRef, ObservationSnapshot, SubmissionAck, SubmissionUri } from "@jinn-network/task-execution-backend";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import type { ProxiedBackend } from "../run/drive.js";
import { previewDisclosureLine, readPreviewLog } from "../run/preview-log.js";
import { claimPackageArtifactPath } from "../workspace/layout.js";
import { getSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import { createVerdictDsseSigner, loadOrCreateVerdictSigningKey, sealVerdictStatement } from "../venue/signing.js";
import type { LocalVenue } from "../venue/venue.js";
import { armAdd } from "./arms.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { runCollect } from "./run-collect.js";
import { runLaunch } from "./run-launch.js";
import { runLock } from "./run-lock.js";
import { runPreview } from "./preview.js";
import { runQuote } from "./run-quote.js";
import { runReport } from "./report.js";
import { runVerify } from "./verify.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp20-preview-disclosure-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let ms = Date.parse("2026-08-06T00:00:00.000Z");
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

/** Adapted verbatim from `./report.test.ts`'s own helper of the same name. */
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

/** Adapted verbatim from `./report.test.ts`'s own helper of the same name — covers both the
 * solve leg (preview and the official launch) and the evaluation leg (the official launch only). */
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

async function setUpTwoArmDraft(clock: () => string, draftId = "draft-1"): Promise<{ evaluationSpecSha256: string }> {
  initWorkspace(contextFor(clock));
  createDraft(contextFor(clock), { draftId, name: "Preview Disclosure Test" });
  const sample = await sampleInit(contextFor(clock), { draftId });
  expect(sample.ok).toBe(true);
  if (!sample.ok) throw new Error("unreachable");
  armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
  return { evaluationSpecSha256: sample.result.evaluationSpecSha256 };
}

/** Shared tail: quote -> lock -> launch (fake backend) -> collect -> report. Identical for the
 * previewed and un-previewed paths below — only what happens BEFORE this tail differs. */
async function quoteLockLaunchCollectReport(clock: () => string, backend: ProxiedBackend, draftId = "draft-1") {
  const quoted = await runQuote(contextFor(clock), { draftId });
  expect(quoted.ok, JSON.stringify(quoted)).toBe(true);

  const locked = runLock(contextFor(clock), { draftId });
  expect(locked.ok, JSON.stringify(locked)).toBe(true);

  const launched = await runLaunch(contextFor(clock), { draftId }, { createVenue: () => fakeVenue(backend) });
  expect(launched.ok, JSON.stringify(launched)).toBe(true);

  const collected = await runCollect(contextFor(clock), { draftId });
  expect(collected.ok, JSON.stringify(collected)).toBe(true);
  expect(readDraftDocument(workspaceDir, draftId).state).toBe("closed");

  return runReport(contextFor(clock), { draftId });
}

describe("runReport + claim package — preview disclosure (BP-20, spec §7.2)", () => {
  test(
    "previewed path: two disclosed previews land in the sealed Report's limitations, the claim package's limitations, and claimPackage.rehearsal; runVerify still passes",
    async () => {
      const clock = makeClock();
      const { evaluationSpecSha256 } = await setUpTwoArmDraft(clock);
      const { backend } = makeStatefulFakeBackend(workspaceDir, evaluationSpecSha256);

      const firstPreview = await runPreview(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
      expect(firstPreview.ok, JSON.stringify(firstPreview)).toBe(true);
      const secondPreview = await runPreview(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
      expect(secondPreview.ok, JSON.stringify(secondPreview)).toBe(true);

      const log = readPreviewLog(workspaceDir, "draft-1");
      expect(log?.count).toBe(2);
      if (log === undefined) throw new Error("unreachable");
      const expectedLine = previewDisclosureLine(log);
      const timestamps = log.previews.map((preview) => preview.at);
      expect(timestamps).toHaveLength(2);
      for (const at of timestamps) expect(expectedLine).toContain(at);

      const reported = await quoteLockLaunchCollectReport(clock, backend);
      expect(reported.ok, JSON.stringify(reported)).toBe(true);
      if (!reported.ok) return;

      // (a) the sealed Report record's limitations contain the exact disclosure line.
      const reportRecord = parseReport(getSealedBytes(workspaceDir, reported.result.reportSha256));
      expect(reportRecord.limitations).toContain(expectedLine);

      // (b) the claim package's limitations contain it too (extracted verbatim from the report).
      expect(reported.result.claimPackage.limitations).toContain(expectedLine);

      // (c) claimPackage.rehearsal deep-equals { previewCount: 2, timestamps: [at1, at2] }.
      expect(reported.result.claimPackage.rehearsal).toEqual({ previewCount: 2, timestamps });

      // (d) runVerify still passes end-to-end on the previewed -> reported workspace — the
      // disclosure does not break claim consistency.
      const verified = await runVerify(contextFor(clock), { draftId: "draft-1" });
      expect(verified.ok, JSON.stringify(verified)).toBe(true);
    },
    30_000,
  );

  test(
    "un-previewed path: no preview/rehearsal limitation appears, and claimPackage.rehearsal is absent from both the return value and the written JSON",
    async () => {
      const clock = makeClock();
      const { evaluationSpecSha256 } = await setUpTwoArmDraft(clock);
      const { backend } = makeStatefulFakeBackend(workspaceDir, evaluationSpecSha256);

      // Same preview log read that ran above finds nothing here — the draft was never previewed.
      expect(readPreviewLog(workspaceDir, "draft-1")).toBeUndefined();

      const reported = await quoteLockLaunchCollectReport(clock, backend);
      expect(reported.ok, JSON.stringify(reported)).toBe(true);
      if (!reported.ok) return;

      const reportRecord = parseReport(getSealedBytes(workspaceDir, reported.result.reportSha256));
      expect((reportRecord.limitations ?? []).some((line) => /preview/i.test(line))).toBe(false);
      expect(reported.result.claimPackage.limitations.some((line) => /preview/i.test(line))).toBe(false);

      expect(reported.result.claimPackage.rehearsal).toBeUndefined();

      const claimJson = JSON.parse(readFileSync(claimPackageArtifactPath(workspaceDir, "draft-1"), "utf8")) as Record<string, unknown>;
      expect(Object.hasOwn(claimJson, "rehearsal")).toBe(false);
      expect(existsSync(claimPackageArtifactPath(workspaceDir, "draft-1"))).toBe(true);

      const verified = await runVerify(contextFor(clock), { draftId: "draft-1" });
      expect(verified.ok, JSON.stringify(verified)).toBe(true);
    },
    30_000,
  );
});
