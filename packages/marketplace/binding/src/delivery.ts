// SPDX-License-Identifier: MIT

import {
  DeliveryRecordSchema,
  sealDelivery,
  type DeliveryRecord,
} from "@jinn-network/task-execution-protocol";
import type { Hex } from "viem";
import { assertIJsonUnicode } from "./canonical-json.js";
import { computeRawCodecCid, type IpfsPinPort } from "./venue/ipfs.js";
import { keccakEvidenceHash, rejectZeroEvidenceHash } from "./venue/digest.js";

export type DeliveryAdmissionFailureKind =
  | "invalid-delivery"
  | "noncanonical-delivery"
  | "missing-execution-ids"
  | "missing-evidence-records";

export class DeliveryAdmissionError extends Error {
  constructor(
    readonly kind: DeliveryAdmissionFailureKind,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "DeliveryAdmissionError";
  }
}

export interface ConvergedDelivery {
  readonly cid: string;
  readonly sha256Digest: `sha256:${string}`;
  readonly keccakEvidenceHash: Hex;
}

export interface InspectedDelivery extends ConvergedDelivery {
  readonly delivery: DeliveryRecord;
}

function byteEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

/**
 * Parses and validates the exact input bytes. Protocol sealing is used only to calculate the
 * authoritative canonical reference for a byte-for-byte admission check; the original bytes
 * remain the sole identity passed to verifiers, IPFS, and settlement.
 */
export function inspectDelivery(sealedDeliveryBytes: Uint8Array): InspectedDelivery {
  let document: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(sealedDeliveryBytes);
    document = JSON.parse(text);
  } catch (cause) {
    throw new DeliveryAdmissionError(
      "invalid-delivery",
      `Delivery bytes are not valid UTF-8 JSON: ${String(cause)}`,
    );
  }

  const parsed = DeliveryRecordSchema.safeParse(document);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new DeliveryAdmissionError(
      "invalid-delivery",
      `Delivery failed schema validation: ${detail}`,
    );
  }
  try {
    assertIJsonUnicode(parsed.data);
  } catch (cause) {
    throw new DeliveryAdmissionError(
      "invalid-delivery",
      `Delivery violates I-JSON Unicode requirements: ${String(cause)}`,
    );
  }
  if (parsed.data.executionIds === undefined || parsed.data.executionIds.length === 0) {
    throw new DeliveryAdmissionError(
      "missing-execution-ids",
      "marketplace Delivery requires at least one executionId",
    );
  }
  if (parsed.data.evidenceRecords === undefined || parsed.data.evidenceRecords.length === 0) {
    throw new DeliveryAdmissionError(
      "missing-evidence-records",
      "marketplace Delivery requires at least one evidenceRecord",
    );
  }

  let canonicalBytes: Uint8Array;
  try {
    canonicalBytes = sealDelivery(parsed.data);
  } catch (cause) {
    throw new DeliveryAdmissionError(
      "invalid-delivery",
      `Delivery cannot be sealed by the protocol canonicalizer: ${String(cause)}`,
    );
  }
  if (!byteEqual(sealedDeliveryBytes, canonicalBytes)) {
    throw new DeliveryAdmissionError(
      "noncanonical-delivery",
      "Delivery bytes do not equal protocol canonical sealed bytes",
    );
  }

  const keccak = keccakEvidenceHash(sealedDeliveryBytes);
  rejectZeroEvidenceHash(keccak);
  return {
    ...computeRawCodecCid(sealedDeliveryBytes),
    delivery: parsed.data,
    keccakEvidenceHash: keccak,
  };
}

/** The envelope already is the TEP Delivery: validate, then pin its exact bytes without re-sealing. */
export async function convergeDelivery(
  sealedDeliveryBytes: Uint8Array,
  ipfs: IpfsPinPort,
): Promise<ConvergedDelivery> {
  const inspected = inspectDelivery(sealedDeliveryBytes);
  await ipfs.pin(sealedDeliveryBytes);
  const { delivery: _delivery, ...converged } = inspected;
  return converged;
}

export type DeliveryCorrespondence =
  | { ok: true }
  | {
      ok: false;
      kind: "digest-divergence";
      asserted: {
        sha256Digest: `sha256:${string}`;
        keccakEvidenceHash: Hex;
      };
      onChain: {
        sha256CidDigest: `sha256:${string}`;
        keccak: Hex;
      };
    };

/** Mandatory today-mode decision-grade digest join; revised mode keeps sha256 only. */
export function checkDeliveryCorrespondence(input: {
  sha256Digest: `sha256:${string}`;
  keccakEvidenceHash: Hex;
  onChainSha256CidDigest: `sha256:${string}`;
  onChainKeccak: Hex;
}): DeliveryCorrespondence {
  if (
    input.sha256Digest === input.onChainSha256CidDigest
    && input.keccakEvidenceHash === input.onChainKeccak
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    kind: "digest-divergence",
    asserted: {
      sha256Digest: input.sha256Digest,
      keccakEvidenceHash: input.keccakEvidenceHash,
    },
    onChain: {
      sha256CidDigest: input.onChainSha256CidDigest,
      keccak: input.onChainKeccak,
    },
  };
}
