# Jinn Local Evidence Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-capable embedded local evidence runtime that durably stores,
announces, indexes, rebuilds, and queries all three Jinn Evidence Protocol record families.

**Architecture:** Three independently publishable packages implement one composition.
`@jinn-network/evidence-catalog-sqlite` is a concrete implementation of the generic Catalog
contract; `@jinn-network/evidence-announcement-journal` is a durable local announcement source;
and `@jinn-network/evidence-local-runtime` composes those packages with the filesystem Repository
and generic Indexer behind the existing `EvidenceRepository` and `EvidenceCatalogReader`
interfaces. A transactional outbox bridges record persistence and announcement publication, and
Catalog generations remain disposable projections rebuilt from the journal and exact Repository
bytes.

**Tech Stack:** TypeScript 5.9.3, ES2022 ESM, Node 22, Yarn 4.13.0, Vitest 4.1.8,
`better-sqlite3@13.0.1`, `@types/better-sqlite3@7.6.13`, and the Jinn Evidence Protocol,
Repository, Catalog, and Indexer packages at `0.1.0`.

## Global Constraints

- Begin from updated `next` only after the complete Evidence Protocol, Evidence Repository,
  Evidence Catalog, and Evidence Indexer stacks are present.
- Create a dedicated worktree and `codex/` branch from that exact base before implementation.
- Create independent package-local Yarn projects; do not add the packages to a root workspace.
- Publish identities are `@jinn-network/evidence-catalog-sqlite@0.1.0`,
  `@jinn-network/evidence-announcement-journal@0.1.0`, and
  `@jinn-network/evidence-local-runtime@0.1.0`.
- Use Node `>=22`, Yarn `4.13.0`, ES2022, strict TypeScript, ESM, MIT licensing, SPDX headers on
  source files, and DCO sign-off on every commit.
- Pin `better-sqlite3` to `13.0.1`; it declares Node `>=22`. Use WAL with
  `PRAGMA synchronous=FULL`, `foreign_keys=ON`, and a bounded busy timeout.
- Preserve the existing Evidence Repository, Catalog, and Indexer interfaces. Do not add another
  record, repository, projection, or trust model.
- Every Catalog collection remains bounded and cursor-paginated. Operational failure inspection
  is also bounded and cursor-paginated.
- Repositories admit exact bytes without requiring protocol conformance. Only the Indexer admits a
  projection into the Catalog.
- The local runtime automatically announces record writes but never announces artifacts
  independently.
- Do not add plugin, Autopilot, marketplace, OCI, IPFS, blockchain, network, scrubbing, corpus,
  ranking, trust, retention, deletion, or legacy migration behavior.
- Do not publish npm packages, provision services, or add credentials.
- Use test-driven development and fault injection at every durable transition.

---

## File and responsibility map

### `packages/evidence-catalog-sqlite`

| File | Responsibility |
| --- | --- |
| `package.json`, `yarn.lock`, `.yarnrc.yml`, `.gitignore` | Independent package and dependency lock |
| `tsconfig.json`, `tsconfig.build.json` | Strict ES2022 source and production build |
| `src/types.ts` | SQLite factory options and close/integrity extension |
| `src/errors.ts` | SQLite-binding failures mapped to Catalog errors |
| `src/database.ts` | Secure database opening and fixed pragmas |
| `src/schema.ts` | Schema version, DDL, metadata, and schema validation |
| `src/projection-row.ts` | Immutable projection JSON and normalized query rows |
| `src/writer.ts` | Atomic projection and location Writer operations |
| `src/cursors.ts` | SQLite-private opaque query cursors |
| `src/reader.ts` | Bounded typed Reader queries |
| `src/catalog.ts` | Public Catalog handle, creation, opening, integrity, and close |
| `src/index.ts` | Root exports |
| `src/*.test.ts` | Schema, contract, query, corruption, and concurrency tests |
| `scripts/pack-smoke.mjs` | Packed-install and dependency-boundary smoke |
| `README.md` | Binding usage and exclusions |

### `packages/evidence-announcement-journal`

| File | Responsibility |
| --- | --- |
| `package.json`, `yarn.lock`, `.yarnrc.yml`, `.gitignore` | Independent package and dependency lock |
| `tsconfig.json`, `tsconfig.build.json` | Strict ES2022 source and production build |
| `src/types.ts` | Journal append, replay, cursor, receipt, and handle contracts |
| `src/errors.ts` | Stable journal error codes |
| `src/paths.ts` | Root containment, modes, and no-symlink checks |
| `src/serialization.ts` | Deterministic private event serialization and SHA-256 |
| `src/marker.ts` | Journal marker creation and validation |
| `src/cursor.ts` | Opaque revision-and-digest cursor encoding |
| `src/replay.ts` | Full chain validation and immutable in-memory replay index |
| `src/journal.ts` | Durable idempotent append, snapshot read, high-water, and close |
| `src/index.ts` | Root exports |
| `src/*.test.ts` | Contract, corruption, cursor, race, permission, and replay tests |
| `scripts/pack-smoke.mjs` | Packed-install and source-replay smoke |
| `README.md` | Local-source behavior and private-format warning |

### `packages/evidence-local-runtime`

| File | Responsibility |
| --- | --- |
| `package.json`, `yarn.lock`, `.yarnrc.yml`, `.gitignore` | Independent package and dependency lock |
| `tsconfig.json`, `tsconfig.build.json` | Strict ES2022 source and production build |
| `src/types.ts` | Runtime, status, synchronization, and failure contracts |
| `src/errors.ts` | Stable runtime error codes and lifecycle guards |
| `src/paths.ts` | Runtime-root containment and private permissions |
| `src/marker.ts` | Root marker identity and version validation |
| `src/lock.ts` | Cross-process exclusive runtime ownership |
| `src/operations-schema.ts` | Outbox, checkpoint, outcome, and failure DDL |
| `src/operations-store.ts` | Durable operational state transactions |
| `src/publication.ts` | Deterministic announcement identity and outbox replay |
| `src/repository.ts` | Announcement-aware `EvidenceRepository` decorator |
| `src/checkpoints.ts` | Generation-scoped Indexer checkpoint adapter |
| `src/indexing-worker.ts` | Wakeable local source runner, retry, and failure classification |
| `src/catalog-reader.ts` | Stable Reader proxy across generation switches |
| `src/generations.ts` | Catalog creation, rebuild, catch-up barrier, and atomic pointer |
| `src/runtime.ts` | Open, recovery, lifecycle, synchronization, status, and close |
| `src/index.ts` | Root exports |
| `src/*.test.ts` | Root, outbox, worker, rebuild, crash, and integration tests |
| `scripts/pack-smoke.mjs` | Packed-install full-flow smoke |
| `README.md` | Application integration and ownership boundary |

### Repository-level files

| File | Responsibility |
| --- | --- |
| `.github/workflows/evidence-local-runtime-ci.yml` | Ordered foundation and local-runtime verification |

---

### Task 1: Freeze the SQLite Catalog binding and schema

**Files:**
- Create: `packages/evidence-catalog-sqlite/package.json`
- Create: `packages/evidence-catalog-sqlite/yarn.lock`
- Create: `packages/evidence-catalog-sqlite/.yarnrc.yml`
- Create: `packages/evidence-catalog-sqlite/.gitignore`
- Create: `packages/evidence-catalog-sqlite/tsconfig.json`
- Create: `packages/evidence-catalog-sqlite/tsconfig.build.json`
- Create: `packages/evidence-catalog-sqlite/src/types.ts`
- Create: `packages/evidence-catalog-sqlite/src/errors.ts`
- Create: `packages/evidence-catalog-sqlite/src/database.ts`
- Create: `packages/evidence-catalog-sqlite/src/schema.ts`
- Create: `packages/evidence-catalog-sqlite/src/catalog.ts`
- Create: `packages/evidence-catalog-sqlite/src/index.ts`
- Create: `packages/evidence-catalog-sqlite/src/schema.test.ts`

**Interfaces:**
- Consumes: `CatalogGeneration`, `EvidenceCatalogReader`, `EvidenceCatalogWriter`, and
  `EvidenceCatalogError` from `@jinn-network/evidence-catalog`.
- Produces:

