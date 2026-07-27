// SPDX-License-Identifier: MIT

export const EVIDENCE_INDEXER_ERROR_CODES = [
  "ANNOUNCEMENT_INVALID",
  "REPOSITORY_NOT_CONFIGURED",
  "RECORD_UNAVAILABLE",
  "REFERENCE_MISMATCH",
  "VALIDATED_RECORD_INCONSISTENT",
  "OPERATION_ABORTED",
] as const;

export type EvidenceIndexerErrorCode =
  (typeof EVIDENCE_INDEXER_ERROR_CODES)[number];

export class EvidenceIndexerError extends Error {
  override readonly name = "EvidenceIndexerError";

  constructor(
    readonly code: EvidenceIndexerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
