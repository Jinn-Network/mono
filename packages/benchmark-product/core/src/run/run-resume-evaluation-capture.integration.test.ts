/**
 * Resume must replay an evaluation Submission the backend ACCEPTED but whose acceptance never
 * reached the run journal (issue #3237).
 *
 * `./run-resume-evaluation-replay.integration.test.ts` (#3068) closed the window where the
 * `submission-accepted` entry *was* journaled and the leg's verdict was not;
 * `./run-resume-evaluation-midexecution.integration.test.ts` (#3069) closed the window where the
 * attempt behind that entry was still nonterminal. Both fixes read the same map, and that map is
 * built solely from `submission-accepted` entries — which `./drive.js`'s recording proxy appends
 * only AFTER `backend.submit` returns. One journal append earlier, the window is open again:
 *
 * - the backend has durably accepted the evaluation Submission (its `submissionsByScope` scope
 *   rehydrates from the durable state root at startup);
 * - nothing in the run journal names it, so `runResume`'s `journaledEvaluationSubmissions` has no
 *   entry for `(cellKey, dispatch, evalIndex, evaluationAttempt)`;
 * - `dispatchEvaluation` therefore seals FRESH bytes, whose `deadline` is
 *   `liveClock() + cellWindow`, under the SAME idempotency key;
 * - the backend refuses ("already has different exact bytes in this requester/backend scope") and
 *   the leg terminals could-not-grade — permanently, because could-not-grade writes the evalIndex
 *   into `completedEvalIndexes` (`./journal.js`), so no `maxInfrastructureRetries` setting
 *   recovers it.
 *
 * The cure is the solve leg's own: a PRE-SUBMIT capture (`evaluation-submission-captured`) that
 * seals the exact bytes before they are offered to the backend, so the replay map covers
 * backend-accepted-but-unjournaled legs the same way `submission-captured` covers the solve leg.
 *
 * The interruption technique: a backend shim UNDER the recording proxy lets the real
 * `backend.submit` accept the evaluation Submission and lets its attempt settle to `delivered`,
 * then never returns. The recording proxy is thus held inside its own `await backend.submit(...)`
 * and never reaches the `appendRunJournalEntry` on the next line — precisely the state a kill
 * between acceptance and journaling leaves. Nothing is hand-written into the run journal.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
  workspaceDir = mkdtempSync(join(tmpdir(), "eval-capture-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

/** Real wall clock — see `./run-resume.integration.test.ts` on why a frozen clock breaks the real
 * supervisor's own deadline checks. */
