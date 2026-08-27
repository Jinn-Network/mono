/**
 * Resume must replay an ALREADY-ACCEPTED evaluation Submission byte-exactly, the same way the
 * solve leg does (`../operations/run-launch.js`'s `journaledSubmissions` +
 * `acceptedSubmissions.acceptedSubmissionBytes`).
 *
 * Canary-proven defect: `./drive.js`'s `dispatchEvaluation` seals fresh bytes on every call, and
 * those bytes carry a wall-clock `deadline`. When a process dies between the backend accepting an
 * evaluation Submission and that leg's verdict being journaled, `driveEvaluationCatchUp` re-mints
 * under the SAME idempotency key with a LATER deadline. The local backend rehydrates
 * `submissionsByScope` from its durable state root at startup
 * (`packages/task-execution/backend-local/assembly/src/backend.ts`), so it correctly refuses:
 *
 *   idempotencyKey "eval:<run>:e1:<cellKey>:<dispatch>" already has different exact bytes in this
 *   requester/backend scope
 *
 * which terminals the leg could-not-grade — permanently, because could-not-grade writes the
 * evalIndex into `completedEvalIndexes` (`./journal.js`), so no retry setting recovers it.
 *
 * The window reproduced here is the canary's own — 18 deliveries, 17 verdicts: the evaluation
 * attempt DELIVERED durably and the process died before its verdict reached the journal.
 *
 * The interruption technique (modelled on `./run-resume.integration.test.ts`, which interrupts the
 * SOLVE leg): a backend shim under the recording proxy lets the evaluation Submission be accepted
 * and its attempt run to delivery — so the proxy journals `submission-accepted` exactly as
 * production does — and then makes the `fetchDelivery` that would have produced the verdict hang
 * forever. The drive is abandoned mid-flight rather than being allowed to journal anything for
 * that leg, which is precisely the state a killed process leaves: an accepted evaluation
 * Submission in the backend's durable scope, a delivered attempt, and an open evaluation leg.
 * Nothing is hand-written into the journal.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseBenchmark, parseMatrix, parseRun } from "@jinn-network/benchmarking-records";
import { launchAndWatch } from "@jinn-network/benchmarking-run";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { armAdd } from "../operations/arms.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft, readDraftDocument } from "../operations/drafts.js";
import { initWorkspace } from "../operations/init.js";
import { runPublish } from "../operations/publish.js";
import { runCollect } from "../operations/run-collect.js";
import { runReport } from "../operations/report.js";
import { runResults } from "../operations/run-results.js";
import { runVerify } from "../operations/verify.js";
import { runLock } from "../operations/run-lock.js";
import { runQuote } from "../operations/run-quote.js";
import { runResume } from "../operations/run-launch.js";
import { sampleInit } from "../operations/sample.js";
import {
  createLocalVenue,
  EVALUATION_HARNESS_PIN,
  SOLVE_HARNESS_PINS,
  type LocalVenue,
} from "../venue/venue.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import { transition } from "../domain/lifecycle.js";
import { createRecordingProxy, driveCellEvents, type DriveDeps, type ProxiedBackend } from "./drive.js";
import {
  appendRunJournalEntry,
  readRunJournalEntries,
  type RunJournalEntry,
} from "./journal.js";
import { requireRunState, writeRunState } from "./state.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "eval-replay-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

/** Real wall clock — see `./run-resume.integration.test.ts`'s note on why a frozen clock breaks
 * the real supervisor's own deadline checks. */
