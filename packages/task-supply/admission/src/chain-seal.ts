// SPDX-License-Identifier: Apache-2.0

import { sealSignedRecord, type DsseSigner } from "@jinn-network/trust-core";
import {
  ADMISSION_RECEIPT_DESCRIPTOR_NAME,
  ADMISSION_RECEIPT_MEDIA_TYPE,
  CHAIN_ADMISSION_PREDICATE_TYPE,
  IN_TOTO_STATEMENT_TYPE,
} from "./identifiers.js";
import {
  verifyChainAdmissionReceiptV1,
  type ChainAdmissionReceiptV1,
} from "./chain-receipt.js";

export interface ChainAdmissionStatementSubject {
  readonly name: string;
  /** in-toto DigestSet: bare lowercase hex, never `sha256:`-prefixed. */
  readonly digest: { readonly sha256: string };
}

export interface ChainAdmissionStatement {
  readonly _type: typeof IN_TOTO_STATEMENT_TYPE;
  readonly subject: readonly [ChainAdmissionStatementSubject, ChainAdmissionStatementSubject];
  readonly predicateType: typeof CHAIN_ADMISSION_PREDICATE_TYPE;
  readonly predicate: ChainAdmissionReceiptV1;
}

export interface SealedChainAdmissionReceipt {
  readonly envelopeBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  /** Digest of the sealed envelope bytes — the receipt's identity. */
  readonly receiptDigest: `sha256:${string}`;
}

export interface ChainAdmissionReceiptDescriptor {
  readonly name: typeof ADMISSION_RECEIPT_DESCRIPTOR_NAME;
  readonly mediaType: typeof ADMISSION_RECEIPT_MEDIA_TYPE;
  readonly digest: { readonly sha256: string };
}

function bareHex(digest: string): string {
  return digest.slice("sha256:".length);
}

/**
 * Wrap a chain admission receipt as the predicate of an in-toto Statement whose subjects are
 * derived from the receipt body.
 */
export function buildChainAdmissionStatement(
  receipt: ChainAdmissionReceiptV1,
): ChainAdmissionStatement {
  const checked = verifyChainAdmissionReceiptV1(receipt);
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      { name: "task", digest: { sha256: bareHex(checked.task.documentDigest) } },
      { name: "evaluation-spec", digest: { sha256: bareHex(checked.task.evaluationSpecDigest) } },
    ],
    predicateType: CHAIN_ADMISSION_PREDICATE_TYPE,
    predicate: checked,
  };
}

/** Seal a chain admission receipt with an injected signer. No key material lives in this package. */
export async function sealChainReceipt(
  receipt: ChainAdmissionReceiptV1,
  signer: DsseSigner,
): Promise<SealedChainAdmissionReceipt> {
  const sealed = await sealSignedRecord({
    record: buildChainAdmissionStatement(receipt),
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
 * The descriptor a Submission carries at `ADMISSION_RECEIPT_ANNOTATION_URI`. Which family minted
 * the receipt is inside the receipt, not in the annotation key.
 */
export function chainAdmissionReceiptAnnotation(
  sealed: SealedChainAdmissionReceipt,
): ChainAdmissionReceiptDescriptor {
  return {
    name: ADMISSION_RECEIPT_DESCRIPTOR_NAME,
    mediaType: ADMISSION_RECEIPT_MEDIA_TYPE,
    digest: { sha256: bareHex(sealed.receiptDigest) },
  };
}
