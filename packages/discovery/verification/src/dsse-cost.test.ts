// SPDX-License-Identifier: Apache-2.0

/**
 * Signature checks counted rather than timed: one per signature, however its key ids repeat.
 */

import { generateKeyPairSync, sign, verify } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { sealDsseEnvelope } from "@jinn-network/trust-core";
import type { DsseProducedSignature } from "@jinn-network/trust-core";

import { didKeyFromEd25519PublicKey } from "./did-key.js";
import { createDidKeyDsseVerifier, verifyDsseSignatures } from "./dsse.js";

vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, verify: vi.fn(crypto.verify) };
});

const SIGNATURES = 64;

function key() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { keyId: didKeyFromEd25519PublicKey(publicKey), publicKey, privateKey };
}

const signer = key();

function wrongSignature(by: ReturnType<typeof key>): DsseProducedSignature {
  return { signature: new Uint8Array(sign(null, Buffer.from("another message"), by.privateKey)), keyid: by.keyId };
}

function sealed(signatures: readonly DsseProducedSignature[]): Uint8Array {
  return sealDsseEnvelope({
    payloadType: "application/vnd.in-toto+json",
    payloadBytes: new TextEncoder().encode("{}"),
    signatures: signatures as [DsseProducedSignature, ...DsseProducedSignature[]],
  });
}

describe("one signature check per signature", () => {
  beforeEach(() => {
    vi.mocked(verify).mockClear();
  });

  test("createDidKeyDsseVerifier, with every signature repeating one key id", () => {
    const envelope = sealed(new Array<DsseProducedSignature>(SIGNATURES).fill(wrongSignature(signer)));
    expect(createDidKeyDsseVerifier()(envelope).validSignerKeyids).toEqual([]);
    expect(verify).toHaveBeenCalledTimes(SIGNATURES);
  });

  test("createDidKeyDsseVerifier, with every signature under its own key id", () => {
    const envelope = sealed(Array.from({ length: SIGNATURES }, () => wrongSignature(key())));
    expect(createDidKeyDsseVerifier()(envelope).validSignerKeyids).toEqual([]);
    expect(verify).toHaveBeenCalledTimes(SIGNATURES);
  });

  test("verifyDsseSignatures, with every signature repeating one key id", () => {
    const envelope = sealed(new Array<DsseProducedSignature>(SIGNATURES).fill(wrongSignature(signer)));
    expect(verifyDsseSignatures(envelope, [signer]).validSignerKeyids).toEqual([]);
    expect(verify).toHaveBeenCalledTimes(SIGNATURES);
  });
});

test("verifyDsseSignatures reads each listed key once, not once per signature", () => {
  const signers = Array.from({ length: SIGNATURES }, key);
  let reads = 0;
  const keys = signers.map(({ keyId, publicKey }) => ({
    get keyId() {
      reads += 1;
      return keyId;
    },
    publicKey,
  }));
  const envelope = sealed(signers.map((by) => wrongSignature(by)));
  expect(verifyDsseSignatures(envelope, keys).validSignerKeyids).toEqual([]);
  expect(reads).toBe(SIGNATURES);
});
