import { createHash } from "node:crypto";
import {
  BENCHMARKING_PROTOCOL,
  cellKey,
  compareCodeUnitStrings,
  parseMatrix,
  sealMatrix,
  type MatrixRecord,
  type Outcome,
} from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";
import {
  BinaryInstrumentReductionError,
  reduceBinaryInstrumentReplicates,
  type BinaryInstrumentItemContext,
  type BinaryInstrumentParsedCellInput,
  type BinaryInstrumentReductionInput,
} from "./binary-instrument.js";

const TASK_A = "a".repeat(64);
const TASK_B = "b".repeat(64);
const TASK_C = "c".repeat(64);
const TASK_D = "d".repeat(64);
const RUN = "e".repeat(64);
const INSTRUMENT_A = "1".repeat(64);
const INSTRUMENT_B = "2".repeat(64);
const CONTEXT_A = "3".repeat(64);
const CONTEXT_B = "4".repeat(64);
const CONTEXT_C = "5".repeat(64);
const CONTEXT_D = "6".repeat(64);
const LABEL_A = "7".repeat(64);
const LABEL_B = "8".repeat(64);
const LABEL_C = "9".repeat(64);
const LABEL_D = "0".repeat(64);

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function verdictDigest(key: string, suffix = ""): `sha256:${string}` {
  return `sha256:${digest(`${key}:${suffix}`)}`;
}

interface CellOverride {
  readonly outcome?: Outcome;
  readonly validVerdicts?: readonly `sha256:${string}`[];
  readonly dispatches?: number;
}

function matrixFixture(input: {
  readonly tasks?: readonly string[];
  readonly arms?: readonly string[];
  readonly k?: number;
  readonly overrides?: Readonly<Record<string, CellOverride>>;
} = {}): MatrixRecord {
  const tasks = input.tasks ?? [TASK_A, TASK_B];
  const arms = input.arms ?? ["armA", "armB"];
  const k = input.k ?? 3;
  const cells = tasks.flatMap((taskDigest) => arms.flatMap((armId) =>
    Array.from({ length: k }, (_, offset) => {
      const replicate = offset + 1;
      const key = cellKey(taskDigest, armId, replicate);
      const override = input.overrides?.[key];
      const outcome = override?.outcome ?? "judged";
      const dispatches = override?.dispatches ?? 1;
      const validVerdicts = override?.validVerdicts
        ?? (outcome === "judged" ? [verdictDigest(key)] : []);
      const delivered = outcome !== "expired";
      return {
        cellKey: key,
        taskDigest,
        armId,
        replicate,
        dispatches,
        ...(dispatches === 0 ? {} : {
          accounted: dispatches,
          submission: `sha256:${digest(`submission:${key}:${dispatches}`)}` as const,
        }),
        ...(delivered ? {
          attempt: `urn:uuid:${digest(`attempt:${key}`).slice(0, 8)}-0000-5000-8000-000000000000`,
          delivery: `sha256:${digest(`delivery:${key}`)}` as const,
        } : {}),
        verdicts: [...validVerdicts].sort(compareCodeUnitStrings),
        validVerdicts: [...validVerdicts].sort(compareCodeUnitStrings),
        outcome,
        verification: {
          harness: "match" as const,
          model: "match" as const,
          loadout: "match" as const,
          isolation: "match" as const,
          checksFailed: [],
        },
        integrityTier: "re-derivable" as const,
      };
    }),
  )).sort((left, right) => compareCodeUnitStrings(left.cellKey, right.cellKey));

  const perArm = Object.fromEntries(arms.map((armId) => {
    const armCells = cells.filter((value) => value.armId === armId);
    const count = (outcome: Outcome) => armCells.filter((value) => value.outcome === outcome).length;
    return [armId, {
      expected: armCells.length,
      judged: count("judged"),
      unjudged: count("unjudged"),
      unscorable: count("unscorable"),
      expired: count("expired"),
      invalidated: count("invalidated"),
      excluded: count("excluded"),
      replacements: armCells.reduce((sum, value) => sum + Math.max(0, value.dispatches - 1), 0),
    }];
  }));
  const judged = cells.filter((value) => value.outcome === "judged").length;
  const document = {
    protocol: BENCHMARKING_PROTOCOL,
    run: { digest: { sha256: RUN } },
    closeBoundary: { at: "2026-08-15T00:00:00Z" },
    cells,
    exclusions: [],
    attrition: { perArm, asymmetryFlags: [] },
    completeness: {
      expected: cells.length,
      judged,
      floor: "1",
      runOutcome: judged === cells.length ? "complete" : "partial",
    },
    assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
  };
  const sealed = sealMatrix(document);
  return parseMatrix(sealed.bytes);
}

