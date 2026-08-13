import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BenchmarkProductError } from "../errors.js";
import { appendFsyncedLineSync } from "../fs/atomic.js";
import { runJournalPath } from "../workspace/layout.js";
import {
  appendRunJournalEntry,
  evaluationGaps,
  foldRunJournalLineage,
  foldRunJournal,
  outstandingCells,
  readRunJournalEntries,
  type RunJournalEntry,
} from "./journal.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp12-run-journal-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

const HEX = (byte: string) => byte.repeat(64);
const CELL_A = `${HEX("a")}/arm-a/1`;
const CELL_B = `${HEX("b")}/arm-a/1`;

describe("append / read round trip", () => {
  test("an absent journal reads as empty", () => {
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toEqual([]);
  });

  test("appends land in file order and read back identically", () => {
    const entries: RunJournalEntry[] = [
      { kind: "launched", at: "2026-08-05T00:00:00Z" },
      {
        kind: "cell-event",
        at: "2026-08-05T00:00:01Z",
        event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "dispatch", attempt: "urn:jinn:attempt:1" },
      },
      { kind: "closed", at: "2026-08-05T00:10:00Z", matrixSha256: HEX("c") },
    ];
    for (const entry of entries) appendRunJournalEntry(workspaceDir, "draft-1", entry);
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toEqual(entries);
  });

  test("evaluation entries with evaluator + evalIndex round-trip; legacy entries without them stay valid (BP-21)", () => {
    const entries: RunJournalEntry[] = [
      // Legacy shape — no evaluator, no evalIndex.
      { kind: "evaluation", at: "2026-08-05T00:00:00Z", cellKey: CELL_A, evalTaskSha256: HEX("f"), verdictSha256: HEX("1") },
      // BP-21 shape — per-leg attribution.
      {
        kind: "evaluation",
        at: "2026-08-05T00:00:01Z",
        cellKey: CELL_A,
        evalTaskSha256: HEX("f"),
        verdictSha256: HEX("2"),
        evaluator: "urn:jinn:benchmark-product:local-venue:evaluator-2",
        evalIndex: 2,
      },
    ];
    for (const entry of entries) appendRunJournalEntry(workspaceDir, "draft-1", entry);
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toEqual(entries);
  });

  test("submission-accepted entries with a leg round-trip; legacy entries without one stay valid (BP-21)", () => {
    const entries: RunJournalEntry[] = [
      // Legacy shape — no leg.
      { kind: "submission-accepted", at: "2026-08-05T00:00:00Z", cellKey: CELL_A, dispatch: 1, submissionSha256: HEX("9") },
      {
        kind: "submission-accepted",
        at: "2026-08-05T00:00:01Z",
        cellKey: CELL_A,
        dispatch: 1,
        submissionSha256: HEX("8"),
        pinningEvidenceSha256: HEX("6"),
        leg: "solve",
      },
      { kind: "submission-accepted", at: "2026-08-05T00:00:02Z", cellKey: CELL_A, dispatch: 1, submissionSha256: HEX("7"), leg: "evaluation" },
    ];
    for (const entry of entries) appendRunJournalEntry(workspaceDir, "draft-1", entry);
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toEqual(entries);
  });

  test("a submission acceptance counts its dispatch before the matching event and never double-counts it", () => {
    const entries: RunJournalEntry[] = [
      { kind: "submission-accepted", at: "2026-08-05T00:00:00Z", cellKey: CELL_A, dispatch: 1, submissionSha256: HEX("9"), leg: "solve" },
      {
        kind: "cell-event",
        at: "2026-08-05T00:00:01Z",
        event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "dispatch" },
      },
    ];
    expect(foldRunJournal(entries).get(CELL_A)?.dispatches).toBe(1);
  });

  test("cancel-requested entries round-trip (BP-22)", () => {
    const entries: RunJournalEntry[] = [
      { kind: "launched", at: "2026-08-05T00:00:00Z" },
      { kind: "cancel-requested", at: "2026-08-05T00:05:00Z" },
    ];
    for (const entry of entries) appendRunJournalEntry(workspaceDir, "draft-1", entry);
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toEqual(entries);
  });

  test("a cell-event entry carrying blame round-trips; one without blame stays valid (BP-22)", () => {
    const entries: RunJournalEntry[] = [
      {
        kind: "cell-event",
        at: "2026-08-05T00:00:00Z",
        event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "error", replaceable: false, detail: "exit 7" },
        blame: "task",
      },
      {
        kind: "cell-event",
        at: "2026-08-05T00:00:01Z",
        event: { cellKey: CELL_B, armId: "arm-a", replicate: 1, dispatch: 1, kind: "error", replaceable: false, detail: "SIGKILL" },
        blame: "infrastructure",
      },
      // No blame at all — the pre-BP-22 shape stays valid.
      {
        kind: "cell-event",
        at: "2026-08-05T00:00:02Z",
        event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "dispatch", attempt: "att-1" },
      },
    ];
    for (const entry of entries) appendRunJournalEntry(workspaceDir, "draft-1", entry);
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toEqual(entries);
  });

  test("blame is rejected unless the cell-event kind is error", () => {
    expect(() => appendRunJournalEntry(workspaceDir, "draft-1", {
      kind: "cell-event",
      at: "2026-08-05T00:00:00Z",
      event: {
        cellKey: CELL_A,
        armId: "arm-a",
        replicate: 1,
        dispatch: 1,
        kind: "delivered",
      },
      blame: "infrastructure",
    })).toThrow();
  });

  test("appendRunJournalEntry refuses validation on a malformed entry", () => {
    expect(() =>
      // @ts-expect-error deliberately malformed for the refusal test
      appendRunJournalEntry(workspaceDir, "draft-1", { kind: "launched" }),
    ).toThrowError();
  });

  test("readRunJournalEntries refuses journal-integrity on a corrupt line", () => {
    appendFsyncedLineSync(runJournalPath(workspaceDir, "draft-1"), "not json");
    try {
      readRunJournalEntries(workspaceDir, "draft-1");
      expect.unreachable("expected a refusal");
    } catch (cause) {
      expect(cause).toBeInstanceOf(BenchmarkProductError);
      expect((cause as BenchmarkProductError).code).toBe("journal-integrity");
    }
  });

  test("readRunJournalEntries refuses journal-integrity on a line failing the schema", () => {
    appendFsyncedLineSync(runJournalPath(workspaceDir, "draft-1"), JSON.stringify({ kind: "launched" }));
    try {
      readRunJournalEntries(workspaceDir, "draft-1");
      expect.unreachable("expected a refusal");
    } catch (cause) {
      expect(cause).toBeInstanceOf(BenchmarkProductError);
      expect((cause as BenchmarkProductError).code).toBe("journal-integrity");
    }
  });
});

