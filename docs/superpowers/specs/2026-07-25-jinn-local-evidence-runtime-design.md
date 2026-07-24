# Jinn Local Evidence Runtime Design

**Date:** 2026-07-25

**Status:** Approved design

**Scope:** A production-capable, embeddable local composition of the Jinn Evidence Repository,
Evidence Discovery Layer, and their concrete filesystem and SQLite bindings.

## 1. Decision

Jinn will provide a reusable local evidence runtime composed from three independently publishable
packages:

```text
@jinn-network/evidence-catalog-sqlite
@jinn-network/evidence-announcement-journal
@jinn-network/evidence-local-runtime
```

The runtime is an actual implementation for applications to embed, not plugin-owned code and not
merely a sample application. The Jinn plugin, a task-marketplace operator, or another producer
uses the same runtime and supplies only its application-specific adapter.

```text
Application-specific producer adapter
                  |
                  v
       Execution Recorder / Attestation Issuer
                  |
                  v
       Local Evidence Runtime
          |       |       |
          v       v       v
     filesystem  journal  SQLite
     repository           catalog
```

Version 1 is an embeddable Node/TypeScript library. A future daemon may wrap its public API, but
cross-process service concerns do not enter this design.

## 2. Placement in the evidence architecture

The local runtime closes a deployment and composition boundary; it does not add a new evidence
semantic layer.

| Layer | Owns | Local runtime relationship |
| --- | --- | --- |
| Evidence Protocol | Record formats, identity, conformance, and semantic relationships | Exact bytes are validated by the generic Indexer |
| Evidence Repository | Exact-byte persistence by family and SHA-256 | The runtime decorates a filesystem implementation |
| Execution Recorder | Live production of Execution Evidence | Receives the runtime repository through the existing contract |
| Attestation Issuer | One-shot production of Evaluation and Verification Evidence | Receives the same runtime repository |
| Evidence Discovery Layer | Announcements, deterministic projection, and Catalog contracts | The runtime supplies concrete local implementations |
| Application views | Corpus, marketplace, plugin, benchmark, trust, and ranking behavior | Consume the Catalog above the runtime |

The runtime does not define a second repository contract. Its announcement-aware repository is an
ordinary `EvidenceRepository` decorator:

```text
Recorder / Issuer
        |
        v EvidenceRepository
Announcement-aware repository decorator
        |                         |
        v                         v
FilesystemEvidenceRepository   durable local announcement
```

This dependency inversion lets every existing and future producer use local discovery without
importing the journal, Indexer, SQLite Catalog, or plugin.

## 3. Package boundaries

### 3.1 `@jinn-network/evidence-catalog-sqlite`

This package implements the generic `EvidenceCatalogReader` and `EvidenceCatalogWriter`
contracts. It owns:

- SQLite schema and migrations;
- atomic record projections and location observations;
- deterministic pagination and query execution;
- Catalog generation creation, validation, and opening; and
- SQLite-specific integrity and concurrency behavior.

Its physical schema is private. It does not own repository bytes, announcements, Indexer
checkpoints, operational failures, application views, or runtime lifecycle.

### 3.2 `@jinn-network/evidence-announcement-journal`

This package implements:

- a durable append interface for local `available` announcements; and
- the generic replayable `EvidenceRecordAnnouncementSource`.

It owns event ordering, idempotent publication, cursor production, replay, journal-format
validation, and chain integrity. Its filesystem representation is a private, versioned local
format rather than another interoperability protocol.

It does not retrieve or validate records, write Catalog projections, store Indexer checkpoints,
or decide whether an announcement is trusted.

### 3.3 `@jinn-network/evidence-local-runtime`

This package composes:

- `@jinn-network/evidence-repository-fs`;
- `@jinn-network/evidence-announcement-journal`;
- `@jinn-network/evidence-indexer`; and
- `@jinn-network/evidence-catalog-sqlite`.

It owns root initialization, process locking, the announcement-aware repository decorator,
publication recovery, Indexer lifecycle, operational checkpoints and failures, Catalog rebuild
coordination, synchronization, status, and orderly shutdown.

It does not depend on the Execution Recorder, Attestation Issuer, plugin, Autopilot, marketplace,
OCI binding, corpus, scrubber, or any application view.

## 4. One-root and single-writer model

