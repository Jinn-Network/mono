import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BenchmarkProductError } from "../errors.js";
import { appendFsyncedLineSync } from "../fs/atomic.js";
import { runJournalPath } from "../workspace/layout.js";
import {
  appendRunJournalEntry,
  deliveredWithoutEvaluation,
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

describe("deliveredWithoutEvaluation", () => {
  test("finds delivered cells missing an evaluation entry", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-1" } },
      { kind: "cell-event", at: "t1", event: { cellKey: CELL_B, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-2" } },
      { kind: "evaluation", at: "t2", cellKey: CELL_B, evalTaskSha256: HEX("f"), verdictSha256: HEX("1") },
    ]);
    const gap = deliveredWithoutEvaluation(fold);
    expect(gap.map((cell) => cell.cellKey)).toEqual([CELL_A]);
  });

  test("empty when every delivered cell has an evaluation entry", () => {
    const fold = foldRunJournal([
      { kind: "cell-event", at: "t0", event: { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-1" } },
      { kind: "evaluation", at: "t1", cellKey: CELL_A, evalTaskSha256: HEX("f"), evaluationTerminal: "could-not-grade" },
    ]);
    expect(deliveredWithoutEvaluation(fold)).toEqual([]);
  });
});
