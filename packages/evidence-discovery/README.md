# `@jinn-network/evidence-discovery`

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
