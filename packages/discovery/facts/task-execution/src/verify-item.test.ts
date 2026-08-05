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
import { sealDelivery, sealSubmission } from "@jinn-network/task-execution-protocol";
import { describe, expect, it } from "vitest";

import { deliveryProfile, submissionProfile, taskProfile } from "./profiles.js";
import { TASK_EXECUTION_FACTS_RECOMPUTE } from "./recompute.js";

// Integration gate (plan Task 24 Step 4, mirroring facts/evidence's own
// verify-item.test.ts): the leaf's profiles + recompute fns, wired through
// protocol's real `verifyItem`/`facts-consistency` procedure over genuine
// sealed task-execution records -- not a hand-simulated comparison. Ports
// this procedure never calls for an author-source item (keys/sigs) are
// stubbed to fail loudly if that assumption ever changes. `entries` is now
// genuinely exercised by §10.4 step 3 (BLOCKER fix) -- `entryFetcherFor`
// below seeds a real AnnouncementEntry that actually announces the item
// under test.

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

async function loadGoldenTaskBytes(): Promise<Uint8Array> {
  const url = import.meta.resolve(
    "@jinn-network/task-execution-protocol/fixtures/golden-task-execution-v1/task.json",
  );
  return new Uint8Array(await readFile(new URL(url)));
}

