# Jinn Evidence Discovery Layer Design

**Date:** 2026-07-24

**Status:** Approved design

**Scope:** The generic announcement, indexing, and catalog boundary above the Jinn Evidence
Repository and below application-specific corpus, marketplace, plugin, and benchmark views.

## 1. Decision

Jinn's next evidence layer is an **Evidence Discovery Layer** composed of:

1. replayable announcement sources that identify records to inspect;
2. a generic Evidence Indexer that retrieves, validates, and projects those records; and
3. an Evidence Catalog that stores and queries the resulting derived projections.

```text
Evidence producers                 Evidence persistence
  Execution Recorder ───────┐
                            ├──▶ Evidence Repository
  Attestation Issuer ───────┘          exact bytes
                                            │
                                  announced record reference
                                            │
                                            ▼
Announcement Source ──▶ Evidence Indexer ──▶ Evidence Catalog
                              │                       │
                    validates and projects           │ structured queries
                                                      ▼
                                       Plugin / marketplace / corpus views
```

The Catalog is the index: it is the queryable derived state. The Indexer is the process or library
that creates that state. They are designed together but remain distinct interfaces.

The layer is record-first. It never creates a globally canonical Task, Execution, Result,
Evaluation, Verification, or Agent. Every projected fact remains attributable to the exact
evidence record that declared it.

## 2. Placement and ownership

| Component | Owns | Does not own |
| --- | --- | --- |
| Evidence Protocol | Record semantics, canonical serialization, validation, artifact and record identity | Persistence, discovery, application policy |
| Evidence Repository contract | Exact-byte `put` and `get` by SHA-256 | Listing, relationships, search, admission |
| Repository binding | Filesystem, OCI, or another concrete persistence mechanism | Evidence semantics and consumer behavior |
| Execution Recorder | Production of one conforming Execution Evidence record from a live execution | Evaluation, publication, discovery |
| Attestation Issuer | Production of one conforming Result Evaluation or Execution Verification record from a supplied decision | Evaluation or verification policy, discovery |
| Announcement source | Replayable notice that a record should be inspected at a configured repository | Conformance, trust, or catalog projection |
| Evidence Indexer | Retrieval, conformance validation, deterministic projection, and idempotent catalog ingestion | Scheduling policy, concrete storage, ranking |
| Evidence Catalog | Record-scoped structured projections, declared relationships, locations, and queries | Original bytes, trust, curation, ranking |
| Application view | Corpus selection, marketplace joins, retrieval preference, trust, ranking, and product behavior | Changing the underlying record declaration |

The dependency direction is inverted through contracts:

```text
Filesystem Repository ─┐
OCI Repository ─────────┼──▶ EvidenceRepository ──▶ Evidence Indexer
Future Repository ──────┘                              │
                                                      ▼
                                             EvidenceCatalogWriter
```

The Indexer never imports a repository binding. A configured repository resolver supplies an
`EvidenceRepository` instance at runtime.

## 3. Standards composition

The discovery layer composes existing standards rather than defining another evidence format.

| Concern | Standard or existing Jinn contract | Use in this layer |
| --- | --- | --- |
| Evidence graph | RO-Crate 1.3, JSON-LD, and the Jinn Execution Evidence profile | Source of declared entities and relationships |
| Provenance | W3C PROV-O | Preserve declared derivation, correction, dispute, generation, and attribution relationships |
| Catalog interoperability | W3C DCAT 3 | Align external descriptions of cataloged resources, distributions, and data services |
| Content retrieval | Jinn Evidence Repository contract | Retrieve exact record bytes by family and SHA-256 |
| OCI discovery | OCI Distribution 1.1 referrers, tags, or an external publication feed | Binding-specific announcement input, never the universal Catalog |
| On-chain discovery | Ponder or another EVM indexer | Marketplace announcement input, not the generic Evidence Indexer |

DCAT distinguishes a cataloged resource from an accessible distribution and from the data service
that provides it. Jinn follows that distinction when exporting catalog metadata, but v1 does not
require RDF storage, SPARQL, or a DCAT-native database. The runtime contract remains a small typed
TypeScript interface.

## 4. Record-first projection model

### 4.1 The immutable unit

The Catalog's primary unit is an exact Evidence Protocol record:

