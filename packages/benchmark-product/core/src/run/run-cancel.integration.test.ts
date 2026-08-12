/**
 * BP-22 acceptance proof on the REAL local venue. A public `runLaunch` drives the actual
 * subprocess backend while its progress callback starts the public, authority-gated `runCancel`
 * operation after the first solve dispatch has reached the journal. The first cancel call writes
 * the durable marker and returns `requested` because the live venue owns the state-root writer;
 * launch sees that marker before the next cell, drains, and exits. A second public cancel call
 * then finalizes the cancelled Matrix. No in-memory backend participates anywhere in this file.
 *
 * The same test continues through results, report, claim, and verify so cancellation cannot be
 * implemented as a display-only flag: every expected cell is sealed, undispatched work is
 * `expired` with `dispatches: 0`, Wilson denominators include only the judged cell(s), the claim
 * carries the adverse completeness/attrition verbatim, and the full verification machinery
 * accepts the result.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseMatrix } from "@jinn-network/benchmarking-records";
import { armAdd } from "../operations/arms.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft } from "../operations/drafts.js";
import { initWorkspace } from "../operations/init.js";
import { runCancel } from "../operations/run-cancel.js";
import { runCollect } from "../operations/run-collect.js";
import { runLaunch } from "../operations/run-launch.js";
import { runLock } from "../operations/run-lock.js";
import { runQuote } from "../operations/run-quote.js";
import { runReport } from "../operations/report.js";
import { runResults } from "../operations/run-results.js";
import { runVerify } from "../operations/verify.js";
import { sampleInit } from "../operations/sample.js";
import { createLocalVenue, SOLVE_HARNESS_PINS } from "../venue/venue.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { readRunJournalEntries } from "./journal.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp22-real-cancel-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function clock(): string {
  return new Date().toISOString();
}

function contextFor(principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

async function setUpLockedDraft(
  draftId: string,
  pins: readonly [
    (typeof SOLVE_HARNESS_PINS)[keyof typeof SOLVE_HARNESS_PINS],
    (typeof SOLVE_HARNESS_PINS)[keyof typeof SOLVE_HARNESS_PINS],
  ] = [SOLVE_HARNESS_PINS["prediction-v1-baseline"], SOLVE_HARNESS_PINS["sample-uniform"]],
): Promise<void> {
  expect(initWorkspace(contextFor()).ok).toBe(true);
  expect(createDraft(contextFor(), { draftId, name: "Real Cancel" }).ok).toBe(true);
  const sample = await sampleInit(contextFor(), { draftId });
  expect(sample.ok).toBe(true);
  expect(armAdd(contextFor(), {
    draftId,
    armId: "baseline",
    pinning: { harness: pins[0] },
  }).ok).toBe(true);
  expect(armAdd(contextFor(), {
    draftId,
    armId: "sample-uniform",
    pinning: { harness: pins[1] },
  }).ok).toBe(true);
  expect((await runQuote(contextFor(), { draftId })).ok).toBe(true);
  expect(runLock(contextFor(), { draftId }).ok).toBe(true);
}

describe("cancel mid-run on the real local venue (BP-22)", () => {
  test(
    "drains, accounts every cell, excludes infra attrition from scores, reports an honest claim, and verifies",
    async () => {
      const draftId = "draft-1";
      await setUpLockedDraft(draftId);

      let firstCancelPromise: ReturnType<typeof runCancel> | undefined;
      const launched = await runLaunch(contextFor(), { draftId }, {
        onProgress(line) {
          if (firstCancelPromise === undefined && line.endsWith(" dispatch")) {
            firstCancelPromise = runCancel(contextFor(), { draftId });
          }
        },
      });
      expect(launched.ok).toBe(true);
      expect(firstCancelPromise, "the real launch never emitted a solve dispatch progress event").toBeDefined();
      if (firstCancelPromise === undefined) throw new Error("unreachable");

      const requested = await firstCancelPromise;
      expect(requested.ok, JSON.stringify(requested)).toBe(true);
      if (!requested.ok) throw new Error("unreachable");
      expect(requested.result.phase).toBe("requested");

      const cancelled = await runCancel(contextFor(), { draftId });
      expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);
      if (!cancelled.ok || cancelled.result.phase !== "cancelled") throw new Error("unreachable");

      const matrix = parseMatrix(getSealedBytes(workspaceDir, cancelled.result.matrixSha256));
      expect(matrix.completeness).toMatchObject({ expected: 6, judged: 1, runOutcome: "cancelled" });
      expect(matrix.cells).toHaveLength(6);
      const judged = matrix.cells.filter((cell) => cell.outcome === "judged");
      const expired = matrix.cells.filter((cell) => cell.outcome === "expired");
      expect(judged).toHaveLength(1);
      expect(expired).toHaveLength(5);
      for (const cell of expired) {
        expect(cell, cell.cellKey).toMatchObject({ dispatches: 0, outcome: "expired" });
      }

      const journal = readRunJournalEntries(workspaceDir, draftId);
      expect(journal.filter((entry) => entry.kind === "cancel-requested")).toHaveLength(1);
      expect(journal.filter((entry) => entry.kind === "closed")).toHaveLength(1);

      const results = runResults(contextFor(), { draftId });
      expect(results.ok).toBe(true);
      if (!results.ok) throw new Error("unreachable");
      expect(results.result.runOutcome).toBe("cancelled");
      expect(results.result.completeness).toEqual(matrix.completeness);
      for (const cell of results.result.cells.filter((candidate) => candidate.outcome === "expired")) {
        expect(cell.failure).toMatchObject({ kind: "cancelled", detail: "drain-to-boundary" });
      }

      const reported = await runReport(contextFor(), { draftId });
      expect(reported.ok, JSON.stringify(reported)).toBe(true);
      if (!reported.ok) throw new Error("unreachable");
      const claim = reported.result.claimPackage;
      expect(claim.completeness).toEqual(matrix.completeness);
      expect(claim.attrition).toEqual(matrix.attrition);

      // The platform aggregate is the denominator authority: only judged cells contribute to
      // the headline's n. Expired cancellation-drain cells remain in completeness/attrition but
      // never become implicit failures in a score denominator.
      // P4b Task 5: `headline` is optional on ClaimPackage; this lifecycle is wilson-only.
      expect(claim.headline).toBeDefined();
      for (const arm of Object.keys(matrix.attrition.perArm)) {
        const judgedForArm = matrix.cells.filter((cell) => cell.armId === arm && cell.outcome === "judged").length;
        expect(claim.headline?.[arm]?.n, arm).toBe(judgedForArm);
      }
      expect(Object.values(claim.headline!).reduce((sum, arm) => sum + arm.n, 0)).toBe(1);

      const verified = await runVerify(contextFor(), { draftId });
      expect(verified.ok, JSON.stringify(verified)).toBe(true);
      if (!verified.ok) throw new Error("unreachable");
      expect(verified.result.checks).toEqual(expect.arrayContaining([
        "matrix-rederivation",
        "report-verification",
        "claim-consistency",
      ]));
    },
    240_000,
  );

  test(
    "cancels a deliberately slow real subprocess while nonterminal and waits for the backend kill terminal",
    async () => {
      const draftId = "draft-slow";
      await setUpLockedDraft(draftId);

      let nonterminalAttempt: string | undefined;
      let requestedPromise: ReturnType<typeof runCancel> | undefined;
      const launched = await runLaunch(contextFor(), { draftId }, {
        createVenue: (options) => createLocalVenue({
          ...options,
          solveStartDelayMsForTesting: 30_000,
        }),
        onSolveAttemptNonterminal(attempt) {
          if (requestedPromise !== undefined) return;
          nonterminalAttempt = attempt;
          requestedPromise = runCancel(contextFor(), { draftId });
        },
      });
      expect(launched.ok, JSON.stringify(launched)).toBe(true);
      expect(nonterminalAttempt, "no real solve attempt was observed while nonterminal").toBeDefined();
      expect(requestedPromise, "nonterminal observation did not trigger cancel").toBeDefined();
      if (nonterminalAttempt === undefined || requestedPromise === undefined) throw new Error("unreachable");

      const requested = await requestedPromise;
      expect(requested.ok, JSON.stringify(requested)).toBe(true);
      if (!requested.ok) throw new Error("unreachable");
      expect(requested.result).toMatchObject({ phase: "requested", reason: "venue-contention" });

      // Inspect the real backend's durable attempt journal. This proves backend.cancel reached
      // the native shim, a signal ended the deliberately slow subprocess, harvest completed,
      // and the attempt terminalized cancelled before launch returned.
      const attemptJournalPath = join(
        workspaceDir,
        "venue",
        "backend-state",
        "attempts",
        nonterminalAttempt.slice("urn:uuid:".length),
        "meta",
        "journal.jsonl",
      );
      const attemptEvents = readFileSync(attemptJournalPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; details: Record<string, unknown> });
      expect(attemptEvents.filter((event) => event.type === "cancel-requested")).toHaveLength(1);
      expect(attemptEvents.find((event) => event.type === "exec-finished")?.details["termSignal"])
        .toMatch(/^SIG(?:TERM|KILL)$/u);
      expect(attemptEvents.find((event) => event.type === "attempt-terminal")?.details["state"])
        .toBe("cancelled");

      const cancelled = await runCancel(contextFor(), { draftId });
      expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);
      if (!cancelled.ok || cancelled.result.phase !== "cancelled") throw new Error("unreachable");
      const matrix = parseMatrix(getSealedBytes(workspaceDir, cancelled.result.matrixSha256));
      expect(matrix.completeness).toMatchObject({ expected: 6, judged: 0, runOutcome: "cancelled" });
      expect(matrix.cells.filter((cell) => cell.dispatches === 1)).toHaveLength(1);
      expect(matrix.cells.filter((cell) => cell.dispatches === 0)).toHaveLength(5);
      const verified = await runVerify(contextFor(), { draftId });
      expect(verified.ok, JSON.stringify(verified)).toBe(true);
    },
    240_000,
  );

  test(
    "serializes a natural collect racing cancel so a complete Matrix can never masquerade as cancelled",
    async () => {
      const draftId = "draft-collect-race";
      await setUpLockedDraft(draftId);
      const launched = await runLaunch(contextFor(), { draftId });
      expect(launched.ok, JSON.stringify(launched)).toBe(true);

      // Evaluation order starts collect first; it reaches its first assembly await after reading
      // the absent marker, exactly reproducing the review's TOCTOU window before cancel starts.
      const [collected, cancelled] = await Promise.all([
        runCollect(contextFor(), { draftId }),
        runCancel(contextFor(), { draftId }),
      ]);
      expect(collected.ok, JSON.stringify(collected)).toBe(true);
      expect(cancelled.ok).toBe(false);
      if (cancelled.ok) throw new Error("unreachable");
      expect(cancelled.error.code).toBe("conflict");

      const retry = await runCancel(contextFor(), { draftId });
      expect(retry.ok).toBe(false);
      if (retry.ok) throw new Error("unreachable");
      expect(retry.error.code).toBe("illegal-transition");

      const verified = await runVerify(contextFor(), { draftId });
      expect(verified.ok, JSON.stringify(verified)).toBe(true);
      if (!verified.ok) throw new Error("unreachable");
      expect(verified.result.checks).toEqual(["matrix-rederivation"]);
    },
    240_000,
  );
});