function makeClock(): () => string {
  return () => new Date().toISOString();
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

async function setUpLockedDraft(clock: () => string, draftId: string): Promise<void> {
  expect(initWorkspace(contextFor(clock)).ok).toBe(true);
  expect(createDraft(contextFor(clock), { draftId, name: "Eval Replay" }).ok).toBe(true);
  expect((await sampleInit(contextFor(clock), { draftId })).ok).toBe(true);
  expect(armAdd(contextFor(clock), {
    draftId,
    armId: "baseline",
    pinning: { harness: SOLVE_HARNESS_PINS["prediction-v1-baseline"] },
  }).ok).toBe(true);
  expect(armAdd(contextFor(clock), {
    draftId,
    armId: "sample-uniform",
    pinning: { harness: SOLVE_HARNESS_PINS["sample-uniform"] },
  }).ok).toBe(true);
  expect((await runQuote(contextFor(clock), { draftId })).ok).toBe(true);
  expect(runLock(contextFor(clock), { draftId }).ok).toBe(true);
}

function isEvaluationSubmission(submissionBytes: Uint8Array): boolean {
  try {
    const doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(submissionBytes)) as {
      readonly requirements?: { readonly harness?: { readonly id?: string } };
    };
    return doc.requirements?.harness?.id === EVALUATION_HARNESS_PIN.id;
  } catch {
    return false;
  }
}

/**
 * Delegates every `ProxiedBackend` method to the real venue backend, except: once an evaluation
 * Submission has been accepted, the `fetchDelivery` that would have produced its verdict never
 * resolves. The attempt itself is allowed to run to delivery first, so the durable state this
 * leaves is exactly the canary's — delivered, unjournaled. The caller abandons the drive there,
 * so no journal entry is ever written for that evaluation leg.
 */
function hangBeforeFirstVerdict(
  backend: ProxiedBackend,
  armed: { value: boolean; resolveArmed?: () => void },
): ProxiedBackend {
  return {
    capabilities: () => backend.capabilities(),
    submit: async (taskBytes, submissionBytes, engagement) => {
      const ack = await backend.submit(taskBytes, submissionBytes, engagement);
      if (ack.accepted && isEvaluationSubmission(submissionBytes)) armed.value = true;
      return ack;
    },
    observe: (ref) => backend.observe(ref),
    ...(backend.watch === undefined ? {} : { watch: (ref, cursor) => backend.watch!(ref, cursor) }),
    ...(backend.cancel === undefined ? {} : { cancel: (a, r) => backend.cancel!(a, r) }),
    recover: (ref) => backend.recover(ref),
    deliveries: (attempt) => backend.deliveries(attempt),
    fetchDelivery: async (ref) => {
      if (!armed.value) return backend.fetchDelivery(ref);
      // The evaluation attempt has delivered durably; the verdict has not been journaled.
      armed.resolveArmed?.();
      return new Promise<Uint8Array>(() => {});
    },
    ...(backend.fetchArtifact === undefined
      ? {}
      : { fetchArtifact: (d) => backend.fetchArtifact!(d) }),
    ...(backend.pinningEvidenceForSubmission === undefined
      ? {}
      : { pinningEvidenceForSubmission: (ref) => backend.pinningEvidenceForSubmission!(ref) }),
    drain: () => backend.drain(),
  };
}

/**
 * Mirrors `runLaunch`'s own `run` closure (advance locked->running, stamp launchedAt, journal
 * "launched", boot the real venue, drive `launchAndWatch`) and abandons the drive the moment the
 * first evaluation Submission has been accepted.
 */
