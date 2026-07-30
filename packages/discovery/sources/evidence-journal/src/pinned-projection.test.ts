import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { EvidenceRecordAnnouncement, EvidenceRecordAnnouncementSource, AnnouncementBatch } from "@jinn-network/evidence-discovery";
import { RECORD_KINDS, sealJson } from "@jinn-network/record-discovery-protocol";
import type { SourceIdentity } from "@jinn-network/record-discovery-protocol";

import type { EvidenceJournalEntry, JournalEntrySource } from "./ports.js";
import { INITIAL_WRAP_STATE, reconcile } from "./reconcile.js";

// Pinned-digest fixtures over the full §11 field-map (plan Task 25 Step 2):
// two journal-sourced "available" entries plus one catalog-sourced
// "withdrawn" reconciled in a single pass, asserting the projected,
// re-sealed discovery entries hash to fixed digests. Same
// compute-once-then-pin workflow as `record-discovery-protocol`'s own
// `fixtures.test.ts`: a missing pinned value throws with the actual digest
// to paste into `expected-digests.json`.

const fixtureRoot = new URL("../fixtures/pinned-projection/", import.meta.url);

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(name, fixtureRoot), "utf8")) as T;
}

function expectPinnedDigest(expectedDigests: Record<string, string>, name: string, digest: string): void {
  const expected = expectedDigests[name];
  if (expected === undefined) {
    throw new Error(
      `No pinned digest for "${name}" yet -- actual digest: ${digest}\n` +
        "Paste this into fixtures/pinned-projection/expected-digests.json and re-run.",
    );
  }
  expect(digest).toBe(expected);
}

function makeJournal(entries: EvidenceJournalEntry[]): JournalEntrySource {
  return {
    async *read(afterRevision: number) {
      for (const entry of entries) if (entry.revision > afterRevision) yield entry;
    },
  };
}

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

describe("pinned §11 projection (journal + catalog -> one re-sealed chain)", () => {
  it("projects the fixed journal.json + withdrawals.json inputs to pinned entry digests", async () => {
    const source = await fixture<SourceIdentity>("source.json");
    const journalEntries = await fixture<EvidenceJournalEntry[]>("journal.json");
    const withdrawals = await fixture<EvidenceRecordAnnouncement[]>("withdrawals.json");
    const expectedDigests = await fixture<Record<string, string>>("expected-digests.json");

    const result = await reconcile({
      source,
      state: INITIAL_WRAP_STATE,
      journal: makeJournal(journalEntries),
      catalog: makeCatalog(withdrawals),
      now: () => new Date("2026-07-28T12:00:00.000Z"),
    });

    expect(result.entries).toHaveLength(3);

    // The §11 field-map, spot-checked field-by-field before the digest pin.
    const [availableOne, availableTwo, withdrawn] = result.entries;
    expect(availableOne!.sequence).toBe("0000000000000001");
    expect(availableOne!.previous).toBeNull();
    expect(availableOne!.announcements[0]).toEqual({
      announcementId: "a-1",
      action: "available",
      record: { kind: RECORD_KINDS.executionEvidence, digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111" },
    });

    expect(availableTwo!.sequence).toBe("0000000000000002");
    expect(availableTwo!.announcements[0]).toMatchObject({
      announcementId: "a-2",
      action: "available",
      record: { kind: RECORD_KINDS.resultEvaluation, digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222" },
    });
    expect((availableTwo!.announcements[0] as { locations?: unknown[] }).locations).toHaveLength(1);

    expect(withdrawn!.sequence).toBe("0000000000000003");
    expect(withdrawn!.announcements[0]).toEqual({
      announcementId: "w-1",
      action: "withdrawn",
      retracts: "a-1",
      reason: "delisted",
    });

    for (const [index, entry] of result.entries.entries()) {
      expectPinnedDigest(expectedDigests, `entry-${index + 1}`, sealJson(entry).digest);
    }
    expectPinnedDigest(expectedDigests, "chain-tip", result.state.previous as string);
  });

  it("is byte-identical on a second, independent run over the same fixture inputs (determinism)", async () => {
    const source = await fixture<SourceIdentity>("source.json");
    const journalEntries = await fixture<EvidenceJournalEntry[]>("journal.json");
    const withdrawals = await fixture<EvidenceRecordAnnouncement[]>("withdrawals.json");

    async function run() {
      return reconcile({
        source,
        state: INITIAL_WRAP_STATE,
        journal: makeJournal(journalEntries),
        catalog: makeCatalog(withdrawals),
        now: () => new Date("2026-07-28T12:00:00.000Z"),
      });
    }

    const first = await run();
    const second = await run();
    expect(first.entries.map((e) => sealJson(e).digest)).toEqual(second.entries.map((e) => sealJson(e).digest));
  });
});
