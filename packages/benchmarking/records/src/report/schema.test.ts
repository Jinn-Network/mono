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

  test("plural-valid.json preserves each subject disclosure without merging repeated arms or flags", () => {
    const parsed = ReportRecordSchema.parse(loadFixture("plural-valid.json"));
    const perSubject = parsed.disclosures!.perSubject;
    expect(perSubject).toHaveLength(2);
    expect(perSubject.map((entry) => entry.subjectSha256)).toEqual(
      parsed.subjects.map((subject) => subject.digest.sha256),
    );
    expect(perSubject.map((entry) => entry.completeness)).toEqual([
      { expected: 3, judged: 1, floor: "0.5", runOutcome: "cancelled" },
      { expected: 4, judged: 3, floor: "0.75", runOutcome: "complete" },
    ]);
    expect(perSubject[0]!.attrition.perArm["armA"]!.replacements).toBe(0);
    expect(perSubject[1]!.attrition.perArm["armA"]!.replacements).toBe(2);
    expect(perSubject.map((entry) => entry.attrition.asymmetryFlags)).toEqual([
      ["cancelled-by-owner", "duplicate-observation"],
      ["partial-coverage", "duplicate-observation"],
    ]);
  });

  test("invalid-missing-disclosures.json fails the required disclosures wire contract (§9.1)", () => {
    const missing = loadFixture("invalid-missing-disclosures.json");
    expect(() => sealReport(missing)).toThrow(InvalidDocumentError);
    try {
      sealReport(missing);
      expect.unreachable();
    } catch (error) {
      const issues = (error as InvalidDocumentError).errors;
      expect(issues).toEqual([{ path: "disclosures", message: "Invalid input: expected object, received undefined" }]);
    }
  });

  test.each([
    (loadFixture("invalid-subject-uri-only.json") as { subjects: unknown[] }).subjects[0],
    { digest: { sha256: "A".repeat(64) } },
    { digest: { sha256: "short" } },
  ])("rejects a Report subject without a canonical lowercase sha256 digest", (subject) => {
    const value = JSON.parse(JSON.stringify(loadFixture("minimal.json"))) as Record<string, unknown>;
    value.subjects = [subject];
    expect(() => sealReport(value)).toThrow(InvalidDocumentError);
  });

  test("requires disclosures.perSubject to match subjects by length, order, and exact digest", () => {
    const value = JSON.parse(JSON.stringify(loadFixture("valid.json"))) as {
      subjects: Array<{ digest: { sha256: string } }>;
      disclosures: { perSubject: Array<{ subjectSha256: string }> };
    };
    expect(value.disclosures.perSubject).toHaveLength(value.subjects.length);
    expect(value.disclosures.perSubject[0]!.subjectSha256).toBe(value.subjects[0]!.digest.sha256);

    value.disclosures.perSubject[0]!.subjectSha256 = "0".repeat(64);
    expect(() => sealReport(value)).toThrow(InvalidDocumentError);
  });

  test("rejects omitted or collapsed disclosure entries for plural subjects", () => {
    const value = loadFixture("plural-valid.json") as {
      disclosures: { perSubject: unknown[] };
    };
    value.disclosures.perSubject.pop();
    expect(() => sealReport(value)).toThrow(InvalidDocumentError);

    const collapsed = loadFixture("plural-valid.json") as Record<string, unknown>;
    collapsed.disclosures = {
      integrityTiers: { "re-derivable": 2, "attested-only": 5 },
      completeness: { expected: 7, judged: 4, floor: "0.5", runOutcome: "partial" },
    };
    expect(() => sealReport(collapsed)).toThrow(InvalidDocumentError);
  });

  test("rejects duplicate Report subjects and reordered per-subject disclosures", () => {
    const value = JSON.parse(JSON.stringify(loadFixture("valid.json"))) as {
      subjects: Array<{ digest: { sha256: string } }>;
      disclosures: { perSubject: Array<Record<string, unknown>> };
    };
    const secondDigest = "1".repeat(64);
    value.subjects.push({ digest: { sha256: secondDigest } });
    value.disclosures.perSubject.push({
      ...value.disclosures.perSubject[0],
      subjectSha256: secondDigest,
    });
    expect(() => sealReport(value)).not.toThrow();

    value.disclosures.perSubject.reverse();
    expect(() => sealReport(value)).toThrow(InvalidDocumentError);

    value.disclosures.perSubject.reverse();
    value.subjects[1] = value.subjects[0]!;
    value.disclosures.perSubject[1] = {
      ...value.disclosures.perSubject[1],
      subjectSha256: value.subjects[0]!.digest.sha256,
    };
    expect(() => sealReport(value)).toThrow(InvalidDocumentError);
  });

  test("rejects a non-IRI author", () => {
    const value = loadFixture("minimal.json") as Record<string, unknown>;
    expect(() => sealReport({ ...value, author: "not an iri" })).toThrow(InvalidDocumentError);
  });

  test.each([
    ["function", () => "not JSON"],
    ["symbol", Symbol("not-json")],
    ["bigint", BigInt(1)],
  ])("rejects non-JSON results: %s", (_label, results) => {
    const value = JSON.parse(JSON.stringify(loadFixture("minimal.json"))) as Record<string, unknown>;
    value.results = results;
    expect(() => sealReport(value)).toThrow();
  });

  test("rejects zero-eligible complete per-subject disclosure completeness", () => {
    const value = JSON.parse(JSON.stringify(loadFixture("minimal.json"))) as Record<string, unknown> & {
      disclosures: {
        perSubject: Array<{
          completeness: { expected: number; judged: number; floor: string; runOutcome: string };
          attrition: { perArm: Record<string, unknown> };
        }>;
      };
    };
    value.disclosures.perSubject[0]!.completeness = {
      expected: 0, judged: 0, floor: "1", runOutcome: "complete",
    };
    expect(() => sealReport(value)).toThrow(InvalidDocumentError);
    try {
      sealReport(value);
      expect.unreachable();
    } catch (error) {
      const issues = (error as InvalidDocumentError).errors;
      expect(issues.some((issue) =>
        issue.path === "disclosures.perSubject.0.completeness.runOutcome"
        && issue.message.includes("runOutcome complete requires the declared completeness floor to pass"),
      )).toBe(true);
    }
    value.disclosures.perSubject[0]!.completeness.runOutcome = "partial";
    expect(() => sealReport(value)).not.toThrow();
  });

  test("rejects all-excluded complete per-subject disclosure completeness", () => {
    const value = JSON.parse(JSON.stringify(loadFixture("valid.json"))) as Record<string, unknown> & {
      disclosures: {
        perSubject: Array<{
          completeness: { expected: number; judged: number; floor: string; runOutcome: string };
          attrition: { perArm: Record<string, { excluded: number; expected: number; judged: number; unjudged: number; unscorable: number; expired: number; invalidated: number; replacements: number }> };
        }>;
      };
    };
    value.disclosures.perSubject[0]!.attrition.perArm.armA = {
      expected: 1, judged: 0, unjudged: 0, unscorable: 0, expired: 0, invalidated: 0, excluded: 1, replacements: 0,
    };
    value.disclosures.perSubject[0]!.completeness = {
      expected: 1, judged: 0, floor: "1", runOutcome: "complete",
    };
    expect(() => sealReport(value)).toThrow(InvalidDocumentError);
    value.disclosures.perSubject[0]!.completeness.runOutcome = "partial";
    expect(() => sealReport(value)).not.toThrow();
  });
});
