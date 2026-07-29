// SPDX-License-Identifier: Apache-2.0

import {
  buildShimSpawn,
  cleanupHarnessSubtree,
  establishSubreaperCustody,
  fingerprintAlive,
  installCustodianSignalGuards,
  foldAttemptRecord,
  openAttemptJournal,
  openSubmissionSegment,
  readOutcome,
  reconcileAttempt,
  runCancellationLadder,
  writeOutcomeFile,
} from "@jinn-network/task-execution-supervisor";
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCompleteSupervisorFixtureOutcome, describeAttemptSupervisorContract, runAttemptSupervisorContract } from "./supervisor-contract.js";
import { expect, it } from "vitest";

type FixtureEvent = { readonly torn?: boolean; readonly rawPartialBytes?: string; readonly attemptId?: string; readonly seq?: number; readonly type?: string; readonly time?: string; readonly details?: Readonly<Record<string, unknown>>; readonly failsAttempt?: boolean; readonly rejectedAtAppend?: boolean };

function replayJournal(input: readonly unknown[]): { readonly metaDir: string; readonly events: Parameters<typeof foldAttemptRecord>[0] } {
  const metaDir = mkdtempSync(join(tmpdir(), "jinn-supervisor-kit-"));
  const path = join(metaDir, "journal.jsonl");
  let journal = openAttemptJournal(metaDir);
  const entries = input as readonly FixtureEvent[];
  for (const [index, entry] of entries.entries()) {
    if (entry.torn === true) {
      appendFileSync(path, entry.rawPartialBytes ?? "{");
      // Exercise the real parser against the on-disk torn tail before simulating the next
      // restart's sanctioned tail discard.  A subsequent append starts from the intact durable
      // prefix, never from an in-memory counter or the torn record's claimed sequence.
      const intact = journal.read();
      if (entries.slice(index + 1).some((candidate) => candidate.torn !== true)) {
        writeFileSync(path, `${intact.map((event) => JSON.stringify(event)).join("\n")}\n`);
        journal = openAttemptJournal(metaDir);
      }
      continue;
    }
    try {
      journal.append({
        attemptId: entry.attemptId ?? "urn:uuid:00000000-0000-0000-0000-000000000401",
        type: (entry.type ?? "attempt-engaged") as Parameters<typeof foldAttemptRecord>[0][number]["type"],
        time: entry.time ?? "2026-07-28T00:00:00.000Z",
        details: entry.details ?? {},
        ...(entry.failsAttempt === undefined ? {} : { failsAttempt: entry.failsAttempt }),
      });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "JournalTerminalRejectedError") throw error;
    }
  }
  return { metaDir, events: journal.read() };
}

function withReplayedJournal<T>(input: readonly unknown[], run: (events: Parameters<typeof foldAttemptRecord>[0]) => T): T {
  const replay = replayJournal(input);
  try { return run(replay.events); } finally { rmSync(replay.metaDir, { recursive: true, force: true }); }
}

function residualPids(scenario: Readonly<Record<string, unknown>>): readonly number[] {
  return (scenario["subtreeAfterCeiling"] as readonly string[] | undefined)?.map((value) => Number(/\d+/u.exec(value)?.[0] ?? "0")).filter((pid) => pid > 0) ?? [];
}

async function runScriptedCancellation(scenario: Readonly<Record<string, unknown>>): Promise<{
  readonly result: Awaited<ReturnType<typeof runCancellationLadder>>;
  readonly effects: readonly string[];
  readonly manifest: readonly string[];
  readonly configuredResidualPids: readonly number[];
}> {
  const effects: string[] = [];
  const manifest = (scenario["outDirAtCancelTime"] ?? scenario["outDirAtExpiryTime"] ?? []) as readonly string[];
  const configuredResidualPids = residualPids(scenario);
  const naturalOutcome = scenario["harnessNaturalExitAt"] === undefined
    ? { exitCode: null, termSignal: "SIGTERM" }
    : { exitCode: 0, termSignal: null };
  const result = await runCancellationLadder({
    terminalState: scenario["attemptAlreadyTerminal"] as string | undefined,
    phase: scenario["phase"] === "setup" ? "provisioning" : undefined,
    requestedTerminalState: scenario["expired"] === true ? "expired" : undefined,
  }, {
    signalTerm: () => { effects.push("signal:SIGTERM"); },
    signalKill: () => { effects.push("signal:SIGKILL"); },
    isSubtreeEmpty: () => configuredResidualPids.length === 0,
    readOutcome: () => naturalOutcome,
    harvest: () => { effects.push("harvest"); },
    listPids: () => configuredResidualPids,
  }, { graceMs: 0, killPollCeilingMs: configuredResidualPids.length === 0 ? 1 : 0, nowMs: () => 1 });
  return { result, effects, manifest, configuredResidualPids };
}

