import {
  TRUST_KEY_BINDING_FORMAT,
  deriveStrength,
  recordDigest as trustRecordDigest,
  sealKeyBinding,
} from "@jinn-network/trust-core";
import type { DsseSigner, KeyBinding, Sha256Digest } from "@jinn-network/trust-core";
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

import { keyBindingProfile } from "./profiles.js";
import { TRUST_FACTS_RECOMPUTE } from "./recompute.js";

// Integration gate (plan Task 23 Step 4): the leaf's profile + recompute
// fn, wired through protocol's real `verifyItem`/`facts-consistency`
// procedure over a genuine sealed key-binding record -- not a
// hand-simulated comparison. Ports this procedure never calls for an
// author-source item (keys/sigs) are stubbed to fail loudly if that
// assumption ever changes. `entries` is now genuinely exercised by §10.4
// step 3 (BLOCKER fix) -- `entryFetcherFor` below seeds a real
// AnnouncementEntry that actually announces the item under test.

const KEY_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

const fakeSigner: DsseSigner = async () => [
  { signature: new Uint8Array([1, 2, 3, 4]), keyid: KEY_DID },
];

function fakeDigest(seed: string): Sha256Digest {
  return trustRecordDigest(new TextEncoder().encode(seed));
}

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

async function sealedKeyBindingBytes(): Promise<Uint8Array> {
  const binding: KeyBinding = {
    protocol: TRUST_KEY_BINDING_FORMAT,
    agent: "urn:uuid:11111111-1111-1111-1111-111111111111",
    key: { publicKey: "fake-public-key-bytes", keyid: KEY_DID, algorithm: "Ed25519", didKey: KEY_DID },
    voucher: { kind: "oidc-machine", subject: "repo:acme/example:ref:refs/heads/main" },
    relationship: "controls",
    scope: ["bindings"],
    validFrom: "2026-07-28T00:00:00.000Z",
    ceremony: { type: "oidc-machine", digest: fakeDigest("ceremony") },
    strength: deriveStrength("oidc-machine"),
    anchors: [],
  };
  const sealed = await sealKeyBinding(binding, fakeSigner);
  return sealed.envelopeBytes;
}

const SOURCE = { agent: "urn:uuid:11111111-1111-1111-1111-111111111111", name: "bindings" };

describe("facts/trust wired into protocol's verifyItem", () => {
  it("a truthful facts card verifies consistent", async () => {
    const bytes = await sealedKeyBindingBytes();
    const digest = recordDigest(bytes);
    const facts = await TRUST_FACTS_RECOMPUTE.get(RECORD_KINDS.keyBinding)!(bytes, { async "fetch"() { return undefined; } });

    const recordFetcher: RecordFetcher = { async "fetch"() { return bytes; } };
    const { entryFetcher, entryDigest } = entryFetcherFor({
      source: SOURCE,
      announcementId: "a1",
      record: { kind: RECORD_KINDS.keyBinding, digest },
    });
    const item: AnnouncedItem = {
      record: { kind: RECORD_KINDS.keyBinding, digest },
      facts,
      provenance: { source: SOURCE, entry: entryDigest, announcementId: "a1" },
    };

    const outcome = await verifyItem({
      item,
      profile: keyBindingProfile,
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: entryFetcher,
        keys: unusedKeyResolver,
        sigs: unusedSignatureVerifier,
        factsRecompute: TRUST_FACTS_RECOMPUTE,
        verifiedChain: async () => true,
      },
    });

    expect(outcome).toEqual({ status: "verified", facts: "consistent" });
  });

  it("a lying facts card fails facts-consistency (signed misbehavior evidence, design §13.6)", async () => {
    const bytes = await sealedKeyBindingBytes();
    const digest = recordDigest(bytes);
    const recordFetcher: RecordFetcher = { async "fetch"() { return bytes; } };
    const { entryFetcher, entryDigest } = entryFetcherFor({
      source: SOURCE,
      announcementId: "a1",
      record: { kind: RECORD_KINDS.keyBinding, digest },
    });
    const item: AnnouncedItem = {
      record: { kind: RECORD_KINDS.keyBinding, digest },
      facts: { relationship: "signs-for" },
      provenance: { source: SOURCE, entry: entryDigest, announcementId: "a1" },
    };

    const outcome = await verifyItem({
      item,
      profile: keyBindingProfile,
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: entryFetcher,
        keys: unusedKeyResolver,
        sigs: unusedSignatureVerifier,
        factsRecompute: TRUST_FACTS_RECOMPUTE,
        verifiedChain: async () => true,
      },
    });

    expect(outcome).toEqual({ status: "verified", facts: "inconsistent" });
  });
});
