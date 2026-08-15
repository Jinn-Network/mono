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

  test("sorts integer-like keys lexically and preserves own __proto__ data", () => {
    const value = JSON.parse(
      '{"2":"two","10":"ten","__proto__":{"retained":true},"a":1}',
    );
    const cloned = cloneJsonValue(value);
    expect(Object.getPrototypeOf(cloned)).toBeNull();
    expect(Object.hasOwn(cloned as object, "__proto__")).toBe(true);
    expect(new TextDecoder().decode(deterministicJsonBytes(value))).toBe(
      '{\n  "10": "ten",\n  "2": "two",\n  "__proto__": {\n    "retained": true\n  },\n  "a": 1\n}\n',
    );
  });

  test.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    new Date("2026-07-24T00:00:00Z"),
    Array(1),
    Object.setPrototypeOf([], null),
    Object.assign([], { "4294967295": "not-an-array-index" }),
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
    Object.defineProperty(source, Symbol.iterator, {
      value: function* () {
        yield 99;
      },
    });
    const copy = cloneBytes(source);
    source[0] = 99;
    expect(copy).toEqual(new Uint8Array([0, 127, 128, 255]));
    expect(standardBase64(copy)).toBe("AH+A/w==");
  });

  test("snapshots an array length intrinsically instead of invoking Proxy gets", () => {
    let lengthReads = 0;
    const hostile = new Proxy(["retained"], {
      get(target, property, receiver) {
        if (property === "length") {
          lengthReads += 1;
          return lengthReads === 1 ? 1 : 0;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(cloneJsonValue({ hostile })).toEqual({
      hostile: ["retained"],
    });
    expect(lengthReads).toBe(0);
  });
});
