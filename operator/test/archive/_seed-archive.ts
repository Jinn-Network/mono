/**
 * Produces a servable record-discovery archive on disk through `serve`'s own writers — the
 * same writers the native solution publisher uses — plus a live SSE tail, and returns the
 * `ArchiveHttpHandler` over it. Shared by the archive listener test, the serving-plane
 * conformance driver, and the second-daemon consumption gate so those entry points cannot
 * drift in how the fixture is produced (cutover stage 4 / one-swap M6, contract 12: legacy
 * behaviour enters as fixtures, never ported code).
 */
import {
  GENESIS_SEQUENCE,
  MEDIA_ENTRY,
  RECORD_DISCOVERY_VERSION,
  archivePagePath,
  dssePreAuthEncoding,
  formatOrigin,
  formatSequence,
  headPath,
  recordDigest,
  sealJson,
  sha256Hex,
  toAnnouncementEvent,
  type AnnouncedItem,
  type AnnouncementEntry,
  type SourceHead,
} from '@jinn-network/record-discovery-protocol';
import {
  maintainHead,
  writeArchivePages,
  writeRecord,
  writeWellKnownDocument,
  type DsseSigner,
  type SignedEntry,
} from '@jinn-network/record-discovery-serve';
import {
  createArchiveHttpHandler,
  createFsBlobStore,
  createInMemoryTailSource,
  type ArchiveHttpHandler,
  type ReadWriteBlobStore,
  type TailPublisher,
} from '@jinn-network/record-discovery-transport-http';
import type { SourceEndpoint } from '@jinn-network/record-discovery-client';

const KEYID = 'seed-key';

/** A deterministic fake DSSE signer, sufficient for the wire profile the suites exercise. */
const signer: DsseSigner = {
  async sign(pae: Uint8Array) {
    return [{ keyid: KEYID, sig: new TextEncoder().encode(`${sha256Hex(pae)}:${KEYID}`) }];
  },
};

export interface SeededArchive {
  readonly rootDir: string;
  readonly agent: string;
  readonly sourceName: string;
  readonly store: ReadWriteBlobStore;
  readonly tail: TailPublisher;
  readonly handler: ArchiveHttpHandler;
  /** The full accumulated entry list, so an append can repaginate the whole corpus. */
  readonly entries: SignedEntry[];
  /** Ordered page identifiers (oldest first); mutated in place on repagination. */
  readonly pages: string[];
  newestPage(): string;
  endpoint(servingRoot: string): SourceEndpoint;
}

async function signEntry(entry: AnnouncementEntry): Promise<SignedEntry> {
  const { bytes } = sealJson(entry);
  const signatures = await signer.sign(dssePreAuthEncoding(MEDIA_ENTRY, bytes));
  return {
    entry,
    signature: {
      payloadType: MEDIA_ENTRY,
      payload: Buffer.from(bytes).toString('base64'),
      signatures: signatures.map((s) => ({
        keyid: s.keyid!,
        sig: Buffer.from(s.sig).toString('base64'),
      })),
    },
  };
}

function entryAt(
  agent: string,
  sourceName: string,
  sequence: bigint,
  previous: `sha256:${string}` | null,
  recordDigestHex: `sha256:${string}`,
): AnnouncementEntry {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    source: { agent, name: sourceName },
    sequence: formatSequence(sequence),
    previous,
    timestamp: '2026-08-05T12:00:00Z',
    announcements: [
      {
        announcementId: `announcement-${sequence}`,
        action: 'available',
        record: { kind: 'https://spec.jinn.network/records/submission/v1', digest: recordDigestHex },
      },
    ],
  } as AnnouncementEntry;
}

async function rewriteHead(seeded: SeededArchive): Promise<void> {
  const newest = seeded.entries.at(-1)!;
  const head: SourceHead = {
    protocol: RECORD_DISCOVERY_VERSION,
    origin: formatOrigin(seeded.agent, seeded.sourceName),
    sequence: newest.entry.sequence,
    entry: sealJson(seeded.entries[0]!.entry).digest,
    issuedAt: '2026-08-05T11:59:00.000Z',
    refreshBy: '2026-08-05T23:59:00.000Z',
  } as SourceHead;
  await maintainHead(
    seeded.store,
    signer,
    { now: () => new Date('2026-08-05T12:00:00Z') },
    { agent: seeded.agent, name: seeded.sourceName },
    head,
  );
}

