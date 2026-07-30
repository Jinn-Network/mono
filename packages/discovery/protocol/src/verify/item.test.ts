import { describe, it, expect } from "vitest";
import { sealJson } from "../sealing.js";
import { recordDigest } from "../hashing.js";
import { RECORD_DISCOVERY_VERSION, GENESIS_SEQUENCE } from "../identifiers.js";
import type { AnnouncementEntry } from "../entry.js";
import type { AnnouncedItem, SourceCursor } from "../item.js";
import { verifyItem } from "./item.js";
import type { EntryFetcher, FactsRecompute, KeyResolver, RecordFetcher, SignatureVerifier } from "./ports.js";

// Direct, protocol-local unit coverage of §10.4 step 3 (BLOCKER fix): a
// consumer holding one item MUST fetch the cited entry, re-hash it, parse
// it, confirm its `announcements[]` actually contains this item's
// `announcementId` for this item's `record`, and confirm the entry is on
// the source's verified chain -- not merely trust an opaque boolean. Full
// corpus coverage lives in `discovery/testing`'s §18 vectors
// (`item-unauthorized-provenance`, `item-lying-entry-provenance`); this
// file exercises the pure logic directly, mirroring chain-rules.test.ts's
// precedent for protocol-local unit coverage.

const AGENT = "did:key:zAgentSourceOne";
const SOURCE_NAME = "feed";
const RECORD_KIND = "https://jinn.network/records/submission/1.0";

const recordBytes = new TextEncoder().encode(JSON.stringify({ hello: "world" }));
const recordDigestValue = recordDigest(recordBytes);

function announcementEntry(overrides: Partial<AnnouncementEntry> = {}): AnnouncementEntry {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    source: { agent: AGENT, name: SOURCE_NAME },
    sequence: GENESIS_SEQUENCE,
    previous: null,
    timestamp: "2026-07-28T12:00:00Z",
    announcements: [
      {
        announcementId: "ann-1",
        action: "available",
        record: { kind: RECORD_KIND, digest: recordDigestValue },
      },
    ],
    ...overrides,
  };
}

function baseItem(entryDigest: `sha256:${string}`): AnnouncedItem {
  return {
    record: { kind: RECORD_KIND, digest: recordDigestValue },
    provenance: {
      source: { agent: AGENT, name: SOURCE_NAME },
      entry: entryDigest,
      announcementId: "ann-1",
    },
  };
}

const noFactsRecompute: FactsRecompute = { get: () => undefined };
const throwingKeys: KeyResolver = {
  async resolve() {
    throw new Error("keys port must not be called by verifyItem step 3");
  },
  async everBound() {
    throw new Error("keys port must not be called by verifyItem step 3");
  },
};
const throwingSigs: SignatureVerifier = {
  async verify() {
    throw new Error("sigs port must not be called by verifyItem step 3");
  },
};
const recordFetcher: RecordFetcher = { async "fetch"() { return recordBytes; } };

function entryFetcherFor(entry: AnnouncementEntry, digest: `sha256:${string}`): EntryFetcher {
  const bytes = sealJson(entry).bytes;
  return {
    async "fetch"(requested) {
      if (requested !== digest) throw new Error(`fake EntryFetcher: no entry seeded for ${requested}`);
      return bytes;
    },
  };
}

describe("verifyItem step 3: cited-entry provenance (§10.4 step 3, BLOCKER)", () => {
  it("accepts an item whose cited entry genuinely announces it and is chain-verified", async () => {
    const entry = announcementEntry();
    const { digest } = sealJson(entry);
    const outcome = await verifyItem({
      item: baseItem(digest),
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: entryFetcherFor(entry, digest),
        keys: throwingKeys,
        sigs: throwingSigs,
        factsRecompute: noFactsRecompute,
        verifiedChain: async () => true,
      },
    });
    expect(outcome).toEqual({ status: "verified", facts: "consistent" });
  });

  it("rejects an item citing a real entry that does NOT announce it (lying-entry variant)", async () => {
    // The entry exists, re-hashes correctly, and parses -- but its
    // announcements[] names a DIFFERENT announcementId/record than the one
    // the item claims. A malicious query service citing a real entry
    // digest with an unrelated announcementId must be caught here.
    const entry = announcementEntry({
      announcements: [
        {
          announcementId: "ann-other",
          action: "available",
          record: { kind: RECORD_KIND, digest: `sha256:${"b".repeat(64)}` },
        },
      ],
    });
    const { digest } = sealJson(entry);
    let verifiedChainCalled = false;
    const outcome = await verifyItem({
      item: baseItem(digest),
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: entryFetcherFor(entry, digest),
        keys: throwingKeys,
        sigs: throwingSigs,
        factsRecompute: noFactsRecompute,
        verifiedChain: async () => {
          verifiedChainCalled = true;
          return true;
        },
      },
    });
    expect(outcome).toEqual({ status: "unauthorized-provenance" });
    // The membership check must fail BEFORE chain-verification is even
    // consulted -- a lying entry is rejected on its own claims.
    expect(verifiedChainCalled).toBe(false);
  });

  it("rejects an item whose cited entry is real and DOES announce it, but never verified onto the chain", async () => {
    const entry = announcementEntry();
    const { digest } = sealJson(entry);
    const outcome = await verifyItem({
      item: baseItem(digest),
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: entryFetcherFor(entry, digest),
        keys: throwingKeys,
        sigs: throwingSigs,
        factsRecompute: noFactsRecompute,
        verifiedChain: async () => false,
      },
    });
    expect(outcome).toEqual({ status: "unauthorized-provenance" });
  });

  it("rejects an item whose cited entry digest is not fetchable/does not re-hash (forged digest)", async () => {
    const entry = announcementEntry();
    const { digest } = sealJson(entry);
    const wrongDigest = `sha256:${"c".repeat(64)}` as const;
    const outcome = await verifyItem({
      item: baseItem(wrongDigest),
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        // Seeded under a DIFFERENT digest than the one requested -- the
        // fetcher throws for `wrongDigest`, simulating an uncorroborated
        // citation.
        entries: entryFetcherFor(entry, digest),
        keys: throwingKeys,
        sigs: throwingSigs,
        factsRecompute: noFactsRecompute,
        verifiedChain: async () => true,
      },
    }).catch((error: unknown) => error);
    // Either a thrown fetch error (nothing at that digest) or a typed
    // unauthorized-provenance outcome is an acceptable rejection shape for
    // an uncorroborated citation -- assert it is NOT a silent "verified".
    if (outcome instanceof Error) {
      expect(outcome.message).toMatch(/no entry seeded/);
    } else {
      expect(outcome).toEqual({ status: "unauthorized-provenance" });
    }
  });

  it("passes the cited entry's REAL sequence (not a placeholder) to verifiedChain", async () => {
    const entry = announcementEntry({ sequence: "0000000000000042", previous: `sha256:${"d".repeat(64)}` });
    const { digest } = sealJson(entry);
    let observedCursor: SourceCursor | undefined;
    const outcome = await verifyItem({
      item: baseItem(digest),
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: entryFetcherFor(entry, digest),
        keys: throwingKeys,
        sigs: throwingSigs,
        factsRecompute: noFactsRecompute,
        verifiedChain: async (cursor) => {
          observedCursor = cursor;
          return true;
        },
      },
    });
    expect(outcome.status).toBe("verified");
    expect(observedCursor).toEqual({ sequence: "0000000000000042", entry: digest });
  });
});
