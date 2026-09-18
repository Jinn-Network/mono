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
 * The interruption technique is the shared abandonment shim in
 * `./testing/evaluation-resume-abandonment.ts`: the evaluation Submission is accepted and its
 * attempt runs to delivery, then the drive is abandoned before any verdict reaches the journal.
 * Nothing is hand-written into the journal.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseMatrix } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import type { OperationContext } from "../operations/context.js";
import { runPublish } from "../operations/publish.js";
import { runCollect } from "../operations/run-collect.js";
import { runReport } from "../operations/report.js";
import { runResults } from "../operations/run-results.js";
import { runVerify } from "../operations/verify.js";
import { runResume } from "../operations/run-launch.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import { appendRunJournalEntry, readRunJournalEntries, type RunJournalEntry } from "./journal.js";
import {
  driveUntilEvaluationDelivered,
  setUpLockedDraft,
} from "./testing/evaluation-resume-abandonment.js";

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
      await setUpLockedDraft(workspaceDir, clock, draftId, "Eval Replay");

      await driveUntilEvaluationDelivered(workspaceDir, clock, draftId);

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
      // A retryable failure is a DIFFERENT crash shape (the leg failed rather than being
      // abandoned mid-flight). Catch it here, where the message is unambiguous.
      expect(
        interrupted.filter((entry) => entry.kind === "evaluation-retryable-failure"),
        "the interruption landed on a failed evaluation leg, not an abandoned one",
      ).toEqual([]);

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
        "the recovered evaluation leg terminaled could-not-grade instead of replaying its "
        + `accepted Submission byte-exactly: ${JSON.stringify(couldNotGrade.map((entry) => entry.detail))}`,
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
      await setUpLockedDraft(workspaceDir, clock, draftId, "Eval Replay");

      await driveUntilEvaluationDelivered(workspaceDir, clock, draftId);
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
      await setUpLockedDraft(workspaceDir, clock, draftId, "Eval Replay");

      await driveUntilEvaluationDelivered(workspaceDir, clock, draftId);
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
