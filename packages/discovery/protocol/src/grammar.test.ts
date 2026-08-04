import { describe, it, expect } from "vitest";
import {
  isSourceName,
  assertRecordKindUri,
  canonicalizeRecordKindUri,
  parseRecordKindUri,
  CANONICAL_RECORDS_ROOT,
  RECORD_KIND_ROOTS,
  formatOrigin,
  splitOrigin,
  formatSequence,
  nextSequence,
} from "./grammar.js";
import {
  CANONICAL_ORIGIN,
  LEGACY_ORIGINS,
  canonicalVersionSegment,
  canonicalizeOrigin,
  identifierOrigin,
  isLegacyOriginIdentifier,
} from "./origins.js";

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
    expect(() => assertRecordKindUri("https://jinn.network/records/task/1.0")).not.toThrow();
  });

  it("throws on a malformed record-kind URI", () => {
    expect(() => assertRecordKindUri("https://jinn.network/records/Task/1.0")).toThrow();
    expect(() => assertRecordKindUri("https://jinn.network/records/task")).toThrow();
    expect(() => assertRecordKindUri("not-a-uri")).toThrow();
  });

  // --- DR-2026-08-04 transition window: dual-accept origin and version ---

  it("accepts the canonical origin with the canonical major-only version", () => {
    expect(() => assertRecordKindUri("https://spec.jinn.network/records/task/v1")).not.toThrow();
  });

  it("accepts every combination of recognized origin and recognized version form", () => {
    for (const root of RECORD_KIND_ROOTS) {
      for (const version of ["v1", "v2", "v10", "1.0", "1.1", "2.0"]) {
        expect(() => assertRecordKindUri(`${root}/task/${version}`)).not.toThrow();
      }
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

describe("record-kind canonicalization (DR-2026-08-04)", () => {
  it("parses either origin and reports which root it matched", () => {
    expect(parseRecordKindUri("https://jinn.network/records/task/1.0")).toEqual({
      root: "https://jinn.network/records",
      segment: "task",
      version: "1.0",
    });
    expect(parseRecordKindUri("https://spec.jinn.network/records/task/v1")).toEqual({
      root: CANONICAL_RECORDS_ROOT,
      segment: "task",
      version: "v1",
    });
    expect(parseRecordKindUri("not-a-uri")).toBeUndefined();
  });

  it("translates a legacy record kind to the canonical origin and major-only version", () => {
    expect(canonicalizeRecordKindUri("https://jinn.network/records/task/1.0"))
      .toBe("https://spec.jinn.network/records/task/v1");
    expect(canonicalizeRecordKindUri("https://jinn.network/records/execution-evidence/1.0"))
      .toBe("https://spec.jinn.network/records/execution-evidence/v1");
  });

  it("collapses a compatible minor revision onto the same identifier", () => {
    // The DR's whole ground for major-only: 1.0 -> 1.1 was never supposed to change identity.
    expect(canonicalizeRecordKindUri("https://jinn.network/records/task/1.1"))
      .toBe(canonicalizeRecordKindUri("https://jinn.network/records/task/1.0"));
    expect(canonicalizeRecordKindUri("https://jinn.network/records/task/2.0"))
      .toBe("https://spec.jinn.network/records/task/v2");
  });

  it("is idempotent on an already-canonical record kind", () => {
    const canonical = "https://spec.jinn.network/records/task/v1";
    expect(canonicalizeRecordKindUri(canonical)).toBe(canonical);
    expect(canonicalizeRecordKindUri(canonicalizeRecordKindUri(canonical) as string)).toBe(canonical);
  });

  it("returns undefined rather than passing a non-conforming name through", () => {
    // A name that is not a record kind must never emerge looking canonical.
    for (const uri of [
      "https://example.org/records/task/v1",
      "https://jinn.network/profiles/task/1.0",
      "https://jinn.network/records/Task/1.0",
      "not-a-uri",
    ]) {
      expect(canonicalizeRecordKindUri(uri)).toBeUndefined();
    }
  });
});

describe("origin translation (DR-2026-08-04)", () => {
  it("recognizes both origins and names which one is legacy", () => {
    expect(identifierOrigin("https://spec.jinn.network/records/task/v1")).toBe(CANONICAL_ORIGIN);
    expect(identifierOrigin("https://jinn.network/records/task/1.0")).toBe(LEGACY_ORIGINS[0]);
    expect(identifierOrigin("https://example.org/x")).toBeUndefined();
    expect(isLegacyOriginIdentifier("https://jinn.network/records/task/1.0")).toBe(true);
    expect(isLegacyOriginIdentifier("https://spec.jinn.network/records/task/v1")).toBe(false);
    expect(isLegacyOriginIdentifier("https://example.org/x")).toBe(false);
  });

  it("compares byte-exactly: no case folding, no trailing dot, no port tolerance", () => {
    for (const uri of [
      "https://JINN.network/records/task/1.0",
      "https://jinn.network./records/task/1.0",
      "https://jinn.network:443/records/task/1.0",
      "http://jinn.network/records/task/1.0",
      "https://spec.JINN.network/records/task/v1",
    ]) {
      expect(identifierOrigin(uri)).toBeUndefined();
      expect(canonicalizeOrigin(uri)).toBeUndefined();
    }
  });

  it("moves only the origin, never the path", () => {
    expect(canonicalizeOrigin("https://jinn.network/profiles/trace-vocabulary/1.0"))
      .toBe("https://spec.jinn.network/profiles/trace-vocabulary/1.0");
    expect(canonicalizeOrigin("https://spec.jinn.network/profiles/x/v1"))
      .toBe("https://spec.jinn.network/profiles/x/v1");
  });

  it("translates version segments to the canonical major-only form", () => {
    expect(canonicalVersionSegment("v1")).toBe("v1");
    expect(canonicalVersionSegment("1.0")).toBe("v1");
    expect(canonicalVersionSegment("1.9")).toBe("v1");
    expect(canonicalVersionSegment("12.3")).toBe("v12");
    for (const bad of ["v0", "0.1", "1", "1.0.0", "latest", ""]) {
      expect(canonicalVersionSegment(bad)).toBeUndefined();
    }
  });
});
