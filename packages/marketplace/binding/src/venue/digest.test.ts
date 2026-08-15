import { keccak256 } from "viem";
import { describe, expect, test } from "vitest";
import { ZeroEvidenceHashError, keccakEvidenceHash, rejectZeroEvidenceHash } from "./digest.js";

describe("keccakEvidenceHash", () => {
  test("computes keccak256 over the exact sealed bytes (today-mode router evidence-hash scheme, §6.3)", () => {
    const sealed = new TextEncoder().encode('{"a":1}');
    expect(keccakEvidenceHash(sealed)).toBe(keccak256(sealed));
  });

  test("is sensitive to every byte: a single-byte difference changes the hash", () => {
    const a = new TextEncoder().encode('{"a":1}');
    const b = new TextEncoder().encode('{"a":2}');
    expect(keccakEvidenceHash(a)).not.toBe(keccakEvidenceHash(b));
  });
});

describe("rejectZeroEvidenceHash", () => {
  test("rejects the all-zero hash (survives verbatim from the mech adapter, §6.3)", () => {
    const zero = `0x${"0".repeat(64)}` as const;
    expect(() => rejectZeroEvidenceHash(zero)).toThrow(ZeroEvidenceHashError);
  });

  test("accepts a non-zero hash", () => {
    const sealed = new TextEncoder().encode('{"a":1}');
    expect(() => rejectZeroEvidenceHash(keccakEvidenceHash(sealed))).not.toThrow();
  });
});
