import { describe, it, expect } from "vitest";
import {
  isSourceName,
  assertRecordKindUri,
  parseRecordKindUri,
  RECORDS_KIND_ROOT,
  formatOrigin,
  splitOrigin,
  formatSequence,
  nextSequence,
} from "./grammar.js";
import { CANONICAL_ORIGIN, isCanonicalOriginIdentifier } from "./origins.js";

describe("isSourceName", () => {
  it("accepts single-character, hyphenated, and 64-char-max names", () => {
    expect(isSourceName("a")).toBe(true);
    expect(isSourceName("a-b")).toBe(true);
    expect(isSourceName("a".repeat(64))).toBe(true);
  });

  it("rejects uppercase, leading hyphen, and names over 64 characters", () => {
    expect(isSourceName("A")).toBe(false);
    expect(isSourceName("-a")).toBe(false);
    expect(isSourceName("a".repeat(65))).toBe(false);
  });
});

describe("formatOrigin / splitOrigin", () => {
  it("formats and splits a urn:uuid: agent IRI (no embedded slashes)", () => {
    expect(formatOrigin("urn:uuid:1234", "feed")).toBe("urn:uuid:1234/feed");
    expect(splitOrigin("urn:uuid:1234/feed")).toEqual({ agent: "urn:uuid:1234", name: "feed" });
  });

  it("splits on the last slash when the agent IRI itself contains slashes", () => {
    expect(splitOrigin("https://ex.org/a/b/feed")).toEqual({
      agent: "https://ex.org/a/b",
      name: "feed",
    });
  });
});

describe("sequence discipline", () => {
  it("formats a bigint as a fixed-width 16-digit decimal", () => {
    expect(formatSequence(1n)).toBe("0000000000000001");
    expect(formatSequence(42n)).toBe("0000000000000042");
  });

  it("increments by exactly one, gap-free", () => {
    expect(nextSequence("0000000000000001")).toBe("0000000000000002");
    expect(nextSequence("0000000000000042")).toBe("0000000000000043");
  });
});

describe("assertRecordKindUri", () => {
  it("accepts a conforming record-kind URI", () => {
    expect(() => assertRecordKindUri("https://spec.jinn.network/records/task/v1")).not.toThrow();
  });

  it("throws on a malformed record-kind URI", () => {
    expect(() => assertRecordKindUri("https://spec.jinn.network/records/Task/v1")).toThrow();
    expect(() => assertRecordKindUri("https://spec.jinn.network/records/task")).toThrow();
    expect(() => assertRecordKindUri("not-a-uri")).toThrow();
  });

  // --- DR-2026-08-04, closed: one origin, one version form ---

  it("accepts every canonical major version", () => {
    for (const version of ["v1", "v2", "v10"]) {
      expect(() => assertRecordKindUri(`${RECORDS_KIND_ROOT}/task/${version}`)).not.toThrow();
    }
  });

  it("refuses the retired origin by name", () => {
    // The regression test for the C2 narrowing: while the apex was dual-accepted, a
    // pre-re-seal spelling parsed as a valid record kind. It must not any more.
    expect(() => assertRecordKindUri("https://jinn.network/records/task/1.0")).toThrow(
      /must start with "https:\/\/spec\.jinn\.network\/records\/"/u,
    );
    expect(() => assertRecordKindUri("https://jinn.network/records/task/v1")).toThrow();
  });

  it("refuses the retired <major>.<minor> version under the canonical origin", () => {
    for (const version of ["1.0", "1.1", "2.0"]) {
      expect(() => assertRecordKindUri(`${RECORDS_KIND_ROOT}/task/${version}`)).toThrow(
        /version must be v<major>/u,
      );
    }
  });

  it("still refuses an unrecognized origin, a bad segment, and a bad version", () => {
    expect(() => assertRecordKindUri("https://evil.jinn.network/records/task/v1")).toThrow();
    expect(() => assertRecordKindUri("https://jinn.network.evil.example/records/task/v1")).toThrow();
    expect(() => assertRecordKindUri("https://spec.jinn.network/records/Task/v1")).toThrow();
    expect(() => assertRecordKindUri("https://spec.jinn.network/records/task/v0")).toThrow();
    expect(() => assertRecordKindUri("https://spec.jinn.network/records/task/1")).toThrow();
    expect(() => assertRecordKindUri("https://spec.jinn.network/records/task/1.0.0")).toThrow();
    expect(() => assertRecordKindUri("https://spec.jinn.network/records/task/v1/facts/v1")).toThrow();
  });
});

describe("record-kind parsing (DR-2026-08-04)", () => {
  it("parses the canonical spelling and nothing else", () => {
    expect(parseRecordKindUri("https://spec.jinn.network/records/task/v1")).toEqual({
      root: RECORDS_KIND_ROOT,
      segment: "task",
      version: "v1",
    });
    for (const uri of [
      "https://jinn.network/records/task/1.0",
      "https://spec.jinn.network/records/task/1.0",
      "https://example.org/records/task/v1",
      "https://spec.jinn.network/profiles/task/v1",
      "https://spec.jinn.network/records/Task/v1",
      "not-a-uri",
    ]) {
      expect(parseRecordKindUri(uri)).toBeUndefined();
    }
  });
});

describe("canonical origin recognition (DR-2026-08-04)", () => {
  it("recognizes the one origin", () => {
    expect(RECORDS_KIND_ROOT).toBe(`${CANONICAL_ORIGIN}/records`);
    expect(isCanonicalOriginIdentifier("https://spec.jinn.network/records/task/v1")).toBe(true);
    expect(isCanonicalOriginIdentifier("https://jinn.network/records/task/1.0")).toBe(false);
    expect(isCanonicalOriginIdentifier("https://example.org/x")).toBe(false);
  });

  it("compares byte-exactly: no case folding, no trailing dot, no port tolerance", () => {
    for (const uri of [
      "https://spec.JINN.network/records/task/v1",
      "https://spec.jinn.network./records/task/v1",
      "https://spec.jinn.network:443/records/task/v1",
      "http://spec.jinn.network/records/task/v1",
      "https://notspec.jinn.network/records/task/v1",
    ]) {
      expect(isCanonicalOriginIdentifier(uri)).toBe(false);
      expect(parseRecordKindUri(uri)).toBeUndefined();
    }
  });
});
