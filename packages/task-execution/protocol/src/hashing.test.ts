import { describe, expect, test } from "vitest";
import { documentDigest, sha256Hex } from "./hashing.js";

describe("sha256Hex / documentDigest", () => {
  test("matches the known SHA-256 test vector for the empty byte string", () => {
    const empty = new Uint8Array();
    expect(sha256Hex(empty)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(documentDigest(empty)).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("matches the known SHA-256 test vector for the ASCII string 'abc'", () => {
    const bytes = new TextEncoder().encode("abc");
    expect(sha256Hex(bytes)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("is deterministic and content-sensitive", () => {
    const a = new TextEncoder().encode("a");
    const b = new TextEncoder().encode("b");
    expect(sha256Hex(a)).toBe(sha256Hex(a));
    expect(sha256Hex(a)).not.toBe(sha256Hex(b));
  });
});
