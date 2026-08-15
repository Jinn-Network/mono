// RecordRef/AnnouncedItem shapes (design §8, §16.9). RecordRef and
// PublishedLocation are shared with the Announcement Entry's per-item shape
// (entry.ts imports them from here); AnnouncedItem is the query/subscribe
// plane's per-item shape, always carrying mandatory provenance (§8 rule 1).

/** A reference to a sealed record by kind and content digest (§5.1, §8). */
export interface RecordRef {
  kind: string;
  digest: `sha256:${string}`;
  mediaType?: string;
}

/** A binding-owned, portable location for fetching a record's bytes (§5.1, §7). */
export interface PublishedLocation {
  profile: string;
  locator: string;
}

/** The `(agent IRI, source name)` tuple that identifies a source (§5.1). */
export interface SourceIdentity {
  agent: string;
  name: string;
}

/** A source position cursor: the generalization of the evidence journal's cursor (§5.3 rule 4). */
export type SourceCursor = {
  sequence: string;
  entry: `sha256:${string}`;
};

/**
 * A query/subscribe-plane item: a record reference plus its announced facts
 * card and mandatory provenance -- the source, the entry that carried the
 * announcement, and the announcement ID (§8 rule 1). `derivation` carries a
 * projection source's derivation annotation (§6.2), absent for author
 * sources.
 */
export interface AnnouncedItem {
  record: RecordRef;
  facts?: unknown;
  locations?: PublishedLocation[];
  provenance: {
    source: SourceIdentity;
    entry: `sha256:${string}`;
    announcementId: string;
    derivation?: unknown;
  };
}
