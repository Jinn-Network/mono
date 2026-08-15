import { describe, expect, it } from "vitest";
import type { AnnouncementEntry, SourceIdentity } from "@jinn-network/record-discovery-protocol";
import { GENESIS_SEQUENCE, RECORD_DISCOVERY_VERSION, formatOrigin, headPath, sealJson } from "@jinn-network/record-discovery-protocol";
import type { BlobStore, Clock, DsseSigner } from "@jinn-network/record-discovery-serve";

import { publish, signEntry } from "./publish.js";

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
      return [{ keyid, sig: pae }];
    },
  };
}

const SOURCE: SourceIdentity = { agent: "did:key:zEvidenceJournalWrapper", name: "evidence-journal" };

function entryAt(sequence: string, previous: `sha256:${string}` | null): AnnouncementEntry {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    source: SOURCE,
    sequence,
    previous,
    timestamp: "2026-07-28T12:00:00.000Z",
    announcements: [
      {
        announcementId: `a-${sequence}`,
        action: "available",
        record: { kind: "https://spec.jinn.network/records/execution-evidence/v1", digest: `sha256:${"a".repeat(64)}` },
      },
    ],
  };
}

describe("signEntry (§5.5: entries are signed once at append time)", () => {
  it("produces a DSSE envelope over the sealed entry bytes under the entry payload type", async () => {
    const entry = entryAt(GENESIS_SEQUENCE, null);
    const envelope = await signEntry(entry, makeSigner("key-1"));
    expect(envelope.payloadType).toBe("application/vnd.jinn.record-discovery.entry.v1+json");
    expect(envelope.signatures).toHaveLength(1);
    expect(envelope.signatures[0]!.keyid).toBe("key-1");
    const decodedPayload = Uint8Array.from(atob(envelope.payload), (c) => c.charCodeAt(0));
    expect(decodedPayload).toEqual(sealJson(entry).bytes);
  });
});

describe("publish (§7, §5.5)", () => {
  it("throws when bootstrapping with no entries and no previous head", async () => {
    const store = makeInMemoryStore();
    await expect(
      publish({ store, clock: makeClock("2026-07-28T00:00:00.000Z"), signer: undefined, source: SOURCE, entries: [], previousHead: undefined }),
    ).rejects.toThrow(/bootstrap/);
  });

  it("bootstraps: writes archive pages and a head citing the newest entry's sequence and digest", async () => {
    const store = makeInMemoryStore();
    const first = entryAt(GENESIS_SEQUENCE, null);
    const second = entryAt("0000000000000002", sealJson(first).digest);
    const result = await publish({
      store,
      clock: makeClock("2026-07-28T00:00:00.000Z"),
      signer: undefined,
      source: SOURCE,
      entries: [first, second],
      previousHead: undefined,
    });

    expect(result.pages.length).toBeGreaterThanOrEqual(1);
    expect(result.head.sequence).toBe("0000000000000002");
    expect(result.head.entry).toBe(sealJson(second).digest);
    expect(result.head.origin).toBe(formatOrigin(SOURCE.agent, SOURCE.name));
    expect(result.headEnvelope).toBeUndefined(); // unpublished profile: no signer
    expect(store.get(headPath(SOURCE.name))).toBeDefined();
  });

  it("publishes DSSE-signed entries and head when given a signer (published profile)", async () => {
    const store = makeInMemoryStore();
    const first = entryAt(GENESIS_SEQUENCE, null);
    const result = await publish({
      store,
      clock: makeClock("2026-07-28T00:00:00.000Z"),
      signer: makeSigner("key-1"),
      source: SOURCE,
      entries: [first],
      previousHead: undefined,
    });

    expect(result.headEnvelope).toBeDefined();
    expect(result.headEnvelope!.signatures[0]!.keyid).toBe("key-1");
  });

  it("advances an existing head to a later batch's tip on a subsequent publish", async () => {
    const store = makeInMemoryStore();
    const first = entryAt(GENESIS_SEQUENCE, null);
    const bootstrap = await publish({
      store,
      clock: makeClock("2026-07-28T00:00:00.000Z"),
      signer: undefined,
      source: SOURCE,
      entries: [first],
      previousHead: undefined,
    });

    const second = entryAt("0000000000000002", sealJson(first).digest);
    const advanced = await publish({
      store,
      clock: makeClock("2026-07-28T01:00:00.000Z"),
      signer: undefined,
      source: SOURCE,
      entries: [second],
      previousHead: bootstrap.head,
    });

    expect(advanced.head.sequence).toBe("0000000000000002");
    expect(advanced.head.entry).toBe(sealJson(second).digest);
    expect(new Date(advanced.head.issuedAt).getTime()).toBeGreaterThan(new Date(bootstrap.head.issuedAt).getTime());
  });

  it("re-signs the existing head in place when there are no new entries (§7 item 3 freshness obligation)", async () => {
    const store = makeInMemoryStore();
    const first = entryAt(GENESIS_SEQUENCE, null);
    const bootstrap = await publish({
      store,
      clock: makeClock("2026-07-28T00:00:00.000Z"),
      signer: undefined,
      source: SOURCE,
      entries: [first],
      previousHead: undefined,
    });

    const refreshed = await publish({
      store,
      clock: makeClock("2026-07-28T01:00:00.000Z"),
      signer: undefined,
      source: SOURCE,
      entries: [],
      previousHead: bootstrap.head,
    });

    expect(refreshed.head.sequence).toBe(bootstrap.head.sequence);
    expect(refreshed.head.entry).toBe(bootstrap.head.entry);
    expect(new Date(refreshed.head.issuedAt).getTime()).toBeGreaterThan(new Date(bootstrap.head.issuedAt).getTime());
    expect(refreshed.pages).toEqual([]);
  });
});
