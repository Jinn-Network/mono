import type {
  AnnouncedItem,
  DiscoveryQueryService,
  FactsFilter,
  Page,
  PageRequest,
  QueryCapabilities,
} from "@jinn-network/record-discovery-protocol";
import { recordDigest, recordPath } from "@jinn-network/record-discovery-protocol";

import type { Transport } from "./ports.js";

// The §8 query client. `DiscoveryQueryService` (capabilities/getRecord/
// referrers/search) is owned by `record-discovery-protocol` (program
// §7.12); `DiscoveryQueryClient` here IMPLEMENTS it as a thin remote
// client -- an HTTP proxy to whatever remote service conforms to the same
// interface. Building the aggregator/cache SERVICE itself (indexing many
// followed chains) is out of this plan's scope (design §8/§20 stage 4,
// plan Out-of-scope); this class only talks to one.
//
// §8's three normative rules are enforced HERE, client-side, because a
// remote query service is untrusted by construction:
//   1. Items verifiable, sets are claims -- an item missing `provenance`
//      is dropped, never surfaced (a query service that originates is
//      caught here; §10.4 step 3, wired through the verification driver,
//      catches a service that FABRICATES provenance for an item it never
//      actually synced).
//   2. Empty is not truncated -- `complete`/`nextCursor`/`freshness` are
//      passed through exactly as reported, never inferred or overwritten.
//   3. No ranking -- items are never locally reordered.

export interface QueryClientDeps {
  transport: Transport;
  /** The remote query service's base URL. */
  baseUrl: string;
}

function hasProvenance(item: AnnouncedItem): boolean {
  const provenance = (item as { provenance?: unknown }).provenance;
  return (
    typeof provenance === "object" &&
    provenance !== null &&
    typeof (provenance as Record<string, unknown>)["source"] === "object" &&
    typeof (provenance as Record<string, unknown>)["entry"] === "string" &&
    typeof (provenance as Record<string, unknown>)["announcementId"] === "string"
  );
}

function dropUnprovenancedItems(page: Page<AnnouncedItem>): Page<AnnouncedItem> {
  return { ...page, items: page.items.filter(hasProvenance) };
}

function pageQueryString(page?: PageRequest): string {
  if (page === undefined) return "";
  const params = new URLSearchParams();
  if (page.limit !== undefined) params.set("limit", String(page.limit));
  if (page.cursor !== undefined) params.set("cursor", page.cursor);
  const query = params.toString();
  return query.length > 0 ? `&${query}` : "";
}

export class DiscoveryQueryClient implements DiscoveryQueryService {
  constructor(private readonly deps: QueryClientDeps) {}

  async capabilities(): Promise<QueryCapabilities> {
    const response = await this.deps.transport.fetch(`${this.deps.baseUrl}/capabilities`);
    return JSON.parse(new TextDecoder().decode(response.bytes)) as QueryCapabilities;
  }

  async getRecord(digest: `sha256:${string}`): Promise<Uint8Array> {
    const response = await this.deps.transport.fetch(`${this.deps.baseUrl}${recordPath(digest)}`);
    if (recordDigest(response.bytes) !== digest) {
      throw new Error(`content-corruption: fetched bytes for ${digest} do not re-hash to the requested digest.`);
    }
    return response.bytes;
  }

  async referrers(
    subject: `sha256:${string}`,
    filter?: { kind?: string },
    page?: PageRequest,
  ): Promise<Page<AnnouncedItem>> {
    const kindParam = filter?.kind !== undefined ? `&kind=${encodeURIComponent(filter.kind)}` : "";
    const url = `${this.deps.baseUrl}/referrers?subject=${encodeURIComponent(subject)}${kindParam}${pageQueryString(page)}`;
    const response = await this.deps.transport.fetch(url);
    const raw = JSON.parse(new TextDecoder().decode(response.bytes)) as Page<AnnouncedItem>;
    return dropUnprovenancedItems(raw);
  }

  async search(kind: string, facts: FactsFilter, page?: PageRequest): Promise<Page<AnnouncedItem>> {
    const factsParam = Object.keys(facts).length > 0 ? `&facts=${encodeURIComponent(JSON.stringify(facts))}` : "";
    const url = `${this.deps.baseUrl}/search?kind=${encodeURIComponent(kind)}${factsParam}${pageQueryString(page)}`;
    const response = await this.deps.transport.fetch(url);
    const raw = JSON.parse(new TextDecoder().decode(response.bytes)) as Page<AnnouncedItem>;
    return dropUnprovenancedItems(raw);
  }
}
