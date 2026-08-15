import { mkdtemp, rm } from "node:fs/promises";
import { generateKeyPairSync, sign as signBytes, verify as verifyBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GENESIS_SEQUENCE,
  MEDIA_ENTRY,
  RECORD_DISCOVERY_VERSION,
  archivePagePath,
  dssePreAuthEncoding,
  formatOrigin,
  formatSequence,
  headPath,
  sealJson,
  sha256Hex,
  verifySourceChain,
} from "@jinn-network/record-discovery-protocol";
import type { AnnouncementEntry, SourceHead } from "@jinn-network/record-discovery-protocol";
import type { DsseSigner, SignedEntry } from "@jinn-network/record-discovery-serve";
import {
  maintainHead,
  signHead,
  writeArchivePages,
  writeRecord,
  writeWellKnownDocument,
} from "@jinn-network/record-discovery-serve";
import type { SourceEndpoint } from "@jinn-network/record-discovery-client";
import {
  coldSync,
  decodeWireEnvelopeForVerification,
  fetchHead,
  returningSync,
  subscribe,
} from "@jinn-network/record-discovery-client";

import type { FetchLike } from "./ports.js";
import { createFsBlobStore } from "./fs-blob-store.js";
import { createArchiveHttpHandler } from "./handler.js";
import { createHttpTransport } from "./fetch-transport.js";
import { createSseStreamTransport, SseTerminalError } from "./sse-transport.js";
import { createInMemoryTailSource } from "./tail.js";
import { withReplayWindowAdvertisements } from "./advertise.js";

const AGENT = "did:key:zLoopbackAgent";
const SOURCE = "feed";
const KEYID = "loopback-key";
const BASE = "https://archive.test";

const signer: DsseSigner = {
  async sign(pae: Uint8Array) {
    return [{ keyid: KEYID, sig: new TextEncoder().encode(`${sha256Hex(pae)}:${KEYID}`) }];
  },
};

function entryAt(sequence: bigint, previous: string | null): AnnouncementEntry {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    source: { agent: AGENT, name: SOURCE },
    sequence: formatSequence(sequence),
    previous,
    timestamp: "2026-07-30T12:00:00Z",
    announcements: [
      {
        announcementId: `announcement-${sequence}`,
        action: "available",
        record: { kind: "https://spec.jinn.network/records/submission/v1", digest: `sha256:${"c".repeat(64)}` },
      },
    ],
  } as AnnouncementEntry;
}

async function signEntry(entry: AnnouncementEntry): Promise<SignedEntry> {
  return signEntryWith(entry, signer);
}

async function signEntryWith(entry: AnnouncementEntry, entrySigner: DsseSigner): Promise<SignedEntry> {
  const { bytes } = sealJson(entry);
  const signatures = await entrySigner.sign(dssePreAuthEncoding(MEDIA_ENTRY, bytes));
  return {
    entry,
    signature: {
      payloadType: MEDIA_ENTRY,
      payload: Buffer.from(bytes).toString("base64"),
      signatures: signatures.map((signature) => ({
        keyid: signature.keyid!,
        sig: Buffer.from(signature.sig).toString("base64"),
      })),
    },
  };
}

