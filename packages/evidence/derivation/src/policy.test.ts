// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { canonicalJsonBytes, sha256Digest } from "./bytes.js";
import { baselinePolicyValue } from "./fixtures.js";
import { parseDerivationPolicy } from "./index.js";

const HOSTILE_BYTE_ACCESSORS = [
  { name: "byteLength", key: "byteLength" },
  { name: "length", key: "length" },
  { name: "iterator", key: Symbol.iterator },
] as const;

describe("derivation policy", () => {
  test("accepts exact RFC 8785 policy bytes", () => {
    const bytes = canonicalJsonBytes(baselinePolicyValue());
    const parsed = parseDerivationPolicy(bytes);
    expect(parsed.value.schemaVersion).toBe(
      "jinn.evidence-derivation-policy.v1",
    );
    expect(parsed.digest).toBe(sha256Digest(bytes));
  });

  test("rejects semantically equal non-canonical bytes", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify(baselinePolicyValue(), null, 2),
    );
    expect(() => parseDerivationPolicy(bytes)).toThrowError(
      expect.objectContaining({ code: "POLICY_INVALID" }),
    );
  });

  test("rejects duplicate detector ids", () => {
    const value = baselinePolicyValue();
    value.requiredDetectors.push(value.requiredDetectors[0]!);
    expect(() => parseDerivationPolicy(canonicalJsonBytes(value))).toThrow(
      /detector ids must be unique/,
    );
  });

  test("rejects a disposition without a stub for redact", () => {
    const value = baselinePolicyValue();
    delete value.stubs.email;
    expect(() => parseDerivationPolicy(canonicalJsonBytes(value))).toThrow(
      /redact class email requires a stub/,
    );
  });

  test("rejects duplicate class/confidence disposition floors", () => {
    const value = baselinePolicyValue();
    (
      value as unknown as {
        dispositions: Array<(typeof value.dispositions)[number]>;
      }
    ).dispositions.push({ ...value.dispositions[0]! });
    expect(() => parseDerivationPolicy(canonicalJsonBytes(value))).toThrow(
      /disposition class\/confidence rows must be unique/,
    );
  });

  test("rejects private configuration material", () => {
    const value = {
      ...baselinePolicyValue(),
      privateKnownIdentities: ["Ada Example"],
    };
    expect(() => parseDerivationPolicy(canonicalJsonBytes(value))).toThrowError(
      expect.objectContaining({ code: "POLICY_INVALID" }),
    );
  });

  test("contains commitments but no synthetic private values", () => {
    const text = new TextDecoder().decode(
      canonicalJsonBytes(baselinePolicyValue()),
    );
    expect(text).not.toContain("Ada Example");
    expect(text).not.toContain("private-test-nonce");
    expect(text).toContain("configurationDigest");
  });

  test.each(HOSTILE_BYTE_ACCESSORS)(
    "snapshots valid bytes without executing an own $name accessor",
    ({ key }) => {
      const expected = canonicalJsonBytes(baselinePolicyValue());
      const bytes = canonicalJsonBytes(baselinePolicyValue());
      let accessorCalls = 0;
      Object.defineProperty(bytes, key, {
        configurable: true,
        get() {
          accessorCalls += 1;
          throw new Error("caller byte accessor must not execute");
        },
      });

      const parsed = parseDerivationPolicy(bytes);

      expect(parsed.bytes).toEqual(expected);
      expect(parsed.digest).toBe(sha256Digest(expected));
      expect(accessorCalls).toBe(0);
    },
  );

  test("maps an unsnapshotable byte input to POLICY_INVALID", () => {
    const bytes = new Proxy(canonicalJsonBytes(baselinePolicyValue()), {});
    expect(() => parseDerivationPolicy(bytes)).toThrowError(
      expect.objectContaining({ code: "POLICY_INVALID" }),
    );
  });
});