async function rewriteWellKnown(seeded: SeededArchive): Promise<void> {
  await writeWellKnownDocument(seeded.store, {
    protocol: RECORD_DISCOVERY_VERSION,
    sources: [
      {
        agent: seeded.agent,
        name: seeded.sourceName,
        headPath: headPath(seeded.sourceName),
        archiveRoot: archivePagePath(seeded.sourceName, seeded.newestPage()),
      },
    ],
  });
}

function relayTail(seeded: SeededArchive, signed: SignedEntry): void {
  const announcement = signed.entry.announcements[0]!;
  if (announcement.action !== 'available') return;
  const item: AnnouncedItem = {
    record: announcement.record,
    provenance: {
      source: { agent: seeded.agent, name: seeded.sourceName },
      entry: sealJson(signed.entry).digest,
      announcementId: announcement.announcementId,
    },
  };
  seeded.tail.publish('announcement', JSON.stringify(toAnnouncementEvent(item, undefined)));
}

/**
 * Seeds `count` records (default 3) and returns the servable archive. `replayWindow` bounds
 * the SSE relay so the second-daemon gate can drive the cursor-too-old path.
 */
export async function seedArchiveFixture(opts: {
  rootDir: string;
  agent?: string;
  sourceName?: string;
  count?: number;
  replayWindow?: number;
}): Promise<SeededArchive> {
  const agent = opts.agent ?? 'did:web:operator.test';
  const sourceName = opts.sourceName ?? 'marketplace';
  const store = createFsBlobStore(opts.rootDir);
  const tail = createInMemoryTailSource(opts.replayWindow ?? 256);
  const pages: string[] = [];
  const entries: SignedEntry[] = [];
  const seeded: SeededArchive = {
    rootDir: opts.rootDir,
    agent,
    sourceName,
    store,
    tail,
    handler: createArchiveHttpHandler({ reader: store, tail: tail.source }),
    entries,
    pages,
    newestPage: () => pages.at(-1) ?? GENESIS_SEQUENCE,
    endpoint: (servingRoot) => ({
      agent,
      name: sourceName,
      servingRoot,
      archiveRootUrl: `${servingRoot}${archivePagePath(sourceName, seeded.newestPage())}`,
    }),
  };

  const count = opts.count ?? 3;
  let previous: `sha256:${string}` | null = null;
  for (let i = 0; i < count; i += 1) {
    const payload = new TextEncoder().encode(JSON.stringify({ n: i + 1 }));
    const { digest } = await writeRecord(store, payload, 'application/json');
    const entry = entryAt(agent, sourceName, BigInt(i + 1), previous, digest);
    const signed = await signEntry(entry);
    entries.push(signed);
    previous = sealJson(entry).digest;
  }
  const seededPages = await writeArchivePages(store, sourceName, entries);
  pages.splice(0, pages.length, ...seededPages.pages);
  await rewriteHead(seeded);
  await rewriteWellKnown(seeded);
  for (const signed of entries) relayTail(seeded, signed);
  return seeded;
}

/**
 * Writes one more record and repaginates the WHOLE corpus (`writeArchivePages` is a
 * whole-corpus repaginator, not an append primitive), re-signs the head, and relays the new
 * announcement to live tail subscribers.
 */
export async function appendOneRecord(seeded: SeededArchive, payloadJson: string): Promise<`sha256:${string}`> {
  const payload = new TextEncoder().encode(payloadJson);
  const { digest } = await writeRecord(seeded.store, payload, 'application/json');
  const previous = sealJson(seeded.entries.at(-1)!.entry).digest;
  const entry = entryAt(
    seeded.agent,
    seeded.sourceName,
    BigInt(seeded.entries.length + 1),
    previous,
    digest,
  );
  const signed = await signEntry(entry);
  seeded.entries.push(signed);
  const repaginated = await writeArchivePages(seeded.store, seeded.sourceName, seeded.entries);
  seeded.pages.splice(0, seeded.pages.length, ...repaginated.pages);
  await rewriteHead(seeded);
  await rewriteWellKnown(seeded);
  relayTail(seeded, signed);
  return digest;
}

export { recordDigest };
