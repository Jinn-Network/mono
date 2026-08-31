// SPDX-License-Identifier: MIT

// The index-side demonstration the offer facts profile exists for, run against this runtime:
// a priced catalog rendered from announcement cards alone, fetching not one offer.
//
// A listing is two announcements on the holder's own append-only chain -- the subject record
// announced as available, and its offer announced beside it -- so this walks the real chain
// this runtime publishes. The evidence record goes in through `repository.putRecord` and is
// announced by the real evidence-journal bridge; the offers are appended to that same source
// through the same real `DurableSourceWriter`, each carrying the card its holder recomputed
// from its own sealed bytes. Then an index reads the published archive pages back out of the
// blob store and answers "offers for subject X, live, cheapest first" from what it found
// there.
//
// Offer bytes arrive through `@jinn-network/record-discovery-facts-offers` and its shipped
// fixture catalog. That is the only route available and the right one: the offer record kind
// sits behind an architecture boundary this package may not cross, and that leaf is the one
// sanctioned edge across it.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DISCOVERY_SIGNING_SCOPE,
  archivePagePath,
  recordDigest,
  recordPath,
  sealJson,
  type AnnouncedItem,
  type AnnouncementEntry,
  type SourceIdentity,
} from "@jinn-network/record-discovery-protocol";
import {
  OFFER_RECORD_KIND,
  listOffersForSubject,
  offerRecompute,
} from "@jinn-network/record-discovery-facts-offers";
import type {
  DurableSourceSigner,
  DurableSourceWriter,
  ReadableImmutableBlobStore,
  StoredBlob,
} from "@jinn-network/record-discovery-serve";
import {
  createEvidenceJournalDurableBridge,
  type EvidenceJournalBridgeState,
} from "@jinn-network/record-discovery-source-evidence-journal";
import { afterEach, describe, expect, it } from "vitest";

import type { EvidenceJournalPublicDiscoveryBridgeFactory } from "./public-discovery.js";
import { openLocalEvidenceRuntime } from "./runtime.js";

const SOURCE: SourceIdentity = {
  agent: "did:key:zEvidenceLocalRuntimeOfferCatalog",
  name: "evidence-journal",
};

const SUBJECT = `sha256:${"a".repeat(64)}`;
const USDC = "https://spec.jinn.network/rails/eip155-8453-erc20-usdc/v1";
const ENTRIES_PREFIX = `/sources/${SOURCE.name}/entries/`;

/** The catalog fixtures: free, priced (USDC 1500000), and a reprice at USDC 900000. */
const CATALOG = ["free", "priced", "superseding"] as const;
type CatalogName = (typeof CATALOG)[number];

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "jinn-evidence-offer-listings-"));
  roots.push(path);
  return path;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Records which paths were read, so "answered from cards alone" is asserted, not asserted-ish. */
class RecordingBlobs implements ReadableImmutableBlobStore {
  readonly values = new Map<string, StoredBlob>();
  readonly reads: string[] = [];

  async get(path: string): Promise<StoredBlob | undefined> {
    this.reads.push(path);
    const value = this.values.get(path);
    return value === undefined
      ? undefined
      : { bytes: value.bytes.slice(), contentType: value.contentType };
  }

  async put(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.values.set(path, { bytes: bytes.slice(), contentType });
  }

  async putImmutable(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const existing = this.values.get(path);
    if (
      existing !== undefined
      && (!equalBytes(existing.bytes, bytes) || existing.contentType !== contentType)
    ) throw new Error(`immutable blob conflict at ${path}`);
    if (existing === undefined) this.values.set(path, { bytes: bytes.slice(), contentType });
  }
}

const SIGNER: DurableSourceSigner = {
  keyId: "evidence-local-runtime-offer-catalog-key",
  scope: DISCOVERY_SIGNING_SCOPE,
  async sign(pae) { return [{ keyid: this.keyId, sig: pae.slice() }]; },
  verify(pae, signature) { return equalBytes(pae, signature); },
};

async function goldenEvidence(): Promise<Uint8Array> {
  return readFile(new URL(
    "../../protocol/fixtures/golden-execution-evidence-v1/execution/ro-crate-metadata.json",
    import.meta.url,
  ));
}

async function offerEnvelope(name: CatalogName): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(import.meta.resolve(
    `@jinn-network/record-discovery-facts-offers/fixtures/catalog/${name}.json`,
  ))));
}

const noReferencedBytes = { async fetch() { return undefined; } };

/**
 * Announces the catalog on the holder's own chain, then withdraws the offer its reprice
 * supersedes -- both ordinary announcements, which is the whole withdrawal mechanism.
 */
async function announceCatalog(
  writer: DurableSourceWriter,
  now: () => Date,
): Promise<Map<CatalogName, string>> {
  const digests = new Map<CatalogName, string>();
  for (const name of CATALOG) {
    const bytes = await offerEnvelope(name);
    await writer.append({
      announcement: {
        announcementId: `offer-${name}`,
        action: "available",
        record: {
          kind: OFFER_RECORD_KIND,
          digest: recordDigest(bytes),
          mediaType: "application/json",
        },
        facts: await offerRecompute(bytes, noReferencedBytes),
      },
      timestamp: now().toISOString(),
      record: { bytes, contentType: "application/json" },
    });
    digests.set(name, recordDigest(bytes));
  }
  await writer.append({
    announcement: {
      announcementId: "offer-priced-withdrawal",
      action: "withdrawn",
      retracts: "offer-priced",
      reason: "superseded",
    },
    timestamp: now().toISOString(),
  });
  return digests;
}