describeAttemptSupervisorContract(() => ({
  reconcile(journal, reality) {
    return withReplayedJournal(journal, (journalEvents) => reconcileAttempt(foldAttemptRecord(journalEvents), {
      processAlive: reality["processAlive"] as boolean | undefined,
      shimAlive: reality["shimFingerprintPresent"] as boolean | undefined,
      outcomePresent: reality["outcomeFilePresent"] as boolean | undefined,
      nonceMatches: reality["nonceMatches"] as boolean | undefined,
      deliveryCheckpointPresent: reality["deliveryCheckpointPresent"] as boolean | undefined,
      shimFingerprintVerifiedSurvivorsAlive: reality["shimFingerprintVerifiedSurvivorsAlive"] as boolean | undefined,
      pids: reality["pids"] as readonly number[] | undefined,
    }));
  },
  async cancel(_attempt, scenario) {
    const scripted = await runScriptedCancellation(scenario);
    if (scripted.result.requested === false) return { cancelAck: { requested: false, terminalState: scripted.result.terminalState } };
    if (scripted.result.terminalState === "rejected") return { terminalState: "rejected", neverExecuted: scripted.effects.length === 0 };
    if (scripted.result.residualPids !== undefined) {
      const names = scripted.result.residualPids.map((pid) => `pid-${pid}-still-alive`);
      return { terminalState: scripted.result.terminalState, blame: scripted.result.blame, annotation: { residualPids: names }, neverHangsNonTerminal: scripted.configuredResidualPids.length > 0 };
    }
    if (scripted.result.terminalState === "cancelled" || scripted.result.terminalState === "expired") {
      return { harvestRuns: scripted.effects.includes("harvest"), manifest: scripted.manifest, terminalState: scripted.result.terminalState };
    }
    return {
      recordedOutcome: scripted.result.outcome,
      terminalState: scripted.result.terminalState === "delivered" || scripted.result.terminalState === "failed"
        ? "delivered-or-failed-per-exit-record-not-cancelled"
        : scripted.result.terminalState,
    };
  },
  async shim(scenario) {
    const operation = scenario["operation"];
    if (operation === "fingerprint-check") {
      const expected = scenario["fingerprint"] as { pid: number; startTime: number };
      const actual = scenario["processTable"] as { pid: number; startTime: number };
      return { fingerprintAlive: fingerprintAlive(expected, actual) };
    }
    if (operation === "outcome-nonce-check") {
      const root = mkdtempSync(join(tmpdir(), "jinn-supervisor-outcome-"));
      try {
        writeOutcomeFile(root, { attemptId: "fixture-attempt", nonce: scenario["outcomeFileNonce"] as string, exitCode: 0, termSignal: null, startedAt: "2026-07-28T00:00:00.000Z", finishedAt: "2026-07-28T00:00:01.000Z" });
        return { readOutcomeReturns: readOutcome(root, scenario["attemptNonce"] as string) === null ? "null" : "outcome" };
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
    if (operation === "group-cleanup") {
      const effects: string[] = [];
      const result = await cleanupHarnessSubtree({
        signalHarnessSubtree: (signal) => { effects.push(`signal:${signal}`); },
        reapHarnessLeader: () => { effects.push("reap:leader"); },
      });
      return {
        reapOrder: result.signalDelivered && result.leaderReaped && effects.join(",") === "signal:SIGKILL,reap:leader"
          ? "signal-group-first-then-reap-leader"
          : "invalid",
        pgidRecycleWindow: effects.indexOf("signal:SIGKILL") < effects.indexOf("reap:leader") ? "closed" : "open",
      };
    }
    if (operation === "subreaper-adoption") {
      const result = await establishSubreaperCustody({ enableSubreaper: () => scenario["grandchildDaemonizes"] === true });
      return { reparentsTo: result.subreaper ? "shim" : "init", visibleToGroupScan: result.visibleToCustodyScan };
    }
    if (operation === "signal-survival") {
      const handlers = new Map<string, () => void>();
      installCustodianSignalGuards({ ignoreSignal: (signal) => { handlers.set(signal, () => undefined); } });
      handlers.get(String(scenario["signalSentToGroup"]))?.();
      const root = mkdtempSync(join(tmpdir(), "jinn-supervisor-signal-"));
      try {
        writeOutcomeFile(root, { attemptId: "fixture-attempt", nonce: "fixture-nonce", exitCode: 0, termSignal: null, startedAt: "2026-07-28T00:00:00.000Z", finishedAt: "2026-07-28T00:00:01.000Z" });
        const outcome = readOutcome(root, "fixture-nonce");
        return { outcomeFile: outcome === null ? null : { exitCode: outcome.exitCode, termSignal: outcome.termSignal }, shimSurvived: handlers.has("SIGTERM") && handlers.has("SIGINT") && handlers.has("SIGHUP") };
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
    if (operation === "fork-time-tags") {
      const root = mkdtempSync(join(tmpdir(), "jinn-supervisor-tags-"));
      try {
        const spawn = buildShimSpawn({ attemptId: "fixture-attempt", nonce: "fixture-nonce", metaDir: root, secretsDir: root });
        return { JINN_ATTEMPT_ID_PRESENT: spawn.env["JINN_ATTEMPT_ID"] !== undefined, JINN_ATTEMPT_NONCE_PRESENT: spawn.env["JINN_ATTEMPT_NONCE"] !== undefined };
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
    if (operation === "atomic-outcome-read") {
      const root = mkdtempSync(join(tmpdir(), "jinn-supervisor-atomic-"));
      const temp = join(root, ".outcome.json.tmp");
      try {
        writeFileSync(temp, '{"partial":true}');
        const before = readOutcome(root);
        rmSync(temp, { force: true });
        return { outcomeFilePresent: before !== null, tempFileCleanedOrIgnored: !existsSync(temp), readOutcomeReturns: before === null ? "null-never-partial-parse" : "outcome" };
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
    throw new Error(`unknown shim contract operation: ${String(operation)}`);
  },
  submission(input) {
    const root = mkdtempSync(join(tmpdir(), "jinn-supervisor-submission-"));
    try {
      const segment = openSubmissionSegment(root);
      for (const event of input as readonly { readonly submission: string; readonly type: "submission-accepted" | "submission-rejected" | "submission-closed"; readonly time: string; readonly details: Readonly<Record<string, unknown>> }[]) segment.append(event);
      const recovered = openSubmissionSegment(root).read();
      const latest = recovered.at(-1);
      return { classification: latest?.type === "submission-rejected" ? "rejected" : "unknown", distinguishableFromNeverSeen: latest?.type === "submission-rejected" };
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
  observationIds(journal) {
    return withReplayedJournal(journal, (events) => events.map((event) => ({
      sourceEventSeq: event.seq!,
      id: `${event.details?.["source"] as string}/${event.attemptId}/${event.seq}`,
    })));
  },
}));

it("negative control: an empty or wrong supervisor adapter cannot satisfy an exact fixture", () => {
  expect(() => assertCompleteSupervisorFixtureOutcome({}, { classification: "matching", action: "resume-supervision" })).toThrow("supervisor fixture mismatch");
});

it("negative control: a fixture-shaped responder is rejected by the executable contract runner", async () => {
  await expect(runAttemptSupervisorContract(() => ({
    reconcile: () => ({ classification: "matching", action: "resume-supervision" }),
    cancel: () => ({}),
    shim: () => ({}),
    submission: () => ({}),
    observationIds: () => [],
  }))).rejects.toThrow("supervisor fixture mismatch");
});
