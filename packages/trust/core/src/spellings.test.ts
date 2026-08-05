import { describe, expect, test } from "vitest";

import {
  Caip19AgentSchema,
  DidPkhSchema,
  RelationshipSchema,
  ScopeSchema,
  didPkh,
  isChecksummedAddress,
  toChecksumAddress,
} from "./spellings.js";

// EIP-55 reference test vectors (from the EIP-55 specification itself).
const CHECKSUMMED_ADDRESS = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

describe("EIP-55 checksum", () => {
  test("computes the canonical checksum casing", () => {
    expect(toChecksumAddress(CHECKSUMMED_ADDRESS.toLowerCase())).toBe(CHECKSUMMED_ADDRESS);
  });

  test("accepts the correctly checksummed address", () => {
    expect(isChecksummedAddress(CHECKSUMMED_ADDRESS)).toBe(true);
  });

  test("rejects a lowercase (non-checksummed) address", () => {
    expect(isChecksummedAddress(CHECKSUMMED_ADDRESS.toLowerCase())).toBe(false);
  });

  test("rejects an incorrectly cased address", () => {
    const wrong = "0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED";
    expect(isChecksummedAddress(wrong)).toBe(false);
  });
});

describe("DidPkhSchema", () => {
  test("mandates EIP-55 checksum (design §3.1) -- a lowercase address is rejected", () => {
    const lowercase = `did:pkh:eip155:8453:${CHECKSUMMED_ADDRESS.toLowerCase()}`;
    expect(DidPkhSchema.safeParse(lowercase).success).toBe(false);
  });

  test("a valid checksummed did:pkh parses and round-trips", () => {
    const value = `did:pkh:eip155:8453:${CHECKSUMMED_ADDRESS}`;
    const result = DidPkhSchema.safeParse(value);
    expect(result.success).toBe(true);
    expect(result.success && result.data).toBe(value);
    expect(didPkh(8453, CHECKSUMMED_ADDRESS.toLowerCase())).toBe(value);
  });
});

describe("Caip19AgentSchema", () => {
  const registry = CHECKSUMMED_ADDRESS.toLowerCase();

  test("requires the erc721: asset namespace", () => {
    expect(Caip19AgentSchema.safeParse(`eip155:8453/erc20:${registry}/1`).success).toBe(false);
    expect(Caip19AgentSchema.safeParse(`eip155:8453/erc721:${registry}/1`).success).toBe(true);
  });

  test("requires a positive decimal agentId with no leading zero", () => {
    expect(Caip19AgentSchema.safeParse(`eip155:8453/erc721:${registry}/0`).success).toBe(false);
    expect(Caip19AgentSchema.safeParse(`eip155:8453/erc721:${registry}/01`).success).toBe(false);
    expect(Caip19AgentSchema.safeParse(`eip155:8453/erc721:${registry}/-1`).success).toBe(false);
    expect(Caip19AgentSchema.safeParse(`eip155:8453/erc721:${registry}/42`).success).toBe(true);
  });
});

describe("RelationshipSchema", () => {
  test("accepts every closed-vocabulary member", () => {
    for (const member of ["controls", "operates", "signs-for"]) {
      expect(RelationshipSchema.safeParse(member).success).toBe(true);
    }
  });

  test("rejects an unknown relationship", () => {
    expect(RelationshipSchema.safeParse("owns").success).toBe(false);
  });
});

describe("ScopeSchema", () => {
  test("accepts every closed-vocabulary member", () => {
    for (const member of [
      "deliveries",
      "verdicts",
      "settlements",
      "observations",
      "authorizations",
      "bindings",
    ]) {
      expect(ScopeSchema.safeParse(member).success).toBe(true);
    }
  });

  test("rejects an unknown scope", () => {
    expect(ScopeSchema.safeParse("wishes").success).toBe(false);
  });

  test("accepts a namespaced extension", () => {
    expect(ScopeSchema.safeParse("jinn:discovery-announcements").success).toBe(true);
  });

  test("accepts TEP §21.3 reverse-DNS and absolute-URI extension names (§7.45)", () => {
    expect(ScopeSchema.safeParse("network.jinn.discovery.announcements").success).toBe(true);
    expect(
      ScopeSchema.safeParse(
        "https://spec.jinn.network/trust-scopes/admission-receipts/v1",
      ).success,
    ).toBe(true);
    expect(ScopeSchema.safeParse("urn:jinn:trust-scope:receipts").success).toBe(true);
  });

  test("rejects a malformed namespaced extension", () => {
    expect(ScopeSchema.safeParse("Jinn:Bad Namespace").success).toBe(false);
    expect(ScopeSchema.safeParse("no-colon").success).toBe(false);
  });

  test.each([
    "relative/scope",
    "https:/missing-authority",
    "https://",
    "https://spec.jinn.network/has whitespace",
    "https://spec.jinn.network/control\u0007",
    "network..jinn.scope",
    "-network.jinn.scope",
    "network.-jinn.scope",
    "network.jinn-.scope",
    "network.jinn.scope-",
  ])("rejects malformed extension scope %j (§7.45)", (scope) => {
    expect(ScopeSchema.safeParse(scope).success).toBe(false);
  });
});
