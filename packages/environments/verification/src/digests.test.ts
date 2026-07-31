// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  BareHexSha256Schema,
  DigestSetSchema,
  PrefixedSha256Schema,
  ResourceDescriptorSchema,
  fromDigestSet,
  toDigestSet,
} from "./digests.js";
import { EnvironmentVerificationError } from "./errors.js";

const HEX = "a".repeat(64);

describe("digest discipline (design §4.2 vs §5.1)", () => {
  it("accepts the prefixed form only for scalar digest fields", () => {
    expect(PrefixedSha256Schema.safeParse(`sha256:${HEX}`).success).toBe(true);
    expect(PrefixedSha256Schema.safeParse(HEX).success).toBe(false);
  });

  it("accepts the bare-hex form only for in-toto DigestSet values", () => {
    expect(BareHexSha256Schema.safeParse(HEX).success).toBe(true);
    expect(BareHexSha256Schema.safeParse(`sha256:${HEX}`).success).toBe(false);
  });

  it("rejects the confusion fixture: a prefixed value inside a DigestSet", () => {
    expect(DigestSetSchema.safeParse({ sha256: `sha256:${HEX}` }).success).toBe(false);
    expect(
      ResourceDescriptorSchema.safeParse({
        name: "outcomes",
        digest: { sha256: `sha256:${HEX}` },
      }).success,
    ).toBe(false);
  });

  it("rejects uppercase hex and extra DigestSet members", () => {
    expect(DigestSetSchema.safeParse({ sha256: "A".repeat(64) }).success).toBe(false);
    expect(DigestSetSchema.safeParse({ sha256: HEX, sha512: HEX }).success).toBe(false);
  });

  it("crosses the two forms in both directions and refuses malformed input", () => {
    expect(toDigestSet(`sha256:${HEX}`)).toEqual({ sha256: HEX });
    expect(fromDigestSet({ sha256: HEX })).toBe(`sha256:${HEX}`);
    expect(() => toDigestSet(HEX as `sha256:${string}`)).toThrow(EnvironmentVerificationError);
    expect(() => fromDigestSet({ sha256: `sha256:${HEX}` })).toThrow(EnvironmentVerificationError);
  });
});
