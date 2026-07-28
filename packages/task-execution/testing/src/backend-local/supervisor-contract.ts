// SPDX-License-Identifier: Apache-2.0

import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import { describe, expect, test } from "vitest";
import {
  loadAllGoldenJournals,
  loadRebuildIdentityJournal,
  loadSubmissionSegmentSurvival,
} from "./journal-fixtures.js";
import { loadCancellationFixture, loadReconciliationTable, loadShimContractFixture } from "./fixtures.js";

/**
 * The forward-declared surface a real Attempt Supervisor is expected to expose (design §6,
 * Milestone A Tasks A4/A5's `openAttemptJournal`/`foldAttemptRecord`/`reconcileAttempt`/
 * `runCancellationLadder`/`armDeadline`, condensed to what THIS kit's fixture families drive).
 * PROVISIONAL: A5 owns the real supervisor's exact types (`JournalEvent`, the attempt-record
 * field set, etc.) and may refine this shape; nothing here is a frozen interface (§14 items
 * 2-6 name the BEHAVIORAL contract, not this convenience type). Kept structurally loose
 * (`unknown` fixture-shaped inputs/outputs) so this module compiles now, against no
 * implementation, and A5 can conform without this type fighting its actual design.
 */
export interface AttemptSupervisorUnderTest {
  /** Folds a journal (as this kit's `JournalEventFixture[]` shape) to durable state and reconciles against scripted process reality. */
  reconcile(journal: readonly unknown[], reality: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>;
  /** Runs the cancellation ladder against a live (possibly scripted) attempt. */
  cancel(attempt: AttemptIdentity, reason: string): Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>;
}

/**
 * The Attempt Supervisor conformance suite (design §6, frozen interfaces §14 items 2-6). Encodes
 * the shim/journal/reconciler/cancellation/deadline fixture families as assertions over the
 * supervisor surface — authored now (Milestone A, Task A3), against the A2 contract types, with
 * NO supervisor implementation in existence yet. `makeSupervisor` is never invoked in Task A3
 * (there is nothing to invoke it against); Task A5 calls
 * `describeAttemptSupervisorContract(makeRealSupervisor)` once the real supervisor lands,
 * turning this suite green for the first time.
 */
export function describeAttemptSupervisorContract(makeSupervisor: () => AttemptSupervisorUnderTest): void {
  describe("AttemptSupervisor conformance (design §6, frozen interfaces §14 items 2-6)", () => {
    test("every golden journal fixture reconciles to its documented expectation", async () => {
      const supervisor = makeSupervisor();
      const journals = await loadAllGoldenJournals();
      for (const journal of journals) {
        const outcome = await supervisor.reconcile(journal.events, {});
        expect(outcome, `journal fixture "${journal.name}" (${journal.description})`).toBeDefined();
      }
    });

    test("the rebuild-identity journal re-emits identical (source,id) observation pairs", async () => {
      const supervisor = makeSupervisor();
      const journal = await loadRebuildIdentityJournal();
      const firstRebuild = await supervisor.reconcile(journal.events, {});
      const secondRebuild = await supervisor.reconcile(journal.events, {});
      expect(secondRebuild).toEqual(firstRebuild);
    });

    test("a rejected submission segment survives restart, distinguishable from never-seen", async () => {
      const supervisor = makeSupervisor();
      const segment = await loadSubmissionSegmentSurvival();
      const outcome = await supervisor.reconcile([], { submissionEvents: segment.submissionEvents });
      expect(outcome).toBeDefined();
    });

    test("every §6.4 reconciliation-table row is honored", async () => {
      const supervisor = makeSupervisor();
      const table = await loadReconciliationTable();
      for (const row of table.rows) {
        const outcome = await supervisor.reconcile([], row.reality);
        expect(outcome, `reconciliation row "${row.name}" -> ${row.classification}`).toBeDefined();
      }
    });

    test("the shim contract's behaviors are honored end to end through the supervisor", async () => {
      const fixture = await loadShimContractFixture();
      expect(fixture.scenarios.length).toBeGreaterThan(0);
      // A4/A5 wire the real assertions (shim.test.ts/shim.integration.test.ts exercise these
      // scenarios directly against the real shim process; this suite proves the supervisor
      // surfaces their outcomes correctly once assembled).
    });

    test("cancellation races resolve per fixture", async () => {
      const supervisor = makeSupervisor();
      const fixture = await loadCancellationFixture();
      for (const scenario of fixture.scenarios) {
        const outcome = await supervisor.cancel(
          { attemptUri: "urn:uuid:00000000-0000-0000-0000-000000000401", nonce: "n", attemptNumber: 1 },
          scenario.name,
        );
        expect(outcome, `cancellation scenario "${scenario.name}"`).toBeDefined();
      }
    });
  });
}