async function driveUntilEvaluationDelivered(clock: () => string, draftId: string): Promise<void> {
  const at = clock();
  const document = readDraftDocument(workspaceDir, draftId);
  const transitioned = transition("locked", "launch");
  if (!transitioned.ok) throw new Error("unreachable");
  atomicWriteFileSync(
    draftPath(workspaceDir, draftId),
    JSON.stringify({ ...document, state: transitioned.state, updatedAt: at }, null, 2),
  );

  const runState = requireRunState(workspaceDir, draftId);
  if (runState.runSha256 === undefined) throw new Error("unreachable");
  writeRunState(workspaceDir, draftId, { ...runState, launchedAt: at });
  appendRunJournalEntry(workspaceDir, draftId, { kind: "launched", at: clock() });

  const runRecord = parseRun(getSealedBytes(workspaceDir, runState.runSha256));
  if (document.spec.taskSet.kind !== "benchmark") throw new Error("unreachable: no benchmark");
  const benchRecord = parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256));

  const venue: LocalVenue = createLocalVenue({ workspaceDir, now: clock });
  const armed: { value: boolean; resolveArmed?: () => void } = { value: false };
  const evaluationDelivered = new Promise<void>((resolve) => {
    armed.resolveArmed = resolve;
  });
  try {
    const backend = createRecordingProxy(
      hangBeforeFirstVerdict(venue.backend, armed),
      { workspaceDir, draftId, liveClock: clock },
    );
    const driveDeps: DriveDeps = {
      workspaceDir,
      draftId,
      venue,
      backend,
      runSha256: runState.runSha256,
      owner: runState.owner,
      cellWindowMs: runRecord.policy.cellWindow,
      minVerdicts: runRecord.policy.evaluation?.minVerdicts ?? 1,
      liveClock: clock,
    };
    const events = launchAndWatch(benchRecord, runRecord, backend, {
      runDigest: `sha256:${runState.runSha256}`,
      taskBytesFor: (taskDigestHex) => getSealedBytes(workspaceDir, taskDigestHex),
      clock: { now: () => new Date(clock()) },
    });

    // The drive is ABANDONED, never awaited to completion: the injected hang holds it inside
    // `dispatchEvaluation` between the attempt's durable delivery and any journal write for it.
    const abandoned = driveCellEvents(driveDeps, events);
    abandoned.catch(() => undefined);
    await evaluationDelivered;
  } finally {
    await venue.shutdown();
  }
}

function submissionDoc(sha256: string): { readonly idempotencyKey?: string; readonly deadline?: string } {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(getSealedBytes(workspaceDir, sha256)),
  ) as { readonly idempotencyKey?: string; readonly deadline?: string };
}

