// SPDX-License-Identifier: Apache-2.0

/**
 * Validates an external harness's run dump against the sealed slate (#2979).
 *
 * The rule this module exists to enforce: **every expected slot appears exactly once, and there is
 * no exclude flag.** A run's denominator is fixed at seal time by `expectedCellSet(benchmark, run)`.
 * An import that let the operator drop the slots their harness could not produce would let them
 * publish a number computed over a slate they chose after seeing the results — the exact move the
 * sealed slate exists to prevent. A slot the harness could not supply is imported with outcome
 * `error`, `timeout`, or `unrun` and a non-blank reason, and it counts.
 *
 * The refusal follows the shape `admitDeclaredCells` set in
 * `../method/skillsbench-demo1-declaration.ts`: collect EVERY problem in one pass and report them
 * all at once. First-failure reporting is worse than useless here — it turns a broken dump into a
 * repair-and-retry loop where each round shows one more problem and the operator never sees the
 * shape of what went wrong.
 *
 * This module is validation only. Journal and record synthesis from an accepted plan is a separate
 * concern and lives elsewhere; on refusal nothing at all is written.
 */

import {
  expectedCellSet,
  isCalendarStrictRfc3339,
  parseCellKey,
  type BenchmarkRecord,
  type CellCoord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import { BenchmarkProductError, type ProductIssue } from "../errors.js";
import {
  EXTERNAL_RUN_IMPORT_OUTCOMES,
  type ExternalRunImportOutcome,
  type ExternalRunRecord,
} from "../intake/external-run-records.js";

export interface ValidateExternalRunRecordsInput {
  /** The normalized rows, in dump order, from `readExternalRunRecords`. */
  readonly records: readonly ExternalRunRecord[];
  /** The sealed benchmark; with `run` it fixes the slate via `expectedCellSet`. */
  readonly benchmark: BenchmarkRecord;
  readonly run: RunRecord;
  /** The sealed coordinates, `sha256:`-prefixed, quoted verbatim in the refusal. */
  readonly benchmarkSha256: string;
  readonly runSha256: string;
}

/** One accepted slot: the expected coordinate joined to the row that supplied it. */
export interface ExternalRunImportCell {
  readonly cellKey: string;
  readonly coord: CellCoord;
  readonly outcome: ExternalRunImportOutcome;
  readonly record: ExternalRunRecord;
}

/** What an accepted dump becomes: every expected slot, once, in expected-cell order. */
export interface ExternalRunImportPlan {
  readonly cells: readonly ExternalRunImportCell[];
  readonly byCellKey: ReadonlyMap<string, ExternalRunImportCell>;
  readonly expectedSlotCount: number;
  readonly rowCount: number;
  readonly benchmarkSha256: string;
  readonly runSha256: string;
}

/** The problem taxonomy, carried on `issues[].path` so callers branch on codes, never on prose. */
export const EXTERNAL_RUN_IMPORT_PROBLEMS = [
  "unparseable-slot",
  "unknown-slot",
  "duplicate-slot",
  "missing-slot",
  "unknown-outcome",
  "missing-reason",
  "forbidden-reason",
  "missing-evidence",
  "forbidden-evidence",
  "missing-measurements",
  "forbidden-measurements",
  "inconsistent-timing",
] as const;

export type ExternalRunImportProblemCode = (typeof EXTERNAL_RUN_IMPORT_PROBLEMS)[number];

/** The closing three lines are load-bearing: they name the ONLY sanctioned way to not have a
 * result for a slot, so an operator reading the refusal cannot conclude that dropping it is one. */
const REMEDY =
  "Every expected slot must appear exactly once. There is no exclude flag.\n" +
  'A slot you cannot supply is recorded with outcome "error", "timeout", or "unrun"\n' +
  "and a non-blank reason; it is counted in the denominator exactly like every other slot.";

/** Slot-level labels are padded to a common width so the keys line up under each other. */
const LABEL_WIDTH = 15;

const OUTCOME_LIST = EXTERNAL_RUN_IMPORT_OUTCOMES.join(", ");

function isOutcome(value: string): value is ExternalRunImportOutcome {
  return (EXTERNAL_RUN_IMPORT_OUTCOMES as readonly string[]).includes(value);
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/**
 * Validates the dump against the slate, reporting every problem at once.
 *
 * Returns a plan on success; throws `BenchmarkProductError` (code `validation`, one issue per
 * problem) otherwise. It writes nothing either way.
 */
export function validateExternalRunRecords(
  input: ValidateExternalRunRecordsInput,
): ExternalRunImportPlan {
  const { records, benchmark, run, benchmarkSha256, runSha256 } = input;
  const expected = expectedCellSet(benchmark, run);
  const expectedByKey = new Map(expected.map((coord) => [coord.cellKey, coord]));

  const slotProblems: ProductIssue[] = [];
  const rowProblems: ProductIssue[] = [];
  /** First row to name each expected slot; a later row naming it again is the duplicate. */
  const claimedBy = new Map<string, ExternalRunRecord>();

  for (const record of records) {
    const at = `row ${record.row}`;

    // --- slot ---------------------------------------------------------------------------------
    let wellFormed = true;
    try {
      parseCellKey(record.cellKey);
    } catch (error) {
      wellFormed = false;
      rowProblems.push({
        path: "unparseable-slot",
        message: `${at}: cellKey "${record.cellKey}" is malformed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
    if (wellFormed) {
      if (!expectedByKey.has(record.cellKey)) {
        slotProblems.push({
          path: "unknown-slot",
          message: `${"unknown slot".padEnd(LABEL_WIDTH)}${record.cellKey} (not in the sealed slate)`,
        });
      } else {
        const first = claimedBy.get(record.cellKey);
        if (first === undefined) {
          claimedBy.set(record.cellKey, record);
        } else {
          slotProblems.push({
            path: "duplicate-slot",
            message: `${"duplicate slot".padEnd(LABEL_WIDTH)}${record.cellKey} (rows ${first.row} and ${record.row})`,
          });
        }
      }
    }

    // --- shape --------------------------------------------------------------------------------
    // Checked for EVERY row, including rows whose slot is unknown or malformed: an operator fixing
    // a dump wants the whole list, not the subset that happened to land on a real slot.
    if (!isOutcome(record.outcome)) {
      rowProblems.push({
        path: "unknown-outcome",
        message: `${at}: outcome "${record.outcome}" is not one of ${OUTCOME_LIST}`,
      });
    } else {
      const graded = record.outcome === "graded";
      const carriesEvidence = record.outcome === "graded" || record.outcome === "ungradeable";

      if (graded) {
        if (record.reason !== undefined) {
          rowProblems.push({
            path: "forbidden-reason",
            message: `${at}: outcome "graded" must not carry a reason`,
          });
        }
      } else if (isBlank(record.reason)) {
        rowProblems.push({
          path: "missing-reason",
          message: `${at}: outcome "${record.outcome}" requires a non-blank reason`,
        });
      }

      if (carriesEvidence && record.evidence === undefined) {
        rowProblems.push({
          path: "missing-evidence",
          message: `${at}: outcome "${record.outcome}" requires evidence`,
        });
      }
      if (!carriesEvidence && record.evidence !== undefined) {
        rowProblems.push({
          path: "forbidden-evidence",
          message: `${at}: outcome "${record.outcome}" must not carry evidence`,
        });
      }

      if (graded && record.measurements === undefined) {
        rowProblems.push({
          path: "missing-measurements",
          message: `${at}: outcome "graded" requires measurements`,
        });
      }
      if (!graded && record.measurements !== undefined) {
        rowProblems.push({
          path: "forbidden-measurements",
          message: `${at}: outcome "${record.outcome}" must not carry measurements`,
        });
      }
    }

    rowProblems.push(...timingProblems(record, at));
  }

  for (const coord of expected) {
    if (!claimedBy.has(coord.cellKey)) {
      slotProblems.push({
        path: "missing-slot",
        message: `${"missing slot".padEnd(LABEL_WIDTH)}${coord.cellKey}`,
      });
    }
  }

  // Slot-level problems lead (they describe the slate), grouped missing → unknown → duplicate so a
  // reader sees the denominator damage first; row-level problems follow in row order.
  const slotRank: Record<string, number> = { "missing-slot": 0, "unknown-slot": 1, "duplicate-slot": 2 };
  const problems = [
    ...[...slotProblems].sort((left, right) => (slotRank[left.path] ?? 3) - (slotRank[right.path] ?? 3)),
    ...rowProblems,
  ];
  if (problems.length > 0) {
    throw new BenchmarkProductError(
      "validation",
      [
        `external run import refused: ${problems.length} problems against the sealed slate`,
        `(benchmark ${benchmarkSha256}, run ${runSha256}, ${expected.length} expected slots,` +
          ` ${records.length} rows read).`,
        "",
        ...problems.map((problem) => `  ${problem.message}`),
        "",
        REMEDY,
      ].join("\n"),
      problems,
    );
  }

  const cells = expected.map((coord): ExternalRunImportCell => {
    const record = claimedBy.get(coord.cellKey)!;
    return { cellKey: coord.cellKey, coord, outcome: record.outcome as ExternalRunImportOutcome, record };
  });

  return {
    cells,
    byCellKey: new Map(cells.map((cell) => [cell.cellKey, cell])),
    expectedSlotCount: expected.length,
    rowCount: records.length,
    benchmarkSha256,
    runSha256,
  };
}

/**
 * Timing consistency. `startedAt`/`endedAt` are both-or-neither, must be calendar-strict RFC 3339,
 * must not run backwards, and when `durationMs` is also given it must equal the interval — a
 * duration that disagrees with its own timestamps means one of the two is fabricated, and we
 * cannot tell which.
 */
function timingProblems(record: ExternalRunRecord, at: string): ProductIssue[] {
  const problems: ProductIssue[] = [];
  const { startedAt, endedAt, durationMs } = record;

  if ((startedAt === undefined) !== (endedAt === undefined)) {
    problems.push({
      path: "inconsistent-timing",
      message: `${at}: startedAt and endedAt must be given together`,
    });
    return problems;
  }
  if (startedAt === undefined || endedAt === undefined) return problems;

  for (const [field, value] of [["startedAt", startedAt], ["endedAt", endedAt]] as const) {
    if (!isCalendarStrictRfc3339(value)) {
      problems.push({
        path: "inconsistent-timing",
        message: `${at}: ${field} "${value}" is not a calendar-valid RFC 3339 timestamp`,
      });
    }
  }
  if (problems.length > 0) return problems;

  const interval = Date.parse(endedAt) - Date.parse(startedAt);
  if (interval < 0) {
    problems.push({
      path: "inconsistent-timing",
      message: `${at}: endedAt precedes startedAt`,
    });
    return problems;
  }
  if (durationMs !== undefined && durationMs !== interval) {
    problems.push({
      path: "inconsistent-timing",
      message: `${at}: durationMs ${durationMs} disagrees with endedAt - startedAt (${interval})`,
    });
  }
  return problems;
}
