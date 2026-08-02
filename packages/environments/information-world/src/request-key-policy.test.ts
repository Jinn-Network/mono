import { describe, expect, test } from "vitest";

import { isHttpToken } from "./ascii.js";
import { InvalidDocumentError } from "./sealing.js";
import {
  CREDENTIAL_HEADER_NAMES,
  REQUEST_KEY_VERSION,
  RequestKeyPolicySchema,
  assertRequestKeyPolicy,
  type RequestKeyPolicy,
} from "./request-key-policy.js";

const base: RequestKeyPolicy = {
  version: "irk1",
  headerSubset: ["accept", "content-type"],
  pathTrailingSlash: "preserve",
  plusInQuery: "literal",
  bodyCanonicalization: "opaque-bytes",
};

describe("RequestKeyPolicySchema", () => {
  test("the version identifier is pinned", () => {
    expect(REQUEST_KEY_VERSION).toBe("irk1");
  });

  test("accepts the base policy and an empty header subset", () => {
    expect(RequestKeyPolicySchema.safeParse(base).success).toBe(true);
    expect(RequestKeyPolicySchema.safeParse({ ...base, headerSubset: [] }).success).toBe(true);
  });

  test("is strict: no extra keys, namespaced or not", () => {
    expect(RequestKeyPolicySchema.safeParse({ ...base, matchLoosely: true }).success).toBe(false);
    expect(RequestKeyPolicySchema.safeParse({ ...base, "network.jinn.x": 1 }).success).toBe(false);
  });

  test("rejects an unknown version, ordering, plus rule, or body rule", () => {
    expect(RequestKeyPolicySchema.safeParse({ ...base, version: "irk2" }).success).toBe(false);
    expect(RequestKeyPolicySchema.safeParse({ ...base, pathTrailingSlash: "ignore" }).success)
      .toBe(false);
    expect(RequestKeyPolicySchema.safeParse({ ...base, plusInQuery: "maybe" }).success).toBe(false);
    expect(RequestKeyPolicySchema.safeParse({ ...base, bodyCanonicalization: "loose" }).success)
      .toBe(false);
  });
});

describe("assertRequestKeyPolicy", () => {
  test("accepts a sorted, unique, lowercase subset", () => {
    expect(() => assertRequestKeyPolicy(base)).not.toThrow();
  });

  test("rejects an uppercase header name rather than folding it", () => {
    // Folding here would make two sealed policies that differ only by case produce identical
    // keys, so the record would no longer be its bytes. Refuse instead.
    expect(() => assertRequestKeyPolicy({ ...base, headerSubset: ["Accept"] }))
      .toThrow(InvalidDocumentError);
  });

  test("rejects an unsorted subset", () => {
    expect(() => assertRequestKeyPolicy({ ...base, headerSubset: ["content-type", "accept"] }))
      .toThrow(InvalidDocumentError);
  });

  test("rejects a duplicated name", () => {
    expect(() => assertRequestKeyPolicy({ ...base, headerSubset: ["accept", "accept"] }))
      .toThrow(InvalidDocumentError);
  });

  test("rejects a name that is not an RFC 9110 token", () => {
    expect(() => assertRequestKeyPolicy({ ...base, headerSubset: ["x forwarded"] }))
      .toThrow(InvalidDocumentError);
  });

  test("seals exactly the three canonical credential header names in a frozen order", () => {
    expect(CREDENTIAL_HEADER_NAMES).toEqual([
      "authorization",
      "cookie",
      "proxy-authorization",
    ]);
    expect(Object.isFrozen(CREDENTIAL_HEADER_NAMES)).toBe(true);
    for (const name of CREDENTIAL_HEADER_NAMES) expect(isHttpToken(name)).toBe(true);
  });

  test("rejects every credential-bearing header name (finding CF6-1)", () => {
    for (const name of CREDENTIAL_HEADER_NAMES) {
      expect(
        () => assertRequestKeyPolicy({ ...base, headerSubset: [name] }),
        `${name} must not key a sealed corpus`,
      ).toThrow(InvalidDocumentError);
    }
  });

  test("names the offending field in the issue path", () => {
    try {
      assertRequestKeyPolicy({ ...base, headerSubset: ["Accept"] });
      throw new Error("expected InvalidDocumentError");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidDocumentError);
      expect((error as InvalidDocumentError).errors[0]?.path).toBe("headerSubset.0");
    }
  });
});
