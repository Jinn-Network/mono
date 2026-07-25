// SPDX-License-Identifier: MIT
export * from "./errors.js";
export * from "./types.js";

import { EvidenceAnnouncementJournalError } from "./errors.js";
import type {
  FilesystemEvidenceAnnouncementJournal,
  OpenFilesystemEvidenceAnnouncementJournalOptions,
} from "./types.js";

export async function openFilesystemEvidenceAnnouncementJournal(
  _options: OpenFilesystemEvidenceAnnouncementJournalOptions,
): Promise<FilesystemEvidenceAnnouncementJournal> {
  throw new EvidenceAnnouncementJournalError(
    "IO_FAILURE",
    "The filesystem announcement journal is not implemented.",
  );
}