One runtime instance owns one caller-supplied root:

```text
<root>/
  runtime.json
  repository/
  announcements/
  catalog/
    generations/
    current.json
  operations/
  runtime.lock
```

`runtime.json` contains the private root-format version, stable runtime identity, and stable local
announcement `sourceId`. It contains no credentials or evidence policy.

The root:

- is created private by default;
- rejects path traversal, symlink traversal, and non-regular control files;
- is opened by at most one writable process through an operating-system-backed exclusive lock;
- has no built-in users, profiles, tenants, or namespaces; and
- is isolated by choosing a different root when an application needs a different security or
  lifecycle boundary.

Multiple components in the owning process share one runtime handle. A future read-only client or
daemon can be designed separately without changing the underlying contracts.

## 5. Public API

The primary API is deliberately small:

```ts
export interface OpenLocalEvidenceRuntimeOptions {
  readonly rootDir: string;
  readonly signal?: AbortSignal;
}

export interface LocalEvidenceRuntime {
  readonly repository: EvidenceRepository;
  readonly catalog: EvidenceCatalogReader;

  sync(
    options?: LocalRuntimeOperationOptions,
  ): Promise<LocalEvidenceSyncReport>;

  awaitIndexed(
    reference: EvidenceRecordReference,
    options?: LocalRuntimeOperationOptions,
  ): Promise<LocalEvidenceIndexingOutcome>;

  getStatus(): Promise<LocalEvidenceRuntimeStatus>;

  listIndexingFailures(
    query?: LocalIndexingFailureQuery,
    options?: LocalRuntimeOperationOptions,
  ): Promise<LocalIndexingFailurePage>;

  close(
    options?: LocalRuntimeOperationOptions,
  ): Promise<void>;
}

export function openLocalEvidenceRuntime(
  options: OpenLocalEvidenceRuntimeOptions,
): Promise<LocalEvidenceRuntime>;
```

`runtime.repository` implements the existing Repository contract:

- `putArtifact()` and artifact reads delegate to the filesystem repository;
- `putRecord()` durably stores the exact record and durably publishes its local announcement;
- record and artifact reads return the exact repository bytes; and
- Repository failures retain the existing `EvidenceRepositoryError` type and stable codes.

Artifacts are not announced or independently cataloged. Their identities and relationships remain
declared by Evidence Protocol records.

The runtime exposes only the Catalog Reader. It does not expose the Catalog Writer, arbitrary SQL,
announcement mutation, public publication, deletion, retention, or application queries.

## 6. Publication transaction and exact-byte ownership

Repository storage and announcement publication are separate durable systems. The runtime uses a
private transactional outbox to prevent a process crash from permanently orphaning a record
between them:

```text
stage exact record bytes and publication intent
                  |
                  v
put exact bytes through FilesystemEvidenceRepository
                  |
                  v
append deterministic available announcement
                  |
                  v
mark publication complete and remove staged recovery bytes
                  |
                  v
return RepositoryWriteReceipt
```

The publication operation is keyed deterministically by runtime source, record family, record
digest, and local repository identity. Repeating the same operation reuses the same logical
announcement. Concurrent identical calls in one process converge on the same operation.

Staged record bytes are temporary recovery material. The Evidence Repository remains the
authoritative exact-byte store after publication. On startup, the runtime completes every valid
unfinished intent before accepting new writes.

A successful `putRecord()` therefore means:

1. the exact record bytes are durably present in the filesystem repository; and
2. a replayable local announcement for that exact reference is durable.

It does not mean the record conforms, has been indexed, is trusted, belongs in a corpus, or is
public.

If publication fails, the decorator throws an `EvidenceRepositoryError` compatible with the
contract. Retrying is safe. Corrupt outbox state is never guessed or silently discarded.

## 7. Announcement journal

The local journal publishes each event as an immutable, sequentially numbered file using:

- same-directory temporary files;
- file and directory flushes;
- atomic publication without overwrite;
- a predecessor-event digest; and
- a private journal-format version.

Replay ignores incomplete temporary files and rejects gaps, changed events, reused announcement
identities with different content, or broken predecessor chains.

The local runtime emits only `available` events in version 1. It has no withdrawal API because the
underlying repository has no delete or retention operation. The journal package may later support
the generic withdrawal event without changing the runtime's current public surface.