describe("facts/task-execution wired into protocol's verifyItem", () => {
  it("a truthful Task facts card verifies consistent", async () => {
    const bytes = await loadGoldenTaskBytes();
    const digest = recordDigest(bytes);
    const recompute = TASK_EXECUTION_FACTS_RECOMPUTE.get(RECORD_KINDS.task)!;
    const facts = await recompute(bytes, { async "fetch"() { return undefined; } });
    // A real announcer only asserts facts it can actually compute -- the
    // sealed/serialized card never carries an explicit `undefined`-valued
    // key (JSON drops those). Mirror that here rather than announcing the
    // raw recompute() result verbatim, which would leave optional-but-
    // absent Task fields (author/evaluationDigest/supersedesDigest) present
    // as `undefined`-valued keys and spuriously trip `indeterminate`.
    const announcedFacts = Object.fromEntries(
      Object.entries(facts).filter(([, value]) => value !== undefined),
    );

    const recordFetcher: RecordFetcher = { async "fetch"() { return bytes; } };
    const source = { agent: "urn:uuid:11111111-1111-1111-1111-111111111111", name: "requester" };
    const { entryFetcher, entryDigest } = entryFetcherFor({
      source,
      announcementId: "a1",
      record: { kind: RECORD_KINDS.task, digest },
    });
    const item: AnnouncedItem = {
      record: { kind: RECORD_KINDS.task, digest },
      facts: announcedFacts,
      provenance: { source, entry: entryDigest, announcementId: "a1" },
    };

    const outcome = await verifyItem({
      item,
      profile: taskProfile,
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: entryFetcher,
        keys: unusedKeyResolver,
        sigs: unusedSignatureVerifier,
        factsRecompute: TASK_EXECUTION_FACTS_RECOMPUTE,
        verifiedChain: async () => true,
      },
    });

    expect(outcome).toEqual({ status: "verified", facts: "consistent" });
  });

  it("a lying Task facts card fails facts-consistency", async () => {
    const bytes = await loadGoldenTaskBytes();
    const digest = recordDigest(bytes);
    const recordFetcher: RecordFetcher = { async "fetch"() { return bytes; } };
    const source = { agent: "urn:uuid:11111111-1111-1111-1111-111111111111", name: "requester" };
    const { entryFetcher, entryDigest } = entryFetcherFor({
      source,
      announcementId: "a1",
      record: { kind: RECORD_KINDS.task, digest },
    });
    const item: AnnouncedItem = {
      record: { kind: RECORD_KINDS.task, digest },
      facts: { profileUri: "https://not-the-real-profile.example/1.0" },
      provenance: { source, entry: entryDigest, announcementId: "a1" },
    };

    const outcome = await verifyItem({
      item,
      profile: taskProfile,
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: entryFetcher,
        keys: unusedKeyResolver,
        sigs: unusedSignatureVerifier,
        factsRecompute: TASK_EXECUTION_FACTS_RECOMPUTE,
        verifiedChain: async () => true,
      },
    });

    expect(outcome).toEqual({ status: "verified", facts: "inconsistent" });
  });

  it("mandatory: a Submission item announcing the benchmarking triple (benchrun/benchcell/bencharm) verifies consistent when truthful", async () => {
    const taskBytes = await loadGoldenTaskBytes();
    const taskDigestHex = recordDigest(taskBytes).slice("sha256:".length);
    const submissionBytes = sealSubmission({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      submission: "urn:uuid:dddddddd-dddd-5ddd-8ddd-dddddddddddd",
      task: { digest: { sha256: taskDigestHex } },
      requester: "urn:uuid:eeeeeeee-eeee-5eee-8eee-eeeeeeeeeeee",
      idempotencyKey: "bench-1",
      nonce: "bench-nonce-1",
      deadline: "2026-08-01T00:00:00Z",
      annotations: {
        run: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        cellKey: "sha256:2222222222222222222222222222222222222222222222222222222222222222/arm-a/1",
        armId: "arm-a",
      },
    });
    const digest = recordDigest(submissionBytes);
    const recordFetcher: RecordFetcher = {
      async "fetch"(requested) {
        if (requested === digest) return submissionBytes;
        if (requested === recordDigest(taskBytes)) return taskBytes;
        throw new Error(`unexpected fetch: ${requested}`);
      },
    };
    const submissionSource = { agent: "urn:uuid:eeeeeeee-eeee-5eee-8eee-eeeeeeeeeeee", name: "requester" };
    const { entryFetcher: submissionEntryFetcher, entryDigest: submissionEntryDigest } = entryFetcherFor({
      source: submissionSource,
      announcementId: "a1",
      record: { kind: RECORD_KINDS.submission, digest },
    });
    const item: AnnouncedItem = {
      record: { kind: RECORD_KINDS.submission, digest },
      facts: {
        taskDigest: recordDigest(taskBytes),
        requesterIri: "urn:uuid:eeeeeeee-eeee-5eee-8eee-eeeeeeeeeeee",
        benchrun: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        benchcell: "sha256:2222222222222222222222222222222222222222222222222222222222222222/arm-a/1",
        bencharm: "arm-a",
      },
      provenance: { source: submissionSource, entry: submissionEntryDigest, announcementId: "a1" },
    };

    const outcome = await verifyItem({
      item,
      profile: submissionProfile,
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: submissionEntryFetcher,
        keys: unusedKeyResolver,
        sigs: unusedSignatureVerifier,
        factsRecompute: TASK_EXECUTION_FACTS_RECOMPUTE,
        verifiedChain: async () => true,
      },
    });

    expect(outcome).toEqual({ status: "verified", facts: "consistent" });
  });

  it("mandatory: a Delivery item with NO benchmarking triple announced verifies consistent (absent, opaque to core)", async () => {
    const deliveryBytes = sealDelivery({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      attempt: "urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
      task: "sha256:2b929dcdfe77f88e8bbb97f04381798e84db81925f2dda884bedc2ac587b27a0",
      outputs: [],
      outcome: "fulfilled",
      createdAt: "2026-08-01T00:05:00Z",
    });
    const digest = recordDigest(deliveryBytes);
    const recordFetcher: RecordFetcher = { async "fetch"() { return deliveryBytes; } };
    const deliverySource = { agent: "urn:uuid:22222222-2222-2222-2222-222222222222", name: "operator" };
    const { entryFetcher: deliveryEntryFetcher, entryDigest: deliveryEntryDigest } = entryFetcherFor({
      source: deliverySource,
      announcementId: "a1",
      record: { kind: RECORD_KINDS.delivery, digest },
    });
    const item: AnnouncedItem = {
      record: { kind: RECORD_KINDS.delivery, digest },
      // No benchrun/benchcell/bencharm announced -- an ordinary, non-benchmarking Delivery.
      facts: { outcome: "fulfilled" },
      provenance: {
        source: deliverySource,
        entry: deliveryEntryDigest,
        announcementId: "a1",
      },
    };

    const outcome = await verifyItem({
      item,
      profile: deliveryProfile,
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: deliveryEntryFetcher,
        keys: unusedKeyResolver,
        sigs: unusedSignatureVerifier,
        factsRecompute: TASK_EXECUTION_FACTS_RECOMPUTE,
        verifiedChain: async () => true,
      },
    });

    expect(outcome).toEqual({ status: "verified", facts: "consistent" });
  });
});
