// SPDX-License-Identifier: Apache-2.0

// Test-only differential oracle. Same pattern, and same justification, as `canonicalize` in
// packages/environments/record: an implementation that only checks itself cannot catch its own
// misreading of a specification, and a wrong ABI encoding does not throw -- it calls a
// different function and the task gets graded on that answer.

import { AbiFunction, AbiParameters, Hex } from "ox";
import { describe, expect, it } from "vitest";

import { encodeAbiCall, type AbiValue } from "./abi-encode.js";
import { loadAbiVectors } from "./abi-vectors.js";

function toOxValues(vector: { types: readonly string[]; values: readonly unknown[] }): unknown[] {
  return vector.values.map((value, index) => toOxValue(value, vector.types[index]!));
}

function toOxValue(value: unknown, type: string): unknown {
  const staticMatch = /^(.+)\[(\d+)\]$/.exec(type);
  if (staticMatch) {
    const [, elem, len] = staticMatch;
    if (!Array.isArray(value) || value.length !== Number(len)) {
      throw new Error(`invalid static array value for ${type}`);
    }
    return value.map((entry) => toOxValue(entry, elem!));
  }
  if (type.endsWith("[]")) {
    const elem = type.slice(0, -2);
    if (!Array.isArray(value)) throw new Error(`invalid dynamic array value for ${type}`);
    return value.map((entry) => toOxValue(entry, elem));
  }
  if (type === "address") return value;
  if (type === "bool") return value === "true";
  if (type.startsWith("uint") || type.startsWith("int")) return BigInt(value as string);
  return value;
}

function oxEncode(signature: string, types: readonly string[], values: readonly unknown[]): string {
  const selector = AbiFunction.getSelector(signature);
  const parameters = AbiParameters.from(types) as unknown as Parameters<typeof AbiParameters.encode>[0];
  const theirs = Hex.concat(
    selector,
    AbiParameters.encode(parameters, toOxValues({ types, values }) as never),
  );
  return theirs;
}

function boundaryValues(bits: number): string[] {
  const max = (1n << BigInt(bits)) - 1n;
  if (bits === 256) {
    return ["0", max.toString()];
  }
  return ["0", max.toString()];
}

function overflowOf(bits: number): string {
  return ((1n << BigInt(bits))).toString();
}

describe("abi encoder, differentially", () => {
  it("agrees with an independent encoder on every committed vector", async () => {
    const vectors = await loadAbiVectors();
    expect(vectors.length).toBeGreaterThanOrEqual(20);
    for (const vector of vectors) {
      const ours = encodeAbiCall(vector.signature, vector.types, vector.values as readonly AbiValue[]);
      const theirs = oxEncode(vector.signature, vector.types, vector.values);
      expect(ours, `${vector.name}: encoders disagree`).toBe(theirs);
      expect(ours, `${vector.name}: corpus disagrees`).toBe(vector.expectedCalldata);
    }
  });

  it("agrees on the boundary values the closed type set admits", () => {
    for (const bits of [8, 16, 32, 64, 128, 256]) {
      for (const value of boundaryValues(bits)) {
        expect(encodeAbiCall(`f(uint${bits})`, [`uint${bits}`], [value]))
          .toBe(oxEncode(`f(uint${bits})`, [`uint${bits}`], [value]));
      }
      expect(() => encodeAbiCall(`f(uint${bits})`, [`uint${bits}`], [overflowOf(bits)]))
        .toThrow();
    }
  });
});