```ts
export const SQLITE_EVIDENCE_CATALOG_SCHEMA_VERSION = 1 as const;

export interface SqliteEvidenceCatalog
  extends EvidenceCatalogReader, EvidenceCatalogWriter {
  readonly databasePath: string;
  readonly generation: CatalogGeneration;
  integrityCheck(
    options?: CatalogOperationOptions,
  ): Promise<SqliteCatalogIntegrityReport>;
  close(): Promise<void>;
}

export function createSqliteEvidenceCatalog(options: {
  readonly databasePath: string;
  readonly generation: CatalogGeneration;
}): Promise<SqliteEvidenceCatalog>;

export function openSqliteEvidenceCatalog(options: {
  readonly databasePath: string;
}): Promise<SqliteEvidenceCatalog>;
```

- [ ] **Step 1: Scaffold the package and write the failing schema contract**

Follow `packages/evidence-repository-fs/package.json`. Use this dependency boundary:

```json
{
  "dependencies": {
    "@jinn-network/evidence-catalog": "0.1.0",
    "@jinn-network/evidence-repository": "0.1.0",
    "better-sqlite3": "13.0.1"
  },
  "devDependencies": {
    "@jinn-network/evidence-protocol": "0.1.0",
    "@types/better-sqlite3": "7.6.13",
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  }
}
```

Add portal resolutions for the three Jinn dependencies. In `schema.test.ts`, assert that creating
a Catalog writes generation metadata, uses schema version `1`, reopens with the same generation,
rejects a non-database file, and rejects a database whose schema version was changed manually.

- [ ] **Step 2: Install and prove the contract is red**

Run:

```bash
cd packages/evidence-catalog-sqlite
yarn install
yarn test src/schema.test.ts
```

Expected: FAIL because the root exports and factories do not exist.

- [ ] **Step 3: Add secure SQLite opening**

In `database.ts`, reject symlink database paths and non-directory or symlink parent paths. Create
parents with mode `0700` and new database files with mode `0600` on POSIX. Open
`better-sqlite3` with a 5-second timeout and apply:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
PRAGMA trusted_schema = OFF;
```

Map access errors to `new EvidenceCatalogError("IO_FAILURE", message, { cause })`. Preserve an
existing `EvidenceCatalogError` unchanged.

- [ ] **Step 4: Create the versioned normalized schema**

In `schema.ts`, create all tables in one `BEGIN IMMEDIATE` transaction:

```sql
CREATE TABLE catalog_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  sqlite_schema_version INTEGER NOT NULL,
  catalog_schema_version TEXT NOT NULL,
  projector_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE records (
  family TEXT NOT NULL,
  digest TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  projection_json TEXT NOT NULL,
  projection_hash TEXT NOT NULL,
  PRIMARY KEY (family, digest)
);

CREATE TABLE entity_keys (
  family TEXT NOT NULL,
  digest TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (family, digest, entity_id),
  FOREIGN KEY (family, digest) REFERENCES records(family, digest)
);

CREATE TABLE execution_records (
  family TEXT NOT NULL CHECK (family = 'execution-evidence'),
  digest TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_digest TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  started_ms INTEGER NOT NULL,
  ended_ms INTEGER NOT NULL,
  published_ms INTEGER NOT NULL,
  PRIMARY KEY (family, digest),
  FOREIGN KEY (family, digest) REFERENCES records(family, digest)
);

CREATE TABLE execution_results (
  family TEXT NOT NULL CHECK (family = 'execution-evidence'),
  digest TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  result_id TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  PRIMARY KEY (family, digest, ordinal),
  FOREIGN KEY (family, digest) REFERENCES records(family, digest)
);

CREATE TABLE evaluation_records (
  family TEXT NOT NULL CHECK (family = 'result-evaluation'),
  digest TEXT NOT NULL,
  task_digest TEXT NOT NULL,
  evaluator_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  evaluated_ms INTEGER NOT NULL,
  PRIMARY KEY (family, digest),
  FOREIGN KEY (family, digest) REFERENCES records(family, digest)
);

CREATE TABLE evaluation_results (
  family TEXT NOT NULL CHECK (family = 'result-evaluation'),
  digest TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  result_digest TEXT NOT NULL,
  PRIMARY KEY (family, digest, ordinal),
  FOREIGN KEY (family, digest) REFERENCES records(family, digest)
);

CREATE TABLE verification_records (
  family TEXT NOT NULL CHECK (family = 'execution-verification'),
  digest TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  subject_record_digest TEXT NOT NULL,
  verifier_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  verified_ms INTEGER NOT NULL,
  PRIMARY KEY (family, digest),
  FOREIGN KEY (family, digest) REFERENCES records(family, digest)
);

CREATE TABLE announcement_keys (
  source_id TEXT NOT NULL,
  announcement_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  PRIMARY KEY (source_id, announcement_id)
);

CREATE TABLE location_observations (
  source_id TEXT NOT NULL,
  announcement_id TEXT NOT NULL,
  family TEXT NOT NULL,
  digest TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  binding_profile TEXT,
  locator_json TEXT,
  PRIMARY KEY (source_id, announcement_id),
  FOREIGN KEY (family, digest) REFERENCES records(family, digest),
  FOREIGN KEY (source_id, announcement_id)
    REFERENCES announcement_keys(source_id, announcement_id)
);

CREATE TABLE location_withdrawals (
  source_id TEXT NOT NULL,
  announcement_id TEXT NOT NULL,
  retracts_announcement_id TEXT NOT NULL,
  PRIMARY KEY (source_id, announcement_id),
  FOREIGN KEY (source_id, announcement_id)
    REFERENCES announcement_keys(source_id, announcement_id)
);
```

Add indexes for every public filter and sort tuple. Include `(started_ms DESC, digest ASC)`,
`(evaluated_ms DESC, digest ASC)`, `(verified_ms DESC, digest ASC)`, every exact actor/subject
filter, `entity_keys(entity_id, family, digest)`, and active-location lookup.

- [ ] **Step 5: Implement creation, opening, metadata validation, integrity, and close**

`createSqliteEvidenceCatalog` must fail if the target exists, create schema and metadata
transactionally, run `PRAGMA quick_check`, and return one handle implementing Reader and Writer.
`openSqliteEvidenceCatalog` must read metadata before preparing other statements and reject an
unknown SQLite schema version with `EvidenceCatalogError("IO_FAILURE", ...)`.

`integrityCheck()` returns:

```ts
export interface SqliteCatalogIntegrityReport {
  readonly valid: boolean;
  readonly messages: readonly string[];
}
```

Use `PRAGMA quick_check`; sort non-`ok` messages. `close()` is idempotent; later operations fail
with `EvidenceCatalogError("IO_FAILURE", "The SQLite Evidence Catalog is closed.")`.

- [ ] **Step 6: Run the schema gate**

Run:

```bash
yarn typecheck
yarn test src/schema.test.ts
yarn build
```

Expected: PASS.

- [ ] **Step 7: Commit the binding foundation**

```bash
git add packages/evidence-catalog-sqlite
git commit -s -m "feat(evidence-catalog-sqlite): define durable catalog schema"
```

---

### Task 2: Implement atomic Catalog writes and the shared contract

**Files:**
- Create: `packages/evidence-catalog-sqlite/src/projection-row.ts`
- Create: `packages/evidence-catalog-sqlite/src/writer.ts`
- Create: `packages/evidence-catalog-sqlite/src/writer.test.ts`
- Modify: `packages/evidence-catalog-sqlite/src/catalog.ts`
- Modify: `packages/evidence-catalog-sqlite/src/index.ts`

**Interfaces:**
- Consumes: the frozen schema and every `EvidenceCatalogWriter` operation.
- Produces: an idempotent transactional Writer that passes
  `describeEvidenceCatalogContract`.

- [ ] **Step 1: Run the generic Catalog contract against an empty implementation**

Create a temporary database per test and invoke:

```ts
describeEvidenceCatalogContract(async () => {
  const catalog = await createSqliteEvidenceCatalog({
    databasePath: join(temporaryRoot, "catalog.sqlite"),
    generation: fixtureGeneration,
  });
  return {
    reader: catalog,
    writer: catalog,
    cleanup: () => catalog.close(),
  };
});
```

Run `yarn test src/writer.test.ts`; expected: FAIL on the first Writer call.

- [ ] **Step 2: Normalize one immutable projection into query rows**

In `projection-row.ts`, recursively sort object keys, reject non-finite JSON, serialize without
mutating the caller, and compute SHA-256 over UTF-8 projection JSON. Produce:

```ts
interface ProjectionRows {
  readonly record: {
    readonly family: EvidenceRecordFamily;
    readonly digest: Sha256Digest;
    readonly byteSize: number;
    readonly projectionJson: string;
    readonly projectionHash: string;
  };
  readonly entityIds: readonly string[];
  readonly familyRow: Readonly<Record<string, string | number>>;
  readonly resultRows: readonly Readonly<Record<string, string | number>>[];
}
```

Build `entityIds` from declared occurrences plus every protocol-owned typed identity used by the
generic in-memory implementation. Convert RFC 3339 instants to epoch milliseconds.

- [ ] **Step 3: Implement atomic projection insertion**

Prepare all SQL statements once. In one synchronous SQLite transaction:

1. look up `(family, digest)`;
2. return `existing` when `projection_hash` and `projection_json` match;
3. throw `EvidenceCatalogError("PROJECTION_CONFLICT", ...)` on any mismatch;
4. insert `records`;
5. insert sorted unique `entity_keys`;
6. insert the family-specific row; and
7. insert ordered Result rows.

Foreign-key or constraint failures caused by caller data become
`EvidenceCatalogError("INVALID_PROJECTION", ...)`. Database failures become `IO_FAILURE`.

- [ ] **Step 4: Implement location observation identity**

Canonicalize a location payload using recursively key-sorted JSON and hash:

```ts
{
  kind: "available",
  reference,
  repositoryId,
  publishedLocation,
}
```

Within one transaction, register `(sourceId, announcementId)` in `announcement_keys`. Equal replay
returns `existing`; another kind or hash throws `LOCATION_CONFLICT`. Require the record projection
to exist before inserting the observation.

- [ ] **Step 5: Implement source-scoped withdrawal**

Hash `{ kind: "withdrawn", retractsAnnouncementId }` and register the withdrawal announcement key.
Return:

- `existing` for an equal replay;
- `absent` when the retracted available event is absent under the same source;
- `withdrawn` after first valid insertion; and
- `LOCATION_CONFLICT` for cross-source or incompatible reuse.

One source must never deactivate another source's observation.

- [ ] **Step 6: Prove transaction rollback and immutable replay**

Fault-inject a failure after `records`, after `entity_keys`, and after each family row. Reopen the
database and assert no partial projection exists. Mutate caller-owned nested arrays after a
successful write and assert the stored JSON remains unchanged.

Run:

```bash
yarn typecheck
yarn test src/writer.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Writer conformance**

