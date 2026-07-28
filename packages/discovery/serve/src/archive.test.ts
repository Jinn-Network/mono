import { describe, expect, it } from "vitest";
import type { AnnouncementEntry } from "@jinn-network/record-discovery-protocol";
import { archivePagePath, parseAnnouncementEntry, sealJson } from "@jinn-network/record-discovery-protocol";

import type { BlobStore } from "./ports.js";
import type { ArchivePage, SignedEntry } from "./archive.js";
import { writeArchivePages } from "./archive.js";

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

function readPage(
  store: ReturnType<typeof makeInMemoryStore>,
  sourceName: string,
  page: string,
): ArchivePage {
  const stored = store.get(archivePagePath(sourceName, page));
  if (stored === undefined) throw new Error(`no page stored at ${archivePagePath(sourceName, page)}`);
  return JSON.parse(new TextDecoder().decode(stored.bytes)) as ArchivePage;
}

function makeEntry(sequence: string, previous: `sha256:${string}` | null, padding = ""): AnnouncementEntry {
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
        ...(padding.length > 0 ? { facts: { padding } } : {}),
      },
    ],
  });
}

function makeSigned(sequence: string, previous: `sha256:${string}` | null, padding = ""): SignedEntry {
  const entry = makeEntry(sequence, previous, padding);
  return {
    entry,
    signature: {
      payloadType: "application/vnd.jinn.record-discovery.entry.v1+json",
      payload: new TextDecoder().decode(sealJson(entry).bytes),
      signatures: [{ keyid: "key-1", sig: "deadbeef" }],
    },
  };
}

describe("writeArchivePages (§7 item 2: RFC-5005-shaped archive pager)", () => {
  it("writes a single page when entries fit comfortably under the ceiling", async () => {
    const store = makeInMemoryStore();
    const entries = [makeSigned("0000000000000001", null), makeSigned("0000000000000002", `sha256:${"b".repeat(64)}`)];

    const { pages } = await writeArchivePages(store, "feed", entries);

    expect(pages).toHaveLength(1);
    const page = readPage(store, "feed", pages[0]!);
    expect(page.entries.map((e) => e.entry.sequence)).toEqual(["0000000000000001", "0000000000000002"]);
    expect(page.entries[0]!.signature).toBeDefined();
    expect(page.prevArchive).toBeNull();
  });

  it("orders entries by sequence using compareCodeUnitStrings even when fed out of order", async () => {
    const store = makeInMemoryStore();
    const entries = [makeSigned("0000000000000002", `sha256:${"b".repeat(64)}`), makeSigned("0000000000000001", null)];

    const { pages } = await writeArchivePages(store, "feed", entries);

    const page = readPage(store, "feed", pages[0]!);
    expect(page.entries.map((e) => e.entry.sequence)).toEqual(["0000000000000001", "0000000000000002"]);
  });

  it("accepts unpublished-profile entries with no signature (§5.5)", async () => {
    const store = makeInMemoryStore();
    const entries: SignedEntry[] = [{ entry: makeEntry("0000000000000001", null) }];

    const { pages } = await writeArchivePages(store, "feed", entries);

    const page = readPage(store, "feed", pages[0]!);
    expect(page.entries[0]!.signature).toBeUndefined();
  });

  it("splits into >= 2 pages once entries would exceed the (injectable) page-byte ceiling, each linking its predecessor", async () => {
    const store = makeInMemoryStore();
    const big = "x".repeat(400);
    const entries = [
      makeSigned("0000000000000001", null, big),
      makeSigned("0000000000000002", `sha256:${"b".repeat(64)}`, big),
      makeSigned("0000000000000003", `sha256:${"c".repeat(64)}`, big),
    ];

    // A small injected ceiling forces a split without megabytes of fixture data.
    const { pages } = await writeArchivePages(store, "feed", entries, 500);

    expect(pages.length).toBeGreaterThanOrEqual(2);

    const firstPage = readPage(store, "feed", pages[0]!);
    expect(firstPage.prevArchive).toBeNull();

    for (let index = 1; index < pages.length; index += 1) {
      const page = readPage(store, "feed", pages[index]!);
      expect(page.prevArchive).toBe(pages[index - 1]);
    }

    // Every entry is present exactly once, across all pages, in sequence order.
    const allSequences: string[] = [];
    for (const pageId of pages) {
      const page = readPage(store, "feed", pageId);
      allSequences.push(...page.entries.map((e) => e.entry.sequence));
    }
    expect(allSequences).toEqual(["0000000000000001", "0000000000000002", "0000000000000003"]);
  });

  it("writes page bodies as sealed I-JSON at the archive-page path", async () => {
    const store = makeInMemoryStore();
    const entries = [makeSigned("0000000000000001", null)];

    const { pages } = await writeArchivePages(store, "feed", entries);

    const path = archivePagePath("feed", pages[0]!);
    const stored = store.get(path);
    expect(stored).toBeDefined();
    const decoded = JSON.parse(new TextDecoder().decode(stored!.bytes));
    const resealed = sealJson(decoded);
    expect(resealed.bytes).toEqual(stored!.bytes);
  });
});
