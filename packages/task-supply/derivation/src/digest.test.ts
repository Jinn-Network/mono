// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { documentDigest as protocolDigest } from "@jinn-network/task-execution-protocol";
import {
  assertBareHex,
  assertPrefixedDigest,
  digestsEqual,
  documentDigest,
  toBareHex,
} from "./digest.js";
import { DerivationError } from "./errors.js";

const HEX = "a".repeat(64);

describe("digest discipline (program §5 contract 6)", () => {
  it("agrees with the protocol package's documentDigest", () => {
    const bytes = new TextEncoder().encode("supply");
    expect(documentDigest(bytes)).toBe(protocolDigest(bytes));
  });

  it("requires the sha256: prefix on record-body digests", () => {
    expect(assertPrefixedDigest(`sha256:${HEX}`, "x")).toBe(`sha256:${HEX}`);
    expect(() => assertPrefixedDigest(HEX, "x")).toThrow(DerivationError);
    expect(() => assertPrefixedDigest(`sha256:${HEX.toUpperCase()}`, "x")).toThrow(DerivationError);
  });

  it("requires bare hex in DigestSet-shaped maps — the confusion fixture", () => {
    expect(assertBareHex(HEX, "x")).toBe(HEX);
    expect(() => assertBareHex(`sha256:${HEX}`, "x")).toThrow(DerivationError);
  });

  it("converts prefixed to bare and refuses already-bare input", () => {
    expect(toBareHex(`sha256:${HEX}`, "x")).toBe(HEX);
    expect(() => toBareHex(HEX, "x")).toThrow(DerivationError);
  });

  it("compares across encodings only where a foreign convention may differ", () => {
    expect(digestsEqual(`sha256:${HEX}`, HEX)).toBe(true);
    expect(digestsEqual(`sha256:${HEX}`, `sha256:${"b".repeat(64)}`)).toBe(false);
    expect(digestsEqual("not-a-digest", HEX)).toBe(false);
  });
});
