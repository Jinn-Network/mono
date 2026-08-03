import { describe, expect, it } from "vitest";
import {
  archivePagePath,
  headPath,
  parseAnnouncementEntry,
  sealJson,
} from "@jinn-network/record-discovery-protocol";
import type { AnnouncementEntry, SourceHead } from "@jinn-network/record-discovery-protocol";

import type { Transport, TransportResponse } from "./ports.js";
import {
  coldSync,
  decodeWireEnvelopeForVerification,
  fetchHead,
  resolveHeadAcrossMirrors,
  returningSync,
} from "./sync.js";
import type { SourceEndpoint } from "./sync.js";

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function makeRoutedTransport(routes: Map<string, unknown>): Transport {
  return {
    async "fetch"(url: string): Promise<TransportResponse> {
      if (!routes.has(url)) throw new Error(`no route seeded for ${url}`);
      const { bytes } = sealJson(routes.get(url));
      return { status: 200, contentType: "application/json", bytes };
    },
  };
}

function makeEntry(sequence: string, previous: `sha256:${string}` | null): AnnouncementEntry {
  return parseAnnouncementEntry({
    protocol: "https://jinn.network/record-discovery/1.0",
    source: { agent: "did:key:zAgentSourceOne", name: "feed" },
    sequence,
    previous,
    timestamp: "2026-07-28T12:00:00.000Z",
    announcements: [
      {
        announcementId: `ann-${sequence}`,
        action: "available",
        record: { kind: "https://jinn.network/records/submission/1.0", digest: `sha256:${"a".repeat(64)}` },
      },
    ],
  });
}

function entryDigest(entry: AnnouncementEntry): `sha256:${string}` {
  return sealJson(entry).digest;
}

const ENDPOINT: SourceEndpoint = {
  agent: "did:key:zAgentSourceOne",
  name: "feed",
  servingRoot: "https://example.org",
  archiveRootUrl: "https://example.org/sources/feed/entries/0000000000000002",
};

describe("fetchHead (§5.2)", () => {
  it("normalizes a real wire DSSE payload for the public verification driver without changing signatures", () => {
    const payload = new TextEncoder().encode('{"sequence":"0000000000000001"}');
    const wire = {
      payloadType: "application/vnd.jinn.record-discovery.head.v1+json",
      payload: Buffer.from(payload).toString("base64"),
      signatures: [{ keyid: "did:key:zSource", sig: Buffer.from("signature").toString("base64") }],
    };

    expect(decodeWireEnvelopeForVerification(wire)).toEqual({
      envelope: wire,
      payloadBytes: payload,
      signatures: [{
        keyid: "did:key:zSource",
        signatureBytes: new TextEncoder().encode("signature"),
      }],
    });
    expect(wire.payload).toBe(Buffer.from(payload).toString("base64"));
  });

  it.each([
    [{ payloadType: "type", payload: "e30", signatures: [{ sig: "c2ln" }] }, "payload is not canonical standard base64"],
    [{ payloadType: "type", payload: "e30=", signatures: [{ sig: "c2ln-_==" }] }, "signature 0 is not canonical standard base64"],
    [{ payloadType: "type", payload: "e30=", signatures: [{ sig: "c2ln" }], extra: true }, "exactly payload, payloadType, and signatures"],
    [{ payloadType: "type", payload: "e30=", signatures: [{ sig: "c2ln", extra: true }] }, "signature 0 must contain exactly sig and optional keyid"],
  ] as const)("rejects malformed or noncanonical wire DSSE %#", (wire, message) => {
    expect(() => decodeWireEnvelopeForVerification(wire)).toThrow(message);
  });

  it("parses a bare (unpublished-profile) head with no signature", async () => {
    const head: SourceHead = {
      protocol: "https://jinn.network/record-discovery/1.0",
      origin: "did:key:zAgentSourceOne/feed",
      sequence: "0000000000000001",
      entry: `sha256:${"a".repeat(64)}`,
      issuedAt: "2026-07-28T12:00:00.000Z",
      refreshBy: "2026-07-29T12:00:00.000Z",
    };
    const routes = new Map<string, unknown>([["https://example.org" + headPath("feed"), head]]);

    const synced = await fetchHead(ENDPOINT, makeRoutedTransport(routes));

    expect(synced.head).toEqual(head);
    expect(synced.signature).toBeUndefined();
  });

  it("parses a published-profile head, extracting its DSSE envelope", async () => {
    const head: SourceHead = {
      protocol: "https://jinn.network/record-discovery/1.0",
      origin: "did:key:zAgentSourceOne/feed",
      sequence: "0000000000000001",
      entry: `sha256:${"a".repeat(64)}`,
      issuedAt: "2026-07-28T12:00:00.000Z",
      refreshBy: "2026-07-29T12:00:00.000Z",
    };
    const headBytes = sealJson(head).bytes;
    const envelope = {
      payloadType: "application/vnd.jinn.record-discovery.head.v1+json",
      payload: encodeBase64(headBytes),
      signatures: [{ keyid: "key-1", sig: "deadbeef" }],
    };
    const routes = new Map<string, unknown>([["https://example.org" + headPath("feed"), envelope]]);

    const synced = await fetchHead(ENDPOINT, makeRoutedTransport(routes));

    expect(synced.head).toEqual(head);
    expect(synced.signature).toEqual(envelope);
  });
});

