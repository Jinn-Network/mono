# `@jinn-network/evidence-discovery`

This is permanent **local evidence catalog and publication-outbox infrastructure**. It is not a
public network discovery plane. Record Discovery is the sole public plane: external consumers use
`@jinn-network/record-discovery-client` and retrieve the exact locations carried by verified
Announcement Entries. The npm name stays unchanged in Phase C for compatibility.

`@jinn-network/evidence-discovery` combines the discovery-layer APIs that
operate over validated Evidence Protocol records.

- The package root exports backend-neutral Catalog contracts and the in-memory
  implementation.
- `@jinn-network/evidence-discovery/testing` exports Catalog contract fixtures.
- `@jinn-network/evidence-discovery/indexer` exports the generic record
  validation and projection worker.
- `@jinn-network/evidence-discovery/journal` exports the concrete local
  filesystem announcement journal.

The root and Indexer are storage-neutral. The Journal is intentionally a
separate concrete binding and is never re-exported by the package root.

The source material retained from the three predecessor packages is available
under [`docs/`](./docs) and [`specifications/`](./specifications).