Journal cursors are stable and opaque. The journal is the authoritative source for reconstructing
local discovery state; the Catalog is disposable derived state.

## 8. Indexing, synchronization, and operational state

Opening the runtime:

1. validates and locks the root;
2. opens the filesystem repository and announcement journal;
3. replays unfinished publication operations;
4. opens the current Catalog generation;
5. restores the local Indexer's checkpoint and failure state;
6. starts the generic Indexer against the local announcement source; and
7. returns the ready runtime handle.

The Indexer follows the already-approved generic flow:

```text
announcement
    |
    v
resolve local repository
    |
    v
retrieve and verify exact bytes
    |
    v
validate with Evidence Protocol
    |
    v
deterministically project
    |
    v
atomically update SQLite Catalog
    |
    v
advance operational checkpoint
```

`putRecord()` returns after publication, not after indexing. This prevents Catalog availability
from blocking evidence capture.

`awaitIndexed(reference)` has three terminal outcomes:

- `indexed`, including or identifying the resulting projection;
- `failed`, including stable operational failure information and conformance diagnostics when
  applicable; or
- `not-announced` when the reference is not present in the local journal.

While an announced record is pending or transiently failing, the call waits until a terminal
outcome, cancellation, or runtime shutdown.

`sync()` captures the journal's current high-water cursor and waits until every event through that
cursor has an indexed or terminal-failure outcome. Its report includes terminal failures; it does
not convert them into Catalog records. Writes after the captured cursor belong to a later
synchronization.

`getStatus()` reports:

- runtime lifecycle state;
- journal high-water and Indexer checkpoint progress;
- pending publication and indexing counts;
- active Catalog generation and rebuild state;
- durable terminal-failure counts and a bounded recent summary; and
- degraded operational components.

`listIndexingFailures()` provides bounded, cursor-paginated inspection of durable terminal
failures. It may filter by exact record reference and stable failure category. Ordering is
deterministic, cursors are opaque, and no unbounded failure listing enters the API.

Status is operational metadata, not evidence and not a trust or quality signal.

## 9. Failure classification and degraded operation

Record-specific failures such as digest mismatch or Evidence Protocol nonconformance are terminal
for that announcement. They are durably inspectable, excluded from the Catalog, and considered
handled for forward checkpoint progress.

Temporary I/O or dependency failures retry with bounded backoff. While a retryable failure
prevents progress, status is degraded and `sync()` cannot report completion through the affected
cursor.

If the repository and announcement journal remain healthy, evidence capture may continue while
the Indexer or Catalog is degraded. The durable journal preserves the work needed for later
recovery.

Runtime-specific typed errors use stable codes covering:

- `ROOT_IN_USE`;
- `ROOT_VERSION_UNSUPPORTED`;
- `RUNTIME_CORRUPT`;
- `UNSAFE_PATH`;
- `RUNTIME_CLOSING`;
- `RUNTIME_CLOSED`;
- `INVALID_QUERY`;
- `OPERATION_ABORTED`;
- `SYNCHRONIZATION_UNAVAILABLE`; and
- `IO_FAILURE`.

Underlying Repository errors propagate as their original type and code. Record-specific indexing
outcomes are reports, not runtime exceptions.

Cancellation and shutdown do not interrupt a filesystem publication transition at an unsafe
point. `close()` stops accepting new writes, completes active durable transitions, stops indexing,
closes SQLite and repository handles, and releases the process lock.

## 10. SQLite Catalog and generations

The SQLite implementation uses transactions for atomic record projection and location
observation. WAL mode permits in-process readers while the Indexer writes. Every query continues
to obey the generic Catalog contract's bounded pagination, deterministic ordering, and
record-scoped projection rules.

Catalog generations are independent databases:

```text
catalog/
  generations/
    <generation-id>.sqlite
  current.json
```

A Catalog schema or projector upgrade:

1. creates an empty generation;
2. replays the complete local journal;
3. retrieves and validates exact repository bytes;
4. verifies that replay reached the captured journal high-water mark; and
5. atomically switches `current.json`.

