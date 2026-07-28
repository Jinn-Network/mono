import type { AnnouncedItem, SourceCursor, SourceIdentity } from "./item.js";

// §8 frozen query-plane interfaces (design §8/§16.9, program §7.12). Owned
// by `protocol` -- not `client` -- so the M3 testing kit's
// `runQueryConformance(svc: DiscoveryQueryService)` can resolve the type
// before `client` exists (kit-before-implementation). `client` (M6) imports
// these and *implements* `DiscoveryQueryService`; it never redefines them.

export interface QueryCapabilities {
  kinds: string[]; // record-kind URIs served
  sources: SourceIdentity[]; // sources followed
  freshness: Array<{ source: SourceIdentity; position: SourceCursor }>;
}

export interface FactsFilter {
  [field: string]: unknown;
}

export interface PageRequest {
  limit?: number;
  cursor?: string; // opaque; deterministic digest tie-break (§8)
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
  complete: boolean; // §8 rule 2: empty is not truncated
  freshness: Array<{ source: SourceIdentity; position: SourceCursor }>;
}

/**
 * A pure cache/aggregator over announce chains it follows (§8). Every
 * `AnnouncedItem` it returns MUST carry provenance (§8 rule 1) -- it never
 * originates. `referrers` is the reverse-lookup operation (OCI-referrers-
 * shaped); `search` is the profiles design's operator task filters
 * generalized to a query.
 */
export interface DiscoveryQueryService {
  capabilities(): Promise<QueryCapabilities>;
  getRecord(digest: `sha256:${string}`): Promise<Uint8Array>;
  referrers(
    subject: `sha256:${string}`,
    filter?: { kind?: string },
    page?: PageRequest,
  ): Promise<Page<AnnouncedItem>>;
  search(kind: string, facts: FactsFilter, page?: PageRequest): Promise<Page<AnnouncedItem>>;
}
