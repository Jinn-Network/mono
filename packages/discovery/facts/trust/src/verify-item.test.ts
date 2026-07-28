import {
  TRUST_KEY_BINDING_FORMAT,
  deriveStrength,
  recordDigest as trustRecordDigest,
  sealKeyBinding,
} from "@jinn-network/trust-core";
import type { DsseSigner, KeyBinding, Sha256Digest } from "@jinn-network/trust-core";
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

import { keyBindingProfile } from "./profiles.js";
import { TRUST_FACTS_RECOMPUTE } from "./recompute.js";

// Integration gate (plan Task 23 Step 4): the leaf's profile + recompute
// fn, wired through protocol's real `verifyItem`/`facts-consistency`
// procedure over a genuine sealed key-binding record -- not a
// hand-simulated comparison. Ports this procedure never calls for an
// author-source item (entries/keys/sigs) are stubbed to fail loudly if that
// assumption ever changes.

const KEY_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

const fakeSigner: DsseSigner = async () => [
  { signature: new Uint8Array([1, 2, 3, 4]), keyid: KEY_DID },
];

function fakeDigest(seed: string): Sha256Digest {
  return trustRecordDigest(new TextEncoder().encode(seed));
}

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

describe("facts/trust wired into protocol's verifyItem", () => {
  it("a truthful facts card verifies consistent", async () => {
    const bytes = await sealedKeyBindingBytes();
    const digest = recordDigest(bytes);
    const facts = await TRUST_FACTS_RECOMPUTE.get(RECORD_KINDS.keyBinding)!(bytes, { async "fetch"() { return undefined; } });

    const recordFetcher: RecordFetcher = { async "fetch"() { return bytes; } };
    const item: AnnouncedItem = {
      record: { kind: RECORD_KINDS.keyBinding, digest },
      facts,
      provenance: {
        source: { agent: "urn:uuid:11111111-1111-1111-1111-111111111111", name: "bindings" },
        entry: digest,
        announcementId: "a1",
      },
    };

    const outcome = await verifyItem({
      item,
      profile: keyBindingProfile,
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: unusedEntryFetcher,
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
    const item: AnnouncedItem = {
      record: { kind: RECORD_KINDS.keyBinding, digest },
      facts: { relationship: "signs-for" },
      provenance: {
        source: { agent: "urn:uuid:11111111-1111-1111-1111-111111111111", name: "bindings" },
        entry: digest,
        announcementId: "a1",
      },
    };

    const outcome = await verifyItem({
      item,
      profile: keyBindingProfile,
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: unusedEntryFetcher,
        keys: unusedKeyResolver,
        sigs: unusedSignatureVerifier,
        factsRecompute: TRUST_FACTS_RECOMPUTE,
        verifiedChain: async () => true,
      },
    });

    expect(outcome).toEqual({ status: "verified", facts: "inconsistent" });
  });
});
