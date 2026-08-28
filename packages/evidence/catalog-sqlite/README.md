# Jinn Evidence Catalog — SQLite binding

`@jinn-network/evidence-catalog-sqlite` is the durable, embedded SQLite
implementation of the backend-neutral Jinn Evidence Catalog Reader and Writer
contracts.

The Catalog is derived discovery state. Repository record bytes and
announcements remain authoritative; a Catalog database may be rebuilt as a new
generation without changing record identity.

## Create and reopen a generation

```ts
import {
  createSqliteEvidenceCatalog,
  openSqliteEvidenceCatalog,
} from "@jinn-network/evidence-catalog-sqlite";

const catalog = await createSqliteEvidenceCatalog({
  databasePath: "/private/runtime/catalog/generation-1.sqlite",
  generation: {
    catalogSchemaVersion: "1.0.0",
    projectorVersion: "projector-v1",
    createdAt: new Date().toISOString(),
  },
});

await catalog.putRecordProjection(projection);
await catalog.observeRecordLocation(projection.reference, {
  sourceId: "local-journal",
  announcementId: "event-1",
  repositoryId: "local-repository",
});

const executions = await catalog.findExecutions({
  executorId: projection.executorId,
  limit: 25,
});

await catalog.close();

const reopened = await openSqliteEvidenceCatalog({
  databasePath: "/private/runtime/catalog/generation-1.sqlite",
});
const integrity = await reopened.integrityCheck();
await reopened.close();
```

Collection queries are bounded to at most 100 records and use private,
query-bound cursors. Exact lookup remains record-scoped and may return a known
record before it has an active location. Private and public derivatives that
share an Execution IRI remain distinct Catalog records.

The binding uses WAL mode, full synchronous durability, foreign keys, a bounded
busy timeout, private POSIX permissions, and no-symlink path checks. It includes
the native `better-sqlite3` addon and therefore requires a supported Node 22+
runtime and native-addon installation environment.

This package stores projections, location observations, and the announcement
edge index. Repository bytes, announcement transport, full-text search, corpus
management, ranking, trust policy, retention, deletion, and migration
orchestration are outside its boundary.

## The announcement edge index

`indexAnnouncementEdges` takes an announcement facts card plus the field names
its facts profile declares reference-bearing, and stores the outbound references
it declares — record kind, record digest, field, ordinal, target digest.
`queryAnnouncementEdges` reads them in either direction: a record's own edges, or
the records pointing at a target (the `referrers` inversion of record-discovery
design §8). Every read requires at least one filter and returns at most
`ANNOUNCEMENT_EDGE_QUERY_LIMIT` rows.

This is the one surface fed from a feed rather than from a fetched record. It is
what lets an index answer join — "this environment, its attempts, their
verdicts" — without fetching anything, which for a record behind a payment gate
is the only way to answer it at all. Cards are holder-authored: an edge is a
hint, and a decision resting on one re-checks it against the fetched record.

The SQLite schema version moves with any table change and there is no migration
path: `openSqliteEvidenceCatalog` refuses a database written under an older
version. A catalog is a derived index, so the answer is to build a new
generation and reproject, which `@jinn-network/evidence-local-runtime` already
does.
