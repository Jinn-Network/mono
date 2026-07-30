// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import { EvidenceContributionError } from "./errors.js";
import {
  parseAbsoluteIri,
  parseBoundedCount,
  parseContributionDigest,
  parseContributionTimestamp,
  snapshotInertJsonValue,
} from "./validation.js";

describe("parseContributionDigest", () => {
  test("accepts a canonical sha256 digest", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(parseContributionDigest(digest, "field")).toBe(digest);
  });

  test("rejects a malformed digest", () => {
    expect(() => parseContributionDigest("not-a-digest", "field"))
      .toThrow(EvidenceContributionError);
  });
});

describe("parseAbsoluteIri", () => {
  test("accepts a credential-free absolute IRI", () => {
    const iri = "https://destinations.example/ipfs";
    expect(parseAbsoluteIri(iri, "field")).toBe(iri);
  });

  test("rejects a relative path", () => {
    expect(() => parseAbsoluteIri("/relative/path", "field"))
      .toThrow(EvidenceContributionError);
  });

  test("rejects an IRI carrying credentials", () => {
    expect(() => parseAbsoluteIri("https://user:pass@example.com/x", "field"))
      .toThrow(EvidenceContributionError);
  });
});

describe("parseContributionTimestamp", () => {
  test("accepts a UTC ISO-8601 timestamp", () => {
    const at = "2026-07-28T00:00:00Z";
    expect(parseContributionTimestamp(at, "field")).toBe(at);
  });

  test("rejects a non-UTC or malformed timestamp", () => {
    expect(() => parseContributionTimestamp("2026-07-28", "field"))
      .toThrow(EvidenceContributionError);
  });
});

describe("parseBoundedCount", () => {
  test("accepts a safe integer within bounds", () => {
    expect(parseBoundedCount(4, "field", { min: 1, max: 10 })).toBe(4);
  });

  test("rejects a value below the minimum", () => {
    expect(() => parseBoundedCount(0, "field", { min: 1 }))
      .toThrow(EvidenceContributionError);
  });

  test("rejects a non-integer", () => {
    expect(() => parseBoundedCount(1.5, "field"))
      .toThrow(EvidenceContributionError);
  });
});

describe("snapshotInertJsonValue", () => {
  test("clones plain nested objects and arrays", () => {
    const value = { a: 1, b: [1, 2, { c: "x" }] };
    const snapshot = snapshotInertJsonValue(value);
    expect(snapshot).toEqual(value);
    expect(snapshot).not.toBe(value);
  });

  test("drops undefined-valued keys", () => {
    expect(snapshotInertJsonValue({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  test("rejects a Proxy", () => {
    const proxy = new Proxy({ a: 1 }, {});
    expect(() => snapshotInertJsonValue(proxy)).toThrow(EvidenceContributionError);
  });

  test("rejects an accessor property", () => {
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, "a", { get: () => 1, enumerable: true });
    expect(() => snapshotInertJsonValue(value)).toThrow(EvidenceContributionError);
  });

  test("rejects a symbol key", () => {
    const key = Symbol("k");
    const value: Record<PropertyKey, unknown> = { [key]: 1 };
    expect(() => snapshotInertJsonValue(value)).toThrow(EvidenceContributionError);
  });

  test("rejects a sparse array", () => {
    const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
    expect(() => snapshotInertJsonValue(sparse)).toThrow(EvidenceContributionError);
  });

  test("rejects a non-finite number", () => {
    expect(() => snapshotInertJsonValue({ a: Number.POSITIVE_INFINITY }))
      .toThrow(EvidenceContributionError);
    expect(() => snapshotInertJsonValue({ a: Number.NaN }))
      .toThrow(EvidenceContributionError);
  });

  test("rejects an unsupported prototype", () => {
    class Custom {
      a = 1;
    }
    expect(() => snapshotInertJsonValue(new Custom()))
      .toThrow(EvidenceContributionError);
  });

  test("rejects a cycle", () => {
    const value: Record<string, unknown> = { a: 1 };
    value.self = value;
    expect(() => snapshotInertJsonValue(value)).toThrow(EvidenceContributionError);
  });

  test("rejects unbounded depth", () => {
    let value: unknown = { leaf: true };
    for (let index = 0; index < 64; index += 1) value = { nested: value };
    expect(() => snapshotInertJsonValue(value)).toThrow(EvidenceContributionError);
  });
});
