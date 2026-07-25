<!-- SPDX-License-Identifier: MIT -->
# Indexer API (`@jinn-network/evidence-discovery/indexer`)

Generic retrieval, Evidence Protocol validation, deterministic projection, and
ordered announcement replay for Jinn evidence records.

## Dependency-injected indexing

```ts
import {
  createEvidenceIndexer,
} from "@jinn-network/evidence-discovery/indexer";

const indexer = createEvidenceIndexer({
  repositories: {
    async resolve(repositoryId) {
      return configuredRepositories.get(repositoryId) ?? null;
    },
  },
  catalog,
});

await indexer.index({
  kind: "available",
  sourceId: "publication-journal",
  announcementId: "event-42",
  repositoryId: "local-evidence",
  reference,
});
```

An available event is resolved, retrieved by exact reference, independently
digest-checked, validated with the Evidence Protocol, projected, written, and
then observed as a location. Artifacts are never fetched. A withdrawal only
deactivates the exact source observation it retracts and never resolves a
repository.

## Terminal rejection and operational failure

Nonconforming immutable bytes produce a terminal `rejected` result and never
enter the Catalog. Missing repository configuration or bytes, access failure,
I/O failure, projection conflict, and cancellation throw. Repository and
Catalog errors retain their original instances and codes so deployments can
apply their own retry policy.

## At-least-once checkpoint ordering

`runEvidenceAnnouncementSource` reads from the stored opaque cursor, processes
events and callbacks sequentially, and checkpoints only after every event in a
batch reaches a terminal indexed, rejected, or withdrawn result. A crash before
the checkpoint replays already-written events safely through Catalog
idempotency.

Ponder can supply replayable marketplace announcements, but it is an adapter
above this library rather than the generic Indexer itself.

## Exclusions

This package contains no daemon loop, scheduler, retry/backoff policy, database,
filesystem or OCI binding, source adapter, marketplace policy, trust inference,
ranking, corpus membership, signature verification, or identity resolution.

## Development

Use Node 22 and Yarn 4.13.0:

```sh
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```
