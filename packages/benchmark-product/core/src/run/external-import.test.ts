/**
 * Slate validation for external run-record import (#2979).
 *
 * The property under test is the one `admitDeclaredCells` established for the demo-1 declaration:
 * a refusal lists EVERY problem and never shrinks the denominator. An importer that stopped at the
 * first bad row would let an operator repair-and-retry their way to a slate that quietly lost
 * cells; an importer with an exclude flag would let them do it in one step. Neither exists here.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expectedCellSet, type BenchmarkRecord, type RunRecord } from "@jinn-network/benchmarking-records";
import { BenchmarkProductError } from "../errors.js";
import type { ExternalRunRecord } from "../intake/external-run-records.js";
import {
  assertExternalRunImportSource,
  EXTERNAL_RUN_IMPORT_SOURCE_MAX_LENGTH,
  preflightExternalRunImport,
  validateExternalRunRecords,
} from "./external-import.js";

const DIGEST_1 = "9f0a".padEnd(64, "0");
const DIGEST_2 = "11cd".padEnd(64, "1");
const BENCHMARK_SHA = `sha256:${"aa".repeat(32)}`;
const RUN_SHA = `sha256:${"bb".repeat(32)}`;

/** `expectedCellSet` reads only `bench.items[].task.digest.sha256`, `run.arms[].armId`, and
 * `run.replicates`; a minimal cast keeps this a unit test of the validator (the precedent is
 * `assembly-ports.test.ts`, which casts the same way for the same reason). */
const BENCHMARK = {
  items: [
    { task: { digest: { sha256: DIGEST_1 } } },
    { task: { digest: { sha256: DIGEST_2 } } },
  ],
} as unknown as BenchmarkRecord;

const RUN = {
  arms: [{ armId: "alpha" }],
  replicates: 2,
  closeAt: "2030-01-01T00:00:00Z",
} as unknown as RunRecord;

/** Wide enough that every timestamp the other cases use falls inside it; the window cases below
 * supply their own tight bounds. */
const RUN_OPEN_AT = "2020-01-01T00:00:00Z";
const IMPORTED_AT = "2029-01-01T00:00:00Z";

const EXPECTED = expectedCellSet(BENCHMARK, RUN);

function row(index: number, overrides: Partial<ExternalRunRecord> = {}): ExternalRunRecord {
  return {
    row: index + 1,
    cellKey: EXPECTED[index]!.cellKey,
    outcome: "unrun",
    reason: "not attempted",
    ...overrides,
  };
}

/** Every expected slot, each carrying a well-formed non-graded record. */
function completeRows(): ExternalRunRecord[] {
  return EXPECTED.map((_, index) => row(index));
}

function validate(
  records: readonly ExternalRunRecord[],
  window: { readonly runOpenAt?: string; readonly run?: RunRecord; readonly importedAt?: string } = {},
) {
  return validateExternalRunRecords({
    records,
    benchmark: BENCHMARK,
    run: window.run ?? RUN,
    benchmarkSha256: BENCHMARK_SHA,
    runSha256: RUN_SHA,
    runOpenAt: window.runOpenAt ?? RUN_OPEN_AT,
    importedAt: window.importedAt ?? IMPORTED_AT,
  });
}

function refusal(
  records: readonly ExternalRunRecord[],
  window: Parameters<typeof validate>[1] = {},
): BenchmarkProductError {
  try {
    validate(records, window);
  } catch (error) {
    if (error instanceof BenchmarkProductError) return error;
    throw error;
  }
  throw new Error("expected a refusal, got a plan");
}

describe("validateExternalRunRecords — happy path", () => {
  it("returns a plan covering every expected cell exactly once, in expected-cell order", () => {
    const shuffled = [...completeRows()].reverse();
    const plan = validate(shuffled);
    expect(plan.cells.map((cell) => cell.cellKey)).toEqual(EXPECTED.map((coord) => coord.cellKey));
    expect(plan.expectedSlotCount).toBe(EXPECTED.length);
    expect(plan.rowCount).toBe(EXPECTED.length);
    expect(plan.byCellKey.size).toBe(EXPECTED.length);
    for (const coord of EXPECTED) {
      expect(plan.byCellKey.get(coord.cellKey)!.record.cellKey).toBe(coord.cellKey);
    }
  });

  it("accepts a graded row carrying evidence and measurements and no reason", () => {
    const rows = completeRows();
    rows[0] = row(0, {
      outcome: "graded",
      reason: undefined,
      evidence: [{ name: "log", path: "a.txt" }],
      measurements: { reward: 1 },
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:01Z",
      durationMs: 1000,
    });
    expect(validate(rows).byCellKey.get(EXPECTED[0]!.cellKey)!.outcome).toBe("graded");
  });
});

