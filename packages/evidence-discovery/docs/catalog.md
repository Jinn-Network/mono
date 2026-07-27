<!-- SPDX-License-Identifier: MIT -->
# Catalog API (`@jinn-network/evidence-discovery`)

Backend-neutral contracts and an in-memory contract implementation for
record-scoped Jinn evidence discovery.

## Catalog is derived, not evidence

The Catalog stores deterministic projections of already validated records. It
does not store or return authoritative record or artifact bytes. Retrieve exact
bytes through an `EvidenceRepository` and validate them with the Evidence
Protocol before relying on them.

Records remain independently inspectable even when they declare the same
Execution or Agent IRI. A private record and its public derivative may therefore
share an Execution IRI while retaining different record digests and locations.

## Reader and Writer

```ts
import { InMemoryEvidenceCatalog } from "@jinn-network/evidence-discovery";

const catalog = new InMemoryEvidenceCatalog();
await catalog.putRecordProjection(projection);
await catalog.observeRecordLocation(projection.reference, {
  sourceId: "local-publication-journal",
  announcementId: "event-42",
  repositoryId: "local-evidence",
});

const page = await catalog.findExecutions({
  taskDigest: projection.task.digest,
  limit: 20,
});
```

Only an Indexer should receive the Writer port. Applications should consume the
Reader port and repository contracts.

## Active and known-unavailable records

Typed collection queries return only projections supported by an active
location observation by default. Use `availability: "any"` to include known
records whose locations were withdrawn. Exact `getRecord` lookup may return a
known projection without an active location.

Withdrawals are source-scoped. One source cannot retract another source's
observation, and a location stays active while any observation supports it.

## Shared implementation contract

Durable Catalog bindings can run the reusable Vitest contract:

```ts
import {
  describeEvidenceCatalogContract,
} from "@jinn-network/evidence-discovery/testing";

describeEvidenceCatalogContract(async () => ({
  reader: catalog,
  writer: catalog,
  cleanup: async () => closeCatalog(),
}));
```

## Exclusions

This package does not own persistence bindings, exact bytes, full-text or vector
search, ranking, trust, corpus membership, marketplace policy, globally merged
entities, retention, or repository credentials.

See [`catalog.md`](../specifications/catalog.md) for the normative v1 contract.

## Development

Use Node 22 and Yarn 4.13.0:

```sh
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```
