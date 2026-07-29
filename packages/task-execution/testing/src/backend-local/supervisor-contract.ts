// SPDX-License-Identifier: Apache-2.0

import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, test } from "vitest";
import { loadAllGoldenJournals, loadRebuildIdentityJournal, loadSubmissionSegmentSurvival } from "./journal-fixtures.js";
import { loadCancellationFixture, loadReconciliationTable, loadShimContractFixture } from "./fixtures.js";

/**
 * The public supervisor-kit adapter.  Each call receives a distinct scripted reality and must
 * return the complete classification/action/terminal/annotation result produced by its real
 * supervisor integration; fixture expectations are intentionally never passed to the adapter.
 */
export interface AttemptSupervisorUnderTest {
  reconcile(journal: readonly unknown[], reality: Readonly<Record<string, unknown>>): Promise<object> | object;
  cancel(attempt: AttemptIdentity, scenario: Readonly<Record<string, unknown>>): Promise<object> | object;
  shim(scenario: Readonly<Record<string, unknown>>): Promise<object> | object;
  submission(events: readonly unknown[]): Promise<object> | object;
  observationIds(journal: readonly unknown[]): Promise<readonly object[]> | readonly object[];
}

/** Shared exact-equality gate used by the kit and its executable negative control. */
export function assertCompleteSupervisorFixtureOutcome(actual: unknown, expected: unknown): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`supervisor fixture mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

const journalRealities: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  valid: { processAlive: false, shimFingerprintPresent: false, outcomeFilePresent: true, nonceMatches: true },
  "torn-tail": { processAlive: true, shimFingerprintPresent: true, outcomeFilePresent: false },
  "contradictory-terminals": { shimFingerprintVerifiedSurvivorsAlive: true, pids: [4400, 4401] },
  "duplicate-nonces": { processAlive: true, shimFingerprintPresent: false, outcomeFilePresent: false, pids: [4500, 4501] },
  "dangling-intents": { processAlive: false, shimFingerprintPresent: false, outcomeFilePresent: false },
  "seq-resumption": { processAlive: false, shimFingerprintPresent: false, outcomeFilePresent: true, nonceMatches: true },
};

const journalExpected: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  valid: { classification: "matching", action: "terminal-record-wins" },
  "torn-tail": { classification: "matching", action: "resume-supervision" },
  "contradictory-terminals": { classification: "contradictory", action: "terminal-record-wins-kill-survivors", killedPids: [4400, 4401] },
  "duplicate-nonces": { classification: "orphaned", action: "kill-ladder-then-lost", terminalState: "lost", blame: "infrastructure", killedPids: [4500, 4501] },
  "dangling-intents": { classification: "absent", action: "lost", terminalState: "lost", blame: "infrastructure" },
  "seq-resumption": { classification: "matching", action: "terminal-record-wins" },
};

function reconciliationJournal(name: string): readonly unknown[] {
  const base = { attemptId: "urn:uuid:00000000-0000-0000-0000-000000000401", time: "2026-07-28T00:00:00.000Z", details: {} };
  if (name === "engaged-no-intent") return [{ ...base, seq: 1, type: "attempt-engaged" }];
  if (name === "spawn-intended-absent") return [{ ...base, seq: 1, type: "attempt-engaged" }, { ...base, seq: 2, type: "spawn-intended" }];
  if (name === "harvesting-resume") return [{ ...base, seq: 1, type: "exec-finished" }, { ...base, seq: 2, type: "harvest-started" }];
  if (name === "recording-resume") return [{ ...base, seq: 1, type: "exec-finished" }, { ...base, seq: 2, type: "harvest-started" }, { ...base, seq: 3, type: "harvested" }];
  if (name === "terminal-with-survivors") return [{ ...base, seq: 1, type: "attempt-terminal", details: { state: "delivered" } }];
  if (name === "two-terminals-one-nonce") return [{ ...base, seq: 1, type: "attempt-terminal", details: { state: "delivered" } }, { ...base, seq: 2, type: "attempt-terminal", details: { state: "failed" }, rejectedAtAppend: true }];
  if (name === "lost-then-corrective") return [{ ...base, seq: 1, type: "attempt-terminal", details: { state: "lost" } }];
  return [{ ...base, seq: 1, type: "spawned" }];
}

/** The executable §6/§6.4/§6.5 supervisor contract. */
export function describeAttemptSupervisorContract(makeSupervisor: () => AttemptSupervisorUnderTest): void {
  describe("AttemptSupervisor conformance (design §6, frozen interfaces §14 items 2-6)", () => {
    test("every golden journal drives its own scripted process reality and exact recovery result", async () => {
      const supervisor = makeSupervisor();
      const journals = await loadAllGoldenJournals();
      for (const journal of journals) {
        const outcome = await supervisor.reconcile(journal.events, journalRealities[journal.name]!);
        expect(() => assertCompleteSupervisorFixtureOutcome(outcome, journalExpected[journal.name]), `journal fixture ${journal.name}`).not.toThrow();
      }
    });

    test("the rebuild-identity journal emits its complete pinned observation identity vector", async () => {
      const supervisor = makeSupervisor();
      const journal = await loadRebuildIdentityJournal();
      const first = await supervisor.observationIds(journal.events);
      const second = await supervisor.observationIds(journal.events);
      const expected = journal.expectedObservationIdentity.map((entry) => ({ sourceEventSeq: entry.sourceEventSeq, id: entry.expectedId }));
      expect(() => assertCompleteSupervisorFixtureOutcome(first, expected)).not.toThrow();
      expect(() => assertCompleteSupervisorFixtureOutcome(second, expected)).not.toThrow();
    });

    test("a rejected submission segment survives restart as the exact rejected projection", async () => {
      const supervisor = makeSupervisor();
      const segment = await loadSubmissionSegmentSurvival();
      const expected = { classification: "rejected", distinguishableFromNeverSeen: true };
      expect(await supervisor.submission(segment.submissionEvents)).toEqual(expected);
      expect(await supervisor.submission(segment.submissionEvents)).toEqual(expected);
    });

    test("every §6.4 reconciliation row returns its exact classification action terminal and blame", async () => {
      const supervisor = makeSupervisor();
      const table = await loadReconciliationTable();
      for (const row of table.rows) {
        const outcome = await supervisor.reconcile(reconciliationJournal(row.name), { ...row.reality, ...(row.name === "lost-then-corrective" ? { outcomeFilePresent: true } : {}) });
        const expected = {
          classification: row.name === "engaged-no-intent" ? "absent-never-executed" : row.name === "matching-late" ? "matching-late" : row.name === "harvesting-resume" ? "harvesting-resume" : row.name === "recording-resume" ? "recording-resume" : row.name === "lost-then-corrective" ? "corrected" : row.name === "two-terminals-one-nonce" || row.name === "terminal-with-survivors" ? "contradictory" : row.name === "stale-foreign-nonce-mismatch" ? "stale-foreign" : row.name === "orphaned-under-dead-shim" ? "orphaned" : row.name === "matching" ? "matching" : "absent",
          action: row.name === "engaged-no-intent" ? "rejected" : row.name === "lost-then-corrective" ? "accept-corrective-terminal" : row.name === "two-terminals-one-nonce" || row.name === "terminal-with-survivors" ? "terminal-record-wins-kill-survivors" : row.action,
          ...(row.name === "orphaned-under-dead-shim" || row.name === "two-terminals-one-nonce" || row.name === "terminal-with-survivors" ? { killedPids: [] } : {}),
          ...(row.name === "engaged-no-intent" ? { terminalState: "rejected" } : row.blame === "infrastructure" ? { terminalState: "lost", blame: "infrastructure" } : {}),
        };
        expect(() => assertCompleteSupervisorFixtureOutcome(outcome, expected), `reconciliation row ${row.name}`).not.toThrow();
      }
    });

    test("every shim scenario drives a distinct exact behavioral result", async () => {
      const supervisor = makeSupervisor();
      const fixture = await loadShimContractFixture();
      for (const scenario of fixture.scenarios) expect(await supervisor.shim(scenario.given), scenario.name).toEqual(scenario.expect);
    });

    test("every cancellation/deadline race returns its complete expected terminal vector", async () => {
      const supervisor = makeSupervisor();
      const fixture = await loadCancellationFixture();
      for (const scenario of fixture.scenarios) {
        const outcome = await supervisor.cancel({ attemptUri: "urn:uuid:00000000-0000-0000-0000-000000000401", nonce: "n", attemptNumber: 1 }, scenario.given);
        expect(outcome, scenario.name).toEqual(scenario.expected);
      }
    });
  });
}