describe("validateExternalRunRecords — one problem code per case", () => {
  it("unparseable-slot", () => {
    const rows = completeRows();
    rows[0] = row(0, { cellKey: "not-a-cell-key" });
    expect(refusal(rows).message).toMatch(/row 1: cellKey "not-a-cell-key" is malformed/);
  });

  it("unknown-slot", () => {
    const rows = completeRows();
    const stranger = `${"cc".repeat(32)}/alpha/1`;
    rows[0] = row(0, { cellKey: stranger });
    expect(refusal(rows).message).toMatch(/unknown slot\s+cc.*\(not in the sealed slate\)/);
  });

  it("duplicate-slot names both rows", () => {
    const rows = completeRows();
    rows[1] = row(1, { cellKey: EXPECTED[0]!.cellKey });
    expect(refusal(rows).message).toMatch(/duplicate slot\s+\S+ \(rows 1 and 2\)/);
  });

  it("missing-slot", () => {
    const rows = completeRows().slice(0, -1);
    const message = refusal(rows).message;
    expect(message).toMatch(new RegExp(`missing slot\\s+${EXPECTED.at(-1)!.cellKey}`));
  });

  it("unknown-outcome", () => {
    const rows = completeRows();
    rows[0] = row(0, { outcome: "skipped" });
    expect(refusal(rows).message).toContain(
      'row 1: outcome "skipped" is not one of graded, ungradeable, error, timeout, unrun',
    );
  });

  it("missing-reason, including a blank one", () => {
    const blank = completeRows();
    blank[0] = row(0, { outcome: "timeout", reason: "   " });
    expect(refusal(blank).message).toContain('row 1: outcome "timeout" requires a non-blank reason');

    const absent = completeRows();
    absent[0] = row(0, { outcome: "timeout", reason: undefined });
    expect(refusal(absent).message).toContain('row 1: outcome "timeout" requires a non-blank reason');
  });

  it("forbidden-reason", () => {
    const rows = completeRows();
    rows[0] = row(0, {
      outcome: "graded",
      reason: "looked fine",
      evidence: [{ name: "log", path: "a" }],
      measurements: { reward: 1 },
    });
    expect(refusal(rows).message).toContain('row 1: outcome "graded" must not carry a reason');
  });

  it("missing-evidence", () => {
    const rows = completeRows();
    rows[0] = row(0, { outcome: "ungradeable", reason: "grader crashed" });
    expect(refusal(rows).message).toContain('row 1: outcome "ungradeable" requires evidence');
  });

  it("forbidden-evidence", () => {
    const rows = completeRows();
    rows[0] = row(0, { outcome: "error", reason: "boom", evidence: [{ name: "log", path: "a" }] });
    expect(refusal(rows).message).toContain('row 1: outcome "error" must not carry evidence');
  });

  it("missing-measurements", () => {
    const rows = completeRows();
    rows[0] = row(0, { outcome: "graded", reason: undefined, evidence: [{ name: "log", path: "a" }] });
    expect(refusal(rows).message).toContain('row 1: outcome "graded" requires measurements');
  });

  it("forbidden-measurements", () => {
    const rows = completeRows();
    rows[0] = row(0, { outcome: "unrun", reason: "x", measurements: { reward: 1 } });
    expect(refusal(rows).message).toContain('row 1: outcome "unrun" must not carry measurements');
  });

  it("inconsistent-timing — durationMs disagreeing with the interval", () => {
    const rows = completeRows();
    rows[0] = row(0, {
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:01Z",
      durationMs: 500,
    });
    expect(refusal(rows).message).toMatch(/row 1: durationMs 500 disagrees with endedAt - startedAt \(1000\)/);
  });

  it("inconsistent-timing — only one of the pair given", () => {
    const rows = completeRows();
    rows[0] = row(0, { startedAt: "2026-01-01T00:00:00Z" });
    expect(refusal(rows).message).toContain("row 1: startedAt and endedAt must be given together");
  });

  it("inconsistent-timing — endedAt before startedAt", () => {
    const rows = completeRows();
    rows[0] = row(0, { startedAt: "2026-01-01T00:00:01Z", endedAt: "2026-01-01T00:00:00Z" });
    expect(refusal(rows).message).toMatch(/row 1: endedAt precedes startedAt/);
  });
});

