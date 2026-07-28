import { describe, expect, it } from "vitest";
import type { SourceHead, SourceIdentity } from "@jinn-network/record-discovery-protocol";
import { dssePreAuthEncoding, formatOrigin, headPath, sealJson } from "@jinn-network/record-discovery-protocol";

import type { BlobStore, Clock, DsseSigner } from "./ports.js";
import { MAX_REFRESH_BY_AHEAD_MS, maintainHead, maintainsFreshness, refreshByWithinBound, refreshHead, signHead } from "./head.js";

function makeInMemoryStore(): BlobStore & { get(path: string): { bytes: Uint8Array; contentType: string } | undefined } {
  const store = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    async put(path, bytes, contentType) {
      store.set(path, { bytes, contentType });
    },
    get(path) {
      return store.get(path);
    },
  };
}

function makeClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

function makeSigner(keyid: string): DsseSigner {
  return {
    async sign(pae: Uint8Array) {
      return [{ keyid, sig: pae }]; // deterministic test double: "signature" is the PAE itself
    },
  };
}

const BASE_HEAD: SourceHead = {
  protocol: "https://jinn.network/record-discovery/1.0",
  origin: "did:key:zAgentSourceOne/feed",
  sequence: "0000000000000001",
  entry: `sha256:${"a".repeat(64)}`,
  issuedAt: "2026-07-28T00:00:00.000Z",
  refreshBy: "2026-07-28T06:00:00.000Z",
};

const SOURCE: SourceIdentity = { agent: "did:key:zAgentSourceOne", name: "feed" };

describe("refreshHead (§5.2)", () => {
  it("strictly increases issuedAt relative to the previous head", () => {
    const refreshed = refreshHead(BASE_HEAD, makeClock("2026-07-28T01:00:00.000Z"), 6 * 60 * 60 * 1000);
    expect(new Date(refreshed.issuedAt).getTime()).toBeGreaterThan(new Date(BASE_HEAD.issuedAt).getTime());
  });

  it("strictly increases issuedAt even when the clock has not advanced", () => {
    const refreshed = refreshHead(BASE_HEAD, makeClock(BASE_HEAD.issuedAt), 1000);
    expect(new Date(refreshed.issuedAt).getTime()).toBeGreaterThan(new Date(BASE_HEAD.issuedAt).getTime());
  });

  it("keeps refreshBy within the published-source-profile bound (<= 24h ahead) regardless of the requested window", () => {
    const refreshed = refreshHead(BASE_HEAD, makeClock("2026-07-28T01:00:00.000Z"), 30 * 60 * 60 * 1000);
    const aheadMs = new Date(refreshed.refreshBy).getTime() - new Date(refreshed.issuedAt).getTime();
    expect(aheadMs).toBeLessThanOrEqual(MAX_REFRESH_BY_AHEAD_MS);
  });

  it("preserves every other field of the head unchanged", () => {
    const refreshed = refreshHead(BASE_HEAD, makeClock("2026-07-28T01:00:00.000Z"), 1000);
    expect(refreshed.protocol).toBe(BASE_HEAD.protocol);
    expect(refreshed.origin).toBe(BASE_HEAD.origin);
    expect(refreshed.sequence).toBe(BASE_HEAD.sequence);
    expect(refreshed.entry).toBe(BASE_HEAD.entry);
  });
});

describe("signHead (§5.5)", () => {
  it("produces a DSSE envelope over the sealed head bytes under the head payload type", async () => {
    const envelope = await signHead(BASE_HEAD, makeSigner("key-1"));
    expect(envelope.payloadType).toBe("application/vnd.jinn.record-discovery.head.v1+json");
    expect(envelope.signatures).toHaveLength(1);
    expect(envelope.signatures[0]!.keyid).toBe("key-1");

    // The envelope's payload base64-decodes to the head's own sealed bytes.
    const decodedPayload = Uint8Array.from(atob(envelope.payload), (c) => c.charCodeAt(0));
    expect(decodedPayload).toEqual(sealJson(BASE_HEAD).bytes);

    // The signature covers the DSSE pre-auth encoding of (payloadType, sealed head bytes).
    const expectedPae = dssePreAuthEncoding(envelope.payloadType, sealJson(BASE_HEAD).bytes);
    const decodedSig = Uint8Array.from(atob(envelope.signatures[0]!.sig), (c) => c.charCodeAt(0));
    expect(decodedSig).toEqual(expectedPae);
  });
});

