// SPDX-License-Identifier: Apache-2.0

import { sealDsseEnvelope } from "@jinn-network/trust-core";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
} from "viem";
import { describe, expect, it, vi } from "vitest";

import { ERC1271_IS_VALID_SIGNATURE_ABI, ERC1271_MAGIC_VALUE } from "./abis.js";
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

  it.each([
    ["nothing", null],
    ["a number", 7],
    ["an empty object", {}],
    ["envelope bytes that are not bytes", { envelopeBytes: 7 }],
  ])("answers for a stored witness of %s, because a throw here reads as an outage", async (_label, witness) => {
    const verifier = createWitnessVerifier({ acceptedVerifiers: [VERIFIER_IRI] });
    await expect(verifier.verify1271Witness(witness as never)).resolves.toMatchObject({ verified: false });
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

  describe("when the archive read does not return", () => {
    const payload = witnessPayload();
    const witness = outerWitness(payload, sealWitnessPayload(payload));
    const verifierFailingWith = (cause: unknown) => createWitnessVerifier({
      acceptedVerifiers: [],
      archiveClient: {
        readContract: async () => {
          throw cause;
        },
      },
    });
    /** A viem client's failure of the shape it wraps every contract read in, naming what went wrong. */
    const failedRead = (...causes: readonly string[]): Error => {
      const inner = causes.reduceRight<Error | undefined>(
        (cause, name) => Object.assign(new Error(name, cause === undefined ? {} : { cause }), { name }),
        undefined,
      );
      return new ContractFunctionExecutionError(inner as never, {
        abi: ERC1271_IS_VALID_SIGNATURE_ABI,
        args: [HASH, SIGNATURE],
        functionName: "isValidSignature",
      });
    };

    it.each([
      ["a client that says nothing of what failed", new Error("no route to host")],
      ["an unreachable node", failedRead("CallExecutionError", "HttpRequestError")],
      ["a node that timed out", failedRead("CallExecutionError", "TimeoutError")],
      ["a socket that failed", failedRead("CallExecutionError", "WebSocketRequestError")],
      ["a socket that closed", failedRead("CallExecutionError", "SocketClosedError")],
      ["a rate limit", failedRead("CallExecutionError", "LimitExceededRpcError")],
      ["a node with no capacity", failedRead("CallExecutionError", "ResourceUnavailableRpcError")],
      ["an unreachable node, whatever wraps it", failedRead("ContractFunctionRevertedError", "HttpRequestError")],
    ])("lets %s out as an outage: no node took the read", async (_label, cause) => {
      await expect(verifierFailingWith(cause).verify1271Witness(witness)).rejects.toBe(cause);
    });

    it.each([
      ["reverted", new ContractFunctionExecutionError(
        new ContractFunctionRevertedError({ abi: ERC1271_IS_VALID_SIGNATURE_ABI, functionName: "isValidSignature", message: "GS026" }),
        { abi: ERC1271_IS_VALID_SIGNATURE_ABI, args: [HASH, SIGNATURE], functionName: "isValidSignature" },
      )],
      ["reverted, however deep the client wrapped it", new Error("outer", {
        cause: new Error("middle", { cause: new Error("inner", { cause: failedRead("ContractFunctionRevertedError") }) }),
      })],
      ["has no code at that block", new ContractFunctionZeroDataError({ functionName: "isValidSignature" })],
      ["returned too few bytes", failedRead("AbiDecodingDataSizeTooSmallError")],
      ["ran out of gas", failedRead("CallExecutionError", "ExecutionRevertedError")],
      ["is at a block the node does not hold", failedRead("CallExecutionError", "InvalidInputRpcError")],
    ])("takes a contract that %s as an answer: a statement chooses both, so it cannot read as an outage", async (_label, cause) => {
      const result = await verifierFailingWith(cause).verify1271Witness(witness);
      expect(result.verified).toBe(false);
      expect(result.reason).toMatch(/archive re-execution/);
    });
  });

  it.each([
    ["an address that is not one", { safe: "0xnot-an-address" }],
    ["an address whose checksum is wrong", { safe: "0x4444444444444444444444444444444444444AaA" }],
    ["a hash that is not 32 bytes", { hash: "0xaa" }],
    ["a hash of the right length that is not hex", { hash: `0x${"zz".repeat(32)}` }],
    ["a signature that is not hex", { signature: "bytes" }],
    ["a block that is not a number on the chain", { blockNumber: 1.5 }],
    ["a block below the first", { blockNumber: -1 }],
    ["a block too far past what a number holds exactly", { blockNumber: 2 ** 53 }],
  ])("answers for a statement holding %s, before any read", async (_label, overrides) => {
    const payload = witnessPayload(overrides);
    const readContract = vi.fn(async () => {
      throw new Error("not read");
    });
    const verifier = createWitnessVerifier({ acceptedVerifiers: [], archiveClient: { readContract } });
    const result = await verifier.verify1271Witness(outerWitness(payload, sealWitnessPayload(payload)));
    expect(result.verified).toBe(false);
    expect(readContract).not.toHaveBeenCalled();
  });

  it.each([
    ["the first block", { blockNumber: 0 }],
    ["an address in lower case", { safe: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" }],
    ["an empty signature", { signature: "0x" }],
  ])("puts a statement naming %s to the archive", async (_label, overrides) => {
    const payload = witnessPayload(overrides);
    const readContract = vi.fn(async () => ERC1271_MAGIC_VALUE);
    const verifier = createWitnessVerifier({ acceptedVerifiers: [], archiveClient: { readContract } });
    await expect(verifier.verify1271Witness(outerWitness(payload, sealWitnessPayload(payload)))).resolves.toEqual({ verified: true });
    expect(readContract).toHaveBeenCalledOnce();
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
