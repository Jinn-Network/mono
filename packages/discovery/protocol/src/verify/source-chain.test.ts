import { describe, it, expect } from "vitest";
import type { DsseEnvelope } from "@jinn-network/trust-core";
import { RECORD_DISCOVERY_VERSION, GENESIS_SEQUENCE, MEDIA_HEAD, MEDIA_ENTRY } from "../identifiers.js";
import { sealJson } from "../sealing.js";
import { sha256Hex } from "../hashing.js";
import { dssePreAuthEncoding } from "../dsse.js";
import type { AnnouncementEntry } from "../entry.js";
import type { SourceHead } from "../head.js";
import { verifySourceChain } from "./source-chain.js";
import type { FreshnessPolicy, HighWaterMark, HighWaterMarkStore, KeyResolver, ResolvedKey, SignatureVerifier } from "./ports.js";

// Direct, protocol-local unit coverage of the MAJOR fix: issuedAt
// monotonicity (§10.3 step 3, §5.2). Mirrors chain-rules.test.ts's
// precedent for protocol-local coverage of source-chain.ts's I/O-adjacent
// orchestration ahead of the full §18 corpus (`discovery/testing`).

const AGENT = "did:key:zAgentSourceOne";
const KEYID = "key-1";
const SOURCE = { agent: AGENT, name: "feed" };

function fakeSig(pae: Uint8Array): string {
  return `${sha256Hex(pae)}:${KEYID}`;
}

const keys: KeyResolver = {
  async resolve(): Promise<ResolvedKey[]> {
    return [{ keyid: KEYID, publicKey: "fake", algorithm: "fake" }];
  },
  async everBound(): Promise<boolean> {
    return true;
  },
};
const sigs: SignatureVerifier = {
  async verify(pae, sig, key): Promise<boolean> {
    return new TextDecoder().decode(sig) === `${sha256Hex(pae)}:${key.keyid}`;
  },
};
const fresh: FreshnessPolicy = {
  isFresh(refreshBy: string, now: Date): boolean {
    return new Date(refreshBy).getTime() > now.getTime();
  },
};

function signedHead(head: SourceHead): DsseEnvelope {
  const payload = JSON.stringify(head);
  const pae = dssePreAuthEncoding(MEDIA_HEAD, new TextEncoder().encode(payload));
  return { payloadType: MEDIA_HEAD, payload, signatures: [{ keyid: KEYID, sig: fakeSig(pae) }] };
}

function signedEntry(entry: AnnouncementEntry): DsseEnvelope {
  const { bytes } = sealJson(entry);
  const payload = new TextDecoder().decode(bytes);
  const pae = dssePreAuthEncoding(MEDIA_ENTRY, bytes);
  return { payloadType: MEDIA_ENTRY, payload, signatures: [{ keyid: KEYID, sig: fakeSig(pae) }] };
}

function genesisEntry(): AnnouncementEntry {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    source: SOURCE,
    sequence: GENESIS_SEQUENCE,
    previous: null,
    timestamp: "2026-07-28T12:00:00Z",
    announcements: [
      {
        announcementId: "ann-1",
        action: "available",
        record: { kind: "https://jinn.network/records/submission/1.0", digest: `sha256:${"a".repeat(64)}` },
      },
    ],
  };
}

function makeHwmStore(seed?: { mark: HighWaterMark }): HighWaterMarkStore {
  const store = new Map<string, HighWaterMark>();
  if (seed !== undefined) store.set(`${AGENT}/feed`, seed.mark);
  return {
    async get() {
      return store.get(`${AGENT}/feed`);
    },
    async put(_source, mark) {
      store.set(`${AGENT}/feed`, mark);
    },
  };
}

async function* oneEntry(entry: AnnouncementEntry): AsyncIterable<{ entry: AnnouncementEntry; signature: DsseEnvelope }> {
  yield { entry, signature: signedEntry(entry) };
}

