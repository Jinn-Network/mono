import type { EvidenceRecordAnnouncementSource } from "@jinn-network/evidence-discovery";
import type { AnnouncementEntry, SourceIdentity } from "@jinn-network/record-discovery-protocol";
import { GENESIS_SEQUENCE, RECORD_DISCOVERY_VERSION, nextSequence as advanceSequence, parseAnnouncementEntry, sealJson } from "@jinn-network/record-discovery-protocol";

import type { EvidenceJournalWrapState, JournalEntrySource } from "./ports.js";
import { projectAvailableAnnouncement, projectWithdrawnAnnouncement } from "./project.js";

// Reconciliation (design §11; plan Task 25 Step 3): merges the journal's
// available chain with the catalog's withdrawals into ONE re-sealed,
// gap-free discovery chain, maintaining its own `previous` linkage over the
// PROJECTED entries (never the journal's own `predecessorDigest`).
//
// Sequence assignment -- an implementer finding on the §11 "affine mapping"
// bullet. The design pins: "the first projected entry is
// 0000000000000001 and increments by one (the wrapper records its offset
// once, at wrap time)". Read as a literal per-item formula
// (`sequence = revision - offset`) reapplied forever, this cannot survive
// withdrawal interleaving: once even one withdrawal has taken a sequence
// slot from the SAME chain, a later available entry's `revision - offset`
// value collides with (falls behind) the chain's true next free slot --
// sequence would either repeat or gap, both forbidden (§5.1, §5.2 "sequence
// is a true entry count"). This module therefore uses a single monotonic
// counter (`state.nextSequence`) as the ONLY mechanism that actually
// assigns sequence numbers, for both available and withdrawal entries alike
// -- this is unconditionally gap-free and collision-free regardless of how
// the two streams interleave across reconcile() calls. `offset` is still
// recorded, exactly once, from the very first available entry ever
// projected (`offset = firstJournalRevision - 1`) -- it is provenance
// bookkeeping, not an ongoing formula. In the common case with no
// withdrawals yet (exercised by this module's own tests), `revision -
// offset` and `nextSequence` coincide, which is exactly what makes the
// pinned bullet true as stated for that case.
//
// Processing order per reconcile() call: every new available entry (journal
// order) is projected and sequenced before any new withdrawal (catalog
// order). This guarantees a same-run withdrawal that retracts a same-run
// available always finds its target already chained (§5.1: `retracts`
// targets an EARLIER `available`).

export const INITIAL_WRAP_STATE: EvidenceJournalWrapState = {
  offset: undefined,
  lastJournalRevision: 0,
  catalogCursor: undefined,
  nextSequence: GENESIS_SEQUENCE,
  previous: null,
};

export interface ReconcileInput {
  readonly source: SourceIdentity;
  readonly state: EvidenceJournalWrapState;
  readonly journal: JournalEntrySource;
  readonly catalog: EvidenceRecordAnnouncementSource;
  readonly now: () => Date;
}

export interface ReconcileOutput {
  readonly entries: readonly AnnouncementEntry[];
  readonly state: EvidenceJournalWrapState;
}

function takeSequence(state: EvidenceJournalWrapState): { sequence: string; state: EvidenceJournalWrapState } {
  const sequence = state.nextSequence;
  return { sequence, state: { ...state, nextSequence: advanceSequence(sequence) } };
}

export async function reconcile(input: ReconcileInput): Promise<ReconcileOutput> {
  const { source, journal, catalog, now } = input;
  let state = input.state;
  const entries: AnnouncementEntry[] = [];

  // Available side: journal, in revision order.
  for await (const journalEntry of journal.read(state.lastJournalRevision)) {
    if (journalEntry.revision !== state.lastJournalRevision + 1) {
      throw new Error(
        `JournalEntrySource yielded revision ${journalEntry.revision} out of order; ` +
          `expected ${state.lastJournalRevision + 1} (gaps are forbidden, §5.1).`,
      );
    }
    if (state.offset === undefined) {
      state = { ...state, offset: journalEntry.revision - 1 };
    }
    const announcement = projectAvailableAnnouncement(journalEntry);
    const { sequence, state: advanced } = takeSequence(state);
    state = advanced;
    const entry: AnnouncementEntry = {
      protocol: RECORD_DISCOVERY_VERSION,
      source,
      sequence,
      previous: state.previous,
      timestamp: now().toISOString(),
      announcements: [announcement],
    };
    parseAnnouncementEntry(entry);
    entries.push(entry);
    state = {
      ...state,
      lastJournalRevision: journalEntry.revision,
      previous: sealJson(entry).digest,
    };
  }

  // Withdrawn side: the catalog's announcement source (§11: "the union
  // carries both" -- only `kind: "withdrawn"` items are harvested here; any
  // "available" items the catalog also yields are the journal's job).
  for await (const batch of catalog.read(state.catalogCursor === undefined ? {} : { after: state.catalogCursor })) {
    for (const announcement of batch.announcements) {
      if (announcement.kind !== "withdrawn") continue;
      const projected = projectWithdrawnAnnouncement(announcement);
      const { sequence, state: advanced } = takeSequence(state);
      state = advanced;
      const entry: AnnouncementEntry = {
        protocol: RECORD_DISCOVERY_VERSION,
        source,
        sequence,
        previous: state.previous,
        timestamp: now().toISOString(),
        announcements: [projected],
      };
      parseAnnouncementEntry(entry);
      entries.push(entry);
      state = { ...state, previous: sealJson(entry).digest };
    }
    state = { ...state, catalogCursor: batch.cursor };
  }

  return { entries, state };
}
