// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { serializeCanonicalJson as protocolSerialize } from "@jinn-network/task-execution-protocol";
import { canonicalJsonBytes, serializeCanonicalJson } from "./canonical.js";
import { DerivationError } from "./errors.js";

describe("canonical JSON (local re-implementation)", () => {
  it("sorts object keys by UTF-16 code unit, not by locale", () => {
    expect(serializeCanonicalJson({ b: 1, a: 2, A: 3, "ä": 4, z: 5 }))
      .toBe('{"A":3,"a":2,"b":1,"z":5,"ä":4}');
  });

  it("agrees byte-for-byte with the protocol package's serializer", () => {
    const value = {
      rule: "network.jinn.source-commitment/1",
      nested: { list: [1, "two", true, null, { k: "v" }], empty: [] },
      unicode: "π — umlaut ü",
      dataset: "owner/dataset",
    };
    // The plan wrote `new TextEncoder().encode(protocolSerialize(value))`; protocol's
    // serializer already returns the encoded bytes (protocol/src/canonical.ts:21), so the
    // comparison is byte array against byte array.
    expect(canonicalJsonBytes(value)).toEqual(protocolSerialize(value));
  });

  it("rejects a fractional number rather than rounding it", () => {
    expect(() => serializeCanonicalJson({ weight: 0.5 })).toThrow(DerivationError);
  });

  it("rejects an undefined property value rather than dropping the key", () => {
    expect(() => serializeCanonicalJson({ a: undefined } as never)).toThrow(DerivationError);
  });

  it("rejects an unpaired surrogate in a string", () => {
    expect(() => serializeCanonicalJson({ s: "\ud800" })).toThrow(DerivationError);
  });

  it("rejects an unpaired surrogate in a key", () => {
    expect(() => serializeCanonicalJson({ "\udc00": 1 })).toThrow(DerivationError);
  });
});
