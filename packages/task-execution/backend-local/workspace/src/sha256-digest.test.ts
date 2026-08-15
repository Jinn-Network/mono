// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { toBareSha256Hex, toSha256Digest } from "./sha256-digest.js";

const HEX = "90b25998166464fbb356ce7738149e7f173a78b6bff4d6896aaa96445e89abd8";

describe("the F9 conversion — bare hex <-> sha256:-prefixed spelling", () => {
  it("converts bare hex to the prefixed spelling", () => {
    expect(toSha256Digest(HEX)).toBe(`sha256:${HEX}`);
  });

  it("converts the prefixed spelling back to bare hex", () => {
    expect(toBareSha256Hex(`sha256:${HEX}`)).toBe(HEX);
  });

  it("round-trips in both directions", () => {
    expect(toBareSha256Hex(toSha256Digest(HEX))).toBe(HEX);
    expect(toSha256Digest(toBareSha256Hex(`sha256:${HEX}`))).toBe(`sha256:${HEX}`);
  });

  it("toSha256Digest rejects anything that is not exactly 64 lowercase hex characters", () => {
    expect(() => toSha256Digest(`sha256:${HEX}`)).toThrow(TypeError);
    expect(() => toSha256Digest(HEX.toUpperCase())).toThrow(TypeError);
    expect(() => toSha256Digest(HEX.slice(1))).toThrow(TypeError);
    expect(() => toSha256Digest("")).toThrow(TypeError);
  });

  it("toBareSha256Hex rejects anything that is not exactly sha256:<64 lowercase hex>", () => {
    expect(() => toBareSha256Hex(HEX)).toThrow(TypeError);
    expect(() => toBareSha256Hex(`SHA256:${HEX}`)).toThrow(TypeError);
    expect(() => toBareSha256Hex(`sha256:${HEX.toUpperCase()}`)).toThrow(TypeError);
    expect(() => toBareSha256Hex("sha256:")).toThrow(TypeError);
  });
});