describe("coldSync (§5.3 rule 3: walk previous toward genesis via archive pages)", () => {
  it("walks every page backward from the current page and yields entries oldest-first", async () => {
    const genesis = makeEntry("0000000000000001", null);
    const second = makeEntry("0000000000000002", entryDigest(genesis));

    const page1 = {
      protocol: "https://jinn.network/record-discovery/1.0",
      source: "feed",
      page: "0000000000000001",
      prevArchive: null,
      entries: [{ entry: genesis }],
    };
    const page2 = {
      protocol: "https://jinn.network/record-discovery/1.0",
      source: "feed",
      page: "0000000000000002",
      prevArchive: "0000000000000001",
      entries: [{ entry: second }],
    };
    const routes = new Map<string, unknown>([
      ["https://example.org" + archivePagePath("feed", "0000000000000002"), page2],
      ["https://example.org" + archivePagePath("feed", "0000000000000001"), page1],
    ]);

    const yielded: AnnouncementEntry[] = [];
    for await (const signed of coldSync(ENDPOINT, { transport: makeRoutedTransport(routes) })) {
      yielded.push(signed.entry);
    }

    expect(yielded.map((e) => e.sequence)).toEqual(["0000000000000001", "0000000000000002"]);
  });
});

describe("returningSync (§5.3 rule 5: head back to the high-water mark, not genesis)", () => {
  it("yields only entries newer than the high-water mark and stops once reached", async () => {
    const genesis = makeEntry("0000000000000001", null);
    const second = makeEntry("0000000000000002", entryDigest(genesis));
    const third = makeEntry("0000000000000003", entryDigest(second));

    const page1 = {
      protocol: "https://jinn.network/record-discovery/1.0",
      source: "feed",
      page: "0000000000000001",
      prevArchive: null,
      entries: [{ entry: genesis }, { entry: second }],
    };
    const page2 = {
      protocol: "https://jinn.network/record-discovery/1.0",
      source: "feed",
      page: "0000000000000002",
      prevArchive: "0000000000000001",
      entries: [{ entry: third }],
    };
    const routes = new Map<string, unknown>([
      ["https://example.org" + archivePagePath("feed", "0000000000000002"), page2],
      ["https://example.org" + archivePagePath("feed", "0000000000000001"), page1],
    ]);

    const yielded: AnnouncementEntry[] = [];
    for await (const signed of returningSync(
      ENDPOINT,
      { sequence: "0000000000000001", entry: entryDigest(genesis) },
      { transport: makeRoutedTransport(routes) },
    )) {
      yielded.push(signed.entry);
    }

    expect(yielded.map((e) => e.sequence)).toEqual(["0000000000000002", "0000000000000003"]);
  });
});

describe("resolveHeadAcrossMirrors (§5.2/§13.3: cold-start mirror disagreement)", () => {
  it("takes the highest valid (sequence, issuedAt) among mirrors", async () => {
    const mirrorA: SourceEndpoint = { ...ENDPOINT, servingRoot: "https://mirror-a.example" };
    const mirrorB: SourceEndpoint = { ...ENDPOINT, servingRoot: "https://mirror-b.example" };
    const mirrorC: SourceEndpoint = { ...ENDPOINT, servingRoot: "https://mirror-c.example" };

    const headAt = (sequence: string, issuedAt: string): SourceHead => ({
      protocol: "https://jinn.network/record-discovery/1.0",
      origin: "did:key:zAgentSourceOne/feed",
      sequence,
      entry: `sha256:${"a".repeat(64)}`,
      issuedAt,
      refreshBy: "2026-07-29T12:00:00.000Z",
    });

    const routes = new Map<string, unknown>([
      ["https://mirror-a.example" + headPath("feed"), headAt("0000000000000003", "2026-07-28T10:00:00.000Z")],
      ["https://mirror-b.example" + headPath("feed"), headAt("0000000000000005", "2026-07-28T11:00:00.000Z")],
      ["https://mirror-c.example" + headPath("feed"), headAt("0000000000000005", "2026-07-28T09:00:00.000Z")],
    ]);

    const result = await resolveHeadAcrossMirrors([mirrorA, mirrorB, mirrorC], { transport: makeRoutedTransport(routes) });

    expect(result?.endpoint.servingRoot).toBe("https://mirror-b.example");
    expect(result?.synced.head.sequence).toBe("0000000000000005");
  });

  it("skips mirrors that fail to respond", async () => {
    const mirrorA: SourceEndpoint = { ...ENDPOINT, servingRoot: "https://mirror-a.example" };
    const mirrorB: SourceEndpoint = { ...ENDPOINT, servingRoot: "https://mirror-b.example" };

    const headAt = (sequence: string, issuedAt: string): SourceHead => ({
      protocol: "https://jinn.network/record-discovery/1.0",
      origin: "did:key:zAgentSourceOne/feed",
      sequence,
      entry: `sha256:${"a".repeat(64)}`,
      issuedAt,
      refreshBy: "2026-07-29T12:00:00.000Z",
    });
    const routes = new Map<string, unknown>([
      ["https://mirror-b.example" + headPath("feed"), headAt("0000000000000002", "2026-07-28T10:00:00.000Z")],
    ]);

    const result = await resolveHeadAcrossMirrors([mirrorA, mirrorB], { transport: makeRoutedTransport(routes) });

    expect(result?.endpoint.servingRoot).toBe("https://mirror-b.example");
  });
});