function context(taskDigest: string): BinaryInstrumentItemContext {
  switch (taskDigest) {
    case TASK_A:
      return { analysisContextSha256: CONTEXT_A, truthLabel: "CORRECT", candidateClass: "answerable", stratum: "core", labelResolutionSha256: LABEL_A };
    case TASK_B:
      return { analysisContextSha256: CONTEXT_B, truthLabel: "WRONG", candidateClass: "contradiction", stratum: "stress", labelResolutionSha256: LABEL_B };
    case TASK_C:
      return { analysisContextSha256: CONTEXT_C, truthLabel: "CORRECT", candidateClass: "temporal", stratum: "core", labelResolutionSha256: LABEL_C };
    case TASK_D:
      return { analysisContextSha256: CONTEXT_D, truthLabel: "WRONG", candidateClass: "abstention", stratum: "stress", labelResolutionSha256: LABEL_D };
    default:
      throw new Error(`unknown fixture Task ${taskDigest}`);
  }
}

function decisiveInputs(
  matrix: MatrixRecord,
  decisions: Readonly<Record<string, "ACCEPT" | "REJECT">> = {},
): BinaryInstrumentParsedCellInput[] {
  return matrix.cells.flatMap((value) => value.outcome === "judged" && value.validVerdicts.length === 1
    ? [{
        cellKey: value.cellKey,
        verdictDigest: value.validVerdicts[0]!,
        verdict: "pass" as const,
        judgeDecision: decisions[value.cellKey] ?? "ACCEPT",
        parseValid: true,
        instrumentSha256: value.armId === "armA" ? INSTRUMENT_A : INSTRUMENT_B,
        context: context(value.taskDigest),
      }]
    : []);
}

function reductionInput(matrix: MatrixRecord, cells = decisiveInputs(matrix), k = 3): BinaryInstrumentReductionInput {
  const tasks = [...new Set(matrix.cells.map((value) => value.taskDigest))];
  const arms = [...new Set(matrix.cells.map((value) => value.armId))];
  return {
    subjectSha256: sealMatrix(matrix).digest.slice("sha256:".length),
    matrix,
    k,
    contexts: tasks.map((taskDigest) => ({ taskDigest, context: context(taskDigest) })),
    instruments: arms.map((armId) => ({ armId, instrumentSha256: armId === "armA" ? INSTRUMENT_A : INSTRUMENT_B })),
    cells,
  };
}

function expectCode(action: () => unknown, code: BinaryInstrumentReductionError["code"]): void {
  expect(action).toThrow(expect.objectContaining({ name: "BinaryInstrumentReductionError", code }));
}

