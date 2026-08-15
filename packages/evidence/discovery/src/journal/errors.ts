// SPDX-License-Identifier: MIT
import type { CatalogOperationOptions } from "../catalog/index.js";

export const EVIDENCE_ANNOUNCEMENT_JOURNAL_ERROR_CODES = [
  "INVALID_ANNOUNCEMENT",
  "ANNOUNCEMENT_CONFLICT",
  "CURSOR_INVALID",
  "JOURNAL_VERSION_UNSUPPORTED",
  "JOURNAL_CORRUPT",
  "STALE_WRITER",
  "JOURNAL_CLOSED",
  "OPERATION_ABORTED",
  "IO_FAILURE",
] as const;

export type EvidenceAnnouncementJournalErrorCode =
  (typeof EVIDENCE_ANNOUNCEMENT_JOURNAL_ERROR_CODES)[number];

export class EvidenceAnnouncementJournalError extends Error {
  override readonly name = "EvidenceAnnouncementJournalError";

  constructor(
    readonly code: EvidenceAnnouncementJournalErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function assertJournalOperationActive(
  options?: CatalogOperationOptions,
): void {
  if (options?.signal?.aborted) {
    throw new EvidenceAnnouncementJournalError(
      "OPERATION_ABORTED",
      "The announcement journal operation was aborted.",
    );
  }
}