function waitFor(predicate: () => boolean, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const tick = () => {
      if (predicate()) { resolve(); return; }
      if (Date.now() > deadline) { reject(new Error(`timed out waiting for ${label}`)); return; }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("loopback: serve writes the layout, the handler serves it, the client reads it back", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "jinn-transport-http-loopback-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips an archive end to end and honors every §7.3 clause", async () => {
    const store = createFsBlobStore(root);
    const tail = createInMemoryTailSource(2);

    // --- producer side: serve's own writers, unmodified -------------
    const entries: SignedEntry[] = [
      await signEntry(entryAt(1n, null)),
      await signEntry(entryAt(2n, sealJson(entryAt(1n, null)).digest)),
    ];
    const { pages } = await writeArchivePages(store, SOURCE, entries);
    for (const signed of entries) await writeRecord(store, sealJson(signed.entry).bytes, MEDIA_ENTRY);

    const newestPage = pages[pages.length - 1]!;
    const genesisHead: SourceHead = {
      protocol: RECORD_DISCOVERY_VERSION,
      origin: formatOrigin(AGENT, SOURCE),
      sequence: GENESIS_SEQUENCE,
      entry: sealJson(entries[0]!.entry).digest,
      issuedAt: "2026-07-30T11:59:00.000Z",
      refreshBy: "2026-07-30T23:59:00.000Z",
    } as SourceHead;
    await maintainHead(store, signer, { now: () => new Date("2026-07-30T12:00:00Z") }, { agent: AGENT, name: SOURCE }, genesisHead);
    await writeWellKnownDocument(store, withReplayWindowAdvertisements(
      {
        protocol: RECORD_DISCOVERY_VERSION,
        sources: [{
          agent: AGENT,
          name: SOURCE,
          headPath: headPath(SOURCE),
          archiveRoot: archivePagePath(SOURCE, newestPage),
        }],
      },
      { [SOURCE]: tail.source.window() },
    ));

    // --- transport: the handler over one in-process fetch -----------
    const handler = createArchiveHttpHandler({
      reader: store,
      tail: tail.source,
      isSealedPage: (_source, page) => page !== newestPage,
    });
    const fetchLike: FetchLike = async (url, init) => handler(new Request(url, {
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      ...(init?.signal === undefined ? {} : { signal: init.signal }),
    }));

    const transport = createHttpTransport(BASE, fetchLike);
    const endpoint: SourceEndpoint = {
      agent: AGENT,
      name: SOURCE,
      servingRoot: BASE,
      archiveRootUrl: `${BASE}${archivePagePath(SOURCE, newestPage)}`,
    };

    // --- consumer side: client's own readers, unmodified ------------
    const head = await fetchHead(endpoint, transport);
    expect(head.head.origin).toBe(formatOrigin(AGENT, SOURCE));
    expect(head.signature).toBeDefined();

    const cold: string[] = [];
    for await (const synced of coldSync(endpoint, { transport })) cold.push(synced.entry.sequence);
    expect(cold).toEqual(["0000000000000001", "0000000000000002"]);

    const returning: string[] = [];
    for await (const synced of returningSync(endpoint, { sequence: "0000000000000001", entry: sealJson(entries[0]!.entry).digest }, { transport })) {
      returning.push(synced.entry.sequence);
    }
    expect(returning).toEqual(["0000000000000002"]);

    // The head is revalidated, not re-downloaded, on the second read.
    await fetchHead(endpoint, transport);
    expect(transport.stats().revalidations).toBeGreaterThanOrEqual(1);

    // --- subscribe, disconnect, resume ------------------------------
    const streamTransport = createSseStreamTransport(BASE, fetchLike, { reconnectDelayMs: 1 });
    const delivered: unknown[] = [];
    const first = subscribe({
      streamTransport,
      url: `${BASE}/sources/${SOURCE}/tail`,
      onAnnouncement: (event) => delivered.push(event),
      onObservation: (raw) => delivered.push(raw),
    });
    tail.publish("observation", JSON.stringify({ specversion: "1.0", type: "observation", id: "o1" }));
    await waitFor(() => delivered.length === 1, "the first delivered event");
    first.close();

    tail.publish("observation", JSON.stringify({ specversion: "1.0", type: "observation", id: "o2" }));

    const resumed: unknown[] = [];
    const second = subscribe({
      streamTransport,
      url: `${BASE}/sources/${SOURCE}/tail?cursor=0000000000000001`,
      onAnnouncement: (event) => resumed.push(event),
      onObservation: (raw) => resumed.push(raw),
    });
    await waitFor(() => resumed.length === 1, "the resumed event");
    second.close();
    expect((resumed[0] as { id: string }).id).toBe("o2");

    // --- cursor-too-old drives the cold-sync path -------------------
    tail.publish("observation", JSON.stringify({ id: "o3" }));
    tail.publish("observation", JSON.stringify({ id: "o4" }));

    const errors: unknown[] = [];
    const third = subscribe({
      streamTransport,
      url: `${BASE}/sources/${SOURCE}/tail?cursor=0000000000000001`,
      onAnnouncement: () => undefined,
      onObservation: () => undefined,
      onError: (error) => errors.push(error),
    });
    await waitFor(() => errors.length === 1, "the cursor-too-old terminal event");
    third.close();

    const terminal = errors[0] as SseTerminalError;
    expect(terminal.terminal).toBe("cursor-too-old");
    expect(terminal.coldSync?.head).toBe(headPath(SOURCE));

    // The named cold-sync path is fetchable and re-walks the chain.
    const recovered: string[] = [];
    for await (const synced of coldSync(endpoint, { transport })) recovered.push(synced.entry.sequence);
    expect(recovered).toEqual(["0000000000000001", "0000000000000002"]);
  });

  it("preserves non-ASCII Ed25519 signatures across serve, HTTP, client decoding, and source verification", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const observedSignatures: Uint8Array[] = [];
    const ed25519Signer: DsseSigner = {
      async sign(pae) {
        const signature = new Uint8Array(signBytes(null, pae, privateKey));
        observedSignatures.push(signature);
        return [{ keyid: KEYID, sig: signature }];
      },
    };
    const store = createFsBlobStore(root);
    const entry = await signEntryWith(entryAt(1n, null), ed25519Signer);
    const { pages } = await writeArchivePages(store, SOURCE, [entry]);
    const initialHead: SourceHead = {
      protocol: RECORD_DISCOVERY_VERSION,
      origin: formatOrigin(AGENT, SOURCE),
      sequence: "0000000000000001",
      entry: sealJson(entry.entry).digest,
      issuedAt: "2026-07-30T11:59:00.000Z",
      refreshBy: "2026-07-30T23:59:00.000Z",
    } as SourceHead;
    await maintainHead(
      store,
      ed25519Signer,
      { now: () => new Date("2026-07-30T12:00:00.000Z") },
      { agent: AGENT, name: SOURCE },
      initialHead,
    );

    const handler = createArchiveHttpHandler({ reader: store });
    const fetchLike: FetchLike = async (url, init) => handler(new Request(url, {
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      ...(init?.signal === undefined ? {} : { signal: init.signal }),
    }));
    const transport = createHttpTransport(BASE, fetchLike);
    const endpoint: SourceEndpoint = {
      agent: AGENT,
      name: SOURCE,
      servingRoot: BASE,
      archiveRootUrl: `${BASE}${archivePagePath(SOURCE, pages[0]!)}`,
    };
    const fetchedHead = await fetchHead(endpoint, transport);
    const fetchedEntries = [];
    for await (const fetchedEntry of coldSync(endpoint, { transport })) fetchedEntries.push(fetchedEntry);

    expect(fetchedHead.signature).toBeDefined();
    expect(fetchedEntries[0]?.signature).toBeDefined();
    expect(observedSignatures).toHaveLength(2);
    expect(observedSignatures.every((signature) => signature.some((byte) => byte > 0x7f))).toBe(true);
    const decodedHead = decodeWireEnvelopeForVerification(fetchedHead.signature);
    expect(decodedHead.signatures[0]?.signatureBytes).toEqual(observedSignatures[1]);

    const outcome = await verifySourceChain({
      head: fetchedHead.head,
      headSignature: fetchedHead.signature!,
      entries: (async function* () {
        for (const fetched of fetchedEntries) {
          yield { entry: fetched.entry, signature: fetched.signature! };
        }
      })(),
      ports: {
        keys: {
          async resolve() {
            return [{ keyid: KEYID, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(), algorithm: "ed25519" }];
          },
          async everBound(_agent, keyid) { return keyid === KEYID; },
        },
        sigs: {
          async verify(pae, signature) { return verifyBytes(null, pae, publicKey, signature); },
        },
        fresh: { isFresh: () => true },
        hwm: { async get() { return undefined; }, async put() {} },
        now: new Date("2026-07-30T12:00:01.000Z"),
        firstAdoption: true,
      },
    });
    expect(outcome.status).toBe("ok");
  });
});