```ts
interface CatalogRecordBase {
  readonly reference: EvidenceRecordReference;
  readonly byteSize: number;
  readonly declaredEntities: readonly DeclaredEntityOccurrence[];
  readonly declaredRelationships: readonly DeclaredRelationshipOccurrence[];
}
```

`CatalogRecordProjection` is a discriminated union of:

- `ExecutionEvidenceProjection`;
- `ResultEvaluationProjection`; and
- `ExecutionVerificationProjection`.

An implementation may normalize these values into relational tables, documents, or another
internal representation. The public contract describes their logical meaning, not their physical
database layout.

`declaredEntities` and `declaredRelationships` include only entities and relationships defined by
the Evidence Protocol and this Catalog contract. Unknown permitted extension fields remain in the
repository record but are not automatically promoted into portable Catalog fields.

### 4.2 Record-scoped facts

An Execution projection contains queryable fields such as:

- source record reference;
- declared Execution IRI;
- primary Task identifier and exact digest;
- Executor Agent IRI;
- Runtime Specification identifier;
- Result identifiers and exact digests;
- lifecycle outcome; and
- start and end timestamps.

Evaluation and Verification projections similarly contain only their source record reference and
the exact subjects, actor, verdict, time, and correction relationships declared by that record.

The same entity IRI may occur in several records. The Catalog indexes that IRI as a grouping and
lookup key but does not merge the records' other properties into a canonical entity.

### 4.3 Private and scrubbed evidence

A private record and a scrubbed derivative concern the same historical Execution when they
declare the same Execution IRI. They remain different records because their bytes and record
digests differ.

```text
Execution urn:uuid:123
├── full record      sha256:aaa...
└── scrubbed record  sha256:bbb...  wasDerivedFrom aaa...
```

The Catalog does not create a separate canonical `ExecutionIdentity` object. A query may return
both record-scoped projections for the same Execution IRI, and an application may present them as
representations of one execution.

A local Catalog may know only the private record. A public Catalog may know only the scrubbed
record. Neither must reveal an inaccessible record merely because it exists elsewhere.

### 4.4 Cross-record matching

The Catalog may create deterministic matches using exact protocol identifiers:

- a Result Evaluation matches every indexed Execution Evidence record containing its exact Task
  subject and every exact Result subject covered by the Evaluation;
- an Execution Verification directly matches the exact Execution Evidence record digest and
  Execution IRI to which it is bound; and
- declared `supersedes`, `disputes`, and `wasDerivedFrom` relationships remain record-scoped
  edges.

If several records match, the Catalog returns all of them. Selecting a preferred, current,
trusted, or authoritative record is outside this layer.

## 5. Catalog interfaces

### 5.1 Reader

Consumers receive a read-only interface:

```ts
interface EvidenceCatalogReader {
  getRecord(
    reference: EvidenceRecordReference,
    options?: CatalogOperationOptions,
  ): Promise<CatalogRecordProjection | null>;

  findRecordsForEntity(
    entityId: string,
    query?: EntityRecordQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<CatalogRecordProjection>>;

  findExecutions(
    query: ExecutionCatalogQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<ExecutionEvidenceProjection>>;

  findEvaluations(
    query: EvaluationCatalogQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<ResultEvaluationProjection>>;

  findVerifications(
    query: VerificationCatalogQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<ExecutionVerificationProjection>>;

  getRecordLocations(
    reference: EvidenceRecordReference,
    options?: CatalogOperationOptions,
  ): Promise<readonly EvidenceRecordLocation[]>;
}
```

Execution queries may filter by protocol-owned Task, Result, Executor, outcome, and time fields.
Evaluation queries may filter by Task, Result, Evaluator, verdict, and time. Verification queries
may filter by Execution IRI, subject record digest, Verifier, verdict, and time.

Every collection result is bounded and cursor-paginated:

```ts
interface CatalogPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}
```

Cursors are opaque. Every ordering has a deterministic record-digest tie-breaker. The base
contract has no unbounded list, arbitrary SQL, generic query language, total-count requirement,
full-text ranking, vector search, or subscription API.

The Reader returns projections and repository locations, never record or artifact bytes.
Consumers retrieve exact bytes through an Evidence Repository and validate them before relying on
them.

Typed collection queries return records with an active location by default. Callers may explicitly
request known unavailable projections. `getRecord` remains an exact-reference lookup and may
return a known projection without an active location. `getRecordLocations` returns only current
active locations.

