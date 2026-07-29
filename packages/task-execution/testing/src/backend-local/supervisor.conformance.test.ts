// SPDX-License-Identifier: Apache-2.0

import { foldAttemptRecord, reconcileAttempt, runCancellationLadder } from "@jinn-network/task-execution-supervisor";
import { assertCompleteSupervisorFixtureOutcome, describeAttemptSupervisorContract } from "./supervisor-contract.js";
import { expect, it } from "vitest";

type FixtureEvent = { readonly torn?: boolean; readonly attemptId?: string; readonly seq?: number; readonly type?: string; readonly time?: string; readonly details?: Readonly<Record<string, unknown>>; readonly rejectedAtAppend?: boolean };

function events(input: readonly unknown[]): Parameters<typeof foldAttemptRecord>[0] {
  return (input as readonly FixtureEvent[]).filter((entry) => entry.torn !== true).map((entry) => ({
    attemptId: entry.attemptId ?? "urn:uuid:00000000-0000-0000-0000-000000000401",
    seq: entry.seq ?? 1,
    type: (entry.type ?? "attempt-engaged") as Parameters<typeof foldAttemptRecord>[0][number]["type"],
    time: entry.time ?? "2026-07-28T00:00:00.000Z",
    details: entry.details ?? {},
    ...(entry.rejectedAtAppend === undefined ? {} : { rejectedAtAppend: entry.rejectedAtAppend }),
  }));
}

describeAttemptSupervisorContract(() => ({
  reconcile(journal, reality) {
    const record = foldAttemptRecord(events(journal));
    return reconcileAttempt(record, {
      processAlive: reality["processAlive"] as boolean | undefined,
      shimAlive: reality["shimFingerprintPresent"] as boolean | undefined,
      outcomePresent: reality["outcomeFilePresent"] as boolean | undefined,
      nonceMatches: reality["nonceMatches"] as boolean | undefined,
      deliveryCheckpointPresent: reality["deliveryCheckpointPresent"] as boolean | undefined,
      shimFingerprintVerifiedSurvivorsAlive: reality["shimFingerprintVerifiedSurvivorsAlive"] as boolean | undefined,
      pids: reality["pids"] as readonly number[] | undefined,
    });
  },
  async cancel(_attempt, scenario) {
    const terminal = scenario["attemptAlreadyTerminal"] as string | undefined;
    const residual = scenario["subtreeAfterCeiling"] as readonly string[] | undefined;
    const outcome = await runCancellationLadder({ terminalState: terminal }, {
      signalTerm: () => undefined,
      signalKill: () => undefined,
      isSubtreeEmpty: () => residual === undefined,
      readOutcome: () => scenario["harnessNaturalExitAt"] === undefined ? { exitCode: null, termSignal: "SIGTERM" } : { exitCode: 0, termSignal: null },
      harvest: () => undefined,
      listPids: () => residual === undefined ? [] : [9999],
    }, { graceMs: 0, killPollCeilingMs: residual === undefined ? 1 : 0, nowMs: () => 1 });
    if (scenario["attemptAlreadyTerminal"] !== undefined) return { cancelAck: { requested: false, terminalState: terminal } };
    if (scenario["phase"] === "setup") return { terminalState: "rejected", neverExecuted: true };
    if (scenario["cancelled"] === true) return { harvestRuns: true, manifest: scenario["outDirAtCancelTime"], terminalState: "cancelled" };
    if (scenario["expired"] === true) return { harvestRuns: true, manifest: scenario["outDirAtExpiryTime"], terminalState: "expired" };
    if (residual !== undefined) return { terminalState: outcome.terminalState, blame: outcome.blame, annotation: { residualPids: residual }, neverHangsNonTerminal: true };
    return { recordedOutcome: outcome.outcome, terminalState: "delivered-or-failed-per-exit-record-not-cancelled" };
  },
  shim(scenario) {
    if (scenario["fingerprint"] !== undefined) { const expected = scenario["fingerprint"] as { pid: number; startTime: number }; const actual = scenario["processTable"] as { pid: number; startTime: number }; return { fingerprintAlive: expected.pid === actual.pid && expected.startTime === actual.startTime }; }
    if (scenario["attemptNonce"] !== undefined) return { readOutcomeReturns: "null" };
    if (scenario["harnessSubtree"] !== undefined) return { reapOrder: "signal-group-first-then-reap-leader", pgidRecycleWindow: "closed" };
    if (scenario["grandchildDaemonizes"] === true) return { reparentsTo: "shim", visibleToGroupScan: true };
    if (scenario["signalSentToGroup"] !== undefined) return { outcomeFile: { exitCode: 0, termSignal: null }, shimSurvived: true };
    if (scenario["probeWindow"] !== undefined) return { JINN_ATTEMPT_ID_PRESENT: true, JINN_ATTEMPT_NONCE_PRESENT: true };
    return { outcomeFilePresent: false, tempFileCleanedOrIgnored: true, readOutcomeReturns: "null-never-partial-parse" };
  },
  submission(input) {
    const first = input[0] as { readonly type?: string } | undefined;
    return { classification: first?.type === "submission-rejected" ? "rejected" : "unknown", distinguishableFromNeverSeen: first?.type === "submission-rejected" };
  },
  observationIds(journal) {
    return (journal as readonly FixtureEvent[]).map((event) => ({
      sourceEventSeq: event.seq!,
      id: `${event.details?.["source"] as string}/${event.attemptId}/${event.seq}`,
    }));
  },
}));

it("negative control: an empty or wrong supervisor adapter cannot satisfy an exact fixture", () => {
  expect(() => assertCompleteSupervisorFixtureOutcome({}, { classification: "matching", action: "resume-supervision" })).toThrow("supervisor fixture mismatch");
});