describe("publication dispatch lineage", () => {
  test("preserves initial, replacement, and resumed dispatch captures while legacy fold selects current", () => {
    const entries: RunJournalEntry[] = [
      { kind: "submission-captured", at: "2026-08-13T00:00:00Z", cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, submissionSha256: HEX("1") },
      { kind: "submission-accepted", at: "2026-08-13T00:00:01Z", cellKey: CELL_A, dispatch: 1, submissionSha256: HEX("1"), leg: "solve" },
      { kind: "observation-accepted", at: "2026-08-13T00:00:02Z", cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, submissionSha256: HEX("1"), observationArchiveSha256: HEX("a"), attempt: "urn:uuid:attempt-1" },
      { kind: "cell-event", at: "2026-08-13T00:00:03Z", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "error", replaceable: true, replaceableReason: "expired" } },
      { kind: "submission-captured", at: "2026-08-13T00:01:00Z", cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 2, submissionSha256: HEX("2") },
      { kind: "submission-accepted", at: "2026-08-13T00:01:01Z", cellKey: CELL_A, dispatch: 2, submissionSha256: HEX("2"), leg: "solve" },
      { kind: "observation-accepted", at: "2026-08-13T00:01:02Z", cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 2, submissionSha256: HEX("2"), observationArchiveSha256: HEX("b"), attempt: "urn:uuid:attempt-2" },
      // A resumed generator reports the same durable dispatch rather than creating a third one.
      { kind: "cell-event", at: "2026-08-13T00:01:03Z", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 2, kind: "delivered", attempt: "urn:uuid:attempt-2" } },
    ];
    const lineage = foldRunJournalLineage(entries).get(CELL_A);
    expect(lineage).toHaveLength(2);
    expect(lineage?.map((dispatch) => dispatch.observationArchiveSha256)).toEqual([HEX("a"), HEX("b")]);
    expect(foldRunJournal(entries).get(CELL_A)?.lastDispatch).toBe(2);
  });
});

