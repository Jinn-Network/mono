// SPDX-License-Identifier: Apache-2.0

import { bareHexDigest } from "@jinn-network/chain-environment-record";
import { describe, expect, it } from "vitest";

import {
  BareHexSha256Schema,
  DigestSetSchema,
  PrefixedSha256Schema,
  ResourceDescriptorSchema,
  fromDigestSet,
  toDigestSet,
} from "./digests.js";
import { ChainVerificationError } from "./errors.js";

const HEX = "a".repeat(64);
const PREFIXED = `sha256:${HEX}` as const;

describe("digest discipline", () => {
  it("scalar fields take the prefixed form and reject the bare one", () => {
    expect(PrefixedSha256Schema.safeParse(PREFIXED).success).toBe(true);
    expect(PrefixedSha256Schema.safeParse(HEX).success).toBe(false);
    expect(PrefixedSha256Schema.safeParse(`sha256:${"A".repeat(64)}`).success).toBe(false);
  });

  it("in-toto DigestSet values take the bare form and reject the prefixed one", () => {
    expect(BareHexSha256Schema.safeParse(HEX).success).toBe(true);
    expect(BareHexSha256Schema.safeParse(PREFIXED).success).toBe(false);
    // The contract-6 confusion fixture, in its smallest form.
    expect(DigestSetSchema.safeParse({ sha256: PREFIXED }).success).toBe(false);
    expect(DigestSetSchema.safeParse({ sha256: HEX, sha512: HEX }).success).toBe(false);
  });

  it("round-trips through the only two sanctioned crossings", () => {
    expect(toDigestSet(PREFIXED)).toEqual({ sha256: HEX });
    expect(fromDigestSet({ sha256: HEX })).toBe(PREFIXED);
    expect(fromDigestSet(toDigestSet(PREFIXED))).toBe(PREFIXED);
  });

  it("agrees with the record package's bare-hex conversion", () => {
    // Cross-package equivalence (program contract 3): two independent implementations of the
    // same crossing must land on the same bytes, or a subject digest means two things.
    expect(toDigestSet(PREFIXED).sha256).toBe(bareHexDigest(PREFIXED));
  });

  it("refuses a malformed crossing loudly rather than coercing", () => {
    expect(() => toDigestSet(HEX as `sha256:${string}`)).toThrow(ChainVerificationError);
    expect(() => fromDigestSet({ sha256: PREFIXED } as never)).toThrow(ChainVerificationError);
  });

  it("a ResourceDescriptor carries a DigestSet and optional locators only", () => {
    expect(ResourceDescriptorSchema.safeParse({
      name: "state-artifact",
      uri: "ipfs://bafy",
      mediaType: "application/vnd.jinn.chain-state.v1",
      digest: { sha256: HEX },
    }).success).toBe(true);
    expect(ResourceDescriptorSchema.safeParse({ digest: { sha256: PREFIXED } }).success)
      .toBe(false);
    expect(ResourceDescriptorSchema.safeParse({ uri: "ipfs://bafy" }).success).toBe(false);
  });
});
