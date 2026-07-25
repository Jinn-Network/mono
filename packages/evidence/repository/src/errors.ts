import type { RepositoryOperationOptions } from "./types.js";

export const EVIDENCE_REPOSITORY_ERROR_CODES = [
  "INVALID_REFERENCE",
  "CONTENT_CORRUPT",
  "REFERENCE_CONFLICT",
  "DEPENDENCY_UNAVAILABLE",
  "ACCESS_DENIED",
  "OPERATION_ABORTED",
  "IO_FAILURE",
] as const;

export type EvidenceRepositoryErrorCode =
  (typeof EVIDENCE_REPOSITORY_ERROR_CODES)[number];

export class EvidenceRepositoryError extends Error {
  override readonly name = "EvidenceRepositoryError";

  constructor(
    readonly code: EvidenceRepositoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function assertRepositoryOperationActive(
  options?: RepositoryOperationOptions,
): void {
  if (options?.signal?.aborted) {
    throw new EvidenceRepositoryError(
      "OPERATION_ABORTED",
      "The repository operation was aborted.",
    );
  }
}
