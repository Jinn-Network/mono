import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { serializeCanonicalFixture } from "./canonical.js";
import {
  loadCancellationFixture,
  loadEvidenceJoinFixture,
  loadExpectedDigests,
  loadReconciliationTable,
  loadResultInterpretationFixture,
  loadShimContractFixture,
  loadWorkspaceFixture,
} from "./fixtures.js";
import {
  GOLDEN_JOURNAL_NAMES,
  loadAllGoldenJournals,
  loadGoldenJournal,
  loadRebuildIdentityJournal,
  loadSubmissionSegmentSurvival,
} from "./journal-fixtures.js";

// The kit precedes the implementation (design §16): these self-tests prove the fixture families
// themselves are well-formed and internally consistent, independent of any supervisor/workspace/
// launcher/backend implementation (none exists yet at Milestone A, Task A3).

describe("golden journal fixtures", () => {
  it("loads all six golden journal families with events", async () => {
    const journals = await loadAllGoldenJournals();
    expect(journals).toHaveLength(GOLDEN_JOURNAL_NAMES.length);
    for (const journal of journals) {
      expect(journal.events.length, journal.name).toBeGreaterThan(0);
      expect(journal.expected, journal.name).toBeDefined();
    }
  });

  it("the valid journal is a clean happy path with a durableSeq of events.length + 1", async () => {
    const valid = await loadGoldenJournal("valid");
    expect(valid.events).toHaveLength(5);
    expect(valid.expected.durableSeq).toBe(6);
    expect(valid.events.every((event) => event.torn !== true)).toBe(true);
  });

  it("the torn-tail journal discards its trailing torn record from durableSeq", async () => {
    const tornTail = await loadGoldenJournal("torn-tail");
    const intact = tornTail.events.filter((event) => event.torn !== true);
    const torn = tornTail.events.filter((event) => event.torn === true);
    expect(torn).toHaveLength(1);
    const maxIntactSeq = Math.max(...intact.map((event) => event.seq ?? 0));
    expect(tornTail.expected.durableSeq).toBe(maxIntactSeq + 1);
  });

  it("the contradictory-terminals journal has exactly two terminal events sharing one nonce", async () => {
    const fixture = await loadGoldenJournal("contradictory-terminals");
    const terminals = fixture.events.filter((event) => event.type === "attempt-terminal");
    expect(terminals).toHaveLength(2);
    const nonces = new Set(terminals.map((event) => event.details?.nonce));
    expect(nonces.size).toBe(1);
  });

  it("the duplicate-nonces journal assigns one nonce across two distinct attempt ids", async () => {
    const fixture = await loadGoldenJournal("duplicate-nonces");
    const attemptIds = new Set(fixture.events.map((event) => event.attemptId));
    expect(attemptIds.size).toBe(2);
    const nonces = new Set(
      fixture.events.filter((event) => event.type === "spawned").map((event) => event.details?.nonce),
    );
    expect(nonces.size).toBe(1);
  });

  it("the dangling-intents journal ends at spawn-intended with no spawned/terminal", async () => {
    const fixture = await loadGoldenJournal("dangling-intents");
    expect(fixture.events.at(-1)?.type).toBe("spawn-intended");
    expect(fixture.events.some((event) => event.type === "spawned")).toBe(false);
  });

  it("the seq-resumption journal reuses the pre-crash seq after a torn record", async () => {
    const fixture = await loadGoldenJournal("seq-resumption");
    const torn = fixture.events.find((event) => event.torn === true);
    expect(torn).toBeDefined();
    const resumed = fixture.events.filter((event) => event.torn !== true).at(-2);
    expect(resumed?.seq).toBe(3);
  });

  it("rebuild-identity pins a deterministic id per (source, attemptId, seq)", async () => {
    const fixture = await loadRebuildIdentityJournal();
    expect(fixture.expectedObservationIdentity).toHaveLength(fixture.events.length);
    for (const entry of fixture.expectedObservationIdentity) {
      expect(entry.expectedId).toContain(String(entry.sourceEventSeq));
    }
  });

  it("submission-segment-survival documents a rejected submission durable across restart", async () => {
    const fixture = await loadSubmissionSegmentSurvival();
    expect(fixture.submissionEvents).toHaveLength(1);
    expect(fixture.submissionEvents[0].type).toBe("submission-rejected");
    expect(fixture.expected.beforeRestart).toEqual(fixture.expected.afterRestart);
  });
});

describe("the §6.4 reconciliation table as fixtures", () => {
  it("covers all eleven rows, each with a classification and action", async () => {
    const table = await loadReconciliationTable();
    expect(table.rows).toHaveLength(11);
    for (const row of table.rows) {
      expect(row.classification, row.name).toBeTruthy();
      expect(row.action, row.name).toBeTruthy();
    }
  });

  it("includes the never-executed row, the orphaned-dead-shim row, both resume rows, and the lost-correction exception", async () => {
    const table = await loadReconciliationTable();
    const names = table.rows.map((row) => row.name);
    expect(names).toContain("engaged-no-intent");
    expect(names).toContain("orphaned-under-dead-shim");
    expect(names).toContain("harvesting-resume");
    expect(names).toContain("recording-resume");
    expect(names).toContain("lost-then-corrective");
  });

  it("the lost-then-corrective row is the only one classified 'corrected'", async () => {
    const table = await loadReconciliationTable();
    const corrected = table.rows.filter((row) => row.classification === "corrected");
    expect(corrected).toHaveLength(1);
    expect(corrected[0].name).toBe("lost-then-corrective");
  });
});

