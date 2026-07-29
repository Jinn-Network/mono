import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { InvalidDocumentError } from "../sealing.js";
import { MatrixRecordSchema, OUTCOME_VOCABULARY, parseMatrix, sealMatrix } from "./schema.js";

function loadFixture(name: string): unknown {
  const url = new URL(`../../fixtures/matrix/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

function loadFixtureText(name: string): string {
  const url = new URL(`../../fixtures/matrix/${name}`, import.meta.url);
  return readFileSync(url, "utf8").trim();
}

type MutableCell = {
  cellKey: string;
  taskDigest: string;
  armId: string;
  replicate: number;
  dispatches: number;
  accounted?: number;
  submission?: string;
  attempt?: string;
  delivery?: string;
  solver?: string;
  evaluator?: string;
  cost?: { value: string; unit: string; source: "reported" | "settled" };
  latencyMs?: number;
  verdicts: string[];
  validVerdicts: string[];
  outcome: (typeof OUTCOME_VOCABULARY)[number];
  verification: {
    harness: "match" | "mismatch" | "unverifiable";
    model: "match" | "mismatch" | "unverifiable";
    loadout: "match" | "mismatch" | "unverifiable";
    isolation: "match" | "mismatch" | "unverifiable";
    checksFailed: string[];
  };
};

type MutableMatrix = {
  cells: MutableCell[];
  exclusions: Array<{ cellKey: string; reason: string }>;
  attrition: {
    perArm: Record<string, {
      expected: number;
      judged: number;
      unjudged: number;
      unscorable: number;
      expired: number;
      invalidated: number;
      excluded: number;
      replacements: number;
    }>;
    asymmetryFlags: string[];
  };
  completeness: {
    expected: number;
    judged: number;
    floor: string;
    runOutcome: "complete" | "partial" | "cancelled";
  };
};

function validMatrix(): MutableMatrix & Record<string, unknown> {
  return JSON.parse(JSON.stringify(loadFixture("valid.json"))) as MutableMatrix & Record<string, unknown>;
}

function rederiveConvenienceViews(matrix: MutableMatrix): void {
  matrix.exclusions = matrix.cells
    .filter((cell) => cell.outcome === "excluded")
    .map((cell) => ({ cellKey: cell.cellKey, reason: "policy.participantExclusions" }));

  const perArm: MutableMatrix["attrition"]["perArm"] = {};
  for (const cell of matrix.cells) {
    const counts = perArm[cell.armId] ?? {
      expected: 0,
      judged: 0,
      unjudged: 0,
      unscorable: 0,
      expired: 0,
      invalidated: 0,
      excluded: 0,
      replacements: 0,
    };
    counts.expected += 1;
    counts[cell.outcome] += 1;
    counts.replacements += Math.max(0, cell.dispatches - 1);
    perArm[cell.armId] = counts;
  }
  matrix.attrition.perArm = perArm;
  matrix.attrition.asymmetryFlags = [];
  matrix.completeness.expected = matrix.cells.length;
  matrix.completeness.judged = matrix.cells.filter((cell) => cell.outcome === "judged").length;
  const denominator = matrix.cells.filter((cell) => cell.outcome !== "excluded").length;
  const completeness = denominator === 0 ? 1 : matrix.completeness.judged / denominator;
  matrix.completeness.runOutcome = completeness >= Number(matrix.completeness.floor) ? "complete" : "partial";
}

test("Matrix rejects an impossible civil closeBoundary.at date", () => {
  const matrix = validMatrix();
  (matrix.closeBoundary as Record<string, unknown>).at = "2026-02-30T00:00:00Z";
  expect(() => sealMatrix(matrix)).toThrow(InvalidDocumentError);
});

describe("OUTCOME_VOCABULARY", () => {
  test("is the frozen six-value set (§8.2/§14.1)", () => {
    expect(OUTCOME_VOCABULARY).toEqual([
      "judged",
      "unjudged",
      "unscorable",
      "expired",
      "invalidated",
      "excluded",
    ]);
  });
});

describe("MatrixRecordSchema / parseMatrix / sealMatrix", () => {
  test("valid.json round-trips through seal -> parse and matches its pinned digest", () => {
    const valid = loadFixture("valid.json");
    const sealed = sealMatrix(valid);
    const roundTripped = parseMatrix(sealed.bytes);
    expect(roundTripped).toEqual(MatrixRecordSchema.parse(valid));
    expect(sealed.digest).toBe(loadFixtureText("valid.sha256"));
  });

  test("minimal.json parses with zero cells", () => {
    const minimal = loadFixture("minimal.json");
    const parsed = MatrixRecordSchema.parse(minimal);
    expect(parsed.cells).toEqual([]);
  });

  test("invalid-missing-cells.json fails: completeness.expected does not match cells.length", () => {
    const missing = loadFixture("invalid-missing-cells.json");
    expect(() => sealMatrix(missing)).toThrow(InvalidDocumentError);
    try {
      sealMatrix(missing);
      expect.unreachable();
    } catch (error) {
      const issues = (error as InvalidDocumentError).errors;
      expect(issues.some((issue) => /does not match cells\.length/.test(issue.message))).toBe(true);
    }
  });

  test("invalid-bad-outcome.json is rejected: outcome outside the six-value enum", () => {
    const badOutcome = loadFixture("invalid-bad-outcome.json");
    expect(() => sealMatrix(badOutcome)).toThrow(InvalidDocumentError);
  });

  test("invalid-aggregate-field.json is rejected: an unnamespaced top-level field (tenet 3)", () => {
    const aggregateField = loadFixture("invalid-aggregate-field.json");
    expect(() => sealMatrix(aggregateField)).toThrow(InvalidDocumentError);
    try {
      sealMatrix(aggregateField);
      expect.unreachable();
    } catch (error) {
      const issues = (error as InvalidDocumentError).errors;
      expect(issues.some((issue) => /reverse-DNS or absolute URI/.test(issue.message))).toBe(true);
    }
  });

  test("a reverse-DNS extension key is accepted", () => {
    const value = loadFixture("valid.json") as Record<string, unknown>;
    const withExtension = { ...value, "network.jinn.benchmarking.internal": "informational" };
    expect(() => MatrixRecordSchema.parse(withExtension)).not.toThrow();
  });

  test("rejects a duplicate cellKey across two cell entries", () => {
    const value = JSON.parse(JSON.stringify(loadFixture("valid.json"))) as {
      cells: unknown[];
      completeness: { expected: number };
    };
    value.cells.push(value.cells[0]);
    value.completeness.expected = 2;
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });

  test("rejects a cell whose cellKey is inconsistent with its own taskDigest/armId/replicate", () => {
    const value = JSON.parse(JSON.stringify(loadFixture("valid.json"))) as {
      cells: Array<{ cellKey: string }>;
    };
    value.cells[0].cellKey = "0000000000000000000000000000000000000000000000000000000000000000/armA/1";
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });

  test.each([
    ["invalid armId", (cell: MutableCell) => {
      cell.armId = "arm A";
      cell.cellKey = `${cell.taskDigest}/arm A/1`;
    }],
    ["unsafe replicate", (cell: MutableCell) => {
      cell.replicate = Number.MAX_SAFE_INTEGER + 1;
      cell.cellKey = `${cell.taskDigest}/${cell.armId}/${Number.MAX_SAFE_INTEGER + 1}`;
    }],
  ])("rejects Matrix cell coordinates with %s", (_label, mutate) => {
    const value = validMatrix();
    mutate(value.cells[0]!);
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });

  test.each([
    ["attempt", (cell: MutableCell) => { cell.attempt = "not-an-iri"; }],
    ["solver", (cell: MutableCell) => { cell.solver = "not-an-iri"; }],
    ["evaluator", (cell: MutableCell) => { cell.evaluator = "not-an-iri"; }],
  ])("rejects a non-IRI Matrix %s identifier", (_label, mutate) => {
    const value = validMatrix();
    mutate(value.cells[0]!);
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });

  test("requires cells to be sorted by exact cellKey", () => {
    const value = validMatrix();
    const first = structuredClone(value.cells[0]!);
    first.taskDigest = "0".repeat(64);
    first.cellKey = `${first.taskDigest}/${first.armId}/${first.replicate}`;
    value.cells.push(first);
    rederiveConvenienceViews(value);
    expect(value.cells[0]!.cellKey > value.cells[1]!.cellKey).toBe(true);
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });

  test("rejects unsorted verdicts", () => {
    const value = JSON.parse(JSON.stringify(loadFixture("valid.json"))) as {
      cells: Array<{ verdicts: string[] }>;
    };
    value.cells[0].verdicts = [
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    ];
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });

  test.each([
    ["verdicts", (cell: MutableCell) => { cell.verdicts.push(cell.verdicts[0]!); }],
    ["validVerdicts", (cell: MutableCell) => { cell.validVerdicts.push(cell.validVerdicts[0]!); }],
    ["checksFailed", (cell: MutableCell) => { cell.verification.checksFailed = ["z-check", "a-check"]; }],
    ["duplicate checksFailed", (cell: MutableCell) => {
      cell.verification.checksFailed = ["same-check", "same-check"];
    }],
  ])("rejects non-canonical %s arrays", (_label, mutate) => {
    const value = validMatrix();
    mutate(value.cells[0]!);
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });

  test("rejects a validVerdicts entry that is not a subset of verdicts", () => {
    const value = JSON.parse(JSON.stringify(loadFixture("valid.json"))) as {
      cells: Array<{ validVerdicts: string[] }>;
    };
    value.cells[0].validVerdicts = [
      "sha256:0b220df1969115139ffebb337981298d243a44f84dad5d20d7e7da5fdb34de43",
    ];
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });

  test.each([
    ["accounted present on a never-dispatched cell", (cell: MutableCell) => {
      cell.dispatches = 0;
    }],
    ["missing accounted on a dispatched cell", (cell: MutableCell) => {
      delete cell.accounted;
    }],
    ["accounted greater than dispatches", (cell: MutableCell) => {
      cell.accounted = 2;
    }],
    ["missing submission on a dispatched cell", (cell: MutableCell) => {
      delete cell.submission;
    }],
  ])("rejects dispatch contradiction: %s", (_label, mutate) => {
    const value = validMatrix();
    mutate(value.cells[0]!);
    rederiveConvenienceViews(value);
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });

  test("accepts the exact never-dispatched shape only as expired", () => {
    const value = validMatrix();
    const cell = value.cells[0]!;
    cell.dispatches = 0;
    delete cell.accounted;
    delete cell.submission;
    delete cell.attempt;
    delete cell.delivery;
    delete cell.solver;
    delete cell.evaluator;
    delete cell.cost;
    delete cell.latencyMs;
    cell.verdicts = [];
    cell.validVerdicts = [];
    cell.outcome = "expired";
    rederiveConvenienceViews(value);
    expect(() => sealMatrix(value)).not.toThrow();

    cell.outcome = "unjudged";
    rederiveConvenienceViews(value);
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });

  test.each([
    ["judged without a valid verdict", (cell: MutableCell) => { cell.validVerdicts = []; }],
    ["judged without a delivery", (cell: MutableCell) => { delete cell.delivery; }],
    ["judged despite a pinning mismatch", (cell: MutableCell) => {
      cell.verification.harness = "mismatch";
    }],
    ["unjudged without a delivery", (cell: MutableCell) => {
      cell.outcome = "unjudged";
      cell.validVerdicts = [];
      delete cell.delivery;
    }],
    ["unjudged with a valid verdict", (cell: MutableCell) => { cell.outcome = "unjudged"; }],
    ["unscorable without a delivery", (cell: MutableCell) => {
      cell.outcome = "unscorable";
      cell.validVerdicts = [];
      delete cell.delivery;
    }],
    ["expired with a delivery", (cell: MutableCell) => {
      cell.outcome = "expired";
      cell.validVerdicts = [];
    }],
    ["invalidated without a pinning mismatch", (cell: MutableCell) => {
      cell.outcome = "invalidated";
      cell.validVerdicts = [];
    }],
  ])("rejects outcome contradiction: %s", (_label, mutate) => {
    const value = validMatrix();
    mutate(value.cells[0]!);
    rederiveConvenienceViews(value);
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });

  test("requires exclusions to be one-to-one with excluded cells and carry a non-empty policy reason", () => {
    const value = validMatrix();
    value.cells[0]!.outcome = "excluded";
    value.cells[0]!.validVerdicts = [];
    rederiveConvenienceViews(value);
    expect(() => sealMatrix(value)).not.toThrow();

    value.exclusions = [];
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
    rederiveConvenienceViews(value);
    value.exclusions[0]!.reason = "";
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
    rederiveConvenienceViews(value);
    value.exclusions.push({ ...value.exclusions[0]! });
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });

  test("rejects an exclusion entry for a non-excluded cell", () => {
    const value = validMatrix();
    value.exclusions.push({
      cellKey: value.cells[0]!.cellKey,
      reason: "policy.participantExclusions",
    });
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });

  test.each([
    ["completeness.expected", (value: MutableMatrix) => { value.completeness.expected += 1; }],
    ["completeness.judged", (value: MutableMatrix) => { value.completeness.judged -= 1; }],
    ["per-arm expected", (value: MutableMatrix) => { value.attrition.perArm.armA!.expected += 1; }],
    ["per-arm outcome count", (value: MutableMatrix) => { value.attrition.perArm.armA!.judged -= 1; }],
    ["per-arm replacements", (value: MutableMatrix) => { value.attrition.perArm.armA!.replacements += 1; }],
    ["missing per-arm key", (value: MutableMatrix) => { delete value.attrition.perArm.armA; }],
    ["extra per-arm key", (value: MutableMatrix) => {
      value.attrition.perArm.armB = structuredClone(value.attrition.perArm.armA!);
    }],
  ])("rejects a derived-count contradiction in %s", (_label, mutate) => {
    const value = validMatrix();
    mutate(value);
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });

  test.each([
    ["complete below the declared floor", (value: MutableMatrix) => {
      value.cells[0]!.outcome = "expired";
      value.cells[0]!.verdicts = [];
      value.cells[0]!.validVerdicts = [];
      delete value.cells[0]!.delivery;
      rederiveConvenienceViews(value);
      value.completeness.runOutcome = "complete";
    }],
    ["partial at or above the declared floor", (value: MutableMatrix) => {
      value.completeness.runOutcome = "partial";
    }],
    ["zero floor", (value: MutableMatrix) => { value.completeness.floor = "0"; }],
    ["floor above one", (value: MutableMatrix) => { value.completeness.floor = "1.1"; }],
  ])("rejects completeness contradiction: %s", (_label, mutate) => {
    const value = validMatrix();
    mutate(value);
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });

  test.each([
    ["duplicate flags", ["same", "same"]],
    ["unsorted flags", ["z-flag", "a-flag"]],
    ["empty flag", [""]],
  ])("rejects structurally invalid asymmetry flags: %s", (_label, flags) => {
    const value = validMatrix();
    value.attrition.asymmetryFlags = flags;
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });

  test("rejects an asymmetry flag when fewer than two arms exist or arm attrition is symmetric", () => {
    const value = validMatrix();
    value.attrition.asymmetryFlags = ["nonjudged-arm-imbalance"];
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);

    const second = structuredClone(value.cells[0]!);
    second.armId = "armB";
    second.cellKey = `${second.taskDigest}/armB/${second.replicate}`;
    value.cells.push(second);
    value.cells.sort((a, b) => a.cellKey < b.cellKey ? -1 : 1);
    rederiveConvenienceViews(value);
    value.attrition.asymmetryFlags = ["nonjudged-arm-imbalance"];
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });

  test.each([
    (loadFixture("invalid-run-uri-only.json") as { run: unknown }).run,
    { digest: { sha256: "A".repeat(64) } },
    { digest: { sha256: "short" } },
  ])("rejects a Matrix Run link without a canonical lowercase sha256 digest", (run) => {
    const value = JSON.parse(JSON.stringify(loadFixture("minimal.json"))) as Record<string, unknown>;
    value.run = run;
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });
});