Existing readers remain on the previous valid generation until the switch completes. New
announcements arriving during the rebuild are applied before the new generation becomes current
or remain queued until it catches up. The rebuilding generation has an independent checkpoint
keyed by source and generation. Before switching, the runtime takes a short publication/indexing
barrier, captures the final high-water cursor, advances the new generation through that cursor,
and then changes the current-generation pointer. Record capture may wait briefly at this barrier
but never observes a partially rebuilt Catalog.

Old-generation cleanup is implementation maintenance. It is not deletion of authoritative
evidence and does not introduce retention policy.

Indexer checkpoints and operational failures are stored outside Catalog generations. Replacing
derived query state therefore cannot erase the authoritative announcement history or confuse
operational state with evidence.

## 11. Security and privacy boundary

The local runtime:

- defaults new roots and files to private permissions;
- never follows symlinks in runtime-controlled paths;
- validates containment before every path-based operation;
- never places credentials, authentication tokens, or portable public locators in its local
  announcement events;
- never announces artifacts separately from their declaring records;
- never exposes a private local filesystem path through the Catalog's portable location shape;
- never infers trust from successful persistence, validation, signature presence, or local
  origin; and
- never publishes local evidence to OCI, IPFS, a blockchain, or another process.

The local `repositoryId` and location observation are deployment-local handles. Public publication
and portable location metadata belong to a later composition.

## 12. Application integration

A producer uses only existing generic APIs:

```ts
const runtime = await openLocalEvidenceRuntime({ rootDir });

const recorder = createExecutionRecorder({
  repository: runtime.repository,
});

const finalized = await recording.finalize(finalizeInput);

if (finalized.finalized) {
  const outcome = await runtime.awaitIndexed(
    finalized.receipt.reference,
  );
}
```

The plugin owns translation from plugin lifecycle events into Recorder capture calls. A
marketplace operator owns translation from attempt execution events into the same calls. Neither
adapter owns filesystem persistence, announcements, indexing, or SQLite projection.

The same pattern applies to a future Attestation Issuer. The local runtime does not need to know
which conforming producer created a record.

## 13. Acceptance invariants

The implementation must demonstrate that:

- all three Evidence Protocol record families persist, announce, index, and query correctly;
- exact retrieved bytes still pass Evidence Protocol validation after indexing;
- artifact bytes remain independently retrievable and are never independently Catalog records;
- repeated and concurrent identical record writes produce one logical announcement and one
  projection;
- different record families sharing exact bytes retain distinct record references and
  announcements;
- every publication transition is recoverable after process interruption;
- restart completes unfinished publication and resumes Indexer progress without duplication;
- invalid records remain retrievable but do not enter the Catalog;
- terminal indexing failures are durable, inspectable, and do not block later announcements;
- transient indexing failures preserve work and report degraded status;
- deletion of a Catalog generation followed by journal replay reconstructs equivalent
  projections from retained repository bytes;
- readers remain on the old generation until a replacement is complete;
- symlink attacks, path escapes, corrupt control files, journal-chain breaks, incompatible
  versions, and concurrent writers fail safely;
- repository errors retain their existing public error identity;
- an external producer can complete the full flow without private Jinn APIs; and
- packed packages have no plugin, marketplace, Autopilot, OCI, network, corpus, or application
  dependency.

Testing must include contract suites for the SQLite Catalog and announcement journal, Evidence
Protocol golden records for all three families, process-level locking, fault injection around
every outbox and journal transition, Indexer retry and failure classification, Catalog rebuilds,
generation switching, aborts, orderly shutdown, and packed-install smoke tests.

## 14. Explicitly out of scope

This design does not specify:

- plugin, Autopilot, or task-marketplace adapters;
- a daemon, HTTP API, IPC API, or cross-process read client;
- OCI, IPFS, blockchain, or other public-source indexing;
- scrubbing or private-to-public evidence derivation;
- public publication or portable locator creation;
- local/public Catalog federation or result merging;
- experience-corpus membership or training suitability;
- full-text search, semantic search, embeddings, ranking, recommendation, or collections;
- trust, reputation, retention, deletion, admission, or eligibility policy;
- marketplace Task and Attempt joins;
- the Attestation Issuer implementation;
- legacy Evidence Index, Ponder schema, client projection, or `EpisodeV1` migration; or
- backward compatibility with pre-launch local stores.

Those application and public-composition concerns follow only after the local runtime has proven
the generic Repository and Discovery contracts end to end.
