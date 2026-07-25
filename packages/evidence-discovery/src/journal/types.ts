// SPDX-License-Identifier: MIT
import type {
  CatalogOperationOptions,
  EvidenceRecordAnnouncement,
  EvidenceRecordAnnouncementSource,
  PublishedEvidenceLocation,
} from "../catalog/index.js";
import type { EvidenceRecordReference } from "@jinn-network/evidence-repository";

export const EVIDENCE_ANNOUNCEMENT_JOURNAL_FORMAT = {
  format: "jinn-evidence-announcement-journal",
  version: 1,
} as const;

export interface AppendAvailableAnnouncementInput {
  readonly announcementId: string;
  readonly reference: EvidenceRecordReference;
  readonly repositoryId: string;
  readonly publishedLocation?: PublishedEvidenceLocation;
}

export interface AnnouncementJournalAppendReceipt {
  readonly announcement: EvidenceRecordAnnouncement & {
    readonly kind: "available";
  };
  readonly cursor: string;
  readonly status: "created" | "existing";
}

export interface FilesystemEvidenceAnnouncementJournal
  extends EvidenceRecordAnnouncementSource {
  readonly sourceId: string;
  appendAvailable(
    input: AppendAvailableAnnouncementInput,
    options?: CatalogOperationOptions,
  ): Promise<AnnouncementJournalAppendReceipt>;
  getHighWaterCursor(
    options?: CatalogOperationOptions,
  ): Promise<string | undefined>;
  getEntryCount(options?: CatalogOperationOptions): Promise<number>;
  findAvailable(
    reference: EvidenceRecordReference,
    options?: CatalogOperationOptions,
  ): Promise<AnnouncementJournalAppendReceipt | null>;
  close(): Promise<void>;
}

export interface OpenFilesystemEvidenceAnnouncementJournalOptions {
  readonly rootDir: string;
  readonly sourceId: string;
}

export interface AnnouncementJournalMarkerV1 {
  readonly format: "jinn-evidence-announcement-journal";
  readonly version: 1;
  readonly sourceId: string;
}

export interface AnnouncementJournalEntryV1 {
  readonly version: 1;
  readonly revision: number;
  readonly predecessorDigest?: `sha256:${string}`;
  readonly announcement: EvidenceRecordAnnouncement & {
    readonly kind: "available";
  };
}

export interface AnnouncementJournalCursorV1 {
  readonly version: 1;
  readonly sourceId: string;
  readonly revision: number;
  readonly entryDigest: `sha256:${string}`;
}