describe("foldRunJournal — per-cell status", () => {
  test("a cell with only a dispatch event is 'dispatched'", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "dispatch", attempt: "att-1" } },
    ]);
    expect(fold.get(CELL_A)).toMatchObject({ status: "dispatched", dispatches: 1, lastDispatch: 1, attempt: "att-1" });
  });

  test("dispatch -> claimed -> delivered folds to 'delivered' with attempt carried through", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "dispatch", attempt: "att-1" } },
      { kind: "cell-event", at: "t1", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "claimed", attempt: "att-1" } },
      { kind: "cell-event", at: "t2", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-1" } },
    ]);
    expect(fold.get(CELL_A)).toMatchObject({ status: "delivered", dispatches: 1, attempt: "att-1" });
  });

  test("an error terminal with replaceableReason 'expired' folds to 'expired'", () => {
    const fold = foldRunJournal([
      {
        kind: "cell-event",
        at: "t0",
        event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "error", replaceable: true, replaceableReason: "expired", detail: "expired" },
      },
    ]);
    expect(fold.get(CELL_A)).toMatchObject({ status: "expired", detail: "expired" });
  });

  test("an error terminal without a replaceable reason folds to 'failed'", () => {
    const fold = foldRunJournal([
      {
        kind: "cell-event",
        at: "t0",
        event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "error", replaceable: false, detail: "rejected" },
      },
    ]);
    expect(fold.get(CELL_A)).toMatchObject({ status: "failed", detail: "rejected" });
  });

  test("cancellation folds to 'cancelled'", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "cancelled", detail: "run-cancelled" } },
    ]);
    expect(fold.get(CELL_A)).toMatchObject({ status: "cancelled" });
  });

  test("blame on an error entry is folded onto the cell (BP-22)", () => {
    const fold = foldRunJournal([
      {
        kind: "cell-event",
        at: "t0",
        event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "error", replaceable: false, detail: "SIGKILL" },
        blame: "infrastructure",
      },
    ]);
    expect(fold.get(CELL_A)).toMatchObject({ status: "failed", blame: "infrastructure" });
  });

  test("an error entry with no blame folds with blame absent", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "error", replaceable: false, detail: "exit 7" } },
    ]);
    expect(fold.get(CELL_A)?.blame).toBeUndefined();
  });

  test("a fresh dispatch resets blame from the prior (replaceable) attempt", () => {
    const fold = foldRunJournal([
      {
        kind: "cell-event",
        at: "t0",
        event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "error", replaceable: true, replaceableReason: "expired", detail: "expired" },
        blame: "infrastructure",
      },
      { kind: "cell-event", at: "t1", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 2, kind: "dispatch", attempt: "att-2" } },
    ]);
    const cell = fold.get(CELL_A);
    expect(cell?.blame).toBeUndefined();
    expect(cell).toMatchObject({ status: "dispatched", dispatches: 1, lastDispatch: 2 });
  });

  test("cancel-requested entries carry no per-cell accounting and do not disturb the fold", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "dispatch", attempt: "att-1" } },
      { kind: "cancel-requested", at: "t1" },
      { kind: "cell-event", at: "t2", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "cancelled", detail: "drain-to-boundary" } },
    ]);
    expect(fold.size).toBe(1);
    expect(fold.get(CELL_A)).toMatchObject({ status: "cancelled", dispatches: 1 });
  });

  test("a delivered cell with a later evaluation verdict folds to 'judged' and carries the verdict digest", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-1" } },
      { kind: "delivery", at: "t1", cellKey: CELL_A, dispatch: 1, attempt: "att-1", deliverySha256: HEX("d"), outputs: [{ name: "prediction", sha256: HEX("e") }] },
      { kind: "evaluation", at: "t2", cellKey: CELL_A, evalTaskSha256: HEX("f"), verdictSha256: HEX("1") },
    ]);
    expect(fold.get(CELL_A)).toMatchObject({
      status: "judged",
      deliverySha256: HEX("d"),
      deliveryOutputs: [{ name: "prediction", sha256: HEX("e") }],
      verdictSha256: HEX("1"),
    });
  });

  test("a delivered cell whose evaluation could not grade stays 'delivered' with the terminal fact recorded", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-1" } },
      { kind: "evaluation", at: "t1", cellKey: CELL_A, evalTaskSha256: HEX("f"), evaluationTerminal: "could-not-grade", detail: "eval-attempt-expired" },
    ]);
    expect(fold.get(CELL_A)).toMatchObject({
      status: "delivered",
      evaluationTerminal: "could-not-grade",
      detail: "eval-attempt-expired",
    });
  });

  test("a replacement dispatch clears the prior attempt's terminal accounting", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "error", replaceable: true, replaceableReason: "expired", detail: "expired" } },
      { kind: "cell-event", at: "t1", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 2, kind: "dispatch", attempt: "att-2" } },
    ]);
    const cell = fold.get(CELL_A);
    expect(cell).toMatchObject({ status: "dispatched", dispatches: 1, lastDispatch: 2, attempt: "att-2" });
    expect(cell?.detail).toBeUndefined();
  });

  test("submission-accepted alone (crash before the dispatch cell-event lands) still tracks the dispatch number", () => {
    const fold = foldRunJournal([
      { kind: "submission-accepted", at: "t0", cellKey: CELL_A, dispatch: 1, submissionSha256: HEX("9") },
    ]);
    expect(fold.get(CELL_A)).toMatchObject({ status: "dispatched", lastDispatch: 1, submissionSha256: HEX("9") });
  });

  test("folds solve pinning evidence without letting evaluation legs overwrite it", () => {
    const fold = foldRunJournal([
      {
        kind: "submission-accepted",
        at: "t0",
        cellKey: CELL_A,
        dispatch: 1,
        submissionSha256: HEX("9"),
        pinningEvidenceSha256: HEX("6"),
        leg: "solve",
      },
      {
        kind: "submission-accepted",
        at: "t1",
        cellKey: CELL_A,
        dispatch: 1,
        submissionSha256: HEX("8"),
        pinningEvidenceSha256: HEX("5"),
        leg: "evaluation",
      },
    ]);
    expect(fold.get(CELL_A)).toMatchObject({
      submissionSha256: HEX("9"),
      pinningEvidenceSha256: HEX("6"),
    });
  });

  test("a later solve dispatch without proof clears the prior dispatch's evidence", () => {
    const fold = foldRunJournal([
      {
        kind: "submission-accepted",
        at: "t0",
        cellKey: CELL_A,
        dispatch: 1,
        submissionSha256: HEX("9"),
        pinningEvidenceSha256: HEX("6"),
        leg: "solve",
      },
      {
        kind: "submission-accepted",
        at: "t1",
        cellKey: CELL_A,
        dispatch: 2,
        submissionSha256: HEX("8"),
        leg: "solve",
      },
    ]);
    expect(fold.get(CELL_A)?.pinningEvidenceSha256).toBeUndefined();
  });
});