```bash
git add packages/evidence-catalog-sqlite
git commit -s -m "feat(evidence-catalog-sqlite): persist catalog projections"
```

---

### Task 3: Implement bounded SQLite queries and distribution readiness

**Files:**
- Create: `packages/evidence-catalog-sqlite/src/cursors.ts`
- Create: `packages/evidence-catalog-sqlite/src/reader.ts`
- Create: `packages/evidence-catalog-sqlite/src/reader.test.ts`
- Create: `packages/evidence-catalog-sqlite/README.md`
- Create: `packages/evidence-catalog-sqlite/scripts/pack-smoke.mjs`
- Modify: `packages/evidence-catalog-sqlite/src/catalog.ts`
- Modify: `packages/evidence-catalog-sqlite/src/index.ts`
- Modify: `packages/evidence-catalog-sqlite/package.json`

**Interfaces:**
- Consumes: every generic Catalog Reader query and the immutable stored projection JSON.
- Produces: a complete packed SQLite Catalog binding.

- [ ] **Step 1: Write failing Reader and pagination tests**

Seed private/public Execution records sharing one Execution IRI, Evaluation and Verification
records, multiple location observations, and one withdrawal. Assert all generic contract filters,
active-only defaults, `availability: "any"`, exact lookup, entity lookup, location deduplication,
cursor continuation, and cursor/query mismatch rejection.

- [ ] **Step 2: Implement private opaque cursors**

Encode base64url JSON containing:

```ts
interface SqliteCatalogCursorV1 {
  readonly version: 1;
  readonly queryHash: string;
  readonly order: readonly (string | number)[];
}
```

Hash normalized query JSON. Reject malformed, wrong-version, or wrong-query cursors with
`EvidenceCatalogError("INVALID_QUERY", ...)`.

- [ ] **Step 3: Implement prepared bounded queries**

Validate `limit` from 1 through 100, defaulting to 50. Build SQL only from whitelisted clauses and
bind every caller value as a parameter. Fetch `limit + 1` keys, parse projection JSON, and create
`nextCursor` from the last returned ordering tuple.

Use these exact orderings:

- Executions: `started_ms DESC, digest ASC`;
- Evaluations: `evaluated_ms DESC, digest ASC`;
- Verifications: `verified_ms DESC, digest ASC`; and
- Entity records: `family ASC, digest ASC`.

Default queries require at least one active location observation. Exact `getRecord` may return a
known unavailable projection.

- [ ] **Step 4: Implement active location deduplication**

Exclude an observation when a valid same-source withdrawal targets it. Deduplicate local-only
locations by `repositoryId`. Deduplicate portable locations by `bindingProfile` plus canonical
`locator_json`. Sort returned locations by repository ID, binding profile, and locator JSON.

- [ ] **Step 5: Complete the Catalog contract and corruption tests**

Run the exported contract kit against SQLite. Add malformed stored JSON, missing family row,
foreign-key corruption, already-aborted operation, and closed-handle cases. Corrupt state must
throw `IO_FAILURE`; it must not synthesize a projection.

- [ ] **Step 6: Add README and packed-install smoke**

Document:

- the Catalog remains derived state;
- how to create/open a generation;
- Reader/Writer examples;
- WAL and native-addon requirements;
- private/public records remain record-scoped; and
- search, corpus, trust, retention, and repository bytes are excluded.

The pack smoke installs tarballs for Protocol, Repository, Catalog, and this binding in a
temporary project. It creates, reopens, queries, and integrity-checks one Catalog. Verify the only
Jinn runtime dependencies are Catalog and Repository and that `dist/` contains no tests.

- [ ] **Step 7: Run and commit the complete binding**

Run:

```bash
yarn typecheck
yarn test
yarn build
yarn pack:smoke
git add packages/evidence-catalog-sqlite
git commit -s -m "feat(evidence-catalog-sqlite): query durable projections"
```

PR 1 ends here. It is independently reviewable and satisfies the generic Catalog contract without
introducing a runtime or announcement source.

---

### Task 4: Freeze the local announcement journal contract

**Files:**
- Create: `packages/evidence-announcement-journal/package.json`
- Create: `packages/evidence-announcement-journal/yarn.lock`
- Create: `packages/evidence-announcement-journal/.yarnrc.yml`
- Create: `packages/evidence-announcement-journal/.gitignore`
- Create: `packages/evidence-announcement-journal/tsconfig.json`
- Create: `packages/evidence-announcement-journal/tsconfig.build.json`
- Create: `packages/evidence-announcement-journal/src/types.ts`
- Create: `packages/evidence-announcement-journal/src/errors.ts`
- Create: `packages/evidence-announcement-journal/src/marker.ts`
- Create: `packages/evidence-announcement-journal/src/index.ts`
- Create: `packages/evidence-announcement-journal/src/contracts.test.ts`

**Interfaces:**
- Consumes: `EvidenceRecordAnnouncementSource`, `PublishedEvidenceLocation`, and
  `EvidenceRecordReference`.
- Produces:

```ts
export const EVIDENCE_ANNOUNCEMENT_JOURNAL_FORMAT = {
  format: "jinn-evidence-announcement-journal",
  version: 1,
} as const;

export interface AppendAvailableAnnouncementInput {
  readonly announcementId: string;
  readonly reference: EvidenceRecordReference;
  readonly repositoryId: string;
  readonly publishedLocation?: PublishedEvidenceLocation;
}

export interface AnnouncementJournalAppendReceipt {
  readonly announcement: EvidenceRecordAnnouncement & {
    readonly kind: "available";
  };
  readonly cursor: string;
  readonly status: "created" | "existing";
}

export interface FilesystemEvidenceAnnouncementJournal
  extends EvidenceRecordAnnouncementSource {
  readonly sourceId: string;
  appendAvailable(
    input: AppendAvailableAnnouncementInput,
    options?: CatalogOperationOptions,
  ): Promise<AnnouncementJournalAppendReceipt>;
  getHighWaterCursor(
    options?: CatalogOperationOptions,
  ): Promise<string | undefined>;
  getEntryCount(
    options?: CatalogOperationOptions,
  ): Promise<number>;
  findAvailable(
    reference: EvidenceRecordReference,
    options?: CatalogOperationOptions,
  ): Promise<AnnouncementJournalAppendReceipt | null>;
  close(): Promise<void>;
}

export function openFilesystemEvidenceAnnouncementJournal(options: {
  readonly rootDir: string;
  readonly sourceId: string;
}): Promise<FilesystemEvidenceAnnouncementJournal>;
```

