import { describe, expect, it } from "vitest";
import { runQueryConformance } from "@jinn-network/record-discovery-testing";
import type { AnnouncedItem, Page, QueryCapabilities } from "@jinn-network/record-discovery-protocol";
import { recordDigest, sealJson } from "@jinn-network/record-discovery-protocol";

import type { Transport, TransportResponse } from "./ports.js";
import { DiscoveryQueryClient } from "./query.js";

function makeRoutedTransport(routes: Map<string, TransportResponse>): Transport {
  return {
    async "fetch"(url: string): Promise<TransportResponse> {
      const response = routes.get(url);
      if (response === undefined) throw new Error(`no route seeded for ${url}`);
      return response;
    },
  };
}

function jsonResponse(value: unknown): TransportResponse {
  return { status: 200, contentType: "application/json", bytes: sealJson(value).bytes };
}

const PROVENANCED_ITEM: AnnouncedItem = {
  record: { kind: "https://spec.jinn.network/records/submission/v1", digest: `sha256:${"a".repeat(64)}` },
  provenance: { source: { agent: "did:key:zAgentSourceOne", name: "feed" }, entry: `sha256:${"b".repeat(64)}`, announcementId: "ann-1" },
};

describe("DiscoveryQueryClient (§8: implements DiscoveryQueryService as a thin remote client)", () => {
  it("capabilities() fetches and parses the remote service's capabilities", async () => {
    const capabilities: QueryCapabilities = { kinds: ["https://spec.jinn.network/records/submission/v1"], sources: [], freshness: [] };
    const routes = new Map([["https://query.example.org/capabilities", jsonResponse(capabilities)]]);
    const client = new DiscoveryQueryClient({ transport: makeRoutedTransport(routes), baseUrl: "https://query.example.org" });

    expect(await client.capabilities()).toEqual(capabilities);
  });

  it("getRecord() re-hashes and rejects content that doesn't match the requested digest", async () => {
    const bytes = sealJson({ hello: "world" }).bytes;
    const digest = recordDigest(bytes);
    const wrongDigest = `sha256:${"f".repeat(64)}` as const;
    const routes = new Map([
      [`https://query.example.org/records/${digest.slice("sha256:".length)}`, { status: 200, bytes }],
      [`https://query.example.org/records/${wrongDigest.slice("sha256:".length)}`, { status: 200, bytes }],
    ]);
    const client = new DiscoveryQueryClient({ transport: makeRoutedTransport(routes), baseUrl: "https://query.example.org" });

    expect(await client.getRecord(digest)).toEqual(bytes);
    await expect(client.getRecord(wrongDigest)).rejects.toThrow(/content-corruption/);
  });

  it("referrers() drops items lacking provenance (§8 rule 1: a query service never originates)", async () => {
    const fabricated = { record: PROVENANCED_ITEM.record, facts: { fabricated: true } }; // no provenance field
    const page: Page<AnnouncedItem> = { items: [PROVENANCED_ITEM, fabricated as unknown as AnnouncedItem], complete: true, freshness: [] };
    const routes = new Map([["https://query.example.org/referrers?subject=sha256%3Aaaa", jsonResponse(page)]]);
    const client = new DiscoveryQueryClient({ transport: makeRoutedTransport(routes), baseUrl: "https://query.example.org" });

    const result = await client.referrers(`sha256:${"a".repeat(3)}` as `sha256:${string}`);

    expect(result.items).toEqual([PROVENANCED_ITEM]);
  });

  it("search() surfaces complete vs truncated honestly, without re-ranking (§8 rules 2, 3)", async () => {
    const truncated: Page<AnnouncedItem> = { items: [PROVENANCED_ITEM], nextCursor: "cursor-1", complete: false, freshness: [] };
    const routes = new Map([
      ["https://query.example.org/search?kind=https%3A%2F%2Fspec.jinn.network%2Frecords%2Fsubmission%2Fv1", jsonResponse(truncated)],
    ]);
    const client = new DiscoveryQueryClient({ transport: makeRoutedTransport(routes), baseUrl: "https://query.example.org" });

    const result = await client.search("https://spec.jinn.network/records/submission/v1", {});

    expect(result.complete).toBe(false);
    expect(result.nextCursor).toBe("cursor-1");
    expect(result.items).toEqual([PROVENANCED_ITEM]);
  });
});

// The kit's own runQueryConformance (M3) only pins the §18 query vectors'
// own well-formedness plus capabilities()'s shape against a concrete
// service; DiscoveryQueryClient satisfies both.
runQueryConformance(
  new DiscoveryQueryClient({
    transport: makeRoutedTransport(new Map([["https://query.example.org/capabilities", jsonResponse({ kinds: [], sources: [], freshness: [] })]])),
    baseUrl: "https://query.example.org",
  }),
);
