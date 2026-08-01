import { dssePreAuthEncoding, parseSignedRecordEnvelope, recordDigest } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";
import { ADMISSION_RECEIPT_MEDIA_TYPE, DIFFERENTIAL_ADMISSION_PREDICATE_TYPE } from "./identifiers.js";
import { admissionReceiptAnnotation, buildAdmissionStatement, sealReceipt } from "./seal.js";
import { goldenReceipt } from "./testing.js";

/** A pure, deterministic test signer: no key material anywhere in this package. */
const signer = async (request: { preAuthEncoding: Uint8Array }) =>
  [{ signature: new TextEncoder().encode(recordDigest(request.preAuthEncoding)), keyid: "test" }] as const;

describe("buildAdmissionStatement", () => {
  it("wraps the receipt as the predicate of an in-toto Statement with bare-hex subjects", () => {
    const receipt = goldenReceipt();
    const statement = buildAdmissionStatement(receipt);
    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.predicateType).toBe(DIFFERENTIAL_ADMISSION_PREDICATE_TYPE);
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

describe("sealReceipt", () => {
  it("seals under the in-toto payload type and identifies the receipt by its envelope digest", async () => {
    const sealed = await sealReceipt(goldenReceipt(), signer as never);
    const parsed = parseSignedRecordEnvelope(sealed.envelopeBytes, ADMISSION_RECEIPT_MEDIA_TYPE);
    expect(parsed.recordDigest).toBe(sealed.receiptDigest);
    expect(JSON.parse(new TextDecoder().decode(parsed.payloadBytes)).predicate.goldPatchHash)
      .toBe(goldenReceipt().goldPatchHash);
  });

  it("signs the DSSE pre-authentication encoding of the payload", async () => {
    const sealed = await sealReceipt(goldenReceipt(), signer as never);
    const expected = recordDigest(
      dssePreAuthEncoding(ADMISSION_RECEIPT_MEDIA_TYPE, sealed.payloadBytes),
    );
    const envelope = JSON.parse(new TextDecoder().decode(sealed.envelopeBytes));
    expect(new TextDecoder().decode(Uint8Array.from(atob(envelope.signatures[0].sig), (c) => c.charCodeAt(0))))
      .toBe(expected);
  });

  it("refuses to seal a receipt that does not satisfy the policy", async () => {
    const broken = { ...goldenReceipt(), goldPatchHash: "not-a-digest" };
    await expect(sealReceipt(broken as never, signer as never)).rejects.toThrow(/invalid-candidate/);
  });

  it("is byte-stable across repeated sealing of the same receipt", async () => {
    const first = await sealReceipt(goldenReceipt(), signer as never);
    const second = await sealReceipt(goldenReceipt(), signer as never);
    expect(second.envelopeBytes).toStrictEqual(first.envelopeBytes);
  });
});

describe("admissionReceiptAnnotation", () => {
  it("DIGEST-CONFUSION FIXTURE: emits a bare-hex DigestSet, never the sha256: spelling", async () => {
    const sealed = await sealReceipt(goldenReceipt(), signer as never);
    const descriptor = admissionReceiptAnnotation(sealed);
    expect(descriptor).toStrictEqual({
      name: "admission-receipt",
      mediaType: ADMISSION_RECEIPT_MEDIA_TYPE,
      digest: { sha256: sealed.receiptDigest.slice("sha256:".length) },
    });
    expect(descriptor.digest.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
