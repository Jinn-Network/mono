// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, sha256Hex } from "./canonical.js";

function text(value: unknown): string {
  return new TextDecoder().decode(canonicalJsonBytes(value));
}

describe("canonicalJsonBytes — accepted plain data", () => {
  it("serializes nested plain objects/arrays/strings/booleans/null/safe integers with sorted keys", () => {
    expect(text({
      b: [1, "two", true, null, { z: 1, a: 2 }],
      a: "first",
    })).toBe('{"a":"first","b":[1,"two",true,null,{"a":2,"z":1}]}');
  });

  it("omits an explicit undefined member exactly as it omits an absent one", () => {
    expect(text({ present: 1, missing: undefined })).toBe(text({ present: 1 }));
    expect(text({ present: 1, missing: undefined })).toBe('{"present":1}');
  });

  it("digests the exact UTF-8 bytes it returned", () => {
    const bytes = canonicalJsonBytes({ a: 1 });
    expect(sha256Hex(bytes)).toBe(sha256Hex(new TextEncoder().encode('{"a":1}')));
  });

  it("sorts object keys by UTF-16 code unit, not Unicode code point", () => {
    // U+FFFF is a single BMP code unit (0xFFFF); U+10000 is a surrogate pair whose leading unit
    // (0xD800) is numerically less than 0xFFFF. Code-unit order (JCS, and what this package must
    // match) puts U+10000 first; naive code-point order would put U+FFFF first.
    const value = { "￿": 1, "\u{10000}": 2 };
    const astralKey = JSON.stringify("\u{10000}");
    const bmpKey = JSON.stringify("￿");

    const rendered = text(value);

    expect(rendered).toBe(`{${astralKey}:2,${bmpKey}:1}`);
    expect(rendered.indexOf(astralKey)).toBeLessThan(rendered.indexOf(bmpKey));
  });
});

describe("canonicalJsonBytes — refusals", () => {
  it("refuses non-plain objects: Date, Map, and a class instance", () => {
    class Widget { public name = "x"; }
    expect(() => canonicalJsonBytes(new Date())).toThrow(/non-plain object/u);
    expect(() => canonicalJsonBytes(new Map([["a", 1]]))).toThrow(/non-plain object/u);
    expect(() => canonicalJsonBytes(new Widget())).toThrow(/non-plain object/u);
  });

  it("accepts a null-prototype plain object", () => {
    const value = Object.assign(Object.create(null), { a: 1 }) as Record<string, unknown>;
    expect(text(value)).toBe('{"a":1}');
  });

  it("refuses a sparse array hole instead of silently emitting invalid JSON", () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3];
    expect(() => canonicalJsonBytes(sparse)).toThrow(/sparse array hole/u);
  });

  it("refuses an explicit undefined array element", () => {
    expect(() => canonicalJsonBytes([1, undefined, 3])).toThrow(/undefined array element/u);
  });

  it("refuses symbol-keyed members", () => {
    const value = { [Symbol("s")]: 1, a: 1 };
    expect(() => canonicalJsonBytes(value)).toThrow(/symbol-keyed member/u);
  });

  it("refuses non-enumerable members", () => {
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, "hidden", { value: 1, enumerable: false });
    expect(() => canonicalJsonBytes(value)).toThrow(/non-enumerable member/u);
  });

  it("refuses cyclic structures with a typed refusal, not a raw RangeError", () => {
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    expect(() => canonicalJsonBytes(cycle)).toThrow(/cyclic structure/u);
    try {
      canonicalJsonBytes(cycle);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).not.toBeInstanceOf(RangeError);
      expect((error as Error).name).toBe("EvaluationOperationalError");
    }
  });

  it("refuses a non-integer number", () => {
    expect(() => canonicalJsonBytes(1.5)).toThrow(/non-integer number/u);
  });

  it("refuses negative zero", () => {
    expect(() => canonicalJsonBytes(-0)).toThrow(/negative zero/u);
  });

  it("refuses a number outside the safe-integer range", () => {
    expect(() => canonicalJsonBytes(Number.MAX_SAFE_INTEGER + 2)).toThrow(/safe range/u);
  });

  it("refuses a lone surrogate in a string value or a key", () => {
    expect(() => canonicalJsonBytes("\ud800")).toThrow(/unpaired surrogate/u);
    expect(() => canonicalJsonBytes({ "\udc00": 1 })).toThrow(/unpaired surrogate/u);
  });
});
