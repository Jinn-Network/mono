// SPDX-License-Identifier: Apache-2.0
import type { RepositoryOperationOptions } from
  "@jinn-network/evidence-repository";

export const EVIDENCE_PUBLICATION_ERROR_CODES = [
  "INVALID_INPUT",
  "CONTENT_DIGEST_MISMATCH",
  "REPOSITORY_CAPABILITY_EXCEEDED",
  "BUNDLE_CONFLICT",
  "JOURNAL_CONFLICT",
  "JOURNAL_CORRUPT",
  "FRAME_TOO_LARGE",
  "SINK_PROTOCOL_VIOLATION",
  "IDEMPOTENCY_CONFLICT",
  "PLACEMENT_REVERTED",
  "PLACEMENT_UNCERTAIN",
  "OPERATION_ABORTED",
  "IO_FAILURE",
] as const;

export type EvidencePublicationErrorCode =
  (typeof EVIDENCE_PUBLICATION_ERROR_CODES)[number];

export class EvidencePublicationError extends Error {
  override readonly name = "EvidencePublicationError";

  constructor(
    readonly code: EvidencePublicationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function assertPublicationOperationActive(
  options?: RepositoryOperationOptions,
): void {
  if (options?.signal?.aborted) {
    throw new EvidencePublicationError(
      "OPERATION_ABORTED",
      "The publication operation was aborted.",
    );
  }
}
