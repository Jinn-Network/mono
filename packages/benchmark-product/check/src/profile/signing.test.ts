// SPDX-License-Identifier: Apache-2.0

/**
 * The check both admission signature ports in `verify.ts` make. Through a bundle it cannot be told
 * apart from a looser one: `admission/verification.ts` parses each envelope exactly and counts its
 * signatures before either port runs. So it is pinned here, on the function the ports call.
 */

import { DSSE_PAYLOAD_TYPE } from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";
import {
  allOf,
  flipped,
  sealSigned,
  signedBy,
  signerFromLabel,
  type DsseSignatures,
} from "../characterization/testing/signers.js";
import { verifySoleSignature } from "./signing.js";

const signer = signerFromLabel("sole-signature");
const stranger = signerFromLabel("sole-signature-stranger");
const key = { keyId: signer.keyId, publicKey: signer.publicKey };
const payload = new TextEncoder().encode('{"admitted":true}');

function sealed(signatures: DsseSignatures): Uint8Array {
  return sealSigned(DSSE_PAYLOAD_TYPE, payload, signatures);
}

describe("verifySoleSignature", () => {
  test("accepts the one signature the key made", () => {
    expect(verifySoleSignature(sealed(signedBy(signer)), key)).toBe(true);
  });

  test("refuses a second signature beside it, whoever made it", () => {
    expect(verifySoleSignature(sealed(allOf(signedBy(signer), signedBy(stranger))), key)).toBe(false);
    expect(verifySoleSignature(sealed(allOf(signedBy(signer), signedBy(signer))), key)).toBe(false);
  });

  test("refuses an envelope that is not the exact sealed encoding", () => {
    const envelope = JSON.parse(new TextDecoder().decode(sealed(signedBy(signer)))) as unknown;
    expect(verifySoleSignature(new TextEncoder().encode(JSON.stringify(envelope, null, 2)), key)).toBe(false);
  });

  test("refuses a signature the key did not make", () => {
    expect(verifySoleSignature(sealed(flipped(signedBy(signer))), key)).toBe(false);
    expect(verifySoleSignature(sealed(signedBy(stranger, signer.keyId)), key)).toBe(false);
    expect(verifySoleSignature(sealed(signedBy(signer, stranger.keyId)), key)).toBe(false);
  });
});