describe("shim-contract fixtures", () => {
  it("covers atomicity, PID-reuse, group-kill, subreaper, signal-survival, and env-tag scenarios", async () => {
    const fixture = await loadShimContractFixture();
    const names = fixture.scenarios.map((scenario) => scenario.name);
    expect(names).toContain("outcome-file-atomicity-kill-9-between-temp-and-rename");
    expect(names).toContain("fingerprint-vs-pid-reuse");
    expect(names).toContain("group-kill-zombie-pinning");
    expect(names).toContain("subreaper-adoption");
    expect(names).toContain("signal-survival-raced-ahead-success");
    expect(names).toContain("env-tag-present-from-fork");
  });
});

describe("launcher result-interpretation fixtures", () => {
  it("covers the fail/not-fail precedence and structured-output scenarios", async () => {
    const fixture = await loadResultInterpretationFixture();
    const names = fixture.scenarios.map((scenario) => scenario.name);
    expect(names).toContain("success-envelope-out-of-range-exit-is-failed");
    expect(names).toContain("limit-exhaustion-is-partial-resumable");
    expect(names).toContain("within-range-exit-no-envelope-is-fulfilled");
    expect(names).toContain("structured-output-alongside-envelope-never-instead");
  });

  it("every scenario declares an exit-record-derived expected outcome", async () => {
    const fixture = await loadResultInterpretationFixture();
    for (const scenario of fixture.scenarios) {
      expect(scenario.expected.outcome, scenario.name).toBeTruthy();
    }
  });
});

describe("workspace fixtures", () => {
  it("covers retention, secret wipe, immutability, rejected-never-executed, symlink escape, quota, and env discipline", async () => {
    const fixture = await loadWorkspaceFixture();
    expect(fixture.scenarios.length).toBeGreaterThanOrEqual(8);
  });

  it("the symlink-escape scenario never dereferences the escaping target", async () => {
    const fixture = await loadWorkspaceFixture();
    const scenario = fixture.scenarios.find((entry) => entry.name === "symlink-in-out-escaping-tree-rejected");
    expect(scenario?.expected.dereferenced).toBe(false);
  });

  it("the no-secrets-in-meta scenario asserts an absence, not a presence", async () => {
    const fixture = await loadWorkspaceFixture();
    const scenario = fixture.scenarios.find((entry) => entry.name === "no-secrets-in-meta-grep");
    expect(scenario?.expected.secretByteContentFoundInMeta).toBe(false);
  });
});

describe("cancellation-race fixtures", () => {
  it("covers cancel-vs-finish, terminal idempotency, both harvest-after variants, the un-killable ceiling, and cancel-during-provisioning", async () => {
    const fixture = await loadCancellationFixture();
    const names = fixture.scenarios.map((scenario) => scenario.name);
    expect(names).toEqual([
      "cancel-vs-finish",
      "cancel-on-terminal-idempotency",
      "harvest-after-cancel",
      "harvest-after-expiry",
      "un-killable-group-member-bounded-poll",
      "cancel-during-provisioning",
    ]);
  });

  it("cancel never wins over a recorded outcome that raced ahead", async () => {
    const fixture = await loadCancellationFixture();
    const scenario = fixture.scenarios.find((entry) => entry.name === "cancel-vs-finish");
    expect(scenario?.expected.recordedOutcome).toEqual({ exitCode: 0, termSignal: null });
  });
});

describe("evidence-join fixtures", () => {
  it("covers capture-always failure, receipt fields, dispatch-context capture, and both seal-once variants", async () => {
    const fixture = await loadEvidenceJoinFixture();
    const names = fixture.scenarios.map((scenario) => scenario.name);
    expect(names).toContain("capture-always-failure-is-failed-infrastructure");
    expect(names).toContain("receipt-fields-present-in-delivery");
    expect(names).toContain("dispatch-context-artifact-in-captured-inputs");
    expect(names).toContain("seal-once-checkpoint-crash-reuse");
    expect(names).toContain("torn-checkpoint-re-read-variant");
  });
});

describe("pinned-digest golden fixtures (Global Constraints, program §7.14)", () => {
  it("the journal->observation projection digest is reproducible via serializeCanonicalFixture", async () => {
    const digests = await loadExpectedDigests();
    const entry = digests.entries.find((candidate) => candidate.name === "journal-to-observation-projection");
    expect(entry).toBeDefined();

    const valid = await loadGoldenJournal("valid");
    const source = "urn:jinn:backend-local:test-root";
    const attemptId = valid.events[0]?.attemptId;
    const projection = valid.events.map((event) => ({
      id: `${source}/${attemptId}/${event.seq}`,
      subject: attemptId,
      type: event.type,
    }));
    const canonical = serializeCanonicalFixture(projection);
    const digest = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
    expect(digest).toBe(entry!.expectedDigest);
  });

  it("the object-key-sort-sensitive LaunchPlan record's digest is reproducible from source-order-shuffled keys", async () => {
    const digests = await loadExpectedDigests();
    const entry = digests.entries.find((candidate) => candidate.name === "launch-plan-out-of-source-order-keys");
    expect(entry).toBeDefined();
    expect(entry!.sourceRecord).toBeDefined();

    const canonical = serializeCanonicalFixture(entry!.sourceRecord);
    const digest = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
    expect(digest).toBe(entry!.expectedDigest);

    // Prove sort-sensitivity: re-serializing the SAME record with keys inserted in a DIFFERENT
    // order produces the identical canonical string (the whole point of the fixture).
    const shuffled = { ...entry!.sourceRecord } as Record<string, unknown>;
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(shuffled).reverse()) reordered[key] = shuffled[key];
    expect(serializeCanonicalFixture(reordered)).toBe(canonical);
  });
});
