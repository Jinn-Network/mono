/**
 * AC2 — the official-run integration test (BP-12, M1 composition dossier): one end-to-end
 * pass over the PUBLIC run operations only (quote -> lock -> launch -> status -> collect ->
 * results), on the real local venue (`../venue/venue.js`'s `createLocalVenue`), with real
 * subprocess-spawning launchers — no in-memory backend, no `task-execution-testing`. This is
 * the one test in the packet that proves the official run path actually works against the
 * real local execution backend, not a fake standing in for it.
 *
 * Fixture idioms (tmp dir prefix, contextFor/makeClock, afterEach cleanup) mirror
 * `../operations/run-launch.test.ts` and `./drive.test.ts`; the sample benchmark and arm
 * pinning shape mirror `../venue/venue.integration.test.ts`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseMatrix, parseReport, parseRun } from "@jinn-network/benchmarking-records";
import type {
  AttemptUri,
  BackendCapabilities,
  DeliveryRef,
  ObservationSnapshot,
  SubmissionAck,
  SubmissionUri,
} from "@jinn-network/task-execution-backend";
import { deriveEvaluationTask } from "@jinn-network/task-execution-profiles";
import { sealDelivery, type ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { canonicalJsonBytes, parseDsseEnvelope } from "@jinn-network/trust-core";
import { readAuditEntries } from "../audit/journal.js";
import { verifyPublicBundle } from "../bundle/verify.js";
import { armAdd } from "../operations/arms.js";
import { authorityGrant } from "../operations/authority-ops.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft, readDraftDocument, updateDraft } from "../operations/drafts.js";
import { importSweBenchRows } from "../operations/import.js";
import { initWorkspace } from "../operations/init.js";
import { runPublish } from "../operations/publish.js";
import { runCollect } from "../operations/run-collect.js";
import { runLaunch } from "../operations/run-launch.js";
import { runLock } from "../operations/run-lock.js";
import { runQuote } from "../operations/run-quote.js";
import { runReport } from "../operations/report.js";
import { runResults } from "../operations/run-results.js";
import { runStatus } from "../operations/run-status.js";
import { runVerify } from "../operations/verify.js";
import { sampleInit } from "../operations/sample.js";
import {
  LEGACY_VERDICT_EVALUATOR_ID,
  createVerdictDsseSigner,
  loadOrCreateVerdictSigningKey,
  readVerdictEnvelope,
  sealVerdictStatement,
} from "../venue/signing.js";
import { SOLVE_HARNESS_PINS, type LocalVenue } from "../venue/venue.js";
import { resultsArtifactPath } from "../workspace/layout.js";
import { getSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import type { ProxiedBackend } from "./drive.js";
import { readRunJournalEntries } from "./journal.js";

const SIX_FRACTION_DIGITS = /^-?\d+\.\d{6}$/;

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp12-run-path-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

/**
 * The REAL wall clock, not a synthetic frozen-in-the-past one: this test drives the real local
 * venue's real subprocess supervisor (`venue.integration.test.ts`'s own `now: () => new
 * Date().toISOString()` pattern), whose deadline/cancellation bookkeeping compares against
 * actual OS time. A synthetic clock rooted at a fixed past instant (the pattern the
 * fake-backend operation tests use, e.g. `../operations/run-launch.test.ts`) makes every real
 * attempt's deadline already-expired by the time the supervisor checks it against the real
 * clock, and the supervisor cancels every attempt within milliseconds of spawning it.
 */
