// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { decodeAbiReturn, encodeAbiCall, type AbiValue } from "./abi-encode.js";
import { loadAbiVectors } from "./abi-vectors.js";
import { ChainVerificationError } from "./errors.js";

function stripSelector(calldata: string): string {
  return `0x${calldata.slice(10)}`;
}

function normalizeDecoded(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeDecoded(entry));
  return value;
}

describe("abi encoder vectors", () => {
  it("matches the committed corpus byte-for-byte", async () => {
    const vectors = await loadAbiVectors();
    expect(vectors.length).toBeGreaterThanOrEqual(20);
    for (const vector of vectors) {
      const calldata = encodeAbiCall(vector.signature, vector.types, vector.values as readonly AbiValue[]);
      expect(calldata, vector.name).toBe(vector.expectedCalldata);
    }
  });

  it("round-trips argument encoding through the return decoder", async () => {
    const vectors = await loadAbiVectors();
    for (const vector of vectors) {
      if (vector.types.length === 0) continue;
      const calldata = encodeAbiCall(vector.signature, vector.types, vector.values as readonly AbiValue[]);
      const decoded = decodeAbiReturn(vector.types, stripSelector(calldata));
      expect(decoded.length, vector.name).toBe(vector.types.length);
      for (let i = 0; i < vector.types.length; i++) {
        const expected = vector.values[i];
        const actual = decoded[i];
        if (Array.isArray(expected)) {
          expect(JSON.parse(actual!), vector.name).toEqual(normalizeDecoded(expected));
        } else {
          expect(actual, vector.name).toBe(expected);
        }
      }
    }
  });

  it("rejects out-of-range integers, mis-cased addresses, and arity mismatches", () => {
    expect(() => encodeAbiCall("f(uint8)", ["uint8"], ["256"])).toThrow(ChainVerificationError);
    expect(() => encodeAbiCall("f(uint256)", ["uint256"], [
      "115792089237316195423570985008687907853269984665640564039457584007913129639936",
    ])).toThrow(ChainVerificationError);
    expect(() => encodeAbiCall("f(address)", ["address"], ["0xAb00000000000000000000000000000000000000aa"]))
      .toThrow(ChainVerificationError);
    expect(() => encodeAbiCall("f(uint256)", ["uint8"], ["1"])).toThrow(ChainVerificationError);
    expect(() => encodeAbiCall("f(uint256)", ["uint256"], ["1", "2"])).toThrow(ChainVerificationError);
    expect(() => encodeAbiCall("f(tuple)", ["tuple"], ["1"])).toThrow(ChainVerificationError);
  });

  it("rejects malformed return decoding", () => {
    expect(() => decodeAbiReturn(["uint256"], "0x")).toThrow(ChainVerificationError);
    expect(() => decodeAbiReturn(["bytes"], "0x0000000000000000000000000000000000000000000000000000000000000080"))
      .toThrow(ChainVerificationError);
    expect(() => decodeAbiReturn(["uint256"], "0x08c379a0000000000000000000000000000000000000000000000000000000000000020"))
      .toThrow(ChainVerificationError);
  });
});
