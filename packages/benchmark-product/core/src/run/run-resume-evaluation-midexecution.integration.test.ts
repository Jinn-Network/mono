/**
 * Resume must reconcile an evaluation attempt killed MID-EXECUTION, the same way the solve leg
 * does (`../operations/run-launch.js`'s `for (const cell of outstanding)` loop calling
 * `backend.recover(...)` before `resumeRun`).
 *
 * `./run-resume-evaluation-replay.integration.test.ts` (issue #3068) closed the window where the
 * backend had ACCEPTED an evaluation Submission and the attempt had already reached a durable
 * terminal. The window left open is a kill while the attempt is still nonterminal:
 *
 * - the replayed bytes make `submit` idempotent, so it returns the ORIGINAL `ack.submission` —
 *   an attempt that is nonterminal and, in the fresh process, owned by no in-process worker;
 * - `deps.backend.drain()` is then a no-op (`drainFixedPoint` sees no workers, no inflight);
 * - `observe(ack.submission)` reports the nonterminal state the attempt froze at, so
 *   `dispatchEvaluation` takes its `derived.state !== "delivered"` branch;
 * - `retryableFailureFromSnapshot` finds no `attempt-terminal` observation and returns undefined,
 *   so `journalEvaluationFailure` falls through to `journalCouldNotGrade` — NON-retryable, and
 *   could-not-grade writes the evalIndex into `completedEvalIndexes` (`./journal.js`), so no
 *   retry setting recovers it. Permanent verdict loss.
 *
 * The cure is `backend.recover(submissionUri)` inside `dispatchEvaluation`, before `submit`, and
 * only for a replayed leg — see the comment at that call site for why the seam cannot be the
 * solve leg's (`runResume`, before any evaluation cell is prepared).
 *
 * The interruption technique: the abandonment shim of the #3068 test leaves the evaluation
 * Submission accepted, its Delivery durably checkpointed, and no journal entry for that leg.
 * A kill an instant EARLIER — before the backend appends the attempt's own `attempt-terminal`
 * event — is then reproduced by rewinding that attempt's backend journal past the terminal, the
 * crash simulation `packages/task-execution/backend-local/assembly/src/backend.recovery.test.ts`
 * uses (`replaceJournal`). Nothing is hand-written into the RUN journal: the run journal carries
 * only what the recording proxy wrote while the real drive ran.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseBenchmark, parseMatrix, parseRun } from "@jinn-network/benchmarking-records";
import { launchAndWatch } from "@jinn-network/benchmarking-run";
import { armAdd } from "../operations/arms.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft, readDraftDocument } from "../operations/drafts.js";
import { initWorkspace } from "../operations/init.js";
import { runCollect } from "../operations/run-collect.js";
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
import { getSealedBytes } from "../workspace/sealed-store.js";
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
  workspaceDir = mkdtempSync(join(tmpdir(), "eval-midexec-"));
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
  expect(createDraft(contextFor(clock), { draftId, name: "Eval Mid-Execution" }).ok).toBe(true);
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

/** See `./run-resume-evaluation-replay.integration.test.ts` — identical abandonment shim: the
 * evaluation attempt's Delivery is proven durably readable through the backend, then the
 * `fetchDelivery` that would have produced the verdict never resolves. */
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
      await backend.fetchDelivery(ref);
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

/** Mirrors `runLaunch`'s own `run` closure and abandons the drive the moment the first evaluation
 * Submission has been accepted and its Delivery is durably readable. */
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

    const abandoned = driveCellEvents(driveDeps, events);
    abandoned.catch(() => undefined);
    await evaluationDelivered;
  } finally {
    await venue.shutdown();
  }
}

interface AttemptJournalEvent {
  readonly type: string;
}

/**
 * Rewinds the backend attempt that carries `submissionSha256` past its `attempt-terminal` event —
 * the durable state a kill lands in when the harness has checkpointed its Delivery but the
 * backend has not yet appended the attempt's terminal. Returns the attempt's journal path.
 */
