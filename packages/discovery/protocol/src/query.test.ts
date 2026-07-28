import { describe, expect, it } from "vitest";

import { RECORD_KINDS } from "./identifiers.js";
import type { AnnouncedItem } from "./item.js";
import type {
  DiscoveryQueryService,
  Page,
  QueryCapabilities,
} from "./query.js";

// §8 frozen query-plane interfaces (design §8/§16.9, program §7.12): owned
// here so the M3 testing kit's `runQueryConformance(svc: DiscoveryQueryService)`
// can resolve the type before `client` implements it.

const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const entryDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

function item(): AnnouncedItem {
  return {
    record: { kind: RECORD_KINDS.submission, digest },
    provenance: {
      source: { agent: "did:key:zSourceAgent", name: "feed" },
      entry: entryDigest,
      announcementId: "ann-1",
    },
  };
}

describe("the §8 query-plane shapes", () => {
  it("a hand-built QueryCapabilities object type-checks against the frozen shape", () => {
    const capabilities: QueryCapabilities = {
      kinds: [RECORD_KINDS.submission],
      sources: [{ agent: "did:key:zSourceAgent", name: "feed" }],
      freshness: [
        { source: { agent: "did:key:zSourceAgent", name: "feed" }, position: { sequence: "0000000000000001", entry: entryDigest } },
      ],
    };
    expect(capabilities.kinds).toEqual([RECORD_KINDS.submission]);
  });

  it("a hand-built Page<AnnouncedItem> distinguishes complete from truncated and carries per-source freshness", () => {
    const complete: Page<AnnouncedItem> = {
      items: [item()],
      complete: true,
      freshness: [{ source: { agent: "did:key:zSourceAgent", name: "feed" }, position: { sequence: "0000000000000001", entry: entryDigest } }],
    };
    const truncated: Page<AnnouncedItem> = {
      items: [item()],
      nextCursor: "opaque-cursor",
      complete: false,
      freshness: [],
    };
    expect(complete.complete).toBe(true);
    expect(complete.nextCursor).toBeUndefined();
    expect(truncated.complete).toBe(false);
    expect(truncated.nextCursor).toBe("opaque-cursor");
  });

  it("DiscoveryQueryService is implementable by a hand-built fake honoring every §8 rule shape", async () => {
    const fake: DiscoveryQueryService = {
      async capabilities() {
        return { kinds: [RECORD_KINDS.submission], sources: [], freshness: [] };
      },
      async getRecord() {
        return new Uint8Array([1, 2, 3]);
      },
      async referrers() {
        return { items: [], complete: true, freshness: [] };
      },
      async search() {
        return { items: [item()], complete: true, freshness: [] };
      },
    };
    await expect(fake.capabilities()).resolves.toEqual({ kinds: [RECORD_KINDS.submission], sources: [], freshness: [] });
    await expect(fake.getRecord(digest)).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(fake.referrers(digest)).resolves.toEqual({ items: [], complete: true, freshness: [] });
    const searched = await fake.search(RECORD_KINDS.submission, { requesterIri: "did:key:zRequester" });
    expect(searched.items).toEqual([item()]);
  });
});