describe("resume replays an accepted evaluation Submission byte-exactly", () => {
  test(
    "a process killed between evaluation acceptance and verdict journaling recovers its verdict",
    async () => {
      const clock = makeClock();
      const draftId = "draft-1";
      await setUpLockedDraft(clock, draftId);

      await driveUntilEvaluationDelivered(clock, draftId);

      // ── the interrupted state is exactly what a killed process leaves ───────────────────
      const interrupted = readRunJournalEntries(workspaceDir, draftId);
      const acceptedEvaluations = interrupted.filter(
        (entry): entry is Extract<RunJournalEntry, { kind: "submission-accepted" }> =>
          entry.kind === "submission-accepted" && entry.leg === "evaluation",
      );
      expect(
        acceptedEvaluations.length,
        "the interruption did not fire on an accepted evaluation Submission",
      ).toBe(1);
      const accepted = acceptedEvaluations[0]!;
      // No terminal was journaled for that leg — neither a verdict nor a could-not-grade (both
      // are `kind: "evaluation"`, discriminated by `evaluationTerminal`).
      expect(interrupted.some((entry) => entry.kind === "evaluation")).toBe(false);

      // ── resume through the PUBLIC operation, on a fresh venue ───────────────────────────
      // Capacity above 1 so the cells that were never dispatched before the crash are not
      // collateral of the crashed cell's still-live attempt slot — this test is about the
      // crashed cell's own evaluation replay, not about post-crash slot reclamation.
      const resumed = await runResume(contextFor(clock), { draftId, maxConcurrentCells: 4 });
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) throw new Error("unreachable");

      const final = readRunJournalEntries(workspaceDir, draftId);

      // The defect surfaces here: catch-up re-mints a LATER deadline under the same key, the
      // backend refuses with "already has different exact bytes", and the leg terminals
      // could-not-grade forever (could-not-grade completes the evalIndex, so no retry recovers).
      const couldNotGrade = final.filter(
        (entry): entry is Extract<RunJournalEntry, { kind: "evaluation" }> =>
          entry.kind === "evaluation" && entry.evaluationTerminal === "could-not-grade",
      );
      expect(
        couldNotGrade.map((entry) => entry.detail ?? ""),
        "an accepted evaluation Submission was re-minted with different bytes on resume",
      ).toEqual([]);

      // ── zero missing verdicts ───────────────────────────────────────────────────────────
      const collected = await runCollect(contextFor(clock), { draftId });
      expect(collected.ok).toBe(true);
      if (!collected.ok) throw new Error("unreachable");
      const matrix = parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));
      for (const cell of matrix.cells) {
        expect(cell.outcome, cell.cellKey).toBe("judged");
      }
      expect(matrix.completeness).toMatchObject({
        expected: matrix.cells.length,
        judged: matrix.cells.length,
        runOutcome: "complete",
      });

      // ── zero duplicate verdicts, and the replayed leg reused the EXACT accepted bytes ────
      const evaluationTerminals = final.filter(
        (entry): entry is Extract<RunJournalEntry, { kind: "evaluation" }> =>
          entry.kind === "evaluation",
      );
      const verdictKeys = evaluationTerminals.map(
        (entry) => `${entry.cellKey}::${entry.evalIndex ?? 1}`,
      );
      expect(new Set(verdictKeys).size).toBe(verdictKeys.length);
      // The crashed leg specifically: a real verdict, not a terminal excuse.
      const crashedLeg = evaluationTerminals.filter((entry) => entry.cellKey === accepted.cellKey);
      expect(crashedLeg).toHaveLength(1);
      expect(crashedLeg[0]?.verdictSha256).toBeDefined();

      const finalAcceptedEvaluations = final.filter(
        (entry): entry is Extract<RunJournalEntry, { kind: "submission-accepted" }> =>
          entry.kind === "submission-accepted" && entry.leg === "evaluation",
      );
      const byKey = new Map<string, string[]>();
      for (const entry of finalAcceptedEvaluations) {
        const key = submissionDoc(entry.submissionSha256).idempotencyKey ?? "";
        byKey.set(key, [...(byKey.get(key) ?? []), entry.submissionSha256]);
      }
      // Every evaluation idempotency key resolves to ONE set of exact bytes across the crash.
      for (const [key, digests] of byKey) {
        expect(new Set(digests).size, key).toBe(1);
      }
      // The specific leg that was accepted before the crash: same bytes, same deadline.
      const replayed = finalAcceptedEvaluations.filter(
        (entry) => entry.cellKey === accepted.cellKey && entry.dispatch === accepted.dispatch,
      );
      expect(replayed.every((entry) => entry.submissionSha256 === accepted.submissionSha256)).toBe(true);
      expect(submissionDoc(accepted.submissionSha256).deadline).toBeDefined();
    },
    240_000,
  );
  test(
    "a recovered run publishes: the replayed acceptance collapses to one submission edge",
    async () => {
      const clock = makeClock();
      const draftId = "draft-publish";
      await setUpLockedDraft(clock, draftId);

      await driveUntilEvaluationDelivered(clock, draftId);
      const resumed = await runResume(contextFor(clock), { draftId, maxConcurrentCells: 4 });
      expect(resumed.ok, JSON.stringify(resumed)).toBe(true);

      // The replay journals a SECOND submission-accepted entry for the same evaluation leg,
      // carrying the IDENTICAL submissionSha256 — append-only, and correct as a record of what
      // happened. Assembly must collapse the pair into one graph edge.
      const final = readRunJournalEntries(workspaceDir, draftId);
      const acceptedEvaluations = final.filter(
        (entry): entry is Extract<RunJournalEntry, { kind: "submission-accepted" }> =>
          entry.kind === "submission-accepted" && entry.leg === "evaluation",
      );
      const byCoordinate = new Map<string, string[]>();
      for (const entry of acceptedEvaluations) {
        const coordinate = `${entry.cellKey}:${entry.evalIndex ?? 1}:${entry.evaluationAttempt ?? 1}`;
        byCoordinate.set(coordinate, [...(byCoordinate.get(coordinate) ?? []), entry.submissionSha256]);
      }
      const replayedCoordinates = [...byCoordinate].filter(([, digests]) => digests.length > 1);
      expect(
        replayedCoordinates.length,
        "no evaluation coordinate was replayed — the interruption did not reproduce the defect",
      ).toBeGreaterThan(0);
      for (const [coordinate, digests] of replayedCoordinates) {
        // Same coordinate, byte-identical Submission: a replay, never a conflict.
        expect(new Set(digests).size, coordinate).toBe(1);
      }

      // ── collect -> results -> report -> verify -> publish, all required to succeed ───────
      const collected = await runCollect(contextFor(clock), { draftId });
      expect(collected.ok, JSON.stringify(collected)).toBe(true);
      expect(runResults(contextFor(clock), { draftId }).ok).toBe(true);
      const reported = await runReport(contextFor(clock), { draftId });
      expect(reported.ok, JSON.stringify(reported)).toBe(true);
      const verified = await runVerify(contextFor(clock), { draftId });
      expect(verified.ok, JSON.stringify(verified)).toBe(true);
      // Before the fix this refuses:
      //   record-integrity: verification.graph.evaluationSubmissions.coordinates contains
      //   duplicate identities
      const published = await runPublish(contextFor(clock), { draftId });
      expect(published.ok, JSON.stringify(published)).toBe(true);
    },
    240_000,
  );

  test(
    "two DIFFERENT Submissions on one evaluation coordinate still fail closed",
    async () => {
      const clock = makeClock();
      const draftId = "draft-conflict";
      await setUpLockedDraft(clock, draftId);

      await driveUntilEvaluationDelivered(clock, draftId);
      expect((await runResume(contextFor(clock), { draftId, maxConcurrentCells: 4 })).ok).toBe(true);

      const accepted = readRunJournalEntries(workspaceDir, draftId).find(
        (entry): entry is Extract<RunJournalEntry, { kind: "submission-accepted" }> =>
          entry.kind === "submission-accepted" && entry.leg === "evaluation",
      );
      expect(accepted).toBeDefined();
      if (accepted === undefined) throw new Error("unreachable");

      // A SECOND, genuinely different Submission for the same evaluator leg — the exact shape the
      // pre-fix re-mint produced: every binding (nonce, evalIndex, evaluator, task) identical,
      // only the wall-clock deadline moved. It passes every per-entry binding check, so it
      // reaches the coordinate collapse and must be refused there rather than collapsed.
      const original = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(getSealedBytes(workspaceDir, accepted.submissionSha256)),
      ) as Record<string, unknown>;
      const drifted = {
        ...original,
        deadline: new Date(Date.parse(String(original["deadline"])) + 60_000).toISOString(),
      };
      const driftedSha256 = putSealedBytes(workspaceDir, canonicalJsonBytes(drifted));
      expect(driftedSha256).not.toBe(accepted.submissionSha256);
      appendRunJournalEntry(workspaceDir, draftId, {
        ...accepted,
        at: clock(),
        submissionSha256: driftedSha256,
      });

      expect((await runCollect(contextFor(clock), { draftId })).ok).toBe(true);
      expect(runResults(contextFor(clock), { draftId }).ok).toBe(true);
      expect((await runReport(contextFor(clock), { draftId })).ok).toBe(true);
      const published = await runPublish(contextFor(clock), { draftId });
      expect(published.ok).toBe(false);
      if (published.ok) throw new Error("unreachable");
      expect(published.error.code).toBe("record-integrity");
      expect(published.error.detail).toContain("names two different Submissions");
    },
    240_000,
  );
});