- [ ] **Step 1: Scaffold the package and red contract tests**

Runtime dependencies are only:

```json
{
  "@jinn-network/evidence-catalog": "0.1.0",
  "@jinn-network/evidence-repository": "0.1.0"
}
```

Write tests for empty high-water and zero-entry state, append/read round trip, equal replay,
conflicting announcement reuse, source identity, cursor continuation, exact entry count, one
announcement per emitted batch, and closed-handle behavior.

- [ ] **Step 2: Install and prove the tests fail**

Run:

```bash
cd packages/evidence-announcement-journal
yarn install
yarn test src/contracts.test.ts
```

Expected: FAIL because the journal implementation is absent.

- [ ] **Step 3: Define stable errors**

Export:

```ts
export const EVIDENCE_ANNOUNCEMENT_JOURNAL_ERROR_CODES = [
  "INVALID_ANNOUNCEMENT",
  "ANNOUNCEMENT_CONFLICT",
  "CURSOR_INVALID",
  "JOURNAL_VERSION_UNSUPPORTED",
  "JOURNAL_CORRUPT",
  "STALE_WRITER",
  "JOURNAL_CLOSED",
  "OPERATION_ABORTED",
  "IO_FAILURE",
] as const;
```

Implement `EvidenceAnnouncementJournalError` with `code`, `message`, and `ErrorOptions`. Validate
non-empty source, announcement, and repository IDs, canonical record references, absolute binding
profiles, and finite JSON locators.

- [ ] **Step 4: Freeze marker and event shapes**

Use:

```ts
interface AnnouncementJournalMarkerV1 {
  readonly format: "jinn-evidence-announcement-journal";
  readonly version: 1;
  readonly sourceId: string;
}

interface AnnouncementJournalEntryV1 {
  readonly version: 1;
  readonly revision: number;
  readonly predecessorDigest?: `sha256:${string}`;
  readonly announcement: EvidenceRecordAnnouncement & {
    readonly kind: "available";
  };
}
```

The entry digest is SHA-256 over its exact deterministic UTF-8 file bytes; it is not embedded in
the entry. A cursor commits to revision and entry digest.

- [ ] **Step 5: Run and commit the frozen contract**

Run `yarn typecheck`; expected: PASS. The behavior test remains red until Task 5.

```bash
git add packages/evidence-announcement-journal
git commit -s -m "feat(evidence-announcement-journal): define local source contract"
```

---

### Task 5: Implement durable journal append, replay, and distribution

**Files:**
- Create: `packages/evidence-announcement-journal/src/paths.ts`
- Create: `packages/evidence-announcement-journal/src/serialization.ts`
- Create: `packages/evidence-announcement-journal/src/cursor.ts`
- Create: `packages/evidence-announcement-journal/src/replay.ts`
- Create: `packages/evidence-announcement-journal/src/journal.ts`
- Create: `packages/evidence-announcement-journal/src/journal.test.ts`
- Create: `packages/evidence-announcement-journal/README.md`
- Create: `packages/evidence-announcement-journal/scripts/pack-smoke.mjs`
- Modify: `packages/evidence-announcement-journal/src/index.ts`
- Modify: `packages/evidence-announcement-journal/package.json`

**Interfaces:**
- Consumes: the Task 4 journal types.
- Produces: a secure replayable filesystem announcement source.

- [ ] **Step 1: Write failing durability and corruption tests**

Use a temporary root and cover:

- snapshot read from the beginning and after every cursor;
- 20-digit zero-padded revision filenames;
- equal and conflicting append races;
- interruption before file sync, hard-link publication, temporary-link removal, and directory
  sync;
- ignored temporary files;
- missing revision, changed event bytes, wrong predecessor, invalid UTF-8, invalid JSON, and marker
  mismatch;
- root, marker, event, and parent symlinks;
- non-private modes corrected on open; and
- a cursor from another chain rejected.

- [ ] **Step 2: Implement private deterministic serialization**

Recursively sort object keys, reject `undefined` and non-finite numbers, serialize with two-space
indentation and one trailing newline, and hash using `node:crypto` SHA-256. Do not claim RFC 8785
conformance.

Encode cursor JSON:

```ts
interface AnnouncementJournalCursorV1 {
  readonly version: 1;
  readonly sourceId: string;
  readonly revision: number;
  readonly entryDigest: `sha256:${string}`;
}
```

using base64url. Decode strictly and validate against replayed revision state.

- [ ] **Step 3: Implement safe paths and marker opening**

Use:

```text
<journal-root>/
  journal.json
  events/
    00000000000000000001.json
    00000000000000000002.json
```

Create directories at `0700` and files at `0600` on POSIX. Reject symlinks and ownership changes
in managed paths. Create `journal.json` through temporary-file sync, atomic rename, and parent
directory sync.

- [ ] **Step 4: Replay the complete chain into immutable indexes**

On open, read all non-temporary event filenames, require contiguous revisions starting at one,
decode fatal UTF-8, validate the event and fixed source ID, verify each predecessor digest, and
build maps by revision, `(sourceId, announcementId)`, and record reference.

An equal duplicate announcement ID can exist only through replay of the same physical entry; a
second event reusing that ID is `JOURNAL_CORRUPT`.

If a final revision file has link count two after a crash, recover only when exactly one
journal-owned temporary path points to the same device and inode. Remove that temporary link,
sync the directory, and continue replay. Any other extra hard link is `JOURNAL_CORRUPT`.

- [ ] **Step 5: Implement idempotent durable append**

Serialize appends in one process. Before publishing, refresh the final on-disk revision and fail
with `STALE_WRITER` if it differs from in-memory state. Equal announcement replay returns the
original receipt. Incompatible reuse throws `ANNOUNCEMENT_CONFLICT`.

Publish the next event with:

1. exclusive temporary-file creation in `events/`;
2. full byte write;
3. file sync;
4. same-directory hard-link publication to the final revision path, failing on `EEXIST`;
5. temporary-link removal;
6. events-directory sync; and
7. in-memory index update.

Only step 7 makes the append visible to the current handle.

- [ ] **Step 6: Implement finite snapshot replay**

Each `read({ after })` captures the high-water revision when iteration begins and yields exactly
one `AnnouncementBatch` per event through that revision. New appends belong to a later read. Check
the AbortSignal before every file operation and yield.

- [ ] **Step 7: Add README, pack smoke, and complete verification**

Document that the journal is a private local binding, not portable evidence. The packed smoke
opens a journal, appends two records, resumes after the first cursor, and verifies exact replay.

Run:

```bash
yarn typecheck
yarn test
yarn build
yarn pack:smoke
git add packages/evidence-announcement-journal
git commit -s -m "feat(evidence-announcement-journal): add durable replay"
```

PR 2 ends here. It is independently testable and has no repository binding, Indexer, SQLite
Catalog, or application dependency.

---

### Task 6: Freeze runtime contracts, root ownership, and operational state

**Files:**
- Create: `packages/evidence-local-runtime/package.json`
- Create: `packages/evidence-local-runtime/yarn.lock`
- Create: `packages/evidence-local-runtime/.yarnrc.yml`
- Create: `packages/evidence-local-runtime/.gitignore`
- Create: `packages/evidence-local-runtime/tsconfig.json`
- Create: `packages/evidence-local-runtime/tsconfig.build.json`
- Create: `packages/evidence-local-runtime/src/types.ts`
- Create: `packages/evidence-local-runtime/src/errors.ts`
- Create: `packages/evidence-local-runtime/src/paths.ts`
- Create: `packages/evidence-local-runtime/src/marker.ts`
- Create: `packages/evidence-local-runtime/src/lock.ts`
- Create: `packages/evidence-local-runtime/src/operations-schema.ts`
- Create: `packages/evidence-local-runtime/src/operations-store.ts`
- Create: `packages/evidence-local-runtime/src/index.ts`
- Create: `packages/evidence-local-runtime/src/contracts.test.ts`
- Create: `packages/evidence-local-runtime/src/root.test.ts`