describe("validateExternalRunRecords — the refusal carries every problem at once", () => {
  it("reports six simultaneous problems in a single refusal", () => {
    const rows: ExternalRunRecord[] = [
      // 1 — unknown outcome.
      { row: 1, cellKey: EXPECTED[0]!.cellKey, outcome: "skipped", reason: "n/a" },
      // 2 — duplicate of row 1's slot, and a graded row with no measurements.
      {
        row: 2,
        cellKey: EXPECTED[0]!.cellKey,
        outcome: "graded",
        evidence: [{ name: "log", path: "a" }],
      },
      // 3 — unknown slot.
      { row: 3, cellKey: `${"cc".repeat(32)}/alpha/1`, outcome: "unrun", reason: "x" },
      // 4 — unparseable slot.
      { row: 4, cellKey: "nope", outcome: "unrun", reason: "x" },
      // 5 — blank reason on a non-graded outcome.
      { row: 5, cellKey: EXPECTED[1]!.cellKey, outcome: "error", reason: "" },
      // EXPECTED[2] and EXPECTED[3] are named by nobody — two missing slots.
    ];

    const error = refusal(rows);
    const problems = [
      "duplicate slot",
      "unknown slot",
      "is malformed",
      'outcome "skipped" is not one of',
      'outcome "error" requires a non-blank reason',
      'outcome "graded" requires measurements',
      `missing slot`,
    ];
    for (const problem of problems) expect(error.message).toContain(problem);
    expect(error.issues.length).toBeGreaterThanOrEqual(6);
    expect(error.code).toBe("validation");
  });
});

describe("validateExternalRunRecords — the refusal message says what to do instead", () => {
  const error = refusal(completeRows().slice(0, 1));

  it("counts the expected slots against expectedCellSet and the rows read", () => {
    expect(error.message).toContain(`${EXPECTED.length} expected slots`);
    expect(error.message).toContain("1 rows read");
    expect(error.message).toContain(`benchmark ${BENCHMARK_SHA}`);
    expect(error.message).toContain(`run ${RUN_SHA}`);
  });

  it("names the three unsupplied-slot outcomes and denies the exclude flag", () => {
    expect(error.message).toContain("There is no exclude flag.");
    expect(error.message).toContain(
      'A slot you cannot supply is recorded with outcome "error", "timeout", or "unrun"',
    );
    expect(error.message).toContain(
      "and a non-blank reason; it is counted in the denominator exactly like every other slot.",
    );
    expect(error.message).toContain("Every expected slot must appear exactly once.");
  });

  it("leads with the problem count", () => {
    expect(error.message).toMatch(/^external run import refused: 3 problems against the sealed slate\n/);
  });
});

