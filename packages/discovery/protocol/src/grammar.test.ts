import { describe, it, expect } from "vitest";
import {
  isSourceName,
  assertRecordKindUri,
  formatOrigin,
  splitOrigin,
  formatSequence,
  nextSequence,
} from "./grammar.js";

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
});