**Interfaces:**
- Consumes: all three concrete local packages plus the generic Repository, Catalog, and Indexer.
- Freezes the exact approved runtime types below. Task 9 adds the public
  `openLocalEvidenceRuntime` factory after every required lifecycle component exists:

```ts
export interface OpenLocalEvidenceRuntimeOptions {
  readonly rootDir: string;
  readonly signal?: AbortSignal;
}

export interface LocalEvidenceRuntime {
  readonly repository: EvidenceRepository;
  readonly catalog: EvidenceCatalogReader;
  sync(options?: LocalRuntimeOperationOptions): Promise<LocalEvidenceSyncReport>;
  awaitIndexed(
    reference: EvidenceRecordReference,
    options?: LocalRuntimeOperationOptions,
  ): Promise<LocalEvidenceIndexingOutcome>;
  getStatus(): Promise<LocalEvidenceRuntimeStatus>;
  listIndexingFailures(
    query?: LocalIndexingFailureQuery,
    options?: LocalRuntimeOperationOptions,
  ): Promise<LocalIndexingFailurePage>;
  close(options?: LocalRuntimeOperationOptions): Promise<void>;
}

```

- [ ] **Step 1: Scaffold the runtime and red public-contract tests**

Use runtime dependencies:

```json
{
  "@jinn-network/evidence-announcement-journal": "0.1.0",
  "@jinn-network/evidence-catalog": "0.1.0",
  "@jinn-network/evidence-catalog-sqlite": "0.1.0",
  "@jinn-network/evidence-indexer": "0.1.0",
  "@jinn-network/evidence-protocol": "0.1.0",
  "@jinn-network/evidence-repository": "0.1.0",
  "@jinn-network/evidence-repository-fs": "0.1.0",
  "better-sqlite3": "13.0.1"
}
```

Use Execution Recorder only as a dev dependency for integration tests. Add portal resolutions for
every Jinn package.

- [ ] **Step 2: Define exact public outcome shapes**

Add:

```ts
export type LocalRuntimeLifecycleState =
  | "ready"
  | "degraded"
  | "rebuilding"
  | "closing"
  | "closed";

export interface LocalRuntimeOperationOptions {
  readonly signal?: AbortSignal;
}

export type LocalIndexingFailureCategory =
  | "protocol-nonconformance"
  | "content-corrupt"
  | "announcement-invalid"
  | "validated-record-inconsistent"
  | "catalog-conflict";

export interface LocalIndexingFailure {
  readonly reference: EvidenceRecordReference;
  readonly category: LocalIndexingFailureCategory;
  readonly sourceCode: string;
  readonly message: string;
  readonly diagnostics?: readonly ConformanceDiagnostic[];
  readonly observedAt: string;
}

export interface LocalTransientIndexingFailure {
  readonly reference?: EvidenceRecordReference;
  readonly sourceCode: string;
  readonly message: string;
  readonly attempt: number;
  readonly observedAt: string;
}

export type LocalEvidenceIndexingOutcome =
  | {
      readonly status: "indexed";
      readonly reference: EvidenceRecordReference;
      readonly projection: CatalogRecordProjection;
    }
  | {
      readonly status: "failed";
      readonly reference: EvidenceRecordReference;
      readonly failure: LocalIndexingFailure;
    }
  | {
      readonly status: "not-announced";
      readonly reference: EvidenceRecordReference;
    };

export interface LocalEvidenceSyncReport {
  readonly status: "synchronized";
  readonly highWaterCursor?: string;
  readonly indexed: number;
  readonly failed: number;
}

export interface LocalIndexingFailureQuery {
  readonly reference?: EvidenceRecordReference;
  readonly category?: LocalIndexingFailureCategory;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface LocalIndexingFailurePage {
  readonly items: readonly LocalIndexingFailure[];
  readonly nextCursor?: string;
}

export interface LocalEvidenceRuntimeStatus {
  readonly state: LocalRuntimeLifecycleState;
  readonly sourceId: string;
  readonly repositoryId: string;
  readonly activeGenerationId: string;
  readonly journalHighWaterCursor?: string;
  readonly indexerCheckpointCursor?: string;
  readonly pendingPublications: number;
  readonly pendingAnnouncements: number;
  readonly terminalFailureCount: number;
  readonly recentFailures: readonly LocalIndexingFailure[];
  readonly transientFailure?: LocalTransientIndexingFailure;
}
```

Failure-query limit defaults to 50 and is restricted to 1 through 100. Cursors are opaque.

- [ ] **Step 3: Define stable runtime errors**

Export:

```ts
export const LOCAL_EVIDENCE_RUNTIME_ERROR_CODES = [
  "ROOT_IN_USE",
  "ROOT_VERSION_UNSUPPORTED",
  "RUNTIME_CORRUPT",
  "UNSAFE_PATH",
  "RUNTIME_CLOSING",
  "RUNTIME_CLOSED",
  "INVALID_QUERY",
  "OPERATION_ABORTED",
  "SYNCHRONIZATION_UNAVAILABLE",
  "IO_FAILURE",
] as const;
```

Implement `LocalEvidenceRuntimeError` and guards. Repository operations exposed through the
decorator must throw `EvidenceRepositoryError`, not runtime errors.

- [ ] **Step 4: Implement secure root marker and identities**

Create:

```ts
interface LocalEvidenceRuntimeMarkerV1 {
  readonly format: "jinn-local-evidence-runtime";
  readonly version: 1;
  readonly runtimeId: `urn:uuid:${string}`;
  readonly sourceId: `urn:uuid:${string}`;
  readonly repositoryId: string;
}
```

Generate all values once. Set `repositoryId` to `local:<runtime UUID without urn:uuid:>`. Persist
the marker with deterministic JSON, file and directory sync, and private modes. Equal reopen
preserves identities; incompatible markers fail.

- [ ] **Step 5: Implement an OS-backed exclusive root lock**

Use `runtime.lock` as a dedicated SQLite database. Open with zero busy timeout, set
`PRAGMA locking_mode=EXCLUSIVE`, create a one-row lock metadata table, perform one write so SQLite
acquires and retains the exclusive file lock, and keep the connection open for the runtime
lifetime. A second process maps `SQLITE_BUSY` or `SQLITE_LOCKED` to `ROOT_IN_USE`. Process death
releases the operating-system lock; do not inspect PIDs or delete a supposed stale lock file.

- [ ] **Step 6: Create the operational database**

In `operations/runtime.sqlite`, use WAL and `synchronous=FULL`. Create:

```sql
CREATE TABLE publication_outbox (
  operation_key TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  digest TEXT NOT NULL,
  record_bytes BLOB NOT NULL,
  byte_size INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staged', 'stored', 'announced')),
  announcement_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE indexer_checkpoints (
  generation_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  cursor TEXT NOT NULL,
  PRIMARY KEY (generation_id, source_id)
);

CREATE TABLE indexing_outcomes (
  generation_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  announcement_id TEXT NOT NULL,
  family TEXT NOT NULL,
  digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('indexed', 'failed')),
  failure_code TEXT,
  failure_json TEXT,
  journal_cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (generation_id, family, digest)
);

CREATE TABLE processed_cursors (
  generation_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  cursor TEXT NOT NULL,
  indexed_total INTEGER NOT NULL,
  failed_total INTEGER NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (generation_id, source_id, cursor)
);

CREATE TABLE transient_indexing_failure (
  generation_id TEXT PRIMARY KEY,
  failure_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Implement transactional adapters for outbox state, generation-scoped
`EvidenceIndexerCheckpointStore`, outcomes, per-cursor cumulative counts, bounded failure queries,
and summary counts. The operation that stores one terminal outcome, records the processed cursor,
and advances the current checkpoint must be one SQLite transaction.

Freeze the internal store surface in `operations-store.ts`:

```ts
interface PublicationIntent {
  readonly operationKey: string;
  readonly reference: EvidenceRecordReference;
  readonly recordBytes: Uint8Array;
  readonly byteSize: number;
  readonly announcementId: string;
  readonly state: "staged" | "stored" | "announced";
}

