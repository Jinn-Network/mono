// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import { canonicalJsonBytes } from "./canonical-json.js";
import { EvidenceContributionError } from "./errors.js";

const decoder = new TextDecoder();

describe("canonicalJsonBytes", () => {
  test("produces identical bytes regardless of key insertion order", () => {
    const first = canonicalJsonBytes({ a: 1, b: 2 }, 1024);
    const second = canonicalJsonBytes({ b: 2, a: 1 }, 1024);
    expect(first).toEqual(second);
    expect(decoder.decode(first)).toBe('{"a":1,"b":2}');
  });

  test("keeps array element order", () => {
    const bytes = canonicalJsonBytes({ list: [3, 1, 2] }, 1024);
    expect(decoder.decode(bytes)).toBe('{"list":[3,1,2]}');
  });

  test("sorts integer-like keys by UTF-16 code unit, not numeric value", () => {
    const bytes = canonicalJsonBytes({ 10: "ten", 2: "two" }, 1024);
    expect(decoder.decode(bytes)).toBe('{"10":"ten","2":"two"}');
  });

  test("emits no indentation or trailing newline", () => {
    const bytes = canonicalJsonBytes({ a: { b: 1 } }, 1024);
    expect(decoder.decode(bytes)).toBe('{"a":{"b":1}}');
  });

  test("mutating the source after serialization does not change the bytes", () => {
    const source: { a: number } = { a: 1 };
    const bytes = canonicalJsonBytes(source, 1024);
    source.a = 2;
    expect(decoder.decode(bytes)).toBe('{"a":1}');
  });

  test("rejects a Proxy input", () => {
    const proxy = new Proxy({ a: 1 }, {});
    expect(() => canonicalJsonBytes(proxy, 1024)).toThrow(EvidenceContributionError);
  });

  test("rejects a mutable Uint8Array embedded in the value", () => {
    expect(() => canonicalJsonBytes({ bytes: new Uint8Array([1, 2, 3]) }, 1024))
      .toThrow(EvidenceContributionError);
  });

  test("rejects output above the supplied byte limit", () => {
    expect(() => canonicalJsonBytes({ a: "x".repeat(100) }, 8))
      .toThrow(EvidenceContributionError);
  });
});
