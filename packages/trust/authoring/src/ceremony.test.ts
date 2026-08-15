// SPDX-License-Identifier: Apache-2.0

import { serializeCeremonyMessage } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import { ceremonyNonce, performEoaCeremony } from "./ceremony.js";

const LOWERCASE_EOA = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as const;
const CHECKSUMMED_EOA = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const SAFE = "0x8464135c8f25da09e49bc8782676a84730c318bc" as const;
const DID_KEY = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

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
      issuedAt: "2026-08-07T00:00:00.000Z",
    });
    expect(ceremony.message.address).toBe(CHECKSUMMED_EOA);
    expect(ceremony.type).toBe("eoa");
    // The bytes handed to the signer are exactly the bytes the evidence carries.
    expect(Buffer.from(signer.seen[0]!).equals(Buffer.from(ceremony.messageBytes))).toBe(true);
    expect(Buffer.from(serializeCeremonyMessage("eoa", ceremony.message))
      .equals(Buffer.from(ceremony.messageBytes))).toBe(true);
  });

  it("declares exactly two resources without a settlement Safe", async () => {
    const ceremony = await performEoaCeremony({
      signer: stubSigner(CHECKSUMMED_EOA),
      agent: "urn:uuid:operator-a",
      didKey: DID_KEY,
      issuedAt: "2026-08-07T00:00:00.000Z",
    });
    expect(ceremony.message.resources).toEqual(["urn:uuid:operator-a", DID_KEY]);
  });

  it("adds the service Safe as a third did:pkh resource for settlement-family bindings (§2.3b)", async () => {
    const ceremony = await performEoaCeremony({
      signer: stubSigner(CHECKSUMMED_EOA),
      agent: "urn:uuid:operator-a",
      didKey: DID_KEY,
      issuedAt: "2026-08-07T00:00:00.000Z",
      settlementSafe: SAFE,
    });
    expect(ceremony.message.resources).toHaveLength(3);
    expect(ceremony.message.resources[2]).toBe("did:pkh:eip155:84532:0x8464135c8F25Da09e49BC8782676a84730C318bC");
    // The third resource rides inside the signed bytes, so it cannot be swapped after the fact.
    expect(new TextDecoder().decode(ceremony.messageBytes))
      .toContain("- did:pkh:eip155:84532:0x8464135c8F25Da09e49BC8782676a84730C318bC");
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

  it("refuses a subject that is not a did:key", async () => {
    await expect(performEoaCeremony({
      signer: stubSigner(CHECKSUMMED_EOA),
      agent: "urn:uuid:operator-a",
      didKey: "0xdeadbeef",
      issuedAt: "2026-08-07T00:00:00.000Z",
    })).rejects.toThrow(/is not a did:key/u);
  });
});

function freshCeremony() {
  return performEoaCeremony({
    signer: stubSigner(CHECKSUMMED_EOA),
    agent: "urn:uuid:operator-a",
    didKey: DID_KEY,
    issuedAt: "2026-08-07T00:00:00.000Z",
  });
}