interface IndexingCheckpointInput {
  readonly generationId: string;
  readonly sourceId: string;
  readonly announcementId: string;
  readonly reference: EvidenceRecordReference;
  readonly journalCursor: string;
  readonly indexedTotal: number;
  readonly failedTotal: number;
  readonly observedAt: string;
}

type IndexedCheckpointInput = IndexingCheckpointInput;

interface FailedCheckpointInput extends IndexingCheckpointInput {
  readonly failure: LocalIndexingFailure;
}

type StoredIndexingOutcome =
  | {
      readonly status: "indexed";
      readonly reference: EvidenceRecordReference;
      readonly journalCursor: string;
    }
  | {
      readonly status: "failed";
      readonly reference: EvidenceRecordReference;
      readonly journalCursor: string;
      readonly failure: LocalIndexingFailure;
    };

interface LocalOperationsSummary {
  readonly pendingPublications: number;
  readonly checkpointCursor?: string;
  readonly indexed: number;
  readonly failed: number;
  readonly transientFailure?: LocalTransientIndexingFailure;
}

interface LocalOperationsStore {
  stagePublication(intent: PublicationIntent): Promise<"created" | "existing">;
  listPendingPublications(): Promise<readonly PublicationIntent[]>;
  markPublicationStored(operationKey: string): Promise<void>;
  markPublicationAnnounced(operationKey: string): Promise<void>;
  completePublication(operationKey: string): Promise<void>;
  getCheckpoint(
    generationId: string,
    sourceId: string,
  ): Promise<string | undefined>;
  recordIndexedAndCheckpoint(input: IndexedCheckpointInput): Promise<void>;
  recordFailureAndCheckpoint(input: FailedCheckpointInput): Promise<void>;
  getOutcome(
    generationId: string,
    reference: EvidenceRecordReference,
  ): Promise<StoredIndexingOutcome | null>;
  setTransientFailure(
    generationId: string,
    failure: LocalTransientIndexingFailure,
  ): Promise<void>;
  clearTransientFailure(generationId: string): Promise<void>;
  listFailures(
    query?: LocalIndexingFailureQuery,
  ): Promise<LocalIndexingFailurePage>;
  getSummary(generationId: string): Promise<LocalOperationsSummary>;
  close(): Promise<void>;
}
```

`recordIndexedAndCheckpoint` stores the indexed outcome and cursor totals in one transaction.
`recordFailureAndCheckpoint` does the same for the supplied terminal failure.

- [ ] **Step 7: Test locking, corruption, and modes**

Spawn a second Node process against the same root and require `ROOT_IN_USE`. Kill the first
without cleanup and prove a new process opens without stale-lock heuristics. Test symlinked roots
and control files, incompatible marker versions, corrupt operations tables, private modes,
already-aborted open, and idempotent close primitives.

- [ ] **Step 8: Run and commit the runtime foundation**

Run:

```bash
yarn typecheck
yarn test src/contracts.test.ts src/root.test.ts
yarn build
git add packages/evidence-local-runtime
git commit -s -m "feat(evidence-local-runtime): define embedded runtime contracts"
```

---

### Task 7: Add the transactional publication outbox and repository decorator

**Files:**
- Create: `packages/evidence-local-runtime/src/publication.ts`
- Create: `packages/evidence-local-runtime/src/repository.ts`
- Create: `packages/evidence-local-runtime/src/publication.test.ts`
- Create: `packages/evidence-local-runtime/src/repository.test.ts`
- Modify: `packages/evidence-local-runtime/src/index.ts`

**Interfaces:**
- Consumes: the filesystem Repository, journal, marker identities, and operational outbox.
- Produces:

```ts
createAnnouncementAwareRepository(options: {
  readonly repository: EvidenceRepository;
  readonly journal: FilesystemEvidenceAnnouncementJournal;
  readonly operations: LocalOperationsStore;
  readonly sourceId: string;
  readonly repositoryId: string;
  readonly assertReadable: () => void;
  readonly assertWritable: () => void;
  readonly onPublished: (
    reference: EvidenceRecordReference,
    cursor: string,
  ) => void;
}): EvidenceRepository;

recoverPendingPublications(options: {
  readonly repository: EvidenceRepository;
  readonly journal: FilesystemEvidenceAnnouncementJournal;
  readonly operations: LocalOperationsStore;
  readonly repositoryId: string;
  readonly signal?: AbortSignal;
}): Promise<void>;
```

- [ ] **Step 1: Write failing exact-delegation and crash-point tests**

Assert artifact methods call the underlying Repository exactly once and never touch outbox or
journal state. For records, inject failures:

- before and after outbox staging;
- before and after repository write;
- before and after outbox `stored`;
- before and after journal append;
- before and after outbox `announced`; and
- before and after staged-byte removal.

After each simulated crash, reopen state, call `recoverPendingPublications`, and assert one exact
record, one logical announcement, and no remaining staged bytes.

Every Repository method first calls `assertReadable`; both put methods additionally call
`assertWritable`. Closing rejects new writes while allowing already-started reads to finish, and a
closed runtime rejects every later Repository call.

- [ ] **Step 2: Define deterministic operation and announcement identities**

Compute SHA-256 over deterministic UTF-8 JSON:

```ts
{
  version: 1,
  sourceId,
  repositoryId,
  family,
  digest,
}
```

Use `operation_key = "sha256:<hex>"` and
`announcementId = "urn:jinn:local-announcement:sha256:<hex>"`. Do not include time, process ID,
path, or call order.

- [ ] **Step 3: Stage exact bytes before external writes**

`putRecord(family, bytes)` must:

1. assert runtime writable and operation active;
2. copy caller bytes immediately;
3. derive the exact record reference with Repository utilities;
4. join or acquire an in-process mutex keyed by operation key;
5. insert or compare the full staged outbox row;
6. call the underlying `putRecord`;
7. require its returned reference and size to match the staged intent;
8. mark `stored`;
9. append the deterministic available announcement;
10. require the journal receipt to match;
11. mark `announced`;
12. delete the outbox row;
13. call `onPublished(reference, journalReceipt.cursor)`; and
14. release the keyed mutex and return the underlying Repository receipt.

An existing operation with different bytes or metadata is `EvidenceRepositoryError(
"REFERENCE_CONFLICT", ...)`.
Release the keyed mutex in `finally`; equal concurrent callers await the same publication promise
and receive equivalent receipts.

- [ ] **Step 4: Recover every persisted state**

For `staged`, retry the Repository write from the staged BLOB. For `stored`, verify
`getRecord(reference)` succeeds before announcing. For `announced`, replay the equal append and
remove the row. Process pending rows by operation key so recovery order is deterministic. The
Indexer starts after recovery and consumes every recovered announcement from its checkpoint.

Never announce when exact Repository bytes are missing or corrupt. Preserve underlying Repository
error identity.

- [ ] **Step 5: Map local publication failures to Repository errors**

Journal, outbox, and runtime-lifecycle errors occur behind an `EvidenceRepository` interface. Map:

- abort to `OPERATION_ABORTED`;
- closed/closing runtime to `IO_FAILURE`;
- journal or outbox access denial to `ACCESS_DENIED`; and
- journal/outbox corruption or incompatible state to `IO_FAILURE`.

Keep the original error as `cause`. Do not wrap an existing `EvidenceRepositoryError`.

- [ ] **Step 6: Prove idempotence, concurrency, and byte snapshotting**

Mutate the caller's `Uint8Array` immediately after invocation and prove staged and repository bytes
retain the original snapshot. Run 20 concurrent identical puts and require one outbox operation
and one announcement. Run same bytes under two record families and require two announcements but
the correct family-specific Repository receipts.

- [ ] **Step 7: Run and commit durable publication**

Run:

```bash
yarn typecheck
yarn test src/publication.test.ts src/repository.test.ts
yarn build
git add packages/evidence-local-runtime
git commit -s -m "feat(evidence-local-runtime): publish repository writes durably"
```

PR 3 ends here. It proves automatic local discovery publication and crash recovery without yet
opening the complete runtime or running the Indexer.

---

### Task 8: Run local indexing, synchronization, and failure inspection

**Files:**
- Create: `packages/evidence-local-runtime/src/checkpoints.ts`
- Create: `packages/evidence-local-runtime/src/indexing-worker.ts`
- Create: `packages/evidence-local-runtime/src/indexing-worker.test.ts`
- Create: `packages/evidence-local-runtime/src/status.test.ts`
- Modify: `packages/evidence-local-runtime/src/types.ts`
- Modify: `packages/evidence-local-runtime/src/operations-store.ts`

**Interfaces:**
- Consumes: `EvidenceIndexer.index`, one-event journal batches, SQLite Catalog Writer, and
  generation-scoped operational state.
- Produces an internal worker with:

```ts
interface LocalEvidenceIndexingWorker {
  wake(): void;
  syncTo(
    highWaterCursor: string | undefined,
    options?: LocalRuntimeOperationOptions,
  ): Promise<LocalEvidenceSyncReport>;
  awaitReference(
    reference: EvidenceRecordReference,
    options?: LocalRuntimeOperationOptions,
  ): Promise<LocalEvidenceIndexingOutcome>;
  getStatus(): Promise<LocalIndexerStatus>;
  stop(): Promise<void>;
}

