// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { decodeRlp } from "./rlp.js";

const bytes = (hex: string) => Uint8Array.from(
  (hex.match(/../gu) ?? []).map((pair) => Number.parseInt(pair, 16)),
);

describe("RLP decoding", () => {
  it("decodes single bytes, short strings, and short lists", () => {
    expect(decodeRlp(bytes("00"))).toEqual(bytes("00"));
    expect(decodeRlp(bytes("83646f67"))).toEqual(bytes("646f67")); // "dog"
    const list = decodeRlp(bytes("c88363617483646f67")); // ["cat", "dog"]
    expect(Array.isArray(list)).toBe(true);
    expect((list as Uint8Array[])[0]).toEqual(bytes("636174"));
  });

  it("decodes long strings and long lists through their length prefixes", () => {
    const payload = "61".repeat(56);
    expect(decodeRlp(bytes(`b838${payload}`))).toEqual(bytes(payload));
  });

  it("refuses trailing bytes and truncated input rather than guessing", () => {
    expect(() => decodeRlp(bytes("83646f6700"))).toThrow(/trailing/u);
    expect(() => decodeRlp(bytes("83646f"))).toThrow(/truncated/u);
  });
});
