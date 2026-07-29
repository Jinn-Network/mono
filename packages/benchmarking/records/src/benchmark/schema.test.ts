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
    const value = loadFixture("invalid-item-uri-only.json");
    expect(() => sealBenchmark(value)).toThrow();
  });

  test.each([
    "not-hex",
    "A".repeat(64),
    "a".repeat(63),
  ])("rejects a non-canonical Benchmark item sha256 digest: %s", (sha256) => {
    const value = {
      protocol: "https://jinn.network/protocols/benchmarking/1.0",
      name: "bad-digest",
      description: "d",
      version: "1.0.0",
      items: [{ task: { digest: { sha256 } } }],
      reveal: { policy: "immediate" },
    };
    expect(() => sealBenchmark(value)).toThrow(InvalidDocumentError);
  });

  test("rejects a non-IRI author", () => {
    const value = loadFixture("minimal.json") as Record<string, unknown>;
    expect(() => sealBenchmark({ ...value, author: "not an iri" })).toThrow(InvalidDocumentError);
  });

  test.each([
    { uri: "https://example.test/benchmark-v1.json" },
    { digest: { sha256: "A".repeat(64) } },
    { digest: { sha256: "short" } },
    { digest: {} },
  ])("rejects supersedes without one canonical lowercase sha256 digest", (supersedes) => {
    const value = loadFixture("minimal.json") as Record<string, unknown>;
    expect(() => sealBenchmark({ ...value, supersedes })).toThrow(InvalidDocumentError);
  });

  test.each([
    ["string value", (value: Record<string, unknown>) => { value.description = "\uD800"; }],
    ["extension key", (value: Record<string, unknown>) => { value["bad\uDC00"] = "value"; }],
  ])("rejects an unpaired surrogate in received record %s", (_label, mutate) => {
    const value = JSON.parse(JSON.stringify(loadFixture("minimal.json"))) as Record<string, unknown>;
    mutate(value);
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    expect(() => parseBenchmark(bytes)).toThrow(/unpaired UTF-16 surrogate/);
  });

  test("accepts a supplementary-plane scalar in received record strings and keys", () => {
    const value = JSON.parse(JSON.stringify(loadFixture("minimal.json"))) as Record<string, unknown>;
    value.description = "astral-\u{1F9EA}";
    value["emoji-\u{1F680}"] = "ok";
    expect(parseBenchmark(sealBenchmark(value).bytes)).toMatchObject(value);
  });
});
