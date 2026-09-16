/**
 * Shared interruption fixture for the evaluation-resume integration tests
 * (`../run-resume-evaluation-{replay,midexecution,harvest}.integration.test.ts`).
 *
 * The technique (modelled on `../run-resume.integration.test.ts`, which interrupts the SOLVE leg):
 * a backend shim under the recording proxy lets the evaluation Submission be accepted and its
 * attempt run to delivery — so the proxy journals `submission-accepted` exactly as production
 * does — and then makes the `fetchDelivery` that would have produced the verdict hang forever.
 * The drive is abandoned mid-flight rather than being allowed to journal anything for that leg,
 * which is precisely the state a killed process leaves: an accepted evaluation Submission in the
 * backend's durable scope, a delivered attempt, and an open evaluation leg. Nothing is
 * hand-written into the journal.
 *
 * Each test keeps its own crash-point rewind and assertions; only this shared crash point lives
 * here.
 */

import { expect } from "vitest";
import { parseBenchmark, parseRun } from "@jinn-network/benchmarking-records";
import { launchAndWatch } from "@jinn-network/benchmarking-run";
import { armAdd } from "../../operations/arms.js";
import type { OperationContext } from "../../operations/context.js";
import { createDraft, readDraftDocument } from "../../operations/drafts.js";
import { initWorkspace } from "../../operations/init.js";
import { runLock } from "../../operations/run-lock.js";
import { runQuote } from "../../operations/run-quote.js";
import { sampleInit } from "../../operations/sample.js";
import {
  createLocalVenue,
  EVALUATION_HARNESS_PIN,
  SOLVE_HARNESS_PINS,
  type LocalVenue,
} from "../../venue/venue.js";
import { atomicWriteFileSync } from "../../fs/atomic.js";
import { draftPath } from "../../workspace/layout.js";
import { getSealedBytes } from "../../workspace/sealed-store.js";
import { transition } from "../../domain/lifecycle.js";
import { createRecordingProxy, driveCellEvents, type DriveDeps, type ProxiedBackend } from "../drive.js";
import { appendRunJournalEntry } from "../journal.js";
import { requireRunState, writeRunState } from "../state.js";

function contextFor(workspaceDir: string, clock: () => string): OperationContext {
  return { workspaceDir, principal: "sponsor-1", clock };
}

/** Initializes the workspace and takes a two-arm benchmark draft through quote and lock. */
export async function setUpLockedDraft(
  workspaceDir: string,
  clock: () => string,
  draftId: string,
  name: string,
): Promise<void> {
  const context = contextFor(workspaceDir, clock);
  expect(initWorkspace(context).ok).toBe(true);
  expect(createDraft(context, { draftId, name }).ok).toBe(true);
  expect((await sampleInit(context, { draftId })).ok).toBe(true);
  expect(armAdd(context, {
    draftId,
    armId: "baseline",
    pinning: { harness: SOLVE_HARNESS_PINS["prediction-v1-baseline"] },
  }).ok).toBe(true);
  expect(armAdd(context, {
    draftId,
    armId: "sample-uniform",
    pinning: { harness: SOLVE_HARNESS_PINS["sample-uniform"] },
  }).ok).toBe(true);
  expect((await runQuote(context, { draftId })).ok).toBe(true);
  expect(runLock(context, { draftId }).ok).toBe(true);
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
      // Let the real read complete first. That proves the evaluation attempt's Delivery is
      // durably readable THROUGH the backend before the drive is abandoned and the venue is shut
      // down, so the resumed backend rehydrates a settled `delivered` attempt rather than
      // whatever state a mid-finalize shutdown happened to leave. Without this the crash point
      // is "somewhere around the delivery write", which under load resolves differently and the
      // resumed leg terminals could-not-grade on attempt state instead of replaying.
      // The crash point itself is unchanged: still after acceptance and delivery, still before
      // any verdict reaches the journal.
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

/**
 * Mirrors `runLaunch`'s own `run` closure (advance locked->running, stamp launchedAt, journal
 * "launched", boot the real venue, drive `launchAndWatch`) and abandons the drive the moment the
 * first evaluation Submission has been accepted and its Delivery is durably readable.
 */
export async function driveUntilEvaluationDelivered(
  workspaceDir: string,
  clock: () => string,
  draftId: string,
): Promise<void> {
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
