// SPDX-License-Identifier: Apache-2.0

export const EVIDENCE_DERIVATION_ERROR_CODES = [
  "INVALID_DERIVATION_INPUT",
  "SOURCE_DIGEST_MISMATCH",
  "SOURCE_NONCONFORMING",
  "ARTIFACT_DIGEST_MISMATCH",
  "POLICY_INVALID",
  "SCRUBBER_DESCRIPTOR_INVALID",
  "DETECTOR_REQUIREMENT_UNSATISFIED",
  "DETECTOR_CONTRACT_VIOLATION",
  "DETECTOR_FAILED",
  "STRUCTURED_ARTIFACT_INVALID",
  "DERIVATIVE_NONCONFORMING",
  "OPERATION_ABORTED",
  "INTERNAL_FAILURE",
] as const;

export type EvidenceDerivationErrorCode =
  (typeof EVIDENCE_DERIVATION_ERROR_CODES)[number];

export class EvidenceDerivationError extends Error {
  readonly code: EvidenceDerivationErrorCode;
  readonly details?: unknown;

  constructor(
    code: EvidenceDerivationErrorCode,
    message: string,
    options?: { readonly cause?: unknown; readonly details?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "EvidenceDerivationError";
    this.code = code;
    this.details = options?.details;
  }
}
