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
      expect(issues.some((issue) => /no aggregate of any kind/.test(issue.message))).toBe(true);
    }
  });

  test("a legitimately namespaced extension key is accepted", () => {
    const value = loadFixture("valid.json") as Record<string, unknown>;
    const withExtension = { ...value, "jinn.benchmarking.internal/note": "informational" };
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

  test("rejects a validVerdicts entry that is not a subset of verdicts", () => {
    const value = JSON.parse(JSON.stringify(loadFixture("valid.json"))) as {
      cells: Array<{ validVerdicts: string[] }>;
    };
    value.cells[0].validVerdicts = [
      "sha256:0b220df1969115139ffebb337981298d243a44f84dad5d20d7e7da5fdb34de43",
    ];
    expect(() => sealMatrix(value)).toThrow(InvalidDocumentError);
  });
});