describe("validateExternalRunRecords — imported timestamps are bounded by the sealed run window", () => {
  /** A run sealed on the 10th, closing on the 20th, imported on the 15th. */
  const WINDOWED = { ...(RUN as unknown as Record<string, unknown>), closeAt: "2026-08-20T00:00:00Z" } as unknown as RunRecord;
  const WINDOW = {
    run: WINDOWED,
    runOpenAt: "2026-08-10T00:00:00Z",
    importedAt: "2026-08-15T00:00:00Z",
  } as const;

  function timed(startedAt: string, endedAt: string): ExternalRunRecord[] {
    const rows = completeRows();
    rows[0] = row(0, { startedAt, endedAt });
    return rows;
  }

  it("accepts a pair inside the window, including both endpoints", () => {
    expect(() => validate(timed("2026-08-10T00:00:00Z", "2026-08-15T00:00:00Z"), WINDOW)).not.toThrow();
  });

  it("refuses a timestamp before the run was sealed — a result cannot predate its own slate", () => {
    const error = refusal(timed("2026-08-09T23:59:59Z", "2026-08-11T00:00:00Z"), WINDOW);
    expect(error.issues.map((issue) => issue.path)).toContain("timestamp-outside-window");
    expect(error.message).toContain('row 1: startedAt "2026-08-09T23:59:59Z" is outside the sealed run window');
    expect(error.message).toContain("2026-08-10T00:00:00Z");
  });

  it("refuses a timestamp after the import instant, which no import could have observed", () => {
    const error = refusal(timed("2026-08-11T00:00:00Z", "2026-08-15T00:00:01Z"), WINDOW);
    expect(error.issues.map((issue) => issue.path)).toContain("timestamp-outside-window");
    expect(error.message).toContain('row 1: endedAt "2026-08-15T00:00:01Z" is outside the sealed run window');
  });

  it("refuses a timestamp after the run's own close instant, even when the import is later still", () => {
    const error = refusal(
      timed("2026-08-11T00:00:00Z", "2026-08-21T00:00:00Z"),
      { ...WINDOW, importedAt: "2026-08-30T00:00:00Z" },
    );
    expect(error.issues.map((issue) => issue.path)).toContain("timestamp-outside-window");
    expect(error.message).toContain("2026-08-20T00:00:00Z");
  });
});

describe("assertExternalRunImportSource — operator strings that are sealed verbatim", () => {
  it("accepts an ordinary source", () => {
    expect(() => assertExternalRunImportSource({ harness: "some-harness", version: "2.4.0", note: "nightly sweep" }))
      .not.toThrow();
  });

  it("refuses a control character, which the dump readers already refuse everywhere else", () => {
    expect(() => assertExternalRunImportSource({ harness: "some\u0007harness" })).toThrow(/control characters/u);
    expect(() => assertExternalRunImportSource({ harness: "h", note: "line\u000bone" })).toThrow(/control characters/u);
  });

  it("refuses leading or trailing whitespace rather than trimming it silently", () => {
    expect(() => assertExternalRunImportSource({ harness: " some-harness" })).toThrow(/whitespace/u);
    expect(() => assertExternalRunImportSource({ harness: "h", version: "2.4.0 " })).toThrow(/whitespace/u);
  });

  it("refuses a string longer than the bound", () => {
    expect(() => assertExternalRunImportSource({ harness: "h".repeat(EXTERNAL_RUN_IMPORT_SOURCE_MAX_LENGTH + 1) }))
      .toThrow(/at most/u);
  });

  it("refuses an empty string, exactly as it always did", () => {
    expect(() => assertExternalRunImportSource({ harness: "" })).toThrow();
  });
});

describe("preflightExternalRunImport — evidence reads never follow a symlink", () => {
  let evidenceRoot: string;

  beforeEach(() => {
    evidenceRoot = mkdtempSync(join(tmpdir(), "bp-import-evidence-"));
  });

  afterEach(() => {
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  /** An `ungradeable` cell reads evidence and needs no sealed EvaluationSpec, so the preflight can
   * be exercised without a workspace. */
  function preflightWith(path: string): void {
    const rows = completeRows();
    rows[0] = row(0, { outcome: "ungradeable", reason: "grader crashed", evidence: [{ name: "log", path }] });
    preflightExternalRunImport({
      workspaceDir: evidenceRoot,
      plan: validate(rows),
      runRecord: RUN,
      evidenceRoot,
    });
  }

  it("reads an ordinary file", () => {
    writeFileSync(join(evidenceRoot, "log.txt"), "ok\n");
    expect(() => preflightWith("log.txt")).not.toThrow();
  });

  it("refuses a symlink, even one that stays inside the dump directory", () => {
    const secret = join(evidenceRoot, "id_rsa");
    writeFileSync(secret, "PRIVATE KEY\n");
    symlinkSync(secret, join(evidenceRoot, "log.txt"));
    expect(() => preflightWith("log.txt")).toThrow(/symbolic link/u);
  });

  it("refuses a symlink pointing outside the dump directory", () => {
    const outside = mkdtempSync(join(tmpdir(), "bp-import-outside-"));
    try {
      writeFileSync(join(outside, "id_rsa"), "PRIVATE KEY\n");
      symlinkSync(join(outside, "id_rsa"), join(evidenceRoot, "log.txt"));
      expect(() => preflightWith("log.txt")).toThrow(/symbolic link/u);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