describe("verifySourceChain: issuedAt monotonicity (§10.3 step 3, §5.2, MAJOR fix)", () => {
  it("rejects a re-signed head whose issuedAt does not strictly increase on the persisted high-water mark", async () => {
    const entry = genesisEntry();
    const { digest } = sealJson(entry);
    const head: SourceHead = {
      protocol: RECORD_DISCOVERY_VERSION,
      origin: `${AGENT}/feed`,
      sequence: GENESIS_SEQUENCE,
      entry: digest,
      issuedAt: "2026-07-27T00:00:00.000Z", // EARLIER than the persisted mark below
      refreshBy: "2026-07-29T00:00:00.000Z",
    };
    const hwm = makeHwmStore({ mark: { sequence: GENESIS_SEQUENCE, entry: digest, issuedAt: "2026-07-27T12:00:00.000Z" } });

    const outcome = await verifySourceChain({
      head,
      headSignature: signedHead(head),
      entries: oneEntry(entry),
      ports: { keys, sigs, fresh, hwm, now: new Date("2026-07-28T00:00:00.000Z"), firstAdoption: false },
    });

    expect(outcome).toEqual({ status: "broken-chain", at: "issued-at-monotonicity" });
  });

  it("rejects a re-signed head whose issuedAt exactly equals the persisted mark's issuedAt (strict increase required)", async () => {
    const entry = genesisEntry();
    const { digest } = sealJson(entry);
    const sameInstant = "2026-07-27T12:00:00.000Z";
    const head: SourceHead = {
      protocol: RECORD_DISCOVERY_VERSION,
      origin: `${AGENT}/feed`,
      sequence: GENESIS_SEQUENCE,
      entry: digest,
      issuedAt: sameInstant,
      refreshBy: "2026-07-29T00:00:00.000Z",
    };
    const hwm = makeHwmStore({ mark: { sequence: GENESIS_SEQUENCE, entry: digest, issuedAt: sameInstant } });

    const outcome = await verifySourceChain({
      head,
      headSignature: signedHead(head),
      entries: oneEntry(entry),
      ports: { keys, sigs, fresh, hwm, now: new Date("2026-07-28T00:00:00.000Z"), firstAdoption: false },
    });

    expect(outcome).toEqual({ status: "broken-chain", at: "issued-at-monotonicity" });
  });

  it("accepts a re-signed head whose issuedAt strictly increases, and persists the new issuedAt on the high-water mark", async () => {
    const entry = genesisEntry();
    const { digest } = sealJson(entry);
    const head: SourceHead = {
      protocol: RECORD_DISCOVERY_VERSION,
      origin: `${AGENT}/feed`,
      sequence: GENESIS_SEQUENCE,
      entry: digest,
      issuedAt: "2026-07-28T00:00:00.000Z", // LATER than the persisted mark
      refreshBy: "2026-07-29T00:00:00.000Z",
    };
    const hwm = makeHwmStore({ mark: { sequence: GENESIS_SEQUENCE, entry: digest, issuedAt: "2026-07-27T12:00:00.000Z" } });

    const outcome = await verifySourceChain({
      head,
      headSignature: signedHead(head),
      entries: oneEntry(entry),
      ports: { keys, sigs, fresh, hwm, now: new Date("2026-07-28T01:00:00.000Z"), firstAdoption: false },
    });

    expect(outcome).toEqual({
      status: "ok",
      head,
      advanced: { sequence: GENESIS_SEQUENCE, entry: digest, issuedAt: "2026-07-28T00:00:00.000Z" },
    });
  });

  it("first adoption has no prior mark to be monotonic against -- issuedAt monotonicity does not apply", async () => {
    const entry = genesisEntry();
    const { digest } = sealJson(entry);
    const head: SourceHead = {
      protocol: RECORD_DISCOVERY_VERSION,
      origin: `${AGENT}/feed`,
      sequence: GENESIS_SEQUENCE,
      entry: digest,
      issuedAt: "2026-07-27T00:00:00.000Z",
      refreshBy: "2026-07-29T00:00:00.000Z",
    };
    const hwm = makeHwmStore();

    const outcome = await verifySourceChain({
      head,
      headSignature: signedHead(head),
      entries: oneEntry(entry),
      ports: { keys, sigs, fresh, hwm, now: new Date("2026-07-27T01:00:00.000Z"), firstAdoption: true },
    });

    expect(outcome.status).toBe("ok");
  });
});

describe("verifySourceChain: entry source-name grammar cross-check (§16 item 2, MINOR fix)", () => {
  it("rejects a walked entry whose source tuple does not equal splitOrigin(head.origin)", async () => {
    // The entry's own `source` claims a DIFFERENT source name than the
    // head it is walked under -- an entry from another of this agent's
    // sources (or a foreign one) must never be accepted as this source's
    // history.
    const entry: AnnouncementEntry = { ...genesisEntry(), source: { agent: AGENT, name: "other-feed" } };
    const { digest } = sealJson(entry);
    const head: SourceHead = {
      protocol: RECORD_DISCOVERY_VERSION,
      origin: `${AGENT}/feed`,
      sequence: GENESIS_SEQUENCE,
      entry: digest,
      issuedAt: "2026-07-28T00:00:00.000Z",
      refreshBy: "2026-07-29T00:00:00.000Z",
    };
    const hwm = makeHwmStore();

    const outcome = await verifySourceChain({
      head,
      headSignature: signedHead(head),
      entries: oneEntry(entry),
      ports: { keys, sigs, fresh, hwm, now: new Date("2026-07-27T01:00:00.000Z"), firstAdoption: true },
    });

    expect(outcome).toEqual({ status: "broken-chain", at: "source-mismatch" });
  });

  it("accepts a walked entry whose source tuple matches splitOrigin(head.origin)", async () => {
    const entry = genesisEntry();
    const { digest } = sealJson(entry);
    const head: SourceHead = {
      protocol: RECORD_DISCOVERY_VERSION,
      origin: `${AGENT}/feed`,
      sequence: GENESIS_SEQUENCE,
      entry: digest,
      issuedAt: "2026-07-28T00:00:00.000Z",
      refreshBy: "2026-07-29T00:00:00.000Z",
    };
    const hwm = makeHwmStore();

    const outcome = await verifySourceChain({
      head,
      headSignature: signedHead(head),
      entries: oneEntry(entry),
      ports: { keys, sigs, fresh, hwm, now: new Date("2026-07-27T01:00:00.000Z"), firstAdoption: true },
    });

    expect(outcome.status).toBe("ok");
  });
});