describe("maintainHead (§7.3): re-sign + write even when nothing new was announced", () => {
  it("writes a signed envelope at headPath when given a signer (published profile)", async () => {
    const store = makeInMemoryStore();
    const { head, envelope } = await maintainHead(store, makeSigner("key-1"), makeClock("2026-07-28T01:00:00.000Z"), SOURCE, BASE_HEAD);

    expect(envelope).toBeDefined();
    const stored = store.get(headPath("feed"));
    expect(stored).toBeDefined();
    const decoded = JSON.parse(new TextDecoder().decode(stored!.bytes));
    expect(decoded).toEqual(envelope);
    expect(head.issuedAt).not.toBe(BASE_HEAD.issuedAt);
  });

  it("writes a bare unsigned head at headPath when given no signer (unpublished profile)", async () => {
    const store = makeInMemoryStore();
    const { head, envelope } = await maintainHead(store, undefined, makeClock("2026-07-28T01:00:00.000Z"), SOURCE, BASE_HEAD);

    expect(envelope).toBeUndefined();
    const stored = store.get(headPath("feed"));
    expect(stored).toBeDefined();
    const decoded = JSON.parse(new TextDecoder().decode(stored!.bytes));
    expect(decoded).toEqual(head);
  });

  it("rejects a head whose origin does not match the maintained source identity", async () => {
    const store = makeInMemoryStore();
    const mismatched: SourceHead = { ...BASE_HEAD, origin: formatOrigin("did:key:zSomeoneElse", "feed") };

    await expect(maintainHead(store, undefined, makeClock("2026-07-28T01:00:00.000Z"), SOURCE, mismatched)).rejects.toThrow();
  });

  it("re-signs and re-writes the head even when nothing new was announced (same entry/sequence)", async () => {
    const store = makeInMemoryStore();
    const first = await maintainHead(store, makeSigner("key-1"), makeClock("2026-07-28T01:00:00.000Z"), SOURCE, BASE_HEAD);
    const second = await maintainHead(store, makeSigner("key-1"), makeClock("2026-07-28T02:00:00.000Z"), SOURCE, first.head);

    expect(second.head.entry).toBe(BASE_HEAD.entry);
    expect(second.head.sequence).toBe(BASE_HEAD.sequence);
    expect(new Date(second.head.issuedAt).getTime()).toBeGreaterThan(new Date(first.head.issuedAt).getTime());
  });
});

describe("refreshByWithinBound (§5.2, for ServeUnderTest.refreshByWithinBound)", () => {
  it("accepts a head whose refreshBy is within the bound", () => {
    expect(refreshByWithinBound({ issuedAt: "2026-07-28T00:00:00.000Z", refreshBy: "2026-07-28T23:00:00.000Z" }, 24)).toBe(true);
  });

  it("rejects a head whose refreshBy exceeds the bound", () => {
    expect(refreshByWithinBound({ issuedAt: "2026-07-28T00:00:00.000Z", refreshBy: "2026-07-30T00:00:00.000Z" }, 24)).toBe(false);
  });
});

describe("maintainsFreshness (for ServeUnderTest.maintainsFreshness)", () => {
  it("accepts a sequence of head envelopes with strictly increasing issuedAt and refreshBy always ahead", () => {
    const first = sealJson({ ...BASE_HEAD, issuedAt: "2026-07-28T00:00:00.000Z", refreshBy: "2026-07-28T06:00:00.000Z" });
    const second = sealJson({ ...BASE_HEAD, issuedAt: "2026-07-28T06:00:00.000Z", refreshBy: "2026-07-28T12:00:00.000Z" });
    expect(maintainsFreshness([{ payload: new TextDecoder().decode(first.bytes) }, { payload: new TextDecoder().decode(second.bytes) }])).toBe(true);
  });

  it("rejects a sequence where issuedAt does not strictly increase", () => {
    const first = sealJson({ ...BASE_HEAD, issuedAt: "2026-07-28T06:00:00.000Z", refreshBy: "2026-07-28T12:00:00.000Z" });
    const second = sealJson({ ...BASE_HEAD, issuedAt: "2026-07-28T00:00:00.000Z", refreshBy: "2026-07-28T06:00:00.000Z" });
    expect(maintainsFreshness([{ payload: new TextDecoder().decode(first.bytes) }, { payload: new TextDecoder().decode(second.bytes) }])).toBe(false);
  });

  it("rejects a head whose refreshBy is not ahead of its own issuedAt", () => {
    const stale = sealJson({ ...BASE_HEAD, issuedAt: "2026-07-28T06:00:00.000Z", refreshBy: "2026-07-28T00:00:00.000Z" });
    expect(maintainsFreshness([{ payload: new TextDecoder().decode(stale.bytes) }])).toBe(false);
  });

  it("also accepts base64-encoded payloads (the real DSSE wire format)", () => {
    const bytes = sealJson({ ...BASE_HEAD, issuedAt: "2026-07-28T00:00:00.000Z", refreshBy: "2026-07-28T06:00:00.000Z" }).bytes;
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    expect(maintainsFreshness([{ payload: btoa(binary) }])).toBe(true);
  });
});
