import { describe, expect, it } from "vitest";
import {
  buildJournalEntry,
  journalEntryDigest,
  journalEntryText,
  parseExactJournalLine,
  validateJournalEntry,
  type CampaignJournalEntry,
} from "./journal-entry.js";
import {
  applyEntry,
  checkEventLegality,
  entersExploring,
  EMPTY_LIFECYCLE_STATE,
  legalEventsIn,
  type CampaignLifecyclePhase,
} from "./journal-lifecycle.js";
import {
  CAMPAIGN_JOURNAL_ENTRY_FORMAT_TOKEN,
  CAMPAIGN_JOURNAL_EVENT_TYPES,
  CAMPAIGN_LIFECYCLE_PHASES,
} from "./tokens.js";
import { digestOf } from "./testing/campaign-fixtures.js";

const campaignDigest = digestOf("c");

function entry(overrides: Partial<CampaignJournalEntry> = {}): CampaignJournalEntry {
  return {
    formatToken: CAMPAIGN_JOURNAL_ENTRY_FORMAT_TOKEN,
    campaign: campaignDigest,
    seq: 1,
    previous: null,
    type: "created",
    recordedAt: "2026-08-03T00:00:00Z",
    payload: {},
    ...overrides,
  };
}

describe("the journal entry envelope", () => {
  it("carries the design's closed event list, all eleven of them", () => {
    expect(CAMPAIGN_JOURNAL_EVENT_TYPES).toEqual([
      "created", "candidate-admitted", "candidate-rejected", "wave-planned", "allocation-decided",
      "run-sealed", "matrix-assembled", "report-recorded", "frontier-updated",
      "promotion-run-sealed", "closed",
    ]);
  });

  it("refuses an unlisted event type, a bad instant, and an unrecognized field", () => {
    expect(validateJournalEntry(entry({ type: "promoted" as never })).ok).toBe(false);
    expect(validateJournalEntry(entry({ recordedAt: "2026-02-30T00:00:00Z" })).ok).toBe(false);
    expect(validateJournalEntry({ ...entry(), extra: 1 }).ok).toBe(false);
  });

  it("requires previous to be null at seq 1 and present after it", () => {
    expect(validateJournalEntry(entry({ previous: digestOf("1") })).ok).toBe(false);
    expect(validateJournalEntry(entry({ seq: 2, previous: null })).ok).toBe(false);
    expect(validateJournalEntry(entry({ seq: 2, previous: digestOf("1"), type: "closed" })).ok).toBe(true);
  });

  it("round-trips through its exact canonical line and refuses any other encoding", () => {
    const built = buildJournalEntry(campaignDigest, null, {
      seq: 1, type: "created", recordedAt: "2026-08-03T00:00:00Z",
    });
    const line = journalEntryText(built);
    expect(parseExactJournalLine(line)).toEqual(built);
    expect(() => parseExactJournalLine(`${line} `)).toThrowError(/canonical/);
    expect(journalEntryDigest(built)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("digests the value, not the literal — member order does not change the chain link", () => {
    const reordered = {
      payload: {}, recordedAt: "2026-08-03T00:00:00Z", type: "created", previous: null,
      seq: 1, campaign: campaignDigest, formatToken: CAMPAIGN_JOURNAL_ENTRY_FORMAT_TOKEN,
    } as unknown as CampaignJournalEntry;
    expect(journalEntryDigest(reordered)).toBe(journalEntryDigest(entry()));
  });
});

describe("the lifecycle table (product §5.2)", () => {
  it("covers exactly the four phases", () => {
    expect(CAMPAIGN_LIFECYCLE_PHASES).toEqual(["DRAFT", "EXPLORING", "CONFIRMING", "CLOSED"]);
  });

  it("never admits `created` outside the empty journal, and admits nothing else on it", () => {
    for (const type of CAMPAIGN_JOURNAL_EVENT_TYPES) {
      const legal = checkEventLegality(EMPTY_LIFECYCLE_STATE, type) === undefined;
      expect(legal).toBe(type === "created");
    }
  });

  it("closes every phase to `created` once the journal has begun", () => {
    let state = applyEntry(EMPTY_LIFECYCLE_STATE, entry(), digestOf("1"));
    expect(checkEventLegality(state, "created")?.code).toBe("lifecycle-violation");
    state = applyEntry(state, entry({ seq: 2, previous: digestOf("1"), type: "closed" }), digestOf("2"));
    expect(checkEventLegality(state, "created")?.code).toBe("lifecycle-violation");
  });

  it("admits nothing at all in CLOSED", () => {
    expect(legalEventsIn("CLOSED")).toEqual([]);
  });

  it("keeps every phase's table inside the closed event list", () => {
    for (const phase of CAMPAIGN_LIFECYCLE_PHASES as readonly CampaignLifecyclePhase[]) {
      for (const type of legalEventsIn(phase)) {
        expect(CAMPAIGN_JOURNAL_EVENT_TYPES).toContain(type);
      }
    }
  });

  it("routes `closed` from every open phase and `promotion-run-sealed` only from EXPLORING", () => {
    let state = applyEntry(EMPTY_LIFECYCLE_STATE, entry(), digestOf("1"));
    expect(checkEventLegality(state, "closed")).toBeUndefined();
    expect(checkEventLegality(state, "promotion-run-sealed")?.code).toBe("lifecycle-violation");
    state = applyEntry(state, entry({ seq: 2, previous: digestOf("1"), type: "wave-planned" }), digestOf("2"));
    expect(state.phase).toBe("EXPLORING");
    expect(checkEventLegality(state, "promotion-run-sealed")).toBeUndefined();
    state = applyEntry(state, entry({ seq: 3, previous: digestOf("2"), type: "promotion-run-sealed" }), digestOf("3"));
    expect(state.phase).toBe("CONFIRMING");
    expect(checkEventLegality(state, "closed")).toBeUndefined();
  });

  it("flags exactly the DRAFT → EXPLORING crossing as needing the §6.3 admission", () => {
    const draft = applyEntry(EMPTY_LIFECYCLE_STATE, entry(), digestOf("1"));
    expect(entersExploring(draft, "wave-planned")).toBe(true);
    expect(entersExploring(draft, "candidate-admitted")).toBe(false);
    expect(entersExploring(EMPTY_LIFECYCLE_STATE, "created")).toBe(false);
    const exploring = applyEntry(draft, entry({ seq: 2, previous: digestOf("1"), type: "wave-planned" }), digestOf("2"));
    expect(entersExploring(exploring, "wave-planned")).toBe(false);
  });

  it("counts events as it folds them", () => {
    let state = applyEntry(EMPTY_LIFECYCLE_STATE, entry(), digestOf("1"));
    state = applyEntry(state, entry({ seq: 2, previous: digestOf("1"), type: "candidate-admitted" }), digestOf("2"));
    state = applyEntry(state, entry({ seq: 3, previous: digestOf("2"), type: "candidate-admitted" }), digestOf("3"));
    expect(state.eventCounts).toEqual({ created: 1, "candidate-admitted": 2 });
    expect(state).toMatchObject({ entries: 3, nextSeq: 4, head: digestOf("3") });
  });
});