function makeClock(): () => string {
  return () => new Date().toISOString();
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

async function setUpLockedDraft(clock: () => string, draftId: string): Promise<void> {
  expect(initWorkspace(contextFor(clock)).ok).toBe(true);
  expect(createDraft(contextFor(clock), { draftId, name: "Eval Capture" }).ok).toBe(true);
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

/** The last two `:`-delimited segments of an evaluation nonce are `<cellKey>:<dispatch>` — see
 * `./drive.ts`'s `cellKeyAndDispatchFromNonce`. */
function evaluationCoordinate(submissionBytes: Uint8Array): {
  readonly cellKey: string;
  readonly dispatch: number;
} {
  const doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(submissionBytes)) as {
    readonly nonce?: unknown;
  };
  if (typeof doc.nonce !== "string") throw new Error("evaluation Submission carries no nonce");
  const parts = doc.nonce.split(":");
  const cellKey = parts.at(-2);
  const dispatch = Number(parts.at(-1));
  if (cellKey === undefined || !Number.isInteger(dispatch)) {
    throw new Error(`unparseable evaluation nonce "${doc.nonce}"`);
  }
  return { cellKey, dispatch };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Interruption {
  hung: boolean;
  submissionBytes?: Uint8Array;
  resolveHung?: () => void;
}

/**
 * Delegates every `ProxiedBackend` method to the real venue backend, except: the FIRST evaluation
 * Submission the backend accepts is allowed to run its attempt to `delivered` and then `submit`
 * never returns. The recording proxy that wraps this shim is therefore suspended inside its own
 * `await backend.submit(...)` and never appends the `submission-accepted` entry on the line after
 * it — the exact window issue #3237 names.
 */
function hangAfterEvaluationAcceptance(
  backend: ProxiedBackend,
  interruption: Interruption,
): ProxiedBackend {
  return {
    capabilities: () => backend.capabilities(),
    submit: async (taskBytes, submissionBytes, engagement) => {
      const arm = !interruption.hung && isEvaluationSubmission(submissionBytes);
      if (arm) interruption.hung = true;
      const ack = await backend.submit(taskBytes, submissionBytes, engagement);
      if (!arm || !ack.accepted) {
        if (arm) interruption.hung = false;
        return ack;
      }
      // Acceptance is now durable in the backend's requester/backend scope. Let the attempt
      // settle before abandoning, so the resumed process rehydrates a `delivered` attempt rather
      // than whatever state a mid-execution shutdown happened to leave — that mid-execution
      // window is a DIFFERENT one, already covered by
      // `./run-resume-evaluation-midexecution.integration.test.ts`.
      for (let poll = 0; poll < 1_200; poll += 1) {
        const snapshot = await backend.observe(ack.submission);
        if (snapshot.descriptor.derived.state === "delivered") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      interruption.submissionBytes = submissionBytes;
      interruption.resolveHung?.();
      // Never returns: the recording proxy's journal append is unreachable, exactly as it is for
      // a process killed here.
      return new Promise(() => {});
    },
    observe: (ref) => backend.observe(ref),
    ...(backend.watch === undefined ? {} : { watch: (ref, cursor) => backend.watch!(ref, cursor) }),
    ...(backend.cancel === undefined ? {} : { cancel: (a, r) => backend.cancel!(a, r) }),
    recover: (ref) => backend.recover(ref),
    deliveries: (attempt) => backend.deliveries(attempt),
    fetchDelivery: (ref) => backend.fetchDelivery(ref),
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
 * first evaluation Submission has been accepted and its attempt has delivered — with nothing
 * journaled for that leg.
 */
async function driveUntilEvaluationAcceptedUnjournaled(
  clock: () => string,
  draftId: string,
): Promise<Interruption> {
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
  const benchRecord = parseBenchmark(
    getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256),
  );

  const venue: LocalVenue = createLocalVenue({ workspaceDir, now: clock });
  const interruption: Interruption = { hung: false };
  const hung = new Promise<void>((resolve) => {
    interruption.resolveHung = resolve;
  });
  try {
    const backend = createRecordingProxy(
      hangAfterEvaluationAcceptance(venue.backend, interruption),
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

    // The drive is ABANDONED, never awaited to completion: the injected hang holds it inside the
    // recording proxy's `submit`, after backend acceptance and before the journal append.
    const abandoned = driveCellEvents(driveDeps, events);
    abandoned.catch(() => undefined);
    await hung;
  } finally {
    await venue.shutdown();
  }
  return interruption;
}

describe("resume replays an evaluation Submission accepted but not yet journaled", () => {
  test(
    "a kill between backend acceptance and the journal append still recovers the verdict",
    async () => {
      const clock = makeClock();
      const draftId = "draft-1";
      await setUpLockedDraft(clock, draftId);

      const interruption = await driveUntilEvaluationAcceptedUnjournaled(clock, draftId);
      const acceptedBytes = interruption.submissionBytes;
      expect(acceptedBytes, "the interruption never fired on an evaluation Submission").toBeDefined();
      if (acceptedBytes === undefined) throw new Error("unreachable");
      const coordinate = evaluationCoordinate(acceptedBytes);
      const acceptedSha256 = sha256Hex(acceptedBytes);

      // ── the interrupted state is exactly what this window's kill leaves ─────────────────
      const interrupted = readRunJournalEntries(workspaceDir, draftId);
      // The defining fact: the backend accepted it, and NOTHING in the journal records that.
      expect(
        interrupted.filter(
          (entry): entry is Extract<RunJournalEntry, { kind: "submission-accepted" }> =>
            entry.kind === "submission-accepted"
            && entry.leg === "evaluation"
            && entry.cellKey === coordinate.cellKey,
        ),
        "the interruption did not land before the `submission-accepted` append",
      ).toEqual([]);
      // No terminal was journaled for that leg either — neither a verdict nor a could-not-grade
      // (both are `kind: "evaluation"`, discriminated by `evaluationTerminal`).
      expect(
        interrupted.some(
          (entry) => entry.kind === "evaluation" && entry.cellKey === coordinate.cellKey,
        ),
      ).toBe(false);
      expect(
        interrupted.filter(
          (entry) =>
            entry.kind === "evaluation-retryable-failure" && entry.cellKey === coordinate.cellKey,
        ),
        "the interruption landed on a failed evaluation leg, not an abandoned one",
      ).toEqual([]);

      // ── resume through the PUBLIC operation, on a fresh venue ───────────────────────────
      const resumed = await runResume(contextFor(clock), { draftId, maxConcurrentCells: 4 });
      expect(resumed.ok, JSON.stringify(resumed)).toBe(true);

      const final = readRunJournalEntries(workspaceDir, draftId);

      // The defect surfaces here: with no journaled acceptance to replay, catch-up re-mints a
      // later deadline under the same idempotency key, the backend refuses, and the leg terminals
      // could-not-grade forever.
      const couldNotGrade = final.filter(
        (entry): entry is Extract<RunJournalEntry, { kind: "evaluation" }> =>
          entry.kind === "evaluation" && entry.evaluationTerminal === "could-not-grade",
      );
      expect(
        couldNotGrade.map((entry) => `${entry.cellKey}: ${entry.detail ?? ""}`),
        "an evaluation leg terminaled could-not-grade instead of replaying the Submission the "
        + "backend had already accepted",
      ).toEqual([]);

      // ── the replayed leg reused the EXACT bytes the backend accepted ────────────────────
      const replayedAcceptance = final.filter(
        (entry): entry is Extract<RunJournalEntry, { kind: "submission-accepted" }> =>
          entry.kind === "submission-accepted"
          && entry.leg === "evaluation"
          && entry.cellKey === coordinate.cellKey
          && entry.dispatch === coordinate.dispatch,
      );
      expect(replayedAcceptance.length).toBeGreaterThan(0);
      expect(
        replayedAcceptance.map((entry) => entry.submissionSha256),
        "the resumed leg sealed fresh bytes instead of replaying the accepted ones",
      ).toEqual(replayedAcceptance.map(() => acceptedSha256));

      // ── a real verdict for the interrupted cell, and no duplicates ──────────────────────
      const evaluationTerminals = final.filter(
        (entry): entry is Extract<RunJournalEntry, { kind: "evaluation" }> =>
          entry.kind === "evaluation",
      );
      const verdictKeys = evaluationTerminals.map(
        (entry) => `${entry.cellKey}::${entry.evalIndex ?? 1}`,
      );
      expect(new Set(verdictKeys).size).toBe(verdictKeys.length);
      const crashedLeg = evaluationTerminals.filter(
        (entry) => entry.cellKey === coordinate.cellKey,
      );
      expect(crashedLeg).toHaveLength(1);
      expect(crashedLeg[0]?.verdictSha256).toBeDefined();

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
    },
    240_000,
  );
});