### 5.2 Writer

Only an Indexer receives the write interface:

```ts
interface EvidenceCatalogWriter {
  putRecordProjection(
    projection: CatalogRecordProjection,
    options?: CatalogOperationOptions,
  ): Promise<CatalogWriteReceipt>;

  observeRecordLocation(
    reference: EvidenceRecordReference,
    observation: RecordLocationObservation,
    options?: CatalogOperationOptions,
  ): Promise<CatalogLocationReceipt>;

  withdrawRecordLocationObservation(
    withdrawal: RecordLocationWithdrawal,
    options?: CatalogOperationOptions,
  ): Promise<CatalogLocationReceipt>;
}
```

`putRecordProjection` atomically publishes one complete, already-validated projection. The Writer
does not expose per-entity, per-edge, or per-field mutation methods that could leave a partial
projection.

Nonconforming bytes never reach the Writer. Retrieval failures and conformance diagnostics belong
to Indexer operational state, not searchable catalog evidence.

## 6. Announcements, repository resolution, and locations

### 6.1 Three distinct identities

The design keeps three concerns separate:

| Value | Question answered | Scope |
| --- | --- | --- |
| `EvidenceRecordReference` | What exact record bytes? | Globally meaningful family and SHA-256 |
| `repositoryId` | Which configured repository instance retrieves it? | Local to one deployment |
| published location | How may another consumer locate it? | Portable, binding-owned metadata |

The Indexer resolves deployment-local handles:

```ts
interface EvidenceRepositoryResolver {
  resolve(
    repositoryId: string,
    options?: RepositoryOperationOptions,
  ): Promise<EvidenceRepository | null>;
}
```

Passing repository objects inside announcements is forbidden because announcements must remain
serializable and replayable.

### 6.2 Binding-owned published locations

A source may include portable location metadata:

```ts
interface PublishedEvidenceLocation {
  readonly bindingProfile: string;
  readonly locator: Readonly<Record<string, JsonValue>>;
}
```

`bindingProfile` is an absolute identifier for the binding's locator semantics. The locator is
interpreted only by that binding. For OCI it can contain the repository name and exact OCI
manifest digest.

Local sources may omit a published location and provide only `repositoryId`. Absolute filesystem
paths, authentication tokens, passwords, registry configuration, and other secrets never appear
in announcements or Catalog results.

The Catalog exposes the resolved current location shape:

```ts
interface EvidenceRecordLocation {
  readonly repositoryId: string;
  readonly publishedLocation?: PublishedEvidenceLocation;
}

interface RecordLocationObservation extends EvidenceRecordLocation {
  readonly sourceId: string;
  readonly announcementId: string;
}
```

A binding profile defines canonical equality for its published locator. For example, the OCI
binding can identify a location by canonical repository name and manifest digest. Observations
without published locators are distinct by deployment-local `repositoryId`.

### 6.3 Announcement events

```ts
type EvidenceRecordAnnouncement =
  | {
      readonly kind: "available";
      readonly sourceId: string;
      readonly announcementId: string;
      readonly reference: EvidenceRecordReference;
      readonly repositoryId: string;
      readonly publishedLocation?: PublishedEvidenceLocation;
    }
  | {
      readonly kind: "withdrawn";
      readonly sourceId: string;
      readonly announcementId: string;
      readonly retractsAnnouncementId: string;
    };
```

An announcement means only that a source says a record should be retrievable. It does not assert
that:

- the bytes exist or match the digest;
- the record conforms;
- the producer or source is trusted;
- the record belongs in a corpus; or
- the consumer is authorized to retrieve it.

The Indexer independently retrieves and validates the record.

`sourceId` is stable for the lifetime of one replayable source. The pair
`(sourceId, announcementId)` is stable and unique, and a replay must reproduce the same event for
that pair. A withdrawal may retract only an earlier `available` event from the same source.

An announcement source provides stable opaque cursors:

```ts
interface AnnouncementBatch {
  readonly announcements: readonly EvidenceRecordAnnouncement[];
  readonly cursor: string;
}

interface EvidenceRecordAnnouncementSource {
  read(options?: {
    readonly after?: string;
    readonly signal?: AbortSignal;
  }): AsyncIterable<AnnouncementBatch>;
}
```