describe("foldRunJournal — multi-leg evaluation accounting (BP-21)", () => {
  test("verdicts accumulate in journal order with evaluator + evalIndex; verdictSha256 bridges to the FIRST verdict", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-1" } },
      { kind: "evaluation", at: "t1", cellKey: CELL_A, evalTaskSha256: HEX("f"), verdictSha256: HEX("1"), evaluator: "urn:e:1", evalIndex: 1 },
      { kind: "evaluation", at: "t2", cellKey: CELL_A, evalTaskSha256: HEX("f"), verdictSha256: HEX("2"), evaluator: "urn:e:2", evalIndex: 2 },
    ]);
    const cell = fold.get(CELL_A);
    expect(cell?.verdicts).toEqual([
      { sha256: HEX("1"), evaluator: "urn:e:1", evalIndex: 1 },
      { sha256: HEX("2"), evaluator: "urn:e:2", evalIndex: 2 },
    ]);
    expect(cell?.verdictSha256).toBe(HEX("1"));
    expect(cell?.completedEvalIndexes).toEqual([1, 2]);
    expect(cell?.status).toBe("judged");
  });

  test("a legacy evaluation entry without evalIndex counts as index 1", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-1" } },
      { kind: "evaluation", at: "t1", cellKey: CELL_A, evalTaskSha256: HEX("f"), verdictSha256: HEX("1") },
    ]);
    const cell = fold.get(CELL_A);
    expect(cell?.verdicts).toEqual([{ sha256: HEX("1") }]);
    expect(cell?.completedEvalIndexes).toEqual([1]);
  });

  test("a could-not-grade leg completes its index without adding a verdict; evaluationTerminal is set", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-1" } },
      { kind: "evaluation", at: "t1", cellKey: CELL_A, verdictSha256: HEX("1"), evaluator: "urn:e:1", evalIndex: 1 },
      { kind: "evaluation", at: "t2", cellKey: CELL_A, evaluationTerminal: "could-not-grade", detail: "leg 2 failed", evaluator: "urn:e:2", evalIndex: 2 },
    ]);
    const cell = fold.get(CELL_A);
    expect(cell?.verdicts).toEqual([{ sha256: HEX("1"), evaluator: "urn:e:1", evalIndex: 1 }]);
    expect(cell?.completedEvalIndexes).toEqual([1, 2]);
    expect(cell?.evaluationTerminal).toBe("could-not-grade");
  });

  test("a submission-accepted entry with leg 'evaluation' does NOT clobber the solve submission digest", () => {
    const fold = foldRunJournal([
      { kind: "submission-accepted", at: "t0", cellKey: CELL_A, dispatch: 1, submissionSha256: HEX("9"), leg: "solve" },
      { kind: "submission-accepted", at: "t1", cellKey: CELL_A, dispatch: 1, submissionSha256: HEX("8"), leg: "evaluation" },
    ]);
    expect(fold.get(CELL_A)?.submissionSha256).toBe(HEX("9"));
  });

  test("a legacy submission-accepted entry without a leg keeps the old last-wins behavior", () => {
    const fold = foldRunJournal([
      { kind: "submission-accepted", at: "t0", cellKey: CELL_A, dispatch: 1, submissionSha256: HEX("9") },
      { kind: "submission-accepted", at: "t1", cellKey: CELL_A, dispatch: 1, submissionSha256: HEX("8") },
    ]);
    expect(fold.get(CELL_A)?.submissionSha256).toBe(HEX("8"));
  });

  test("a fresh dispatch resets the verdicts array and completedEvalIndexes along with the rest", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-1" } },
      { kind: "evaluation", at: "t1", cellKey: CELL_A, verdictSha256: HEX("1"), evaluator: "urn:e:1", evalIndex: 1 },
      { kind: "cell-event", at: "t2", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 2, kind: "dispatch", attempt: "att-2" } },
    ]);
    const cell = fold.get(CELL_A);
    expect(cell?.verdicts).toEqual([]);
    expect(cell?.completedEvalIndexes).toEqual([]);
    expect(cell?.verdictSha256).toBeUndefined();
  });
});

