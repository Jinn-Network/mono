import { compareCodeUnitStrings, type MatrixRecord } from "@jinn-network/benchmarking-records";

export interface CellRef {
  readonly cellKey: string;
  readonly taskDigest: string;
  readonly armId: string;
  readonly replicate: number;
}

export interface ExcludedReport {
  readonly count: number;
  readonly cellKeys: readonly string[];
}

/**
 * §9.3 exclusion discipline: only `judged` cells enter any score. `unjudged`, `unscorable`,
 * `expired`, `invalidated`, and `excluded` never enter a denominator — this is the structural
 * gate over the Matrix's own outcome field; a `judged` cell's valid verdicts can still turn out
 * `conflicted` under the contract-wide `verdictRule` (see `reduceValidVerdicts`), which is a
 * separate, later gate a Method applies per scored cell.
 */
export function selectScorableCells(matrix: MatrixRecord): { scored: CellRef[]; excluded: ExcludedReport } {
  const scored: CellRef[] = [];
  const excludedKeys: string[] = [];
  for (const cell of matrix.cells) {
    const ref: CellRef = { cellKey: cell.cellKey, taskDigest: cell.taskDigest, armId: cell.armId, replicate: cell.replicate };
    if (cell.outcome === "judged") scored.push(ref);
    else excludedKeys.push(cell.cellKey);
  }
  excludedKeys.sort(compareCodeUnitStrings);
  return { scored, excluded: { count: excludedKeys.length, cellKeys: excludedKeys } };
}