function rewindAttemptPastTerminal(submissionSha256: string): string {
  const stateRoot = join(workspaceDir, "venue", "backend-state");
  const submissionsRoot = join(stateRoot, "submissions");
  for (const entry of readdirSync(submissionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(submissionsRoot, entry.name);
    const bytes = readFileSync(join(directory, "submission.sealed"));
    if (createHash("sha256").update(bytes).digest("hex") !== submissionSha256) continue;
    const metadata = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8")) as {
      readonly attempt?: { readonly attempt?: string } | string;
    };
    const attemptUri = typeof metadata.attempt === "string"
      ? metadata.attempt
      : metadata.attempt?.attempt;
    if (typeof attemptUri !== "string") {
      throw new Error(`durable submission ${submissionSha256} names no attempt`);
    }
    const journalPath = join(
      stateRoot,
      "attempts",
      attemptUri.slice("urn:uuid:".length),
      "meta",
      "journal.jsonl",
    );
    const events = readFileSync(journalPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AttemptJournalEvent);
    expect(
      events.some((event) => event.type === "attempt-terminal"),
      "the evaluation attempt never reached a terminal, so there is nothing to rewind past",
    ).toBe(true);
    const rewound = events.filter((event) => event.type !== "attempt-terminal");
    writeFileSync(journalPath, `${rewound.map((event) => JSON.stringify(event)).join("\n")}\n`);
    return journalPath;
  }
  throw new Error(`no durable submission matches ${submissionSha256}`);
}

describe("resume reconciles an evaluation attempt killed mid-execution", () => {
  test(
    "a nonterminal evaluation attempt is recovered instead of terminaled could-not-grade",
    async () => {
      const clock = makeClock();
      const draftId = "draft-1";
      await setUpLockedDraft(clock, draftId);

      await driveUntilEvaluationDelivered(clock, draftId);

      // ── the interrupted state is exactly what a mid-execution kill leaves ───────────────
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
      // No terminal was journaled for that leg — neither a verdict nor a could-not-grade.
      expect(interrupted.some((entry) => entry.kind === "evaluation")).toBe(false);
      expect(
        interrupted.filter((entry) => entry.kind === "evaluation-retryable-failure"),
        "the interruption landed on a failed evaluation leg, not an abandoned one",
      ).toEqual([]);

      const journalPath = rewindAttemptPastTerminal(accepted.submissionSha256);
      expect(readFileSync(journalPath, "utf8")).not.toContain("attempt-terminal");

      // ── resume through the PUBLIC operation, on a fresh venue ───────────────────────────
      // Capacity headroom of one slot above the outstanding cell count: the interrupted
      // evaluation attempt rehydrates NONTERMINAL, so the resumed backend counts it live and
      // holds its capacity slot until that leg's own reconciliation settles it. Without the
      // headroom an unrelated cell loses its dispatch to "local backend capacity exhausted" and
      // expires — collateral of the crash, not the verdict-recovery question under test.
      // That slot-holding is tracked as its own defect (issue #3192): reconciliation cannot
      // move earlier than the evaluation cell's own preparation, so the slot is only
      // released once this leg reaches `dispatchEvaluation`.
      const resumed = await runResume(contextFor(clock), { draftId, maxConcurrentCells: 9 });
      expect(resumed.ok, JSON.stringify(resumed)).toBe(true);

      const final = readRunJournalEntries(workspaceDir, draftId);

      // The defect surfaces here: without reconciliation the replayed leg observes a nonterminal
      // attempt with no in-process worker, classifies nothing as retryable, and terminals
      // could-not-grade — which completes the evalIndex, so no retry ever recovers it.
      const couldNotGrade = final.filter(
        (entry): entry is Extract<RunJournalEntry, { kind: "evaluation" }> =>
          entry.kind === "evaluation" && entry.evaluationTerminal === "could-not-grade",
      );
      expect(
        couldNotGrade.map((entry) => entry.detail ?? ""),
        "the recovered evaluation leg terminaled could-not-grade instead of being reconciled: "
        + JSON.stringify(couldNotGrade.map((entry) => entry.detail)),
      ).toEqual([]);

      // ── zero missing verdicts ───────────────────────────────────────────────────────────
      const collected = await runCollect(contextFor(clock), { draftId });
      expect(collected.ok, JSON.stringify(collected)).toBe(true);
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

      // ── zero duplicate verdicts, and the reconciled leg carries a real verdict ───────────
      const evaluationTerminals = final.filter(
        (entry): entry is Extract<RunJournalEntry, { kind: "evaluation" }> =>
          entry.kind === "evaluation",
      );
      const verdictKeys = evaluationTerminals.map(
        (entry) => `${entry.cellKey}::${entry.evalIndex ?? 1}`,
      );
      expect(new Set(verdictKeys).size).toBe(verdictKeys.length);
      const crashedLeg = evaluationTerminals.filter((entry) => entry.cellKey === accepted.cellKey);
      expect(crashedLeg).toHaveLength(1);
      expect(crashedLeg[0]?.verdictSha256).toBeDefined();
    },
    240_000,
  );
});
