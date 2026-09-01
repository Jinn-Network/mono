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

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fakeSig(pae: Uint8Array): Uint8Array {
  return new TextEncoder().encode(`${sha256Hex(pae)}:${KEYID}`);
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
  const payload = sealJson(head).bytes;
  const pae = dssePreAuthEncoding(MEDIA_HEAD, payload);
  return { payloadType: MEDIA_HEAD, payload: encodeBase64(payload), signatures: [{ keyid: KEYID, sig: encodeBase64(fakeSig(pae)) }] };
}

function signedEntry(entry: AnnouncementEntry): DsseEnvelope {
  const { bytes } = sealJson(entry);
  const pae = dssePreAuthEncoding(MEDIA_ENTRY, bytes);
  return { payloadType: MEDIA_ENTRY, payload: encodeBase64(bytes), signatures: [{ keyid: KEYID, sig: encodeBase64(fakeSig(pae)) }] };
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
        record: { kind: "https://spec.jinn.network/records/submission/v1", digest: `sha256:${"a".repeat(64)}` },
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
      issuedAt: "2026-07-27T06:00:00.000Z", // EARLIER than the persisted mark below
      refreshBy: "2026-07-28T06:00:00.000Z",
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

  it("rejects a re-signed idle head at the SAME position, because the walk is fed no entries (#3443 gap)", async () => {
    // A live source re-signs its idle head at least daily (`serve`'s
    // `maintainHead`): same `sequence`, same `entry`, a bumped `issuedAt`.
    // `issuedAt` monotonicity passes -- and then the linkage walk looks the
    // head's own cited entry up in the fed set, which a returning consumer's
    // walk above its mark is legitimately empty for, and fails `linkage`
    // before it consults the boundary the entry IS.
    //
    // So a correctly operating archive is still refused between appends. That
    // is NOT closed by the same-head revalidation path #3443 added (which
    // covers only a byte-identical head), and closing it is a separate
    // decision: either admit this shape onto revalidation and advance the
    // mark, or terminate the walk when `headEntryDigest === stopAt.digest`.
    // Both consumers refuse it today, so this test states the current
    // behaviour rather than blessing it.
    const entry = genesisEntry();
    const { digest } = sealJson(entry);
    const head: SourceHead = {
      protocol: RECORD_DISCOVERY_VERSION,
      origin: `${AGENT}/feed`,
      sequence: GENESIS_SEQUENCE,
      entry: digest,
      issuedAt: "2026-07-27T18:00:00.000Z", // strictly AFTER the mark below
      refreshBy: "2026-07-28T18:00:00.000Z",
    };
    const hwm = makeHwmStore({
      mark: { sequence: GENESIS_SEQUENCE, entry: digest, issuedAt: "2026-07-27T12:00:00.000Z" },
    });

    const outcome = await verifySourceChain({
      head,
      headSignature: signedHead(head),
      entries: (async function* () {})(), // a returning walk above the mark yields nothing
      ports: { keys, sigs, fresh, hwm, now: new Date("2026-07-28T00:00:00.000Z"), firstAdoption: false },
    });

    expect(outcome).toEqual({ status: "broken-chain", at: "linkage" });
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
      refreshBy: "2026-07-28T12:00:00.000Z",
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
      refreshBy: "2026-07-28T00:00:00.000Z",
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

describe("verifySourceChain: exact wire envelope binding", () => {
  it("rejects a correctly signed Head payload carried under the Entry media type", async () => {
    const entry = genesisEntry();
    const head: SourceHead = {
      protocol: RECORD_DISCOVERY_VERSION,
      origin: `${AGENT}/feed`,
      sequence: GENESIS_SEQUENCE,
      entry: sealJson(entry).digest,
      issuedAt: "2026-07-28T00:00:00.000Z",
      refreshBy: "2026-07-29T00:00:00.000Z",
    };
    const payload = sealJson(head).bytes;
    const pae = dssePreAuthEncoding(MEDIA_ENTRY, payload);
    const wrongType: DsseEnvelope = {
      payloadType: MEDIA_ENTRY,
      payload: encodeBase64(payload),
      signatures: [{ keyid: KEYID, sig: encodeBase64(fakeSig(pae)) }],
    };

    const outcome = await verifySourceChain({
      head,
      headSignature: wrongType,
      entries: oneEntry(entry),
      ports: { keys, sigs, fresh, hwm: makeHwmStore(), now: new Date("2026-07-28T01:00:00.000Z"), firstAdoption: true },
    });

    expect(outcome).toEqual({ status: "unauthorized-signer" });
  });

  it("rejects a valid signature whose envelope payload bytes are not the exact supplied Head", async () => {
    const entry = genesisEntry();
    const head: SourceHead = {
      protocol: RECORD_DISCOVERY_VERSION,
      origin: `${AGENT}/feed`,
      sequence: GENESIS_SEQUENCE,
      entry: sealJson(entry).digest,
      issuedAt: "2026-07-28T00:00:00.000Z",
      refreshBy: "2026-07-29T00:00:00.000Z",
    };
    const other = sealJson({ ...head, issuedAt: "2026-07-28T00:00:01.000Z" }).bytes;
    const pae = dssePreAuthEncoding(MEDIA_HEAD, other);
    const mismatched: DsseEnvelope = {
      payloadType: MEDIA_HEAD,
      payload: encodeBase64(other),
      signatures: [{ keyid: KEYID, sig: encodeBase64(fakeSig(pae)) }],
    };

    const outcome = await verifySourceChain({
      head,
      headSignature: mismatched,
      entries: oneEntry(entry),
      ports: { keys, sigs, fresh, hwm: makeHwmStore(), now: new Date("2026-07-28T01:00:00.000Z"), firstAdoption: true },
    });

    expect(outcome).toEqual({ status: "unauthorized-signer" });
  });
});

describe("verifySourceChain: the published-profile refreshBy ceiling (#3467, §5.2)", () => {
  function ceilingHead(entryDigest: `sha256:${string}`, refreshBy: string): SourceHead {
    return {
      protocol: RECORD_DISCOVERY_VERSION,
      origin: `${AGENT}/feed`,
      sequence: GENESIS_SEQUENCE,
      entry: entryDigest,
      issuedAt: "2026-07-28T00:00:00.000Z",
      refreshBy,
    };
  }

  it("rejects a head whose refreshBy runs further ahead of issuedAt than the profile allows", async () => {
    // `isFresh` can never catch this head: its `refreshBy` outruns every
    // clock the consumer will ever read, so without the ceiling one minting
    // makes the source permanently live and the §5.2 withholding-detection
    // window unbounded.
    const entry = genesisEntry();
    const head = ceilingHead(sealJson(entry).digest, "2030-01-01T00:00:00.000Z");

    const outcome = await verifySourceChain({
      head,
      headSignature: signedHead(head),
      entries: oneEntry(entry),
      ports: { keys, sigs, fresh, hwm: makeHwmStore(), now: new Date("2026-07-28T01:00:00.000Z"), firstAdoption: true },
    });

    expect(outcome).toEqual({ status: "broken-chain", at: "refresh-by-ceiling" });
  });

  it("accepts a head sitting exactly on the published-profile ceiling", async () => {
    const entry = genesisEntry();
    const head = ceilingHead(sealJson(entry).digest, "2026-07-29T00:00:00.000Z");

    const outcome = await verifySourceChain({
      head,
      headSignature: signedHead(head),
      entries: oneEntry(entry),
      ports: { keys, sigs, fresh, hwm: makeHwmStore(), now: new Date("2026-07-28T01:00:00.000Z"), firstAdoption: true },
    });

    expect(outcome.status).toBe("ok");
  });

  it("honors a tighter profile ceiling supplied by the caller", async () => {
    const entry = genesisEntry();
    const head = ceilingHead(sealJson(entry).digest, "2026-07-28T12:00:00.000Z");

    const outcome = await verifySourceChain({
      head,
      headSignature: signedHead(head),
      entries: oneEntry(entry),
      ports: {
        keys,
        sigs,
        fresh,
        hwm: makeHwmStore(),
        now: new Date("2026-07-28T01:00:00.000Z"),
        firstAdoption: true,
        maxRefreshByAheadMs: 60 * 60 * 1000,
      },
    });

    expect(outcome).toEqual({ status: "broken-chain", at: "refresh-by-ceiling" });
  });

  it("refuses a head whose timestamps cannot be compared at all", async () => {
    const entry = genesisEntry();
    const head: SourceHead = { ...ceilingHead(sealJson(entry).digest, "2026-07-29T00:00:00.000Z"), issuedAt: "not-a-timestamp" };

    const outcome = await verifySourceChain({
      head,
      headSignature: signedHead(head),
      entries: oneEntry(entry),
      ports: { keys, sigs, fresh, hwm: makeHwmStore(), now: new Date("2026-07-28T01:00:00.000Z"), firstAdoption: true },
    });

    expect(outcome).toEqual({ status: "broken-chain", at: "refresh-by-ceiling" });
  });
});

describe("verifySourceChain: the future-issued head the ceiling alone cannot see (#3467, §5.2)", () => {
  function futureHead(entryDigest: `sha256:${string}`, issuedAt: string, refreshBy: string): SourceHead {
    return {
      protocol: RECORD_DISCOVERY_VERSION,
      origin: `${AGENT}/feed`,
      sequence: GENESIS_SEQUENCE,
      entry: entryDigest,
      issuedAt,
      refreshBy,
    };
  }

  it("rejects a head issued further into the future than one freshness window, even with a conformant window", async () => {
    // Left open by a refreshBy-vs-issuedAt ceiling alone, and worse here than
    // on the revalidation path: on first adoption this head also becomes the
    // persisted high-water mark, so every honest head after it fails
    // issued-at monotonicity.
    const entry = genesisEntry();
    const head = futureHead(sealJson(entry).digest, "2099-01-01T00:00:00.000Z", "2099-01-02T00:00:00.000Z");

    const outcome = await verifySourceChain({
      head,
      headSignature: signedHead(head),
      entries: oneEntry(entry),
      ports: { keys, sigs, fresh, hwm: makeHwmStore(), now: new Date("2026-07-28T01:00:00.000Z"), firstAdoption: true },
    });

    expect(outcome).toEqual({ status: "broken-chain", at: "head-issued-ahead" });
  });

  it("rejects a head whose refreshBy is not after its issuedAt", async () => {
    const entry = genesisEntry();
    const head = futureHead(sealJson(entry).digest, "2099-01-01T00:00:00.000Z", "2098-01-01T00:00:00.000Z");

    const outcome = await verifySourceChain({
      head,
      headSignature: signedHead(head),
      entries: oneEntry(entry),
      ports: { keys, sigs, fresh, hwm: makeHwmStore(), now: new Date("2026-07-28T01:00:00.000Z"), firstAdoption: true },
    });

    expect(outcome).toEqual({ status: "broken-chain", at: "refresh-by-ceiling" });
  });

  it("cannot be widened by a caller-supplied ceiling -- a profile may only tighten", async () => {
    const entry = genesisEntry();
    const head = futureHead(sealJson(entry).digest, "2026-07-28T00:00:00.000Z", "2030-01-01T00:00:00.000Z");

    const outcome = await verifySourceChain({
      head,
      headSignature: signedHead(head),
      entries: oneEntry(entry),
      ports: {
        keys,
        sigs,
        fresh,
        hwm: makeHwmStore(),
        now: new Date("2026-07-28T01:00:00.000Z"),
        firstAdoption: true,
        maxRefreshByAheadMs: 4 * 365 * 24 * 60 * 60 * 1000,
      },
    });

    expect(outcome).toEqual({ status: "broken-chain", at: "refresh-by-ceiling" });
  });
});
