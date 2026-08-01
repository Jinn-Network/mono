import { describe, expect, test } from "vitest";

import { bareHexDigest, prefixedDigest, sealedRecordDigest, sha256Hex } from "./hashing.js";

const bytes = new TextEncoder().encode('{"kind":"x"}');

describe("digest spellings", () => {
  test("a record-body digest is sha256:-prefixed lowercase hex", () => {
    expect(sealedRecordDigest(bytes)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sha256Hex(bytes)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("bareHexDigest yields the in-toto DigestSet spelling and round-trips", () => {
    const digest = sealedRecordDigest(bytes);
    const bare = bareHexDigest(digest);
    expect(bare).toMatch(/^[0-9a-f]{64}$/);
    expect(bare.startsWith("sha256:")).toBe(false);
    expect(prefixedDigest(bare)).toBe(digest);
  });

  test("bareHexDigest refuses an already-bare value rather than passing it through", () => {
    const bare = bareHexDigest(sealedRecordDigest(bytes));
    expect(() => bareHexDigest(bare as never)).toThrow();
  });

  test("prefixedDigest refuses an already-prefixed value rather than double-prefixing", () => {
    expect(() => prefixedDigest(sealedRecordDigest(bytes))).toThrow();
  });

  test("prefixedDigest refuses uppercase hex: canonical bytes admit one spelling", () => {
    expect(() => prefixedDigest("A".repeat(64))).toThrow();
  });
});
