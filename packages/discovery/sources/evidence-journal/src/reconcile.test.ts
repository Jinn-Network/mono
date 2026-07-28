import { describe, expect, it } from "vitest";
import type { AnnouncementBatch, EvidenceRecordAnnouncement, EvidenceRecordAnnouncementSource } from "@jinn-network/evidence-discovery";
import { GENESIS_SEQUENCE, compareCodeUnitStrings, sealJson } from "@jinn-network/record-discovery-protocol";
import type { SourceIdentity } from "@jinn-network/record-discovery-protocol";

import type { EvidenceJournalEntry, JournalEntrySource } from "./ports.js";
import { INITIAL_WRAP_STATE, reconcile } from "./reconcile.js";

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function makeJournal(entries: EvidenceJournalEntry[]): JournalEntrySource {
  return {
    async *read(afterRevision: number) {
      for (const entry of entries) {
        if (entry.revision > afterRevision) yield entry;
      }
    },
  };
}

/** One announcement per batch, mirroring the real evidence journal's own granularity. */
function makeCatalog(announcements: EvidenceRecordAnnouncement[]): EvidenceRecordAnnouncementSource {
  return {
    async *read(options?: { readonly after?: string }): AsyncIterable<AnnouncementBatch> {
      const start = options?.after === undefined ? 0 : Number(options.after) + 1;
      for (let index = start; index < announcements.length; index += 1) {
        yield { announcements: [announcements[index]!], cursor: String(index) };
      }
    },
  };
}

const SOURCE: SourceIdentity = { agent: "did:key:zEvidenceJournalWrapper", name: "evidence-journal" };
const NOW = () => new Date("2026-07-28T12:00:00.000Z");

function available(revision: number, announcementId: string, digestChar: string): EvidenceJournalEntry {
  return {
    version: 1,
    revision,
    announcement: {
      kind: "available",
      sourceId: "evidence-source",
      announcementId,
      reference: { family: "execution-evidence", digest: digest(digestChar) },
      repositoryId: "local-repository",
    },
  };
}

describe("reconcile (§11 Task 25): available-only", () => {
  it("assigns sequence = revision - offset when only availables are processed (the pinned affine bullet's simple case)", async () => {
    const journal = makeJournal([available(1, "a-1", "1"), available(2, "a-2", "2"), available(3, "a-3", "3")]);
    const catalog = makeCatalog([]);
    const result = await reconcile({ source: SOURCE, state: INITIAL_WRAP_STATE, journal, catalog, now: NOW });

    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]!.sequence).toBe(GENESIS_SEQUENCE);
    expect(result.entries[1]!.sequence).toBe("0000000000000002");
    expect(result.entries[2]!.sequence).toBe("0000000000000003");
    expect(result.state.offset).toBe(0); // firstJournalRevision(1) - 1
  });

  it("chains previous over the RE-SEALED projected entries, not the journal's own predecessorDigest", async () => {
    const journal = makeJournal([available(1, "a-1", "1"), available(2, "a-2", "2")]);
    const result = await reconcile({ source: SOURCE, state: INITIAL_WRAP_STATE, journal, catalog: makeCatalog([]), now: NOW });

    expect(result.entries[0]!.previous).toBeNull();
    expect(result.entries[1]!.previous).toBe(sealJson(result.entries[0]!).digest);
    expect(result.state.previous).toBe(sealJson(result.entries[1]!).digest);
  });

  it("records offset from the FIRST journal revision it ever sees, not always 1", async () => {
    // Simulates wrapping a journal that already had history: the wrapper
    // starts from revision 41 (offset = 40), first projected sequence is
    // still GENESIS_SEQUENCE regardless.
    const journal = makeJournal([available(41, "a-41", "1"), available(42, "a-42", "2")]);
    const state = { ...INITIAL_WRAP_STATE, lastJournalRevision: 40 };
    const result = await reconcile({ source: SOURCE, state, journal, catalog: makeCatalog([]), now: NOW });

    expect(result.state.offset).toBe(40);
    expect(result.entries[0]!.sequence).toBe(GENESIS_SEQUENCE);
    expect(result.entries[1]!.sequence).toBe("0000000000000002");
  });

  it("throws on a journal revision gap (defensive invariant check)", async () => {
    const journal = makeJournal([available(1, "a-1", "1"), available(3, "a-3", "3")]);
    await expect(
      reconcile({ source: SOURCE, state: INITIAL_WRAP_STATE, journal, catalog: makeCatalog([]), now: NOW }),
    ).rejects.toThrow(/out of order/);
  });

  it("is deterministic: identical inputs from the same starting state produce byte-identical re-sealed entries", async () => {
    const journal = () => makeJournal([available(1, "a-1", "1"), available(2, "a-2", "2")]);
    const first = await reconcile({ source: SOURCE, state: INITIAL_WRAP_STATE, journal: journal(), catalog: makeCatalog([]), now: NOW });
    const second = await reconcile({ source: SOURCE, state: INITIAL_WRAP_STATE, journal: journal(), catalog: makeCatalog([]), now: NOW });
    expect(first.entries.map((e) => sealJson(e).digest)).toEqual(second.entries.map((e) => sealJson(e).digest));
  });
});

