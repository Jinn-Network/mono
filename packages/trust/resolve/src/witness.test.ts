// SPDX-License-Identifier: Apache-2.0

import { sealDsseEnvelope } from "@jinn-network/trust-core";
import { describe, expect, it, vi } from "vitest";

import { ERC1271_MAGIC_VALUE } from "./abis.js";
import { createWitnessVerifier } from "./witness.js";

const VERIFIER_IRI = "https://spec.jinn.network/agents/verifier-1";
const SAFE = "0x4444444444444444444444444444444444444444";
const HASH = `0x${"aa".repeat(32)}`;
const SIGNATURE = `0x${"bb".repeat(65)}`;
const BLOCK_HASH = `0x${"cc".repeat(32)}`;

function witnessPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    chainId: 84532,
    blockNumber: 12345,
    blockHash: BLOCK_HASH,
    verifier: VERIFIER_IRI,
    safe: SAFE,
    hash: HASH,
    signature: SIGNATURE,
    result: ERC1271_MAGIC_VALUE,
    ...overrides,
  };
}

function sealWitnessPayload(payload: Record<string, unknown>): Uint8Array {
  return sealDsseEnvelope({
    payloadBytes: new TextEncoder().encode(JSON.stringify(payload)),
    signatures: [{ signature: new Uint8Array([1, 2, 3]), keyid: "did:key:zTestVerifierKey" }],
  });
}

function outerWitness(payload: ReturnType<typeof witnessPayload>, envelopeBytes: Uint8Array) {
  return {
    chainId: payload.chainId,
    blockNumber: payload.blockNumber,
    blockHash: payload.blockHash,
    verifier: payload.verifier,
    envelopeBytes,
  };
}

describe("createWitnessVerifier", () => {
  it("verifies a witness statement from a policy-accepted verifier", async () => {
    const payload = witnessPayload();
    const envelopeBytes = sealWitnessPayload(payload);
    const verifier = createWitnessVerifier({ acceptedVerifiers: [VERIFIER_IRI] });

    await expect(
      verifier.verify1271Witness(outerWitness(payload, envelopeBytes)),
    ).resolves.toEqual({ verified: true });
  });

  it("fails a fabricated (unsigned) witness envelope", async () => {
    const verifier = createWitnessVerifier({ acceptedVerifiers: [VERIFIER_IRI] });
    const fabricated = new TextEncoder().encode(
      JSON.stringify({ payloadType: "application/vnd.in-toto+json", payload: "not-base64!", signatures: [] }),
    );

    const result = await verifier.verify1271Witness({
      chainId: 84532,
      blockNumber: 12345,
      blockHash: BLOCK_HASH,
      verifier: VERIFIER_IRI,
      envelopeBytes: fabricated,
    });
    expect(result).toEqual({
      verified: false,
      reason: "witness envelope does not decode to a signed statement.",
    });
  });

  it("fails when the witness statement content does not match the claimed fields (lifted witness)", async () => {
    const payload = witnessPayload();
    const envelopeBytes = sealWitnessPayload(payload);
    const verifier = createWitnessVerifier({ acceptedVerifiers: [VERIFIER_IRI] });

    const result = await verifier.verify1271Witness({
      chainId: payload.chainId,
      blockNumber: payload.blockNumber,
      blockHash: `0x${"ff".repeat(32)}`, // mismatched blockHash
      verifier: payload.verifier,
      envelopeBytes,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/content does not match/);
  });

  it("falls back to archive re-execution when the witness author is not policy-accepted", async () => {
    const payload = witnessPayload();
    const envelopeBytes = sealWitnessPayload(payload);
    const readContract = vi.fn(async () => ERC1271_MAGIC_VALUE);
    const verifier = createWitnessVerifier({
      acceptedVerifiers: [],
      archiveClient: { readContract },
    });

    await expect(
      verifier.verify1271Witness(outerWitness(payload, envelopeBytes)),
    ).resolves.toEqual({ verified: true });

    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: SAFE,
      functionName: "isValidSignature",
      args: [HASH, SIGNATURE],
      blockNumber: BigInt(payload.blockNumber),
    }));
  });

  it("fails closed when the witness author is not policy-accepted and no archive client is configured", async () => {
    const payload = witnessPayload();
    const envelopeBytes = sealWitnessPayload(payload);
    const verifier = createWitnessVerifier({ acceptedVerifiers: [] });

    const result = await verifier.verify1271Witness(outerWitness(payload, envelopeBytes));
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/not policy-accepted/);
  });

  it("fails the archive re-execution path when the on-chain result is not the magic value", async () => {
    const payload = witnessPayload();
    const envelopeBytes = sealWitnessPayload(payload);
    const readContract = vi.fn(async () => "0xdeadbeef");
    const verifier = createWitnessVerifier({
      acceptedVerifiers: [],
      archiveClient: { readContract },
    });

    const result = await verifier.verify1271Witness(outerWitness(payload, envelopeBytes));
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/magic value/);
  });

  it("fails when the witness-attested result itself is not the magic value (even if policy-accepted)", async () => {
    const payload = witnessPayload({ result: "0xdeadbeef" });
    const envelopeBytes = sealWitnessPayload(payload);
    const verifier = createWitnessVerifier({ acceptedVerifiers: [VERIFIER_IRI] });

    const result = await verifier.verify1271Witness(outerWitness(payload, envelopeBytes));
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/magic value/);
  });
});