The Indexer persists progress through an injected checkpoint boundary:

```ts
interface EvidenceIndexerCheckpointStore {
  get(sourceId: string): Promise<string | undefined>;
  put(sourceId: string, cursor: string): Promise<void>;
}
```

Checkpoint storage is operational state, not Catalog evidence. It may share a physical database
with a Catalog implementation without becoming part of the Catalog Reader.

## 7. Generic Indexer

The generic Indexer is a reusable TypeScript library, not necessarily a daemon:

```text
announcement
    ↓
resolve repositoryId
    ↓
getRecord(reference)
    ↓
verify requested digest
    ↓
validate exact bytes with Evidence Protocol
    ↓
create deterministic record-scoped projection
    ↓
putRecordProjection
    ↓
observe confirmed location
    ↓
checkpoint source cursor
```

It depends only on:

- the Evidence Protocol;
- the Evidence Repository contract;
- the Evidence Catalog contract; and
- injected announcement, repository-resolution, checkpoint, and logging facilities.

It has no filesystem, OCI, IPFS, Ponder, marketplace, plugin, SQLite, or PostgreSQL dependency.

Ponder remains useful for blockchain history, ordering, backfill, reorganization handling, and
marketplace event projection. It may feed evidence announcements to the generic Indexer, but it
does not replace the generic Indexer because its indexing functions are EVM-triggered and do not
provide the local or arbitrary-repository boundary.

## 8. Idempotency and replacement

Processing is at-least-once:

1. process an announcement;
2. publish the projection and location observation;
3. checkpoint the source cursor only after those writes succeed.

A crash before checkpointing causes replay. Catalog operations therefore follow these rules:

| Operation | Result |
| --- | --- |
| Same record and same deterministic projection | `existing` |
| Same record reference and a different projection | conflict; never overwrite |
| Same source announcement and location observation | `existing` |
| Same record available from another source or repository | retain every distinct active observation |

Evidence records are never replaced in place. Corrections, disputes, re-evaluations,
re-verifications, and scrubbed derivatives are new records connected by protocol relationships.

Locations are mutable observations. A withdrawal deactivates only the observation previously
made by the same source; one source cannot retract another source's announcement. A location
remains active while any active observation supports it.

When no active location remains, the record projection remains known but unavailable within the
current Catalog generation. Normal queries exclude unavailable records unless the caller
explicitly requests known unavailable records. The Catalog does not promise that an advertised
external endpoint will remain reachable; retrieval remains authoritative.

## 9. Rebuild and projection upgrades

The Catalog is disposable derived state. A complete rebuild requires replayable announcement
sources because the Evidence Repository contract deliberately has no `list` operation.

An authoritative announcement source must provide either:

- replay from its beginning; or
- a complete current-state snapshot followed by replayable incremental events.

Examples include a local publication journal, blockchain history, an OCI publication feed or
snapshot, and a durable manual-import journal. An OCI registry's mutable tags alone are not
assumed to provide complete historical replay.

Replay can reconstruct only projections whose exact bytes remain retrievable. A deployment that
promises durable discovery of records after their external locations disappear must retain an
archival repository location for those bytes. Without such retention, a projection may remain
known in the current generation after its final withdrawal but may be absent from a later full
rebuild. The Catalog itself does not create that retention guarantee.

Every Catalog generation records:

```ts
interface CatalogGeneration {
  readonly catalogSchemaVersion: string;
  readonly projectorVersion: string;
  readonly createdAt: string;
}
```

A schema or projector change creates a new generation by replaying announcements into empty
derived state. The existing generation continues serving until the new generation is complete,
after which the implementation switches readers atomically.

The physical mechanism is implementation-specific:

- a new SQLite file or generation;
- a new PostgreSQL schema or table generation; or
- a replacement in-memory instance.

Generation administration is not part of the ordinary Reader or Writer interface.

## 10. Generic catalog versus application views

The Catalog contains a field or relationship only when it is:

1. defined by the Evidence Protocol;
2. deterministically extractable from exact record bytes;
3. independent of trust, policy, and external application state; and
4. expected to produce the same answer in every conforming implementation.

The Catalog may answer:

- which evaluations reference an exact Result;
- which records declare a given Execution IRI;
- which Verification binds an exact Execution Evidence record;
- what verdict and actor a record declares;
- what derivation or correction relationships a record declares; and
- where a validated record was observed.

