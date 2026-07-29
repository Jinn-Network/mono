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

/**
 * Runs the complete supervisor contract outside Vitest's describe registration.  This is also
 * the negative-control seam: a deliberately wrong implementation must execute the identical
 * fixture suite and fail on its first complete outcome, rather than merely failing a helper.
 */
export async function runAttemptSupervisorContract(makeSupervisor: () => AttemptSupervisorUnderTest): Promise<void> {
  const supervisor = makeSupervisor();
  const journals = await loadAllGoldenJournals();
  for (const journal of journals) {
    const executable = journal as typeof journal & {
      readonly conformance: { readonly reality: Readonly<Record<string, unknown>>; readonly expectedResult: Readonly<Record<string, unknown>> };
    };
    const outcome = await supervisor.reconcile(executable.events, executable.conformance.reality);
    assertCompleteSupervisorFixtureOutcome(outcome, executable.conformance.expectedResult);
  }

  const journal = await loadRebuildIdentityJournal();
  const first = await supervisor.observationIds(journal.events);
  const second = await supervisor.observationIds(journal.events);
  const expectedIdentities = journal.expectedObservationIdentity.map((entry) => ({ sourceEventSeq: entry.sourceEventSeq, id: entry.expectedId }));
  assertCompleteSupervisorFixtureOutcome(first, expectedIdentities);
  assertCompleteSupervisorFixtureOutcome(second, expectedIdentities);

  const segment = await loadSubmissionSegmentSurvival();
  const expectedSubmission = { classification: "rejected", distinguishableFromNeverSeen: true };
  assertCompleteSupervisorFixtureOutcome(await supervisor.submission(segment.submissionEvents), expectedSubmission);
  assertCompleteSupervisorFixtureOutcome(await supervisor.submission(segment.submissionEvents), expectedSubmission);

  const table = await loadReconciliationTable();
  for (const row of table.rows) {
    const executable = row as typeof row & {
      readonly script: { readonly journal: readonly unknown[]; readonly reality: Readonly<Record<string, unknown>> };
      readonly expectedResult: Readonly<Record<string, unknown>>;
    };
    const outcome = await supervisor.reconcile(executable.script.journal, executable.script.reality);
    assertCompleteSupervisorFixtureOutcome(outcome, executable.expectedResult);
  }

  const shim = await loadShimContractFixture();
  for (const scenario of shim.scenarios) assertCompleteSupervisorFixtureOutcome(await supervisor.shim(scenario.given), scenario.expect);

  const cancellation = await loadCancellationFixture();
  for (const scenario of cancellation.scenarios) {
    const outcome = await supervisor.cancel({ attemptUri: "urn:uuid:00000000-0000-0000-0000-000000000401", nonce: "n", attemptNumber: 1 }, scenario.given);
    assertCompleteSupervisorFixtureOutcome(outcome, scenario.expected);
  }
}

/** The executable §6/§6.4/§6.5 supervisor contract. */
export function describeAttemptSupervisorContract(makeSupervisor: () => AttemptSupervisorUnderTest): void {
  describe("AttemptSupervisor conformance (design §6, frozen interfaces §14 items 2-6)", () => {
    test("executes every golden journal, recovery, shim, cancellation, submission, and observation family", async () => {
      await runAttemptSupervisorContract(makeSupervisor);
    });
  });
}
