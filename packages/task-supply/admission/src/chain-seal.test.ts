// SPDX-License-Identifier: Apache-2.0

import { dssePreAuthEncoding, parseSignedRecordEnvelope, recordDigest } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";
import {
  ADMISSION_RECEIPT_MEDIA_TYPE,
  CHAIN_ADMISSION_PREDICATE_TYPE,
} from "./identifiers.js";
import {
  buildChainAdmissionStatement,
  chainAdmissionReceiptAnnotation,
  sealChainReceipt,
} from "./chain-seal.js";
import { goldenChainReceipt } from "./chain-testing.js";

const signer = async (request: { preAuthEncoding: Uint8Array }) =>
  [{ signature: new TextEncoder().encode(recordDigest(request.preAuthEncoding)), keyid: "test" }] as const;

describe("buildChainAdmissionStatement", () => {
  it("wraps the receipt as the predicate of an in-toto Statement with bare-hex subjects", () => {
    const receipt = goldenChainReceipt();
    const statement = buildChainAdmissionStatement(receipt);
    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.predicateType).toBe(CHAIN_ADMISSION_PREDICATE_TYPE);
    expect(statement.predicate).toStrictEqual(receipt);
    expect(statement.subject).toStrictEqual([
      { name: "task", digest: { sha256: receipt.task.documentDigest.slice(7) } },
      { name: "evaluation-spec", digest: { sha256: receipt.task.evaluationSpecDigest.slice(7) } },
    ]);
    for (const subject of statement.subject) {
      expect(subject.digest.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(subject.digest.sha256.startsWith("sha256:")).toBe(false);
    }
  });
});

describe("sealChainReceipt", () => {
  it("seals under the in-toto payload type and identifies the receipt by its envelope digest", async () => {
    const sealed = await sealChainReceipt(goldenChainReceipt(), signer as never);
    const parsed = parseSignedRecordEnvelope(sealed.envelopeBytes, ADMISSION_RECEIPT_MEDIA_TYPE);
    expect(parsed.recordDigest).toBe(sealed.receiptDigest);
    expect(JSON.parse(new TextDecoder().decode(parsed.payloadBytes)).predicate.family)
      .toBe("state-predicate");
  });

  it("signs the DSSE pre-authentication encoding of the payload", async () => {
    const sealed = await sealChainReceipt(goldenChainReceipt(), signer as never);
    const expected = recordDigest(
      dssePreAuthEncoding(ADMISSION_RECEIPT_MEDIA_TYPE, sealed.payloadBytes),
    );
    const envelope = JSON.parse(new TextDecoder().decode(sealed.envelopeBytes));
    expect(new TextDecoder().decode(Uint8Array.from(atob(envelope.signatures[0].sig), (c) => c.charCodeAt(0))))
      .toBe(expected);
  });

  it("refuses to seal a receipt that does not satisfy the policy", async () => {
    const broken = { ...goldenChainReceipt(), referenceScriptDigest: "not-a-digest" };
    await expect(sealChainReceipt(broken as never, signer as never)).rejects.toThrow(/invalid-candidate/);
  });
});

describe("chainAdmissionReceiptAnnotation", () => {
  it("emits a bare-hex DigestSet, never the sha256: spelling", async () => {
    const sealed = await sealChainReceipt(goldenChainReceipt(), signer as never);
    const descriptor = chainAdmissionReceiptAnnotation(sealed);
    expect(descriptor.name).toBe("admission-receipt");
    expect(descriptor.mediaType).toBe(ADMISSION_RECEIPT_MEDIA_TYPE);
    expect(descriptor.digest.sha256).toBe(sealed.receiptDigest.slice("sha256:".length));
    expect(descriptor.digest.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