describe("reconcile (§11 Task 25): withdrawals from the catalog", () => {
  it("projects a withdrawal with reason=delisted, appended after its target's available entry", async () => {
    const journal = makeJournal([available(1, "a-1", "1")]);
    const catalog = makeCatalog([
      { kind: "withdrawn", sourceId: "evidence-source", announcementId: "w-1", retractsAnnouncementId: "a-1" },
    ]);
    const result = await reconcile({ source: SOURCE, state: INITIAL_WRAP_STATE, journal, catalog, now: NOW });

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.announcements[0]!.action).toBe("available");
    const withdrawal = result.entries[1]!.announcements[0]!;
    expect(withdrawal).toEqual({ announcementId: "w-1", action: "withdrawn", retracts: "a-1", reason: "delisted" });
    expect(result.entries[1]!.sequence).toBe("0000000000000002");
    expect(result.entries[1]!.previous).toBe(sealJson(result.entries[0]!).digest);
  });

  it("ignores any available-kind items the catalog source also yields (journal is the sole available source)", async () => {
    const journal = makeJournal([]);
    const catalog = makeCatalog([
      {
        kind: "available",
        sourceId: "evidence-source",
        announcementId: "catalog-available",
        reference: { family: "execution-evidence", digest: digest("9") },
        repositoryId: "local-repository",
      },
    ]);
    const result = await reconcile({ source: SOURCE, state: INITIAL_WRAP_STATE, journal, catalog, now: NOW });
    expect(result.entries).toHaveLength(0);
  });

  it("advances the persisted catalogCursor so a later call resumes from where it left off", async () => {
    const journal = makeJournal([]);
    const catalog = makeCatalog([
      { kind: "withdrawn", sourceId: "evidence-source", announcementId: "w-1", retractsAnnouncementId: "a-1" },
      { kind: "withdrawn", sourceId: "evidence-source", announcementId: "w-2", retractsAnnouncementId: "a-2" },
    ]);
    const first = await reconcile({ source: SOURCE, state: INITIAL_WRAP_STATE, journal, catalog, now: NOW });
    expect(first.entries).toHaveLength(2);
    expect(first.state.catalogCursor).toBe("1");

    const second = await reconcile({ source: SOURCE, state: first.state, journal, catalog, now: NOW });
    expect(second.entries).toHaveLength(0); // nothing new past the persisted cursor
  });
});

describe("reconcile (§11 Task 25): mixed, single pass", () => {
  it("processes all new availables before any new withdrawal in one call (retraction-of-same-batch-available is sound)", async () => {
    const journal = makeJournal([available(1, "a-1", "1"), available(2, "a-2", "2")]);
    const catalog = makeCatalog([
      { kind: "withdrawn", sourceId: "evidence-source", announcementId: "w-1", retractsAnnouncementId: "a-2" },
    ]);
    const result = await reconcile({ source: SOURCE, state: INITIAL_WRAP_STATE, journal, catalog, now: NOW });

    expect(result.entries.map((e) => e.announcements[0]!.action)).toEqual(["available", "available", "withdrawn"]);
    expect(result.entries.map((e) => e.sequence)).toEqual(["0000000000000001", "0000000000000002", "0000000000000003"]);
    // A gap-free, single ascending run -- exactly what the real
    // `checkGlobalChainRules`/`walkLinkage` procedures require.
    const sorted = [...result.entries].sort((a, b) => compareCodeUnitStrings(a.sequence, b.sequence));
    expect(sorted).toEqual(result.entries);
  });

  it("stays gap-free across reconcile() calls even when a withdrawal is interspersed before a later available (the deviation from a literal 'revision - offset forever' formula)", async () => {
    // Run 1: one available + one withdrawal -- consumes sequence slots 1
    // and 2. If the affine formula were reapplied per-item forever, run
    // 2's new available (revision 2) would compute sequence = 2 - 0 = 2,
    // COLLIDING with the withdrawal already at slot 2. This test proves
    // the monotonic counter design avoids that.
    const journalEntries = [available(1, "a-1", "1"), available(2, "a-2", "2")];
    const journal: JournalEntrySource = {
      async *read(afterRevision: number) {
        for (const entry of journalEntries) if (entry.revision > afterRevision) yield entry;
      },
    };
    const catalogAnnouncements: EvidenceRecordAnnouncement[] = [
      { kind: "withdrawn", sourceId: "evidence-source", announcementId: "w-1", retractsAnnouncementId: "a-1" },
    ];
    const catalog = makeCatalog(catalogAnnouncements);

    const run1Journal = makeJournal([journalEntries[0]!]);
    const run1 = await reconcile({ source: SOURCE, state: INITIAL_WRAP_STATE, journal: run1Journal, catalog, now: NOW });
    expect(run1.entries.map((e) => e.sequence)).toEqual(["0000000000000001", "0000000000000002"]);

    const run2 = await reconcile({ source: SOURCE, state: run1.state, journal, catalog: makeCatalog(catalogAnnouncements), now: NOW });
    expect(run2.entries).toHaveLength(1);
    expect(run2.entries[0]!.sequence).toBe("0000000000000003"); // not "0000000000000002"
    expect(run2.entries[0]!.previous).toBe(run1.state.previous);

    // The full merged chain (both runs) is strictly ascending and gap-free.
    const all = [...run1.entries, ...run2.entries].map((e) => e.sequence);
    expect(all).toEqual(["0000000000000001", "0000000000000002", "0000000000000003"]);
  });
});