interface LocalIndexerStatus {
  readonly running: boolean;
  readonly stopped: boolean;
  readonly checkpointCursor?: string;
  readonly indexed: number;
  readonly failed: number;
  readonly transientFailure?: LocalTransientIndexingFailure;
}
```

- [ ] **Step 1: Write failing indexed, rejected, retry, and checkpoint tests**

Use the protocol golden records and a corrupt record. Cover:

- three families reaching indexed outcomes;
- a protocol rejection becoming a terminal failure;
- terminal digest/reference corruption;
- repository access and I/O failures remaining retryable;
- Catalog I/O remaining retryable;
- checkpoint only after durable outcome state;
- replay after outcome but before checkpoint;
- later announcements continuing after a terminal failure;
- `awaitReference` indexed, failed, not-announced, abort, and shutdown behavior; and
- `syncTo` capturing a fixed high-water mark while later writes continue.

- [ ] **Step 2: Implement the fixed local repository resolver**

Resolve only the marker's exact `repositoryId` to the announcement-aware repository. Return
`null` for every other ID. Local announcements omit `publishedLocation`; no filesystem path enters
the Catalog.

- [ ] **Step 3: Implement deployment-owned terminal classification**

Treat these immutable record failures as terminal and checkpointable:

- protocol `rejected` result;
- `EvidenceRepositoryError("CONTENT_CORRUPT")`;
- Indexer `ANNOUNCEMENT_INVALID`, `REFERENCE_MISMATCH`, and
  `VALIDATED_RECORD_INCONSISTENT`;
- Catalog `PROJECTION_CONFLICT`, `LOCATION_CONFLICT`, `INVALID_PROJECTION`, and
  `INVALID_QUERY`.

Treat dependency unavailable, access denied, Repository/Catalog `IO_FAILURE`, and unexpected
filesystem errors as retryable. Abort stops the current run without checkpointing. Persist the
complete terminal failure before moving the checkpoint.

- [ ] **Step 4: Process one journal event at a time**

Read the generation checkpoint, request a finite journal snapshot after it, and for each one-event
batch:

1. call `indexer.index`;
2. transactionally persist the indexed or terminal-failed outcome, cumulative cursor counts, and
   that generation's source checkpoint;
3. clear any transient failure for the generation; and
4. notify synchronization and reference waiters.

On retryable failure, persist current transient state, stop advancing, and retry with delays of
100 ms, 250 ms, 500 ms, 1 s, 2 s, then 5 s maximum. `wake()` interrupts the delay when a new
publication or shutdown occurs.

- [ ] **Step 5: Implement bounded operational failure queries**

Store failure JSON with family, digest, stable category, source error code, message,
protocol diagnostics, and observed time. Do not store stack traces in the public value.

`listIndexingFailures` accepts exact reference, category, limit, and opaque cursor. Order by
`updated_at DESC`, family, digest. `getStatus()` returns total count and at most the ten most recent
failures. Compute pending announcements as the journal entry count minus the active generation's
cumulative indexed and failed totals; never infer it by parsing an opaque cursor.

The failure cursor is base64url JSON:

```ts
interface LocalFailureCursorV1 {
  readonly version: 1;
  readonly queryHash: string;
  readonly updatedAt: string;
  readonly family: EvidenceRecordFamily;
  readonly digest: Sha256Digest;
}
```

Reject malformed or cross-query cursor reuse with
`LocalEvidenceRuntimeError("INVALID_QUERY", ...)`.

- [ ] **Step 6: Implement synchronization semantics**

`syncTo(undefined)` returns zero counts immediately for an empty journal. Otherwise wait until a
`processed_cursors` row exists for the exact captured cursor and return its stored cumulative
indexed and failed counts. This remains correct if the worker processes later announcements before
the waiting promise resumes.

If the worker is stopped, Catalog generation is unavailable, or a retryable failure remains when
the caller's signal aborts, throw the appropriate runtime error. Never report a later cursor as
proof that an earlier requested cursor failed to process.

- [ ] **Step 7: Run and commit worker behavior**

Run:

```bash
yarn typecheck
yarn test src/indexing-worker.test.ts src/status.test.ts
yarn build
git add packages/evidence-local-runtime
git commit -s -m "feat(evidence-local-runtime): index local announcements"
```

---

### Task 9: Add Catalog generations and complete runtime lifecycle

**Files:**
- Create: `packages/evidence-local-runtime/src/catalog-reader.ts`
- Create: `packages/evidence-local-runtime/src/generations.ts`
- Create: `packages/evidence-local-runtime/src/runtime.ts`
- Create: `packages/evidence-local-runtime/src/generations.test.ts`
- Create: `packages/evidence-local-runtime/src/runtime.test.ts`
- Modify: `packages/evidence-local-runtime/src/index.ts`

**Interfaces:**
- Consumes: Tasks 6–8.
- Produces the complete `openLocalEvidenceRuntime` implementation and stable Reader proxy:

```ts
export function openLocalEvidenceRuntime(
  options: OpenLocalEvidenceRuntimeOptions,
): Promise<LocalEvidenceRuntime>;
```

- [ ] **Step 1: Write failing fresh-open, restart, rebuild, and close tests**

Cover:

- fresh root creates generation and reaches ready;
- restart preserves runtime/source/repository identities and Catalog contents;
- pending outbox recovery occurs before worker start;
- existing valid generation opens without replay;
- projector-version mismatch rebuilds from revision one;
- new announcements during rebuild appear in both old and new generations before switch;
- failure during rebuild leaves `current.json` unchanged;
- Reader calls started before switch complete against old generation;
- Reader calls after switch use new generation;
- close stops writes, drains durable publication, stops worker, closes databases, and releases
  lock; and
- second close is a no-op.

- [ ] **Step 2: Implement atomic generation pointers**

Use:

```ts
interface LocalCatalogPointerV1 {
  readonly format: "jinn-local-catalog-pointer";
  readonly version: 1;
  readonly generationId: `urn:uuid:${string}`;
  readonly databaseFile: string;
  readonly catalogSchemaVersion: string;
  readonly projectorVersion: string;
  readonly createdAt: string;
}
```

Require `databaseFile` to be one basename under `catalog/generations/`. Publish `current.json`
using temporary file, sync, atomic rename, and directory sync. Never modify an existing generation
database in place for an upgrade.

- [ ] **Step 3: Implement the switchable Reader proxy**

Route each Reader call through a lease on the current Catalog handle. On switch, new calls acquire
the new handle; existing leases finish against the old handle. Close the old Catalog only after
its lease count reaches zero. The proxy never implements or exposes the Writer.

- [ ] **Step 4: Implement rebuild and catch-up barrier**

For a new generation:

1. create a new SQLite Catalog with the current Catalog and projector versions;
2. create an independent checkpoint keyed by new generation ID;
3. replay from journal revision one with a dedicated Indexer;
4. continue catch-up until it reaches a captured high-water cursor;
5. enter a short publication/indexing barrier;
6. capture the final high-water cursor;
7. advance the new generation through it;
8. atomically publish `current.json`;
9. switch the Reader proxy and active worker; and
10. release the barrier.

If any step fails, close and retain the incomplete generation for diagnostics, keep the old
pointer, and report degraded rebuild status. Do not delete authoritative bytes or journal events.

- [ ] **Step 5: Implement open order exactly**

`openLocalEvidenceRuntime` must:

1. validate/create secure root directories;
2. acquire `runtime.lock`;
3. create/validate `runtime.json`;
4. open operations state;
5. open filesystem repository;
6. open announcement journal with marker `sourceId`;
7. recover pending publications;
8. open or create the current Catalog generation;
9. create resolver, Indexer, worker, and stable Reader proxy;
10. start catch-up; and
11. return the ready or rebuilding handle.

On any failure, close already-opened components in reverse order and preserve the primary error.

- [ ] **Step 6: Implement public methods and lifecycle**

- `repository` is the stable announcement-aware decorator.
- `catalog` is the stable Reader proxy.
- `sync()` captures journal high-water once and delegates to active worker.
- `awaitIndexed()` first validates the reference and uses journal/outcome state.
- `getStatus()` merges lifecycle, outbox, journal, generation, worker, and failure summaries.
- `listIndexingFailures()` delegates to bounded operational state.
- `close()` changes state to closing before awaiting active publications and rejects new writes.

After closed, status remains available with state `closed`; Repository, Catalog, sync, await, and
failure-list operations reject with their contract-appropriate closed errors.

- [ ] **Step 7: Run and commit the complete lifecycle**

Run:

```bash
yarn typecheck
yarn test src/generations.test.ts src/runtime.test.ts
yarn build
git add packages/evidence-local-runtime
git commit -s -m "feat(evidence-local-runtime): compose local evidence lifecycle"
```

---

### Task 10: Prove producer integration, harden distribution, and add CI

**Files:**
- Create: `packages/evidence-local-runtime/src/integration.test.ts`
- Create: `packages/evidence-local-runtime/src/hardening.test.ts`
- Create: `packages/evidence-local-runtime/README.md`
- Create: `packages/evidence-local-runtime/scripts/pack-smoke.mjs`
- Create: `.github/workflows/evidence-local-runtime-ci.yml`
- Modify: `packages/evidence-local-runtime/package.json`
- Modify: `packages/evidence-catalog-sqlite/package.json`
- Modify: `packages/evidence-announcement-journal/package.json`

**Interfaces:**
- Consumes: the complete package stack.
- Produces: publish-ready tarballs and one isolated CI workflow.

- [ ] **Step 1: Add the real Execution Recorder integration**

Create a completed recording from the Execution Recorder producer-contract fixture using
`runtime.repository`. Assert:

1. finalization returns before requiring Catalog polling;
2. `awaitIndexed(receipt.reference)` returns `indexed`;
3. `catalog.getRecord` returns the exact Execution projection;
4. Repository retrieval returns the Recorder's exact metadata bytes;
5. every referenced available artifact passes protocol integrity checking; and
6. restart preserves the projection and exact bytes.

- [ ] **Step 2: Add all-family and invalid-record integration**

Write the Protocol golden Result Evaluation and Execution Verification envelopes through
`runtime.repository` and assert all three families query by their exact typed fields. Persist
nonconforming bytes under a valid family and assert:

- Repository retrieval succeeds;
- `awaitIndexed` returns terminal failed diagnostics;
- Catalog exact lookup returns `null`;
- `sync()` completes and reports the failure; and
- a later conforming record still indexes.

- [ ] **Step 3: Add process and power-transition hardening**

Spawn child processes and terminate them at every named fault hook around:

- outbox stage/mark/delete;
- Repository return;
- journal file write/sync/rename/directory sync;
- outcome persistence;
- checkpoint persistence;
- generation pointer publication; and
- runtime close.

After each restart, require an intact root, one logical announcement per record, valid exact
Repository bytes, deterministic Catalog state, and no permanent synchronization hang.

- [ ] **Step 4: Write the runtime README**

Include:

- the architecture diagram from the design;
- `openLocalEvidenceRuntime` plus Execution Recorder example;
- persistence versus indexing semantics;
- `sync`, `awaitIndexed`, status, and bounded failure inspection;
- one-root and single-writer behavior;
- automatic local discovery versus explicit public publication;
- recovery and Catalog rebuild behavior; and
- exclusions for adapters, daemons, corpus, trust, scrubbing, retention, and migration.

- [ ] **Step 5: Add packed-install smoke**

Pack every Jinn runtime dependency into a temporary project, install the tarballs together with
the declared `better-sqlite3@13.0.1` npm dependency, and run the smoke against the installed
packages. It must:

- import all three new package roots;
- open a runtime;
- put and retrieve one golden record and artifact;
- await indexing and query the Catalog;
- close and reopen the root;
- verify package READMEs ship;
- verify `dist/` contains no tests; and
- verify no plugin, Autopilot, marketplace, OCI, IPFS, network, Recorder, or Attestation Issuer
  runtime dependency exists.

- [ ] **Step 6: Add ordered local-runtime CI**

Create `.github/workflows/evidence-local-runtime-ci.yml` for PRs and pushes to `next` when any
foundation, discovery, local package, or the workflow changes. Use Node 22 and Yarn 4.13.0.

Run immutable install, typecheck, tests, build, and pack smoke in dependency order:

```text
evidence-protocol
evidence-repository
evidence-repository-fs
evidence-catalog
evidence-indexer
evidence-catalog-sqlite
evidence-announcement-journal
execution-recorder
evidence-local-runtime
```

Run `yarn check:profile` for Evidence Protocol before its typecheck. Run `pack:smoke` only for
packages that define it.

Do not add service containers, secrets, npm publication, or network integration.

- [ ] **Step 7: Run the complete local acceptance gate**

From each of the three new package directories, run:

```bash
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

