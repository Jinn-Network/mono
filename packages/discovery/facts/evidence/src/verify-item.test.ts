import { readFile } from "node:fs/promises";

import {
  RECORD_KINDS,
  recordDigest,
  verifyItem,
} from "@jinn-network/record-discovery-protocol";
import type {
  AnnouncedItem,
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
// (entries/keys/sigs) are stubbed to fail loudly if that assumption ever
// changes.

const fixtureRoot = new URL(
  ".",
  import.meta.resolve(
    "@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/README.md",
  ),
);

const unusedEntryFetcher: EntryFetcher = {
  async "fetch"(): Promise<Uint8Array> {
    throw new Error("entries port must not be called for this item verification");
  },
};
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

describe("facts/evidence wired into protocol's verifyItem", () => {
  it("a truthful facts card verifies consistent", async () => {
    const bytes = await loadExecutionEvidenceBytes();
    const digest = recordDigest(bytes);
    const recompute = EVIDENCE_FACTS_RECOMPUTE.get(RECORD_KINDS.executionEvidence)!;
    const facts = await recompute(bytes, { async "fetch"() { return undefined; } });

    const recordFetcher: RecordFetcher = { async "fetch"() { return bytes; } };
    const item: AnnouncedItem = {
      record: { kind: RECORD_KINDS.executionEvidence, digest },
      facts,
      provenance: {
        source: { agent: "urn:uuid:11111111-1111-1111-1111-111111111111", name: "evidence" },
        entry: digest,
        announcementId: "a1",
      },
    };

    const outcome = await verifyItem({
      item,
      profile: executionEvidenceProfile,
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: unusedEntryFetcher,
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
    const item: AnnouncedItem = {
      record: { kind: RECORD_KINDS.executionEvidence, digest },
      facts: { outcome: "not-the-real-outcome" },
      provenance: {
        source: { agent: "urn:uuid:11111111-1111-1111-1111-111111111111", name: "evidence" },
        entry: digest,
        announcementId: "a1",
      },
    };

    const outcome = await verifyItem({
      item,
      profile: executionEvidenceProfile,
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: unusedEntryFetcher,
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
    const item: AnnouncedItem = {
      record: { kind: RECORD_KINDS.executionEvidence, digest },
      facts: { outcome: fullFacts["outcome"] },
      provenance: {
        source: { agent: "urn:uuid:11111111-1111-1111-1111-111111111111", name: "evidence" },
        entry: digest,
        announcementId: "a1",
      },
    };

    const outcome = await verifyItem({
      item,
      profile: executionEvidenceProfile,
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: unusedEntryFetcher,
        keys: unusedKeyResolver,
        sigs: unusedSignatureVerifier,
        factsRecompute: EVIDENCE_FACTS_RECOMPUTE,
        verifiedChain: async () => true,
      },
    });

    expect(outcome).toEqual({ status: "verified", facts: "consistent" });
  });
});
