import { describe, expect, test } from "vitest";
import { selectScorableCells } from "./exclusion.js";
import type { MatrixRecord } from "@jinn-network/benchmarking-records";

function matrixWithOutcomes(outcomes: readonly string[]): MatrixRecord {
  return {
    cells: outcomes.map((outcome, index) => ({
      cellKey: `task${index}/armA/1`,
      taskDigest: `task${index}`,
      armId: "armA",
      replicate: 1,
      outcome,
    })),
  } as unknown as MatrixRecord;
}

describe("selectScorableCells (design §9.3 exclusion discipline)", () => {
  test("only judged cells are scorable", () => {
    const matrix = matrixWithOutcomes(["judged", "unjudged", "unscorable", "expired", "invalidated", "excluded"]);
    const { scored, excluded } = selectScorableCells(matrix);
    expect(scored.map((cell) => cell.cellKey)).toEqual(["task0/armA/1"]);
    expect(excluded.count).toBe(5);
    expect(excluded.cellKeys).toEqual([
      "task1/armA/1",
      "task2/armA/1",
      "task3/armA/1",
      "task4/armA/1",
      "task5/armA/1",
    ]);
  });

  test("all judged: nothing excluded", () => {
    const matrix = matrixWithOutcomes(["judged", "judged"]);
    const { scored, excluded } = selectScorableCells(matrix);
    expect(scored.length).toBe(2);
    expect(excluded).toEqual({ count: 0, cellKeys: [] });
  });

  test("none judged: nothing scored", () => {
    const matrix = matrixWithOutcomes(["unjudged", "expired"]);
    const { scored, excluded } = selectScorableCells(matrix);
    expect(scored).toEqual([]);
    expect(excluded.count).toBe(2);
  });

  test("excluded cellKeys are sorted (UTF-16 code-unit order)", () => {
    const matrix = matrixWithOutcomes(["unjudged"]);
    // Reorder cells so the natural array order is NOT sorted; the function must still sort.
    (matrix.cells as unknown[]).push({
      cellKey: "aaa/armA/1",
      taskDigest: "aaa",
      armId: "armA",
      replicate: 1,
      outcome: "unjudged",
    });
    const { excluded } = selectScorableCells(matrix);
    expect(excluded.cellKeys).toEqual(["aaa/armA/1", "task0/armA/1"]);
  });
});