function makeClock(): () => string {
  return () => new Date().toISOString();
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

const PAIRED_BASELINE_HARNESS = "paired-fixture-baseline";
const PAIRED_CANDIDATE_HARNESS = "paired-fixture-candidate";

type FixtureVerdict = "pass" | "fail" | "no-verdict";

interface PairedComparison {
  readonly pairs: number;
  readonly delta: string | null;
  readonly interval: { readonly alpha: string; readonly low: string; readonly high: string } | null;
  readonly reasons: readonly string[];
}

interface PairedScenario {
  readonly draftId: string;
  readonly rows: readonly ReturnType<typeof pairedRow>[];
  readonly verdictFor: (instanceId: string, armId: "baseline" | "candidate") => FixtureVerdict;
}

function utf8(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function pairedRow(index: number, repo: string) {
  const suffix = index.toString(16).padStart(2, "0");
  return {
    instance_id: `paired-fixture-${suffix}`,
    repo,
    base_commit: `${"a".repeat(38)}${suffix}`,
    problem_statement: `Apply deterministic fixture change ${suffix}.`,
    language: "typescript",
    image: {
      uri: "https://example.org/images/paired-fixture:1",
      digest: { sha256: "8".repeat(64) },
    },
    testMaterial: [{ uri: `https://example.org/tests/paired-fixture-${suffix}.json` }],
    parser: {
      id: "jinn.parser.fixture",
      version: "1.0.0",
      digest: `sha256:${"9".repeat(64)}`,
    },
    transitions: {
      failToPass: [`fixture-${suffix}::target`],
      passToPass: [`fixture-${suffix}::regression`],
    },
    timeout: 60,
  };
}

async function fixtureVerdictEnvelope(
  evaluationSpecificationSha256: string,
  verdict: "pass" | "fail",
): Promise<Uint8Array> {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: "subject-task.json", digest: { sha256: "a".repeat(64) } },
      { name: "patch", digest: { sha256: "b".repeat(64) } },
    ],
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluator: { id: LEGACY_VERDICT_EVALUATOR_ID },
      verdict,
      evaluationSpecification: { digest: { sha256: evaluationSpecificationSha256 } },
      taskSubject: "subject-task.json",
      resultSubjects: ["patch"],
      measurements: [{ name: "passed", value: verdict === "pass" }],
      evaluatedAt: "2026-08-12T00:00:00Z",
    },
  };
  const key = loadOrCreateVerdictSigningKey(workspaceDir);
  return sealVerdictStatement({
    statementBytes: canonicalJsonBytes(statement),
    evaluatorId: LEGACY_VERDICT_EVALUATOR_ID,
    expectedEvaluationSpecificationSha256: evaluationSpecificationSha256,
    signer: createVerdictDsseSigner(key),
  });
}

const PAIRED_FIXTURE_CAPABILITIES: BackendCapabilities = {
  taskProfiles: [],
  inputMediaTypes: [],
  outputMediaTypes: [],
  cancel: false,
  watch: false,
  preflight: false,
  fetchArtifact: true,
  confidentialInputs: false,
  signedObservations: false,
  signedDeliveries: false,
  evidenceCapture: "none",
  deadlineEnforcement: false,
  isolation: ["unrestricted"],
  attempts: {},
  runPinning: {
    keys: [
      { key: "harness", inventory: [PAIRED_BASELINE_HARNESS, PAIRED_CANDIDATE_HARNESS], posture: "enforced" },
      { key: "isolationPolicy", inventory: ["unrestricted"], posture: "enforced" },
    ],
  },
};

/**
 * Purpose-built repository-work venue for P4b Task 8b. The public operations and platform
 * driver are real; only execution is deterministic: solve deliveries carry an arm marker, and
 * the venue turns that marker plus the sealed Task's instance id into a real signed verdict.
 */
