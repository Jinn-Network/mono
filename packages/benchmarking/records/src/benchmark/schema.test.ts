import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { InvalidDocumentError } from "../sealing.js";
import { BenchmarkRecordSchema, parseBenchmark, sealBenchmark } from "./schema.js";

function loadFixture(name: string): unknown {
  const url = new URL(`../../fixtures/benchmark/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

function loadFixtureText(name: string): string {
  const url = new URL(`../../fixtures/benchmark/${name}`, import.meta.url);
  return readFileSync(url, "utf8").trim();
}

describe("BenchmarkRecordSchema / parseBenchmark / sealBenchmark", () => {
  test("valid.json round-trips through seal -> parse and matches its pinned digest", () => {
    const valid = loadFixture("valid.json");
    const sealed = sealBenchmark(valid);
    const roundTripped = parseBenchmark(sealed.bytes);
    expect(roundTripped).toEqual(BenchmarkRecordSchema.parse(valid));
    expect(sealed.digest).toBe(loadFixtureText("valid.sha256"));
  });

  test("minimal.json parses with no optional fields present", () => {
    const minimal = loadFixture("minimal.json");
    const parsed = BenchmarkRecordSchema.parse(minimal);
    expect(parsed.author).toBeUndefined();
    expect(parsed.license).toBeUndefined();
    expect(parsed.citation).toBeUndefined();
    expect(parsed.supersedes).toBeUndefined();
  });

  test("invalid-duplicate-item.json is schema-VALID (distinctness is a separate named check)", () => {
    const duplicate = loadFixture("invalid-duplicate-item.json");
    expect(() => BenchmarkRecordSchema.parse(duplicate)).not.toThrow();
  });

  test("invalid-bad-version.json is rejected: version is not a SemVer 2.0.0 string", () => {
    const badVersion = loadFixture("invalid-bad-version.json");
    expect(() => sealBenchmark(badVersion)).toThrow(InvalidDocumentError);
    try {
      sealBenchmark(badVersion);
      expect.unreachable();
    } catch (error) {
      const issues = (error as InvalidDocumentError).errors;
      expect(issues.some((issue) => issue.path === "version" && /SemVer/.test(issue.message))).toBe(true);
    }
  });

  test("an item's task ResourceDescriptor without a sha256 digest is rejected", () => {
    const value = {
      protocol: "https://jinn.network/protocols/benchmarking/1.0",
      name: "no-digest",
      description: "d",
      version: "1.0.0",
      items: [{ task: { uri: "https://example.test/task" } }],
      reveal: { policy: "immediate" },
    };
    expect(() => sealBenchmark(value)).toThrow();
  });
});
