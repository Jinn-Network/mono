// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  cloneBytes,
  cloneJsonValue,
  deterministicJsonBytes,
  standardBase64,
} from "./deterministic-json.js";

describe("deterministic JSON", () => {
  test("sorts object keys recursively while preserving array order", () => {
    expect(new TextDecoder().decode(deterministicJsonBytes({
      z: 1,
      a: [{ y: true, x: false }, 2],
    }))).toBe(
      '{\n  "a": [\n    {\n      "x": false,\n      "y": true\n    },\n    2\n  ],\n  "z": 1\n}\n',
    );
  });

  test.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    new Date("2026-07-24T00:00:00Z"),
  ])("rejects non-JSON input %#", (value) => {
    expect(() => cloneJsonValue(value)).toThrow(
      expect.objectContaining({ code: "INVALID_ISSUANCE_INPUT" }),
    );
  });

  test("rejects cycles and copies bytes", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => cloneJsonValue(cycle)).toThrow(
      expect.objectContaining({ code: "INVALID_ISSUANCE_INPUT" }),
    );
    const source = new Uint8Array([0, 127, 128, 255]);
    const copy = cloneBytes(source);
    source[0] = 99;
    expect(copy).toEqual(new Uint8Array([0, 127, 128, 255]));
    expect(standardBase64(copy)).toBe("AH+A/w==");
  });
});
