import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { InvalidDocumentError } from "../sealing.js";
import { parseRun, RunRecordSchema, sealRun } from "./schema.js";

function loadFixture(name: string): unknown {
  const url = new URL(`../../fixtures/run/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

function loadFixtureText(name: string): string {
  const url = new URL(`../../fixtures/run/${name}`, import.meta.url);
  return readFileSync(url, "utf8").trim();
}

describe("RunRecordSchema / parseRun / sealRun", () => {
  test("valid.json round-trips through seal -> parse and matches its pinned digest", () => {
    const valid = loadFixture("valid.json");
    const sealed = sealRun(valid);
    const roundTripped = parseRun(sealed.bytes);
    expect(roundTripped).toEqual(RunRecordSchema.parse(valid));
    expect(sealed.digest).toBe(loadFixtureText("valid.sha256"));
  });

  test("minimal.json parses with no optional fields present", () => {
    const minimal = loadFixture("minimal.json");
    const parsed = RunRecordSchema.parse(minimal);
    expect(parsed.analysisPlan).toBeUndefined();
    expect(parsed.budget).toBeUndefined();
    expect(parsed.venue).toBeUndefined();
  });

  test("rejects an impossible civil closeAt date", () => {
    const value = JSON.parse(JSON.stringify(loadFixture("minimal.json"))) as Record<string, unknown>;
    value.closeAt = "2026-02-30T00:00:00Z";
    expect(() => sealRun(value)).toThrow(InvalidDocumentError);
  });

  test("invalid-missing-closeAt.json is rejected as invalid-document", () => {
    const missing = loadFixture("invalid-missing-closeAt.json");
    expect(() => parseRun(new TextEncoder().encode(JSON.stringify(missing)))).toThrow(InvalidDocumentError);
    try {
      parseRun(new TextEncoder().encode(JSON.stringify(missing)));
      expect.unreachable();
    } catch (error) {
      expect((error as InvalidDocumentError).category).toBe("invalid-document");
      expect((error as InvalidDocumentError).errors.some((issue) => issue.path === "closeAt")).toBe(true);
    }
  });

  test("invalid-dup-arm.json is rejected: two arms share byte-identical pinning", () => {
    const dup = loadFixture("invalid-dup-arm.json");
    expect(() => sealRun(dup)).toThrow(InvalidDocumentError);
    try {
      sealRun(dup);
      expect.unreachable();
    } catch (error) {
      const issues = (error as InvalidDocumentError).errors;
      expect(issues.some((issue) => /pairwise distinct/.test(issue.message))).toBe(true);
    }
  });

  test("rejects a completenessFloor outside (0,1]", () => {
    const value = JSON.parse(JSON.stringify(loadFixture("minimal.json"))) as Record<string, unknown>;
    (value.policy as Record<string, unknown>).completenessFloor = "0";
    expect(() => sealRun(value)).toThrow(InvalidDocumentError);
  });

  test("rejects a non-decimal-string completenessFloor", () => {
    const value = JSON.parse(JSON.stringify(loadFixture("minimal.json"))) as Record<string, unknown>;
    (value.policy as Record<string, unknown>).completenessFloor = 0.8;
    expect(() => sealRun(value)).toThrow(InvalidDocumentError);
  });

  test("rejects a duplicate armId even when pinning differs", () => {
    const value = JSON.parse(JSON.stringify(loadFixture("invalid-dup-arm.json"))) as Record<string, unknown>;
    const arms = value.arms as Array<Record<string, unknown>>;
    arms[0].armId = "same";
    arms[1].armId = "same";
    (arms[1].pinning as Record<string, unknown>) = { model: { id: "different" } };
    expect(() => sealRun(value)).toThrow(InvalidDocumentError);
  });

  test("rejects an armId containing '/'", () => {
    const value = JSON.parse(JSON.stringify(loadFixture("minimal.json"))) as Record<string, unknown>;
    (value.arms as Array<Record<string, unknown>>)[0].armId = "bad/arm";
    expect(() => sealRun(value)).toThrow(InvalidDocumentError);
  });

  test.each([
    (loadFixture("invalid-benchmark-uri-only.json") as { benchmark: unknown }).benchmark,
    { digest: { sha256: "A".repeat(64) } },
    { digest: { sha256: "abc" } },
  ])("rejects a Run Benchmark link without a canonical lowercase sha256 digest", (benchmark) => {
    const value = JSON.parse(JSON.stringify(loadFixture("minimal.json"))) as Record<string, unknown>;
    value.benchmark = benchmark;
    expect(() => sealRun(value)).toThrow(InvalidDocumentError);
  });

  test("requires independence gating on an open-competition venue", () => {
    const value = JSON.parse(JSON.stringify(loadFixture("minimal.json"))) as Record<string, unknown>;
    value.venue = { kind: "open-competition" };
    (value.policy as Record<string, unknown>).independence = "disclosed";
    expect(() => sealRun(value)).toThrow(InvalidDocumentError);
  });

  test("accepts an open-competition venue when evaluator independence is gating", () => {
    const value = JSON.parse(JSON.stringify(loadFixture("minimal.json"))) as Record<string, unknown>;
    value.venue = { kind: "open-competition" };
    (value.policy as Record<string, unknown>).independence = "gating";
    expect(() => sealRun(value)).not.toThrow();
  });

  test.each([
    ["owner", (value: Record<string, unknown>) => { value.owner = "not an iri"; }],
    ["allowlist", (value: Record<string, unknown>) => {
      ((value.arms as Array<Record<string, unknown>>)[0]).execution = { allowlist: ["not an iri"] };
    }],
    ["participant exclusions", (value: Record<string, unknown>) => {
      (value.policy as Record<string, unknown>).participantExclusions = ["not an iri"];
    }],
  ])("rejects a non-IRI %s identity", (_label, mutate) => {
    const value = JSON.parse(JSON.stringify(loadFixture("minimal.json"))) as Record<string, unknown>;
    mutate(value);
    expect(() => sealRun(value)).toThrow(InvalidDocumentError);
  });
});