interface ReadFeed {
  readonly items: AnnouncedItem[];
  readonly withdrawnRecordDigests: Set<string>;
}

/**
 * What an index does: walk the source's published archive pages and fold them into announced
 * items, plus the set of record digests the chain has withdrawn. Withdrawals name an
 * announcement, so the digest they retract is resolved through the available announcement
 * that minted it -- never through a card's own claim about itself.
 */
async function readPublishedFeed(blobs: RecordingBlobs): Promise<ReadFeed> {
  const pages = [...blobs.values.keys()].filter((path) => path.startsWith(ENTRIES_PREFIX)).sort();
  const items: AnnouncedItem[] = [];
  const digestByAnnouncementId = new Map<string, string>();
  const retracted: string[] = [];
  for (const path of pages) {
    const blob = await blobs.get(path);
    const page = JSON.parse(new TextDecoder().decode(blob!.bytes)) as {
      entries: { entry: AnnouncementEntry }[];
    };
    for (const { entry } of page.entries) {
      const entryDigest = recordDigest(sealJson(entry).bytes);
      for (const announcement of entry.announcements) {
        if (announcement.action === "withdrawn") {
          retracted.push(announcement.retracts);
          continue;
        }
        digestByAnnouncementId.set(announcement.announcementId, announcement.record.digest);
        items.push({
          record: announcement.record,
          ...(announcement.facts === undefined ? {} : { facts: announcement.facts }),
          provenance: {
            source: entry.source,
            entry: entryDigest,
            announcementId: announcement.announcementId,
          },
        });
      }
    }
  }
  const withdrawnRecordDigests = new Set(
    retracted.flatMap((id) => {
      const digest = digestByAnnouncementId.get(id);
      return digest === undefined ? [] : [digest];
    }),
  );
  return { items, withdrawnRecordDigests };
}

describe("a card-only offer catalog over the local runtime's published chain", () => {
  it("answers 'offers for subject X, live, cheapest first' without fetching one offer", async () => {
    const blobs = new RecordingBlobs();
    let clockMs = Date.parse("2026-08-31T12:00:00.000Z");
    const now = () => new Date((clockMs += 1_000));
    let announced: Promise<Map<CatalogName, string>> | undefined;

    const bridgeFactory: EvidenceJournalPublicDiscoveryBridgeFactory = (context) => {
      const journal = createEvidenceJournalDurableBridge({
        source: context.source,
        evidenceSourceId: context.evidenceSourceId,
        journal: context.journal,
        withdrawals: context.withdrawals,
        records: context.records,
        writer: context.writer,
        writerIntents: context.writerIntents,
        states: context.openBridgeStateStore<EvidenceJournalBridgeState>(),
        strategies: context.strategies,
        now: context.now,
      });
      return {
        async sync() {
          const state = await journal.sync();
          // The offers ride the holder's own chain, beside the subject the journal announced.
          announced ??= announceCatalog(context.writer, context.now);
          await announced;
          return state;
        },
        readState: () => journal.readState(),
      };
    };

    const runtime = await openLocalEvidenceRuntime({
      rootDir: await root(),
      publicDiscovery: { source: SOURCE, signer: SIGNER, blobs, bridgeFactory, now },
    });
    try {
      await runtime.repository.putRecord("execution-evidence", await goldenEvidence());
      await runtime.sync();
    } finally {
      await runtime.close();
    }

    const digests = await announced!;
    // Every offer record IS published and retrievable -- the index below declines to fetch
    // one, it is not merely unable to.
    for (const name of CATALOG) {
      expect(blobs.values.has(recordPath(digests.get(name)! as `sha256:${string}`))).toBe(true);
    }
    // Everything from here on is the index's side of the wall. The holder's own publishing
    // reads records, of course; the index that reads its feed must not.
    const publishedReads = blobs.reads.length;

    const feed = await readPublishedFeed(blobs);
    expect(feed.withdrawnRecordDigests).toEqual(new Set([digests.get("priced")]));

    const readsBefore = blobs.reads.length;
    const catalog = listOffersForSubject(feed.items, {
      subject: SUBJECT,
      rail: USDC,
      withdrawnOfferDigests: feed.withdrawnRecordDigests,
    });

    // Free sorts ahead of every priced offer; the withdrawn USDC 1500000 offer is gone; the
    // live reprice at USDC 900000 follows.
    expect(catalog.map((card) => card.offerRecordDigest)).toEqual([
      digests.get("free"),
      digests.get("superseding"),
    ]);
    expect(catalog.map((card) => card.rails)).toEqual([[], [{ rail: USDC, amount: "900000" }]]);
    expect(catalog.every((card) => card.subject === SUBJECT)).toBe(true);
    // The query itself reads nothing at all, and the whole index side read no record: only
    // the source's archive pages.
    expect(blobs.reads.length).toBe(readsBefore);
    expect(blobs.reads.slice(publishedReads).every((path) => path.startsWith(ENTRIES_PREFIX)))
      .toBe(true);

    // And the feed the index walked really is the mixed one this runtime publishes: the
    // evidence record's own announcement is in it, and the catalog ignored it.
    expect(feed.items.filter((item) => item.record.kind !== OFFER_RECORD_KIND)).toHaveLength(1);
  });
});
