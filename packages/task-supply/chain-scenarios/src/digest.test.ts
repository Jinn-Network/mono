// SPDX-License-Identifier: Apache-2.0
import { documentDigest as derivationDigest } from "@jinn-network/task-derivation";
import { describe, expect, it } from "vitest";
import { assertBareHex, assertPrefixedDigest, documentDigest, toBareHex } from "./digest.js";

const BARE = "e".repeat(64);
const PREFIXED = `sha256:${BARE}`;

describe("prefixed and bare spellings never substitute for each other", () => {
  it("agrees with the derivation unit on document digests", () => {
    const bytes = new TextEncoder().encode('{"a":1}');
    expect(documentDigest(bytes)).toBe(derivationDigest(bytes));
  });
  it("refuses a bare hex where a record-body digest is required", () => {
    expect(() => assertPrefixedDigest(BARE, "test")).toThrow(/sha256:/);
  });
  it("refuses a prefixed digest where a DigestSet value is required", () => {
    expect(() => assertBareHex(PREFIXED, "test")).toThrow(/bare/);
  });
  it("refuses uppercase hex in either spelling", () => {
    expect(() => assertBareHex(BARE.toUpperCase(), "test")).toThrow();
    expect(() => assertPrefixedDigest(`sha256:${BARE.toUpperCase()}`, "test")).toThrow();
  });
  it("converts prefixed to bare and nothing else", () => {
    expect(toBareHex(PREFIXED, "test")).toBe(BARE);
  });
});
