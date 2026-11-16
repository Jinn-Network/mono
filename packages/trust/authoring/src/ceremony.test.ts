// SPDX-License-Identifier: Apache-2.0

import {
  bindingTermsCommitment,
  ceremonyCurrencyFailure,
  matchCeremonyContent,
  serializeCeremonyMessage,
  type BindingTerms,
  type KeyBinding,
} from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import { ceremonyNonce, performEoaCeremony } from "./ceremony.js";

const LOWERCASE_EOA = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as const;
const CHECKSUMMED_EOA = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const SAFE = "0x8464135c8f25da09e49bc8782676a84730c318bc" as const;
const DID_KEY = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const ISSUED_AT = "2026-08-07T00:00:00.000Z";
const TERMS: BindingTerms = {
  relationship: "controls",
  scope: ["deliveries"],
  validFrom: ISSUED_AT,
};

function stubSigner(address: `0x${string}`) {
  const seen: Uint8Array[] = [];
  return {
    address,
    seen,
    async signMessage(input: { readonly message: { readonly raw: Uint8Array } }): Promise<`0x${string}`> {
      seen.push(input.message.raw);
      return `0x${"11".repeat(65)}`;
    },
  };
}

describe("performEoaCeremony", () => {
  it("declares the ACTUAL signer as message.address, EIP-55 checksummed", async () => {
    const signer = stubSigner(LOWERCASE_EOA);
    const ceremony = await performEoaCeremony({
      signer,
      agent: "urn:uuid:operator-a",
      didKey: DID_KEY,
      issuedAt: ISSUED_AT,
      terms: TERMS,
    });
    expect(ceremony.message.address).toBe(CHECKSUMMED_EOA);
    expect(ceremony.type).toBe("eoa");
    // The bytes handed to the signer are exactly the bytes the evidence carries.
    expect(Buffer.from(signer.seen[0]!).equals(Buffer.from(ceremony.messageBytes))).toBe(true);
    expect(Buffer.from(serializeCeremonyMessage("eoa", ceremony.message))
      .equals(Buffer.from(ceremony.messageBytes))).toBe(true);
  });

  it("commits to the binding's terms as the last resource without a settlement Safe (ceremony currency §2)", async () => {
    const ceremony = await performEoaCeremony({
      signer: stubSigner(CHECKSUMMED_EOA),
      agent: "urn:uuid:operator-a",
      didKey: DID_KEY,
      issuedAt: ISSUED_AT,
      terms: TERMS,
    });
    const commitment = bindingTermsCommitment(TERMS);
    expect(ceremony.message.resources).toEqual(["urn:uuid:operator-a", DID_KEY, commitment]);
    expect(new TextDecoder().decode(ceremony.messageBytes)).toContain(`- ${commitment}`);
    expect(ceremonyCurrencyFailure(ceremony.message, TERMS, {
      profile: { termsCutover: ISSUED_AT },
      effectiveStart: ISSUED_AT,
    })).toBeUndefined();
  });

  it("places the service Safe as the third resource ahead of the terms commitment (§2.3b, ceremony currency §3)", async () => {
    const settlementTerms: BindingTerms = {
      relationship: "controls",
      scope: ["settlements"],
      validFrom: ISSUED_AT,
    };
    const ceremony = await performEoaCeremony({
      signer: stubSigner(CHECKSUMMED_EOA),
      agent: "urn:uuid:operator-a",
      didKey: DID_KEY,
      issuedAt: ISSUED_AT,
      terms: settlementTerms,
      settlementSafe: SAFE,
    });
    const commitment = bindingTermsCommitment(settlementTerms);
    expect(ceremony.message.resources).toEqual([
      "urn:uuid:operator-a",
      DID_KEY,
      "did:pkh:eip155:84532:0x8464135c8F25Da09e49BC8782676a84730C318bC",
      commitment,
    ]);
    // Both the Safe and the terms commitment ride inside the signed bytes.
    const text = new TextDecoder().decode(ceremony.messageBytes);
    expect(text).toContain("- did:pkh:eip155:84532:0x8464135c8F25Da09e49BC8782676a84730C318bC");
    expect(text).toContain(`- ${commitment}`);
    expect(ceremonyCurrencyFailure(ceremony.message, settlementTerms, {
      profile: { termsCutover: ISSUED_AT },
      effectiveStart: ISSUED_AT,
    })).toBeUndefined();
  });

  it("includes expiresAt in the terms commitment when the binding carries one (ceremony currency §2)", async () => {
    const withExpiry: BindingTerms = { ...TERMS, expiresAt: "2026-09-07T00:00:00.000Z" };
    const ceremony = await performEoaCeremony({
      signer: stubSigner(CHECKSUMMED_EOA),
      agent: "urn:uuid:operator-a",
      didKey: DID_KEY,
      issuedAt: ISSUED_AT,
      terms: withExpiry,
    });
    expect(ceremony.message.resources.at(-1)).toBe(bindingTermsCommitment(withExpiry));
    expect(ceremony.message.resources.at(-1)).not.toBe(bindingTermsCommitment(TERMS));
    // Reusing that ceremony for an unending record fails the commitment check.
    expect(ceremonyCurrencyFailure(ceremony.message, TERMS, {
      profile: {},
      effectiveStart: ISSUED_AT,
    })).toMatch(/commits to terms/u);
  });

  it("never sets expirationTime (§2.3d: ceremony evidence stays offline-verifiable forever)", async () => {
    const ceremony = await freshCeremony();
    expect(ceremony.message.expirationTime).toBeUndefined();
    expect(new TextDecoder().decode(ceremony.messageBytes)).not.toContain("Expiration Time:");
  });

  it("uses the §7 nonce scheme: 16 random bytes, lowercase hex, fresh per ceremony", async () => {
    const first = await freshCeremony();
    const second = await freshCeremony();
    expect(first.message.nonce).toMatch(/^[0-9a-f]{32}$/u);
    expect(second.message.nonce).not.toBe(first.message.nonce);
    expect(ceremonyNonce()).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("names the domain and URI the verifier requires (§7.2), so what it authors binds", async () => {
    const ceremony = await freshCeremony();
    // Only the fields the content match reads: the signature is a stub here, and
    // trust-core's own tests cover recovery.
    const binding = { agent: "urn:uuid:operator-a", key: { didKey: DID_KEY } } as KeyBinding;
    expect(matchCeremonyContent(ceremony, binding)).toEqual({ matches: true });
    const elsewhere = { ...ceremony.message, domain: "login.example" };
    expect(matchCeremonyContent({ ...ceremony, message: elsewhere, messageBytes: serializeCeremonyMessage("eoa", elsewhere) }, binding))
      .toMatchObject({ matches: false, mismatch: expect.stringMatching(/domain/u) });
  });

  it("refuses a subject that is not a did:key", async () => {
    await expect(performEoaCeremony({
      signer: stubSigner(CHECKSUMMED_EOA),
      agent: "urn:uuid:operator-a",
      didKey: "0xdeadbeef",
      issuedAt: ISSUED_AT,
      terms: TERMS,
    })).rejects.toThrow(/is not a did:key/u);
  });

  it.each([
    ["an unreadable issuedAt", { issuedAt: "2026-08-07T00:00Z" }, /issuedAt .* cannot be read/u],
    ["an unreadable terms validFrom", { terms: { ...TERMS, validFrom: "2026-08-07" } }, /validFrom .* cannot be read/u],
    ["an unreadable terms expiresAt", { terms: { ...TERMS, expiresAt: "2026-09-07T00:00+02:00" } }, /expiresAt .* cannot be read/u],
    ["an empty terms scope", { terms: { ...TERMS, scope: [] } }, /non-empty scope/u],
    ["an agent using the binding-terms URN family", { agent: "urn:jinn:trust:binding-terms:v1:sha256:00" }, /binding-terms/u],
  ])("refuses %s", async (_label, overrides, pattern) => {
    await expect(performEoaCeremony({
      signer: stubSigner(CHECKSUMMED_EOA),
      agent: "urn:uuid:operator-a",
      didKey: DID_KEY,
      issuedAt: ISSUED_AT,
      terms: TERMS,
      ...overrides,
    })).rejects.toThrow(pattern);
  });
});

function freshCeremony() {
  return performEoaCeremony({
    signer: stubSigner(CHECKSUMMED_EOA),
    agent: "urn:uuid:operator-a",
    didKey: DID_KEY,
    issuedAt: ISSUED_AT,
    terms: TERMS,
  });
}
