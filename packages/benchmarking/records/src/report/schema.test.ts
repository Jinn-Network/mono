import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { InvalidDocumentError } from "../sealing.js";
import { parseReport, ReportRecordSchema, sealReport } from "./schema.js";

function loadFixture(name: string): unknown {
  const url = new URL(`../../fixtures/report/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

function loadFixtureText(name: string): string {
  const url = new URL(`../../fixtures/report/${name}`, import.meta.url);
  return readFileSync(url, "utf8").trim();
}

describe("ReportRecordSchema / parseReport / sealReport", () => {
  test("valid.json round-trips through seal -> parse and matches its pinned digest", () => {
    const valid = loadFixture("valid.json");
    const sealed = sealReport(valid);
    const roundTripped = parseReport(sealed.bytes);
    expect(roundTripped).toEqual(ReportRecordSchema.parse(valid));
    expect(sealed.digest).toBe(loadFixtureText("valid.sha256"));
  });

  test("minimal.json parses with no optional fields present", () => {
    const minimal = loadFixture("minimal.json");
    const parsed = ReportRecordSchema.parse(minimal);
    expect(parsed.preregistered).toBeUndefined();
    expect(parsed.limitations).toBeUndefined();
  });

  test("invalid-missing-disclosures.json fails via the disclosures-required refine (§9.1)", () => {
    const missing = loadFixture("invalid-missing-disclosures.json");
    expect(() => sealReport(missing)).toThrow(InvalidDocumentError);
    try {
      sealReport(missing);
      expect.unreachable();
    } catch (error) {
      const issues = (error as InvalidDocumentError).errors;
      expect(issues).toEqual([
        { path: "disclosures", message: "disclosures is required (§9.1: a report that hides attrition is malformed)" },
      ]);
    }
  });
});
