// SPDX-License-Identifier: Apache-2.0

/**
 * Signature checks counted rather than timed. An envelope is something a publisher hands a reader,
 * so its size must not buy quadratic work, and a count fails at once where a slow run of the same
 * regression would hold a test worker for minutes.
 */

import { generateKeyPairSync, sign, verify } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { sealDsseEnvelope } from "@jinn-network/trust-core";
import type { DsseProducedSignature } from "@jinn-network/trust-core";

import { checkRecord } from "./check-record.js";
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

  test("checkRecord, with every signature repeating one key id", async () => {
    const envelope = sealed(new Array<DsseProducedSignature>(SIGNATURES).fill(wrongSignature(signer)));
    const report = await checkRecord(envelope, {
      kinds: {
        note: {
          family: "example",
          identify: () => true,
          validate: () => [],
          anyEnvelopeSpelling: true,
        },
      },
      trust: { keys: [] },
    });
    expect(report.signatures).toMatchObject({ total: SIGNATURES, invalid: SIGNATURES });
    expect(verify).toHaveBeenCalledTimes(SIGNATURES);
  });

  test("verifyDsseSignatures, with every signature repeating one key id", () => {
    const envelope = sealed(new Array<DsseProducedSignature>(SIGNATURES).fill(wrongSignature(signer)));
    expect(verifyDsseSignatures(envelope, [signer]).validSignerKeyids).toEqual([]);
    expect(verify).toHaveBeenCalledTimes(SIGNATURES);
  });
});