const EXPECTED = [
  { cellKey: CELL_A, armId: "arm-a", replicate: 1, taskDigest: HEX("a") },
  { cellKey: CELL_B, armId: "arm-a", replicate: 1, taskDigest: HEX("b") },
];

describe("outstandingCells", () => {
  test("a never-dispatched expected cell is outstanding at dispatch 1", () => {
    const fold = foldRunJournal([]);
    const outstanding = outstandingCells(EXPECTED, fold);
    expect(outstanding).toEqual([
      { cellKey: CELL_A, armId: "arm-a", replicate: 1, taskDigest: HEX("a"), dispatch: 1 },
      { cellKey: CELL_B, armId: "arm-a", replicate: 1, taskDigest: HEX("b"), dispatch: 1 },
    ]);
  });

  test("a delivered cell is not outstanding even without an evaluation entry yet", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-1" } },
    ]);
    const outstanding = outstandingCells(EXPECTED, fold);
    expect(outstanding.map((cell) => cell.cellKey)).toEqual([CELL_B]);
  });

  test("a fully judged cell is not outstanding", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-1" } },
      { kind: "evaluation", at: "t1", cellKey: CELL_A, evalTaskSha256: HEX("f"), verdictSha256: HEX("1") },
    ]);
    const outstanding = outstandingCells(EXPECTED, fold);
    expect(outstanding.map((cell) => cell.cellKey)).toEqual([CELL_B]);
  });

  test("an in-flight (dispatched, no terminal) cell resumes at its same dispatch number", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "dispatch", attempt: "att-1" } },
    ]);
    const outstanding = outstandingCells(EXPECTED, fold);
    const cellA = outstanding.find((cell) => cell.cellKey === CELL_A);
    expect(cellA).toEqual({ cellKey: CELL_A, armId: "arm-a", replicate: 1, taskDigest: HEX("a"), dispatch: 1 });
  });

  test("an expired (replaceable) cell resumes at a FRESH incremented dispatch number", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "error", replaceable: true, replaceableReason: "expired" } },
    ]);
    const outstanding = outstandingCells(EXPECTED, fold);
    const cellA = outstanding.find((cell) => cell.cellKey === CELL_A);
    expect(cellA?.dispatch).toBe(2);
  });

  test("a cancelled cell is not outstanding (a non-replaceable terminal)", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "cancelled" } },
    ]);
    const outstanding = outstandingCells(EXPECTED, fold);
    expect(outstanding.map((cell) => cell.cellKey)).toEqual([CELL_B]);
  });

  test("a failed (non-replaceable error) cell is not outstanding", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "error", replaceable: false } },
    ]);
    const outstanding = outstandingCells(EXPECTED, fold);
    expect(outstanding.map((cell) => cell.cellKey)).toEqual([CELL_B]);
  });
});