describe("reduceBinaryInstrumentReplicates", () => {
  test("reduces exact task-arm groups by strict majority and marks only non-unanimous groups unstable", () => {
    const matrix = matrixFixture();
    const decisions: Record<string, "ACCEPT" | "REJECT"> = {};
    decisions[cellKey(TASK_A, "armB", 3)] = "REJECT";
    decisions[cellKey(TASK_B, "armA", 1)] = "REJECT";
    decisions[cellKey(TASK_B, "armA", 2)] = "REJECT";
    decisions[cellKey(TASK_B, "armA", 3)] = "REJECT";
    const result = reduceBinaryInstrumentReplicates(reductionInput(matrix, decisiveInputs(matrix, decisions)));

    expect(result.items.map((item) => [item.taskDigest, item.armId])).toEqual([
      [TASK_A, "armA"], [TASK_A, "armB"], [TASK_B, "armA"], [TASK_B, "armB"],
    ]);
    expect(result.items.map((item) => ({ decision: item.decision, unstable: item.unstable, accepted: item.accepted, rejected: item.rejected }))).toEqual([
      { decision: "ACCEPT", unstable: false, accepted: 3, rejected: 0 },
      { decision: "ACCEPT", unstable: true, accepted: 2, rejected: 1 },
      { decision: "REJECT", unstable: false, accepted: 0, rejected: 3 },
      { decision: "ACCEPT", unstable: false, accepted: 3, rejected: 0 },
    ]);
    expect(result.excluded).toEqual([]);
    expect(result.conflicted).toEqual({ count: 0, cellKeys: [] });
    expect(result.evaluatedCalls).toHaveLength(12);
    expect(result.items[1]!.calls.map((call) => call.replicate)).toEqual([1, 2, 3]);
  });

  test("sorts nonjudged, missing, inconclusive, and conflicted exclusions with exact cell keys", () => {
    const nonjudged = cellKey(TASK_A, "armA", 1);
    const conflict = cellKey(TASK_B, "armA", 2);
    const matrix = matrixFixture({
      tasks: [TASK_D, TASK_C, TASK_B, TASK_A],
      arms: ["armA"],
      overrides: {
        [nonjudged]: { outcome: "unjudged", validVerdicts: [] },
        [conflict]: { validVerdicts: [verdictDigest(conflict, "a"), verdictDigest(conflict, "b")].sort(compareCodeUnitStrings) },
      },
    });
    const missing = cellKey(TASK_C, "armA", 3);
    const inconclusive = cellKey(TASK_D, "armA", 1);
    const cells = decisiveInputs(matrix)
      .filter((value) => value.cellKey !== missing)
      .map((value) => value.cellKey === inconclusive
        ? { ...value, verdict: "inconclusive" as const, judgeDecision: null }
        : value);
    const result = reduceBinaryInstrumentReplicates(reductionInput(matrix, cells));

    expect(result.items).toEqual([]);
    expect(result.excluded.map((entry) => ({
      taskDigest: entry.taskDigest,
      reasons: entry.reasons.map((reason) => [reason.reason, reason.cellKeys]),
    }))).toEqual([
      { taskDigest: TASK_A, reasons: [["cell-not-judged", [nonjudged]]] },
      { taskDigest: TASK_B, reasons: [["conflicted-evaluations", [conflict]]] },
      { taskDigest: TASK_C, reasons: [["missing-evaluation", [missing]]] },
      { taskDigest: TASK_D, reasons: [["inconclusive-evaluation", [inconclusive]]] },
    ]);
    expect(result.conflicted).toEqual({ count: 1, cellKeys: [conflict] });
    // Decisive peers remain visible for later call-level parser-invalid accounting.
    expect(result.evaluatedCalls).toHaveLength(8);
  });

  test("does not turn replacement dispatches into extra scientific observations", () => {
    const replaced = cellKey(TASK_A, "armA", 2);
    const matrix = matrixFixture({ tasks: [TASK_A], arms: ["armA"], overrides: { [replaced]: { dispatches: 3 } } });
    const result = reduceBinaryInstrumentReplicates(reductionInput(matrix));
    expect(matrix.cells.find((value) => value.cellKey === replaced)?.dispatches).toBe(3);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.calls).toHaveLength(3);
    expect(result.items[0]!.calls.map((call) => call.replicate)).toEqual([1, 2, 3]);
  });

  test("requires odd positive k and the exact task x arm x 1..k coordinate set", () => {
    const matrix = matrixFixture({ tasks: [TASK_A], arms: ["armA"] });
    expectCode(() => reduceBinaryInstrumentReplicates(reductionInput(matrix, decisiveInputs(matrix), 0)), "invalid-k");
    expectCode(() => reduceBinaryInstrumentReplicates(reductionInput(matrix, decisiveInputs(matrix), 2)), "invalid-k");
    expectCode(() => reduceBinaryInstrumentReplicates(reductionInput(matrix, decisiveInputs(matrix), 5)), "incomplete-coordinate-set");
  });

  test("hard-fails duplicate Matrix coordinates before accepting an inexact subject", () => {
    const matrix = matrixFixture({ tasks: [TASK_A], arms: ["armA"] });
    const duplicated = { ...matrix, cells: [...matrix.cells, matrix.cells[0]!] } as MatrixRecord;
    expectCode(
      () => reduceBinaryInstrumentReplicates({ ...reductionInput(matrix), matrix: duplicated }),
      "duplicate-coordinate",
    );
  });

  test("hard-fails subject, parsed-cell, and sole-verdict digest drift", () => {
    const matrix = matrixFixture({ tasks: [TASK_A], arms: ["armA"] });
    const base = reductionInput(matrix);
    expectCode(() => reduceBinaryInstrumentReplicates({ ...base, subjectSha256: "f".repeat(64) }), "subject-digest-mismatch");
    expectCode(() => reduceBinaryInstrumentReplicates({ ...base, cells: [...base.cells, base.cells[0]!] }), "duplicate-cell-input");
    expectCode(
      () => reduceBinaryInstrumentReplicates({ ...base, cells: [{ ...base.cells[0]!, cellKey: cellKey(TASK_B, "armA", 1) }, ...base.cells.slice(1)] }),
      "unknown-cell-input",
    );
    expectCode(
      () => reduceBinaryInstrumentReplicates({ ...base, cells: [{ ...base.cells[0]!, verdictDigest: `sha256:${"f".repeat(64)}` }, ...base.cells.slice(1)] }),
      "verdict-digest-mismatch",
    );
  });

  test("hard-fails context and instrument drift against the expected Task/arm bindings", () => {
    const matrix = matrixFixture({ tasks: [TASK_A], arms: ["armA"] });
    const base = reductionInput(matrix);
    expectCode(
      () => reduceBinaryInstrumentReplicates({
        ...base,
        cells: [{ ...base.cells[0]!, context: { ...base.cells[0]!.context, stratum: "stress" } }, ...base.cells.slice(1)],
      }),
      "context-drift",
    );
    expectCode(
      () => reduceBinaryInstrumentReplicates({
        ...base,
        cells: [{ ...base.cells[0]!, instrumentSha256: INSTRUMENT_B }, ...base.cells.slice(1)],
      }),
      "instrument-drift",
    );
    expectCode(
      () => reduceBinaryInstrumentReplicates({ ...base, contexts: [] }),
      "context-drift",
    );
    expectCode(
      () => reduceBinaryInstrumentReplicates({ ...base, instruments: [] }),
      "instrument-drift",
    );
  });

  test("hard-fails unsupported runtime vocabulary even when TypeScript callers are bypassed", () => {
    const matrix = matrixFixture({ tasks: [TASK_A], arms: ["armA"] });
    const base = reductionInput(matrix);
    const unsupported = {
      ...base.cells[0]!,
      judgeDecision: "MAYBE",
    } as unknown as BinaryInstrumentParsedCellInput;
    expectCode(
      () => reduceBinaryInstrumentReplicates({ ...base, cells: [unsupported, ...base.cells.slice(1)] }),
      "unsupported-vocabulary",
    );
  });
});
