import type { EvidenceRecordReference } from "@jinn-network/evidence-repository";
import type { PublishedEvidenceLocation } from "@jinn-network/evidence-discovery";

// Injected ports and mirrored input shapes (design §11; plan Task 25). This
// package is I/O-free: it never opens a file or a socket itself, and it
// never signs journal bytes as-is (§11's normative framing) -- it consumes
// the frozen evidence contracts only through these ports and re-seals a new,
// discovery-native chain from what they yield.
//
// `EvidenceJournalEntry` mirrors `AnnouncementJournalEntryV1`
// (packages/evidence/discovery/src/journal/types.ts) field-for-field. That
// type is internal to evidence-discovery's journal module -- its own
// `journal/index.ts` re-exports `AnnouncementJournalAppendReceipt`,
// `AppendAvailableAnnouncementInput`, `FilesystemEvidenceAnnouncementJournal`,
// and `OpenFilesystemEvidenceAnnouncementJournalOptions`, but never the raw
// entry shape or its cursor codec -- so importing it directly is not
// possible without editing the frozen evidence package, which §11 and the
// plan (Task 25) forbid ("Zero changes to the frozen contracts"). This
// wrapper therefore declares its own structurally-identical port shape
// instead, the same precedent `record-discovery-serve`'s `head.ts` uses for
// `DsseEnvelope` relative to `trust-core`'s type: structurally compatible,
// never imported. A real `FilesystemEvidenceAnnouncementJournal`'s entries
// satisfy this shape as-is; translating its `.read()` (which yields the
// catalog-shaped `AnnouncementBatch`, opaque `cursor` included) into a
// `JournalEntrySource` -- recovering each entry's `revision` -- is host
// assembly, out of this package's scope (the same "host reaches into
// concrete bindings" boundary as `record-discovery-client`'s
// `FactsProfileRegistry`/`FactsRecompute` ports, plan Finding F4).
export interface EvidenceJournalEntry {
  readonly version: 1;
  readonly revision: number;
  readonly predecessorDigest?: `sha256:${string}`;
  readonly announcement: {
    readonly kind: "available";
    readonly sourceId: string;
    readonly announcementId: string;
    readonly reference: EvidenceRecordReference;
    readonly repositoryId: string;
    readonly publishedLocation?: PublishedEvidenceLocation;
  };
}

/**
 * Source of the journal's available-only entries, in ascending `revision`
 * order (§11: "the available chain comes from the append-only journal").
 * `afterRevision` follows the tree's cursor idiom: yield entries whose
 * `revision` is strictly greater than `afterRevision` (`0` means "from the
 * beginning" -- real journal revisions start at 1).
 */
export interface JournalEntrySource {
  read(afterRevision: number): AsyncIterable<EvidenceJournalEntry>;
}

/**
 * Persisted reconciliation state for one wrapped source (design §11's
 * "offset recorded once, at wrap time"; plan Task 25 Step 2). Callers
 * persist this between `reconcile()` calls (this package performs no
 * storage itself -- consistent with every other I/O-free package in this
 * tree); `INITIAL_WRAP_STATE` is the state for a source that has never been
 * wrapped.
 *
 * `offset` is recorded once, from the very first available journal entry
 * ever projected (`offset = firstJournalRevision - 1`), and is never
 * recomputed afterward -- purely a provenance/audit fact (see
 * `reconcile.ts`'s top comment for why it is not re-applied as an ongoing
 * per-item formula once withdrawals share the same sequence space).
 */
export interface EvidenceJournalWrapState {
  readonly offset: number | undefined;
  readonly lastJournalRevision: number;
  readonly catalogCursor: string | undefined;
  readonly nextSequence: string;
  readonly previous: `sha256:${string}` | null;
}