Also run the existing Protocol profile check and all Repository, Catalog, Indexer, and Recorder
tests. Expected: every command PASS.

- [ ] **Step 8: Commit integration and CI**

```bash
git add packages/evidence-catalog-sqlite \
  packages/evidence-announcement-journal \
  packages/evidence-local-runtime \
  .github/workflows/evidence-local-runtime-ci.yml
git commit -s -m "ci(evidence-local-runtime): verify embedded local flow"
```

PR 4 ends here.

---

## PR and execution structure

Ship four sequential PRs to `next`:

1. **SQLite Catalog binding:** Tasks 1–3.
2. **Local announcement journal:** Tasks 4–5.
3. **Runtime contracts and durable publication:** Tasks 6–7.
4. **Indexing, generations, integration, and CI:** Tasks 8–10.

PRs 1 and 2 are logically independent after the generic Discovery stack lands. If execution uses
subagents, they may be developed in parallel isolated worktrees from the same exact foundation
head, then ordered into the stack by the integration agent. Package manifests, package-local
lockfiles, root exports, and CI remain integration-agent-owned.

Tasks 6–9 are sequential because they share the runtime lifecycle and operational schema. After
Task 9, one worker may add process-level hardening while another writes README and packed-install
coverage. The integration agent combines them and runs two fresh final reviews:

- specification and layer-boundary compliance; and
- durability, recovery, SQLite safety, and security.

Do not integrate the plugin or any application adapter in this PR stack. The real Recorder
integration is a dev-only acceptance test proving the public boundary.

## Final acceptance checklist

- The three new packages are independent, publish-ready Yarn projects.
- The SQLite binding passes the complete generic Catalog contract.
- SQLite projection and location writes are atomic and idempotent.
- Typed queries are bounded, deterministic, and active-location-aware.
- Journal events are immutable, hash-chained, replayable, and privately formatted.
- Journal cursors commit to exact revision bytes and reject another chain.
- `runtime.repository` is the existing Repository interface, not a new facade contract.
- Artifacts delegate directly and are never independently announced.
- Record writes return only after exact storage and durable announcement.
- The outbox recovers every interruption without duplicate logical announcements.
- Runtime identity, announcement source, and repository handle remain stable across restart.
- One writable process owns a root; process death releases the OS-backed lock.
- Protocol rejection never becomes a Catalog projection.
- Immutable terminal failures do not block later announcements.
- Retryable dependency failures do not advance checkpoints.
- `sync()` commits to one captured journal high-water mark.
- `awaitIndexed()` distinguishes indexed, terminal failed, and not announced.
- Failure listing and status summaries are bounded.
- Indexer checkpoints are scoped by Catalog generation.
- A failed rebuild leaves the old Catalog pointer unchanged.
- Readers never observe a partially rebuilt generation.
- The Catalog can be reconstructed from retained journal events and exact Repository bytes.
- Repository and Catalog error identities remain intact at their public boundaries.
- A real Execution Recorder completes the full flow without private integration APIs.
- The packages contain no plugin, Autopilot, marketplace, OCI, IPFS, network, corpus, trust,
  retention, deletion, or migration behavior.
- No package is published and no hosted service is provisioned.