function pairedFixtureVenue(scenario: PairedScenario): LocalVenue {
  const byUri = new Map<string, { attempt: string; submission: string; deliverySha256: string }>();
  const accepted = new Map<string, SubmissionAck>();
  const bytesBySha256 = new Map<string, Uint8Array>();
  const evaluationByTask = new Map<string, {
    readonly evaluationSpecificationSha256: string;
    readonly verdict: FixtureVerdict;
  }>();
  let sequence = 0;

  function store(bytes: Uint8Array): string {
    const digest = sha256Hex(bytes);
    bytesBySha256.set(digest, bytes);
    return digest;
  }

  const backend: ProxiedBackend = {
    async capabilities() {
      return PAIRED_FIXTURE_CAPABILITIES;
    },
    async submit(taskBytes, submissionBytes) {
      const submission = JSON.parse(new TextDecoder().decode(submissionBytes)) as {
        readonly idempotencyKey: string;
        readonly submission: string;
        readonly task: { readonly digest: { readonly sha256: string } };
        readonly requirements?: { readonly harness?: { readonly id?: string } };
      };
      const prior = accepted.get(submission.idempotencyKey);
      if (prior !== undefined) return prior;

      sequence += 1;
      const attempt = `urn:uuid:00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
      const harnessId = submission.requirements?.harness?.id;
      const isEvaluation = harnessId === "evaluation-harness";
      let outputName: string;
      let outputBytes: Uint8Array;
      if (isEvaluation) {
        const evaluation = evaluationByTask.get(sha256Hex(taskBytes));
        if (evaluation === undefined) throw new Error("paired fixture: unknown evaluation Task");
        if (evaluation.verdict === "no-verdict") {
          outputName = "diagnostic";
          outputBytes = utf8({ detail: "purpose-built zero-pair fixture" });
        } else {
          outputName = "verdict";
          outputBytes = await fixtureVerdictEnvelope(
            evaluation.evaluationSpecificationSha256,
            evaluation.verdict,
          );
        }
      } else {
        const armId = harnessId === PAIRED_CANDIDATE_HARNESS ? "candidate" : "baseline";
        outputName = "patch";
        outputBytes = utf8({ armId });
      }

      const outputSha256 = store(outputBytes);
      const deliveryBytes = sealDelivery({
        protocol: "https://spec.jinn.network/profiles/task-execution/v1",
        attempt,
        task: `sha256:${submission.task.digest.sha256}`,
        outputs: [{ name: outputName, digest: { sha256: outputSha256 } }],
        outcome: "fulfilled",
        createdAt: "2026-08-12T00:00:00Z",
      });
      const deliverySha256 = store(deliveryBytes);
      const state = { attempt, submission: submission.submission, deliverySha256 };
      byUri.set(submission.submission, state);
      byUri.set(attempt, state);
      const ack: SubmissionAck = {
        accepted: true,
        submission: submission.submission as SubmissionUri,
        digest: `sha256:${sha256Hex(submissionBytes)}`,
      };
      accepted.set(submission.idempotencyKey, ack);
      return ack;
    },
    async observe(reference) {
      const found = byUri.get(reference as string);
      if (found === undefined) throw new Error(`paired fixture: unknown attempt ${String(reference)}`);
      const snapshot: ObservationSnapshot = {
        descriptor: {
          attempt: found.attempt as AttemptUri,
          task: `sha256:${"0".repeat(64)}`,
          submission: found.submission as SubmissionUri,
          derived: {
            state: "delivered",
            terminal: true,
            contradictory: false,
            cancelRequested: false,
            executionIds: [],
            deliveries: [],
          },
        },
        cursor: { sequence: "0" },
        observations: [],
      };
      return snapshot;
    },
    async recover() {
      throw new Error("paired fixture: recover is not used");
    },
    async deliveries(attempt) {
      const found = byUri.get(attempt as string);
      return found === undefined
        ? []
        : [{ attempt: attempt as AttemptUri, digest: `sha256:${found.deliverySha256}` } as DeliveryRef];
    },
    async fetchDelivery(reference) {
      const bytes = bytesBySha256.get(reference.digest.slice("sha256:".length));
      if (bytes === undefined) throw new Error("paired fixture: unknown Delivery bytes");
      return bytes;
    },
    async fetchArtifact(descriptor: ResourceDescriptor) {
      const digest = descriptor.digest?.["sha256"];
      const bytes = digest === undefined ? undefined : bytesBySha256.get(digest);
      if (bytes === undefined) throw new Error("paired fixture: unknown artifact bytes");
      return bytes;
    },
    async drain() {},
  };

  return {
    backend: backend as unknown as LocalVenue["backend"],
    verdictKeyId: "paired-fixture-verdict-key",
    evaluators: [{ id: LEGACY_VERDICT_EVALUATOR_ID, keyId: "paired-fixture-verdict-key" }],
    prepareEvaluationCell(input) {
      const subject = JSON.parse(new TextDecoder().decode(input.subjectTaskBytes)) as {
        readonly payload?: { readonly instance_id?: string };
      };
      const patch = input.resultArtifacts.find((artifact) => artifact.name === "patch");
      const marker = patch === undefined
        ? undefined
        : JSON.parse(new TextDecoder().decode(patch.bytes)) as { readonly armId?: "baseline" | "candidate" };
      const instanceId = subject.payload?.instance_id;
      const armId = marker?.armId;
      if (instanceId === undefined || armId === undefined) {
        throw new Error("paired fixture: missing sealed instance or arm marker");
      }
      const derived = deriveEvaluationTask({
        subjectTask: { name: "subject-task.json", digest: `sha256:${sha256Hex(input.subjectTaskBytes)}` },
        subjectDelivery: { name: "subject-delivery.json", digest: `sha256:${sha256Hex(input.subjectDeliveryBytes)}` },
        subjectResults: input.resultArtifacts.map((artifact) => ({
          name: artifact.name,
          digest: `sha256:${sha256Hex(artifact.bytes)}`,
        })),
        evaluationSpecDigest: `sha256:${sha256Hex(input.evaluationSpecBytes)}`,
      });
      const taskSha256 = derived.digest.slice("sha256:".length);
      evaluationByTask.set(taskSha256, {
        evaluationSpecificationSha256: sha256Hex(input.evaluationSpecBytes),
        verdict: scenario.verdictFor(instanceId, armId),
      });
      return { taskBytes: derived.bytes, taskSha256 };
    },
    async shutdown() {},
  };
}

async function runPairedLifecycle(scenario: PairedScenario): Promise<{
  readonly comparison: PairedComparison;
  readonly bundleDir: string;
}> {
  const clock = makeClock();
  const context = contextFor(clock);
  expect(initWorkspace(context).ok).toBe(true);
  expect(createDraft(context, { draftId: scenario.draftId, name: "Paired lifecycle fixture" }).ok).toBe(true);
  const imported = importSweBenchRows(context, {
    draftId: scenario.draftId,
    rows: scenario.rows,
    name: "Paired lifecycle fixture",
    description: "Purpose-built P4b end-to-end coverage",
  });
  expect(imported.ok, JSON.stringify(imported)).toBe(true);

  expect(armAdd(context, {
    draftId: scenario.draftId,
    armId: "baseline",
    pinning: { harness: { id: PAIRED_BASELINE_HARNESS, version: "1" } },
  }).ok).toBe(true);
  expect(armAdd(context, {
    draftId: scenario.draftId,
    armId: "candidate",
    pinning: { harness: { id: PAIRED_CANDIDATE_HARNESS, version: "1" } },
  }).ok).toBe(true);
  expect(updateDraft(context, {
    draftId: scenario.draftId,
    patch: {
      analysis: {
        method: "jinn.benchmarking.method/paired-delta",
        version: "1",
        baseline: "baseline",
        candidate: "candidate",
        parameters: { seed: 123456789, resamples: 1000, alpha: "0.05" },
      },
    },
  }).ok).toBe(true);

  const createVenue = () => pairedFixtureVenue(scenario);
  const quoted = await runQuote(context, { draftId: scenario.draftId }, { createVenue });
  expect(quoted.ok && quoted.result.quote.ok, JSON.stringify(quoted)).toBe(true);
  expect(runLock(context, { draftId: scenario.draftId }).ok).toBe(true);
  const launched = await runLaunch(context, { draftId: scenario.draftId }, { createVenue });
  expect(launched.ok, JSON.stringify(launched)).toBe(true);
  const collected = await runCollect(context, { draftId: scenario.draftId });
  expect(collected.ok, JSON.stringify(collected)).toBe(true);
  expect(runResults(context, { draftId: scenario.draftId }).ok).toBe(true);
  const reported = await runReport(context, { draftId: scenario.draftId });
  expect(reported.ok, JSON.stringify(reported)).toBe(true);
  if (!reported.ok) throw new Error("unreachable");
  const verified = await runVerify(context, { draftId: scenario.draftId });
  expect(verified.ok, JSON.stringify(verified)).toBe(true);
  const published = await runPublish(context, { draftId: scenario.draftId });
  expect(published.ok, JSON.stringify(published)).toBe(true);
  if (!published.ok) throw new Error("unreachable");

  const bundleDir = join(workspaceDir, published.result.bundleRelativePath);
  const bundleVerification = await verifyPublicBundle(bundleDir);
  expect(bundleVerification.checks).toEqual([
    "manifest",
    "evidence-closure",
    "trust",
    "matrix-rederivation",
    "report-verification",
    "claim-consistency",
  ]);

  const report = parseReport(getSealedBytes(workspaceDir, reported.result.reportSha256));
  const perSubject = (report.results as { readonly perSubject?: readonly { readonly results?: unknown }[] }).perSubject;
  expect(perSubject).toHaveLength(1);
  return {
    comparison: perSubject![0]!.results as PairedComparison,
    bundleDir,
  };
}

describe("official run path — public operations only, real local venue (AC2)", () => {
  test(
    "quote -> gated lock -> gated launch -> status -> collect -> results, end to end on the real backend",
    async () => {
      const clock = makeClock();
      const draftId = "draft-1";

      // ── 1. workspace, bundled sample, two arms ──────────────────────────────────────────
      const initialized = initWorkspace(contextFor(clock));
      expect(initialized.ok).toBe(true);
      const created = createDraft(contextFor(clock), { draftId, name: "Official Run" });
      expect(created.ok).toBe(true);

      const sample = await sampleInit(contextFor(clock), { draftId });
      expect(sample.ok).toBe(true);
      if (!sample.ok) throw new Error("unreachable");
      expect(sample.result.tasks).toHaveLength(3);

      const baselineArm = armAdd(contextFor(clock), {
        draftId,
        armId: "baseline",
        pinning: { harness: SOLVE_HARNESS_PINS["prediction-v1-baseline"] },
      });
      expect(baselineArm.ok).toBe(true);
      const sampleArm = armAdd(contextFor(clock), {
        draftId,
        armId: "sample-uniform",
        pinning: { harness: SOLVE_HARNESS_PINS["sample-uniform"] },
      });
      expect(sampleArm.ok).toBe(true);

      // ── 2. quote ─────────────────────────────────────────────────────────────────────────
      const quoted = await runQuote(contextFor(clock), { draftId });
      expect(quoted.ok).toBe(true);
      if (!quoted.ok) throw new Error("unreachable");
      expect(quoted.result.quote.ok).toBe(true);
      expect(quoted.result.quote.expectedCellCount).toBe(6);
      expect(readDraftDocument(workspaceDir, draftId).state).toBe("quoted");

      // ── 3. gated lock (AC5, inline) ──────────────────────────────────────────────────────
      const scoped = authorityGrant(contextFor(clock), { principalId: "agent-1", operations: [] });
      expect(scoped.ok).toBe(true);

      const deniedLock = runLock(contextFor(clock, "agent-1"), { draftId });
      expect(deniedLock.ok).toBe(false);
      if (deniedLock.ok) throw new Error("unreachable");
      expect(deniedLock.error.code).toBe("authority-denied");
      const auditAfterDenial = readAuditEntries(workspaceDir);
      expect(auditAfterDenial[auditAfterDenial.length - 1]).toMatchObject({
        action: "lock",
        actor: "agent-1",
        outcome: "authority-denied",
      });

      const grantedLockLaunch = authorityGrant(contextFor(clock), {
        principalId: "agent-1",
        operations: ["lock", "launch"],
      });
      expect(grantedLockLaunch.ok).toBe(true);

      const locked = runLock(contextFor(clock, "agent-1"), { draftId });
      expect(locked.ok).toBe(true);
      if (!locked.ok) throw new Error("unreachable");
      expect(locked.result.draft.state).toBe("locked");

      const runRecord = parseRun(getSealedBytes(workspaceDir, locked.result.runSha256));
      expect(runRecord.arms).toHaveLength(2);
      expect(runRecord.analysisPlan?.[0]).toMatchObject({
        method: "jinn.benchmarking.method/wilson",
        version: "1",
      });
      expect(runRecord.policy.independence).toBe("disclosed");
      expect(runRecord.policy.evaluation.minVerdicts).toBe(1);
      expect(runRecord.venue).toMatchObject({ kind: "self-run" });
      expect(runRecord.closeAt).toBe(locked.result.closeAt);

      // Draft is immutable after lock — updateDraft/armAdd both refuse illegal-transition.
      const lateArm = armAdd(contextFor(clock), { draftId, armId: "late", pinning: {} });
      expect(lateArm.ok).toBe(false);
      if (lateArm.ok) throw new Error("unreachable");
      expect(lateArm.error.code).toBe("illegal-transition");

      // ── 4. launch — the real run: 6 solve cells (2 real launchers x 3 items) + 6 evaluation
      //      cells, all real subprocesses on the local venue's real backend ──────────────────
      const launched = await runLaunch(contextFor(clock, "agent-1"), { draftId });
      expect(launched.ok).toBe(true);
      if (!launched.ok) throw new Error("unreachable");
      expect(launched.result.draft.state).toBe("running");

      // Every evaluation journal entry is evaluator-attributed (BP-21): minVerdicts 1 means one
      // leg per cell, served by the venue's first evaluator identity.
      const journalEntries = readRunJournalEntries(workspaceDir, draftId);
      const evaluationJournalEntries = journalEntries.filter((entry) => entry.kind === "evaluation");
      expect(evaluationJournalEntries).toHaveLength(6);
      for (const entry of evaluationJournalEntries) {
        expect(entry).toMatchObject({
          evaluator: "urn:jinn:benchmark-product:local-venue:evaluator-1",
          evalIndex: 1,
        });
      }

      // ── 5. status ────────────────────────────────────────────────────────────────────────
      const status = runStatus(contextFor(clock), { draftId });
      expect(status.ok).toBe(true);
      if (!status.ok) throw new Error("unreachable");
      expect(status.result.cells).toHaveLength(6);
      expect(status.result.counts).toMatchObject({
        expected: 6,
        dispatched: 6,
        delivered: 6,
        judged: 6,
        failed: 0,
      });
      for (const cell of status.result.cells) {
        expect(cell.status, cell.cellKey).toBe("judged");
      }

      // ── 6. collect ───────────────────────────────────────────────────────────────────────
      const collected = await runCollect(contextFor(clock), { draftId });
      expect(collected.ok).toBe(true);
      if (!collected.ok) throw new Error("unreachable");
      expect(collected.result.draft.state).toBe("closed");

      const matrix = parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));
      expect(matrix.cells).toHaveLength(6);
      expect(matrix.completeness).toMatchObject({ expected: 6, judged: 6, runOutcome: "complete" });
      for (const cell of matrix.cells) {
        expect(cell.outcome, cell.cellKey).toBe("judged");
        expect(cell.integrityTier, cell.cellKey).toBe("re-derivable");
        // The trust resolver (BP-21) resolves this identity ONLY after verifying the real
        // verdict envelope's DSSE signature against evaluator-1's workspace-registered key —
        // "unresolved" here would mean the signature-verifying resolver failed against genuine
        // venue-signed verdicts.
        expect(cell.evaluator, cell.cellKey).toBe("urn:jinn:benchmark-product:local-venue:evaluator-1");
        // The venue wires an exact {id, version} pin plus a matching launcherDeployments
        // identity digest for every harness it serves (venue.ts's own header) — the harness
        // axis is therefore expected to verify as "match" against the real backend's admission
        // gate. If this were ever "unverifiable" or "mismatch" that would be a real finding
        // about the venue's admission wiring, not something to relax the assertion for.
        expect(cell.verification.harness, cell.cellKey).toBe("match");
      }

      // ── 7. verdict evidence ──────────────────────────────────────────────────────────────
      for (const cell of matrix.cells) {
        expect(cell.verdicts, cell.cellKey).toHaveLength(1);
        const [prefixedDigest] = cell.verdicts;
        expect(prefixedDigest).toBeDefined();
        if (prefixedDigest === undefined) continue;
        const verdictSha256 = prefixedDigest.startsWith("sha256:")
          ? prefixedDigest.slice("sha256:".length)
          : prefixedDigest;
        const envelopeBytes = getSealedBytes(workspaceDir, verdictSha256);

        const parsedEnvelope = parseDsseEnvelope(envelopeBytes);
        expect(parsedEnvelope.payloadType).toBe("application/vnd.in-toto+json");

        const view = readVerdictEnvelope(envelopeBytes);
        expect(view.measurements["solverBrier"], cell.cellKey).toEqual(expect.stringMatching(SIX_FRACTION_DIGITS));
        expect(view.measurements["consensusBrier"], cell.cellKey).toEqual(expect.stringMatching(SIX_FRACTION_DIGITS));
        expect(view.measurements["brierSpread"], cell.cellKey).toEqual(expect.stringMatching(SIX_FRACTION_DIGITS));

        if (cell.armId === "baseline") {
          // prediction-v1-baseline echoes the posted consensus verbatim — solverBrier and
          // consensusBrier are scored against the identical predicted value, so the spread is
          // exactly zero by construction (consensus echo).
          expect(view.measurements["brierSpread"], cell.cellKey).toBe("0.000000");
        } else if (cell.armId === "sample-uniform") {
          // sample-uniform always predicts 0.5; every bundled sample task's consensus is != 0.5
          // (0.64 / 0.32 / 1.0), so the real coin-flip baseline's spread is never zero here.
          expect(view.measurements["brierSpread"], cell.cellKey).not.toBe("0.000000");
        }
      }

      // ── 8. results ───────────────────────────────────────────────────────────────────────
      const results = runResults(contextFor(clock), { draftId });
      expect(results.ok).toBe(true);
      if (!results.ok) throw new Error("unreachable");
      expect(results.result.runOutcome).toBe("complete");
      expect(results.result.completeness).toMatchObject({ expected: 6, judged: 6 });
      expect(results.result.cells).toHaveLength(6);
      for (const cell of results.result.cells) {
        expect(cell.outcome, cell.cellKey).toBe("judged");
      }
      expect(results.result.attrition).toBeDefined();
      expect(results.result.venueHonesty).toMatchObject({
        venue: "self-run",
        preRegistration: "structural-and-append-order-only",
      });
      expect(results.result.venueHonesty.limits.length).toBeGreaterThan(0);

      const artifactPath = resultsArtifactPath(workspaceDir, draftId);
      expect(existsSync(artifactPath)).toBe(true);
      expect(JSON.parse(readFileSync(artifactPath, "utf8"))).toEqual(results.result);

      // ── 9. audit ─────────────────────────────────────────────────────────────────────────
      const audit = readAuditEntries(workspaceDir);
      for (const action of ["quote", "lock", "launch", "run.collect", "run.results"] as const) {
        expect(
          audit.some((entry) => entry.action === action && entry.outcome === "ok"),
          `expected an "ok" audit entry for action "${action}"`,
        ).toBe(true);
      }
    },
    240_000,
  );
});

describe("paired-delta public lifecycle — P4b Task 8b", () => {
  test(
    "interval present: create -> import -> arms -> lock -> launch -> collect -> report -> verify -> publish -> bundle verify",
    async () => {
      const rows = [
        pairedRow(1, "example/cluster-a"),
        pairedRow(2, "example/cluster-a"),
        pairedRow(3, "example/cluster-a"),
        pairedRow(4, "example/cluster-b"),
        pairedRow(5, "example/cluster-b"),
        pairedRow(6, "example/cluster-b"),
      ];
      const baseline = new Map(rows.map((row, index) => [row.instance_id, index < 2 ? "pass" : "fail"] as const));
      const candidate = new Map(rows.map((row, index) => [row.instance_id, index < 4 ? "pass" : "fail"] as const));
      const outcome = await runPairedLifecycle({
        draftId: "paired-interval-present",
        rows,
        verdictFor: (instanceId, armId) => (armId === "baseline" ? baseline : candidate).get(instanceId)!,
      });

      expect(outcome.comparison.pairs).toBe(6);
      expect(outcome.comparison.delta).toBe("0.3333");
      expect(outcome.comparison.interval).toMatchObject({ alpha: "0.0500" });
      expect(outcome.comparison.reasons).toEqual([]);
      const html = readFileSync(join(outcome.bundleDir, "index.html"), "utf8");
      expect(html).toContain(outcome.comparison.interval!.low);
      expect(html).toContain(outcome.comparison.interval!.high);
    },
    60_000,
  );

  test(
    "interval withheld: the complete lifecycle retains delta and both method reasons",
    async () => {
      const rows = [pairedRow(1, "example/one-cluster"), pairedRow(2, "example/one-cluster")];
      const outcome = await runPairedLifecycle({
        draftId: "paired-interval-withheld",
        rows,
        verdictFor: (_instanceId, armId) => armId === "candidate" ? "pass" : "fail",
      });

      expect(outcome.comparison.pairs).toBe(2);
      expect(outcome.comparison.delta).toBe("1.0000");
      expect(outcome.comparison.interval).toBeNull();
      expect(outcome.comparison.reasons).toEqual([
        "fewer than minN=5 paired tasks (got 2)",
        "fewer than two source clusters (got 1)",
      ]);
      const html = readFileSync(join(outcome.bundleDir, "index.html"), "utf8");
      for (const reason of outcome.comparison.reasons) expect(html).toContain(reason);
    },
    60_000,
  );

  test(
    "zero pairs: the complete lifecycle publishes no delta or interval and does not crash",
    async () => {
      const rows = [pairedRow(1, "example/zero-a"), pairedRow(2, "example/zero-b")];
      const outcome = await runPairedLifecycle({
        draftId: "paired-zero-pairs",
        rows,
        verdictFor: (_instanceId, armId) => armId === "candidate" ? "no-verdict" : "pass",
      });

      expect(outcome.comparison.pairs).toBe(0);
      expect(outcome.comparison.delta).toBeNull();
      expect(outcome.comparison.interval).toBeNull();
      const html = readFileSync(join(outcome.bundleDir, "index.html"), "utf8");
      expect(html).toContain("Interval withheld");
      expect(html).toContain("fewer than minN=5 paired tasks (got 0)");
    },
    60_000,
  );
});
