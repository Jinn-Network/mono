import { readFile } from "node:fs/promises";

import {
  GENESIS_SEQUENCE,
  RECORD_DISCOVERY_VERSION,
  RECORD_KINDS,
  recordDigest,
  sealJson,
  verifyItem,
} from "@jinn-network/record-discovery-protocol";
import type {
  AnnouncedItem,
  AnnouncementEntry,
  EntryFetcher,
  KeyResolver,
  RecordFetcher,
  SignatureVerifier,
} from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import { executionEvidenceProfile } from "./profiles.js";
import { EVIDENCE_FACTS_RECOMPUTE } from "./recompute.js";

// Integration gate (plan Task 22 Step 5): the leaf's profile + recompute
// fn, wired through protocol's real `verifyItem`/`facts-consistency`
// procedure over a genuine sealed evidence record -- not a hand-simulated
// comparison. Ports this procedure never calls for an author-source item
// (keys/sigs) are stubbed to fail loudly if that assumption ever changes.
// `entries` is now genuinely exercised by §10.4 step 3 (BLOCKER fix) --
// `entryFetcherFor` below seeds a real AnnouncementEntry that actually
// announces the item under test.

const fixtureRoot = new URL(
  ".",
  import.meta.resolve(
    "@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/README.md",
  ),
);

/** Builds a genuine AnnouncementEntry announcing `(announcementId, record)`, and an EntryFetcher serving it at its real digest -- the digest to set as `item.provenance.entry`. */
function entryFetcherFor(params: {
  source: { agent: string; name: string };
  announcementId: string;
  record: { kind: string; digest: `sha256:${string}` };
}): { entryFetcher: EntryFetcher; entryDigest: `sha256:${string}` } {
  const entry: AnnouncementEntry = {
    protocol: RECORD_DISCOVERY_VERSION,
    source: params.source,
    sequence: GENESIS_SEQUENCE,
    previous: null,
    timestamp: "2026-07-28T12:00:00Z",
    announcements: [
      { announcementId: params.announcementId, action: "available", record: params.record },
    ],
  };
  const { bytes, digest } = sealJson(entry);
  return {
    entryDigest: digest,
    entryFetcher: {
      async "fetch"(requested) {
        if (requested !== digest) throw new Error(`no entry seeded for ${requested}`);
        return bytes;
      },
    },
  };
}

const unusedKeyResolver: KeyResolver = {
  async resolve() {
    throw new Error("keys port must not be called for this item verification");
  },
  async everBound() {
    throw new Error("keys port must not be called for this item verification");
  },
};
const unusedSignatureVerifier: SignatureVerifier = {
  async verify() {
    throw new Error("sigs port must not be called for this item verification");
  },
};

async function loadExecutionEvidenceBytes(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL("public/ro-crate-metadata.json", fixtureRoot)));
}

const SOURCE = { agent: "urn:uuid:11111111-1111-1111-1111-111111111111", name: "evidence" };

describe("facts/evidence wired into protocol's verifyItem", () => {
  it("a truthful facts card verifies consistent", async () => {
    const bytes = await loadExecutionEvidenceBytes();
    const digest = recordDigest(bytes);
    const recompute = EVIDENCE_FACTS_RECOMPUTE.get(RECORD_KINDS.executionEvidence)!;
    const facts = await recompute(bytes, { async "fetch"() { return undefined; } });

    const recordFetcher: RecordFetcher = { async "fetch"() { return bytes; } };
    const { entryFetcher, entryDigest } = entryFetcherFor({
      source: SOURCE,
      announcementId: "a1",
      record: { kind: RECORD_KINDS.executionEvidence, digest },
    });
    const item: AnnouncedItem = {
      record: { kind: RECORD_KINDS.executionEvidence, digest },
      facts,
      provenance: { source: SOURCE, entry: entryDigest, announcementId: "a1" },
    };

    const outcome = await verifyItem({
      item,
      profile: executionEvidenceProfile,
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: entryFetcher,
        keys: unusedKeyResolver,
        sigs: unusedSignatureVerifier,
        factsRecompute: EVIDENCE_FACTS_RECOMPUTE,
        verifiedChain: async () => true,
      },
    });

    expect(outcome).toEqual({ status: "verified", facts: "consistent" });
  });

  it("a lying facts card fails facts-consistency (signed misbehavior evidence, design §13.6)", async () => {
    const bytes = await loadExecutionEvidenceBytes();
    const digest = recordDigest(bytes);
    const recordFetcher: RecordFetcher = { async "fetch"() { return bytes; } };
    const { entryFetcher, entryDigest } = entryFetcherFor({
      source: SOURCE,
      announcementId: "a1",
      record: { kind: RECORD_KINDS.executionEvidence, digest },
    });
    const item: AnnouncedItem = {
      record: { kind: RECORD_KINDS.executionEvidence, digest },
      facts: { outcome: "not-the-real-outcome" },
      provenance: { source: SOURCE, entry: entryDigest, announcementId: "a1" },
    };

    const outcome = await verifyItem({
      item,
      profile: executionEvidenceProfile,
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: entryFetcher,
        keys: unusedKeyResolver,
        sigs: unusedSignatureVerifier,
        factsRecompute: EVIDENCE_FACTS_RECOMPUTE,
        verifiedChain: async () => true,
      },
    });

    expect(outcome).toEqual({ status: "verified", facts: "inconsistent" });
  });

  it("an unannounced fact is not checked; a partially-truthful card still verifies consistent", async () => {
    const bytes = await loadExecutionEvidenceBytes();
    const digest = recordDigest(bytes);
    const recompute = EVIDENCE_FACTS_RECOMPUTE.get(RECORD_KINDS.executionEvidence)!;
    const fullFacts = await recompute(bytes, { async "fetch"() { return undefined; } });
    const recordFetcher: RecordFetcher = { async "fetch"() { return bytes; } };
    const { entryFetcher, entryDigest } = entryFetcherFor({
      source: SOURCE,
      announcementId: "a1",
      record: { kind: RECORD_KINDS.executionEvidence, digest },
    });
    const item: AnnouncedItem = {
      record: { kind: RECORD_KINDS.executionEvidence, digest },
      facts: { outcome: fullFacts["outcome"] },
      provenance: { source: SOURCE, entry: entryDigest, announcementId: "a1" },
    };

    const outcome = await verifyItem({
      item,
      profile: executionEvidenceProfile,
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: entryFetcher,
        keys: unusedKeyResolver,
        sigs: unusedSignatureVerifier,
        factsRecompute: EVIDENCE_FACTS_RECOMPUTE,
        verifiedChain: async () => true,
      },
    });

    expect(outcome).toEqual({ status: "verified", facts: "consistent" });
  });
});