describe("evaluationGaps", () => {
  test("a delivered cell with no evaluation legs at all is missing every index 1..minVerdicts", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-1" } },
    ]);
    const gaps = evaluationGaps(fold, 3);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.cell.cellKey).toBe(CELL_A);
    expect(gaps[0]?.missingEvalIndexes).toEqual([1, 2, 3]);
  });

  test("a partially evaluated cell (1 of 3 legs done) is missing exactly the uncovered indexes, ascending", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-1" } },
      { kind: "evaluation", at: "t1", cellKey: CELL_A, verdictSha256: HEX("1"), evaluator: "urn:e:1", evalIndex: 1 },
    ]);
    const gaps = evaluationGaps(fold, 3);
    // The first verdict flips the fold's status to "judged" — a judged cell with uncovered
    // legs is still a gap (status is a solve-side summary, not per-leg accounting).
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.missingEvalIndexes).toEqual([2, 3]);
  });

  test("empty when every leg is covered (verdict or could-not-grade)", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-1" } },
      { kind: "evaluation", at: "t1", cellKey: CELL_A, verdictSha256: HEX("1"), evaluator: "urn:e:1", evalIndex: 1 },
      { kind: "evaluation", at: "t2", cellKey: CELL_A, evaluationTerminal: "could-not-grade", evaluator: "urn:e:2", evalIndex: 2 },
    ]);
    expect(evaluationGaps(fold, 2)).toEqual([]);
  });

  test("legacy single-entry folds (no evalIndex) satisfy minVerdicts 1 exactly as before", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-1" } },
      { kind: "cell-event", at: "t1", event: { cellKey: CELL_B, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-2" } },
      { kind: "evaluation", at: "t2", cellKey: CELL_B, evalTaskSha256: HEX("f"), verdictSha256: HEX("1") },
    ]);
    const gaps = evaluationGaps(fold, 1);
    expect(gaps.map((gap) => gap.cell.cellKey)).toEqual([CELL_A]);
    expect(gaps[0]?.missingEvalIndexes).toEqual([1]);
  });

  test("a legacy could-not-grade entry (no evalIndex) covers index 1 — not a gap at minVerdicts 1", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-1" } },
      { kind: "evaluation", at: "t1", cellKey: CELL_A, evalTaskSha256: HEX("f"), evaluationTerminal: "could-not-grade" },
    ]);
    expect(evaluationGaps(fold, 1)).toEqual([]);
  });

  test("non-delivered cells (dispatched, failed, cancelled) are never gaps", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "dispatch", attempt: "att-1" } },
      { kind: "cell-event", at: "t1", event: { cellKey: CELL_B, armId: "arm-a", replicate: 1, dispatch: 1, kind: "error", replaceable: false } },
    ]);
    expect(evaluationGaps(fold, 2)).toEqual([]);
  });
});