Views above the Catalog own:

- experience-corpus membership and training suitability;
- quality, retention, eligibility, and publication policy;
- trusted, current, best, or aggregate verdicts;
- private, scrubbed, or full representation preference;
- full-text search, semantic similarity, embeddings, ranking, and recommendation;
- task deduplication and benchmark contamination checks;
- benchmark splits and aggregate scores;
- marketplace Task and Attempt joins, wallets, ERC-8004 identities, reputation, rewards, and
  disputes;
- plugin-local and public composition;
- collections, tags, and human curation; and
- skill or other knowledge distillation.

```text
Evidence Catalog
├── Experience Corpus View
├── Marketplace Evidence View
├── Plugin Knowledge View
└── Benchmark View
```

These views may use tables in the same physical database, but their schemas and APIs do not enter
the generic Evidence Catalog contract.

## 11. Failure, privacy, and trust boundaries

Repository absence, temporary unavailability, access denial, digest mismatch, protocol
nonconformance, and unsupported projection versions are Indexer operational outcomes. They do not
create searchable evidence records.

Previously validated projections remain record-scoped facts even if all known locations later
disappear. Availability is reported separately.

The discovery layer:

- never stores record or artifact bytes as the authoritative copy;
- never treats an announcement as evidence conformance;
- never treats a Catalog row as proof that bytes are still available;
- never places repository credentials or private local paths in portable metadata;
- never infers control of an Agent identity from a wallet, key, or announcement source;
- never assigns trust from signature presence, evaluator identity, or verifier identity; and
- never reveals a private location merely because a public derivative commits to its source.

Consumers retrieve and validate exact bytes before relying on evidence. Authentication,
authorization, admission, reputation, and trust remain repository, marketplace, or application
responsibilities.

## 12. Package boundary

The standalone contract structure is:

```text
@jinn-network/evidence-catalog
  Reader, Writer, projection, query, announcement, location, and testing contracts

@jinn-network/evidence-indexer
  generic retrieval, validation, deterministic projection, and ingestion library

future bindings and applications
  evidence-catalog-sqlite
  evidence-catalog-postgres
  local announcement journal adapter
  OCI publication adapter
  marketplace/Ponder announcement adapter
```

`evidence-catalog` depends only on the Evidence Protocol and Evidence Repository contracts.
`evidence-indexer` additionally depends on `evidence-catalog`. Concrete Catalog implementations
and announcement adapters depend on these contracts, never the reverse.

This design does not decide whether the local and public Catalog implementations live in separate
packages, processes, or deployments.

## 13. Design acceptance invariants

The later implementation must demonstrate that:

- all three Evidence Protocol record families project deterministically;
- every projected fact retains its source record reference;
- records sharing an entity IRI remain independently inspectable;
- private and scrubbed evidence can share an Execution IRI without sharing a record digest;
- duplicate announcements and crash replay do not duplicate logical projections;
- a conflicting projection for one record digest is rejected;
- one source cannot withdraw another source's location observation;
- unavailable records can remain known without appearing in default available-only queries;
- nonconforming repository bytes never become searchable Catalog records;
- retained, retrievable records can be rebuilt exclusively from replayable announcements and
  exact repository bytes;
- SQLite and PostgreSQL implementations can satisfy the same Reader and Writer contracts;
- no concrete repository binding is imported by the generic Indexer; and
- corpus, marketplace, plugin, benchmark, ranking, and trust policy remain outside the Catalog.

## 14. Explicitly out of scope

This design does not specify:

- a concrete SQLite or PostgreSQL schema;
- a hosted Catalog service, REST API, GraphQL API, or SPARQL endpoint;
- a filesystem, OCI, IPFS, blockchain, or manual-import announcement adapter;
- deployment, scaling, monitoring, or service-level objectives;
- search ranking, embeddings, or vector storage;
- corpus definitions or knowledge-retrieval behavior;
- marketplace evidence policy;
- catalog federation;
- migration from `EpisodeV1`, the legacy Evidence Index, client projections, or the existing
  Ponder schema;
- package implementation sequence or pull-request stack; or
- backward compatibility with pre-launch legacy indexes.

Those concerns follow only after the generic Discovery Layer contract is implemented and proven
against at least one local Catalog implementation.
