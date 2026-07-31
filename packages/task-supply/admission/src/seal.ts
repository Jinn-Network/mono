// SPDX-License-Identifier: Apache-2.0

import { sealSignedRecord, type DsseSigner } from "@jinn-network/trust-core";
import {
  ADMISSION_RECEIPT_DESCRIPTOR_NAME,
  ADMISSION_RECEIPT_MEDIA_TYPE,
  DIFFERENTIAL_ADMISSION_PREDICATE_TYPE,
  IN_TOTO_STATEMENT_TYPE,
} from "./identifiers.js";
import {
  verifyDifferentialAdmissionReceiptV3,
  type DifferentialAdmissionReceiptV3,
} from "./receipt.js";

export interface AdmissionStatementSubject {
  readonly name: string;
  /** in-toto DigestSet: bare lowercase hex, never `sha256:`-prefixed. */
  readonly digest: { readonly sha256: string };
}

export interface AdmissionStatement {
  readonly _type: typeof IN_TOTO_STATEMENT_TYPE;
  readonly subject: readonly [AdmissionStatementSubject, AdmissionStatementSubject];
  readonly predicateType: typeof DIFFERENTIAL_ADMISSION_PREDICATE_TYPE;
  readonly predicate: DifferentialAdmissionReceiptV3;
}

export interface SealedAdmissionReceipt {
  readonly envelopeBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  /** Digest of the sealed envelope bytes — the receipt's identity. */
  readonly receiptDigest: `sha256:${string}`;
}

export interface AdmissionReceiptDescriptor {
  readonly name: typeof ADMISSION_RECEIPT_DESCRIPTOR_NAME;
  readonly mediaType: typeof ADMISSION_RECEIPT_MEDIA_TYPE;
  readonly digest: { readonly sha256: string };
}

/**
 * `sha256:<hex>` (receipt-body spelling) -> bare hex (in-toto DigestSet spelling). The parameter
 * is `string` because the receipt schema's regex refinement produces `string`, not the template
 * literal type; the prefix is already guaranteed by that regex at parse time.
 */
function bareHex(digest: string): string {
  return digest.slice("sha256:".length);
}

/**
 * Wrap a receipt as the predicate of an in-toto Statement whose subjects are the sealed Task and
 * EvaluationSpec digests. Subjects are *derived* from the receipt body, so the two can never
 * diverge. This shape is what the evaluation leg parses (design §7.1: conform, do not redefine).
 */
export function buildAdmissionStatement(
  receipt: DifferentialAdmissionReceiptV3,
): AdmissionStatement {
  const checked = verifyDifferentialAdmissionReceiptV3(receipt);
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      { name: "task", digest: { sha256: bareHex(checked.task.documentDigest) } },
      { name: "evaluation-spec", digest: { sha256: bareHex(checked.task.evaluationSpecDigest) } },
    ],
    predicateType: DIFFERENTIAL_ADMISSION_PREDICATE_TYPE,
    predicate: checked,
  };
}

/** Seal a receipt with an injected signer. No key material lives in this package. */
export async function sealReceipt(
  receipt: DifferentialAdmissionReceiptV3,
  signer: DsseSigner,
): Promise<SealedAdmissionReceipt> {
  const sealed = await sealSignedRecord({
    record: buildAdmissionStatement(receipt),
    payloadType: ADMISSION_RECEIPT_MEDIA_TYPE,
    signer,
  });
  return {
    envelopeBytes: sealed.envelopeBytes,
    payloadBytes: sealed.payloadBytes,
    receiptDigest: sealed.recordDigest,
  };
}

/**
 * The descriptor a Submission carries at `ADMISSION_RECEIPT_ANNOTATION_URI`. Its digest names the
 * envelope bytes and uses the bare-hex DigestSet spelling — the receipt body's own digests keep
 * the `sha256:` prefix (program contract 6).
 */
export function admissionReceiptAnnotation(
  sealed: SealedAdmissionReceipt,
): AdmissionReceiptDescriptor {
  return {
    name: ADMISSION_RECEIPT_DESCRIPTOR_NAME,
    mediaType: ADMISSION_RECEIPT_MEDIA_TYPE,
    digest: { sha256: bareHex(sealed.receiptDigest) },
  };
}
