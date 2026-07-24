# Jinn Evidence Discovery Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build publish-ready, backend-neutral Evidence Catalog contracts and a generic Evidence
Indexer that retrieves, validates, and deterministically projects all three Jinn Evidence Protocol
record families.

**Architecture:** `@jinn-network/evidence-catalog` defines immutable record-scoped projections,
typed queries, announcement/location contracts, Reader and Writer ports, and a reusable in-memory
contract implementation. `@jinn-network/evidence-indexer` depends only on the Evidence Protocol,
Repository contract, and Catalog contract; it resolves an injected repository, validates exact
bytes, projects records, writes the Catalog idempotently, and checkpoints replayable announcement
sources. Concrete SQLite, PostgreSQL, OCI-discovery, Ponder, filesystem-journal, corpus, plugin,
and marketplace integrations are excluded.

**Tech Stack:** TypeScript 5.9.3, ES2022 ESM, Node 22, Yarn 4.13.0, Vitest 4.1.8,
`@jinn-network/evidence-protocol@0.1.0`, and
`@jinn-network/evidence-repository@0.1.0`.

## Global Constraints

- Create independent package-local Yarn projects at `packages/evidence-catalog` and
  `packages/evidence-indexer`; do not add either package to a root workspace.
- Publish identities are `@jinn-network/evidence-catalog@0.1.0` and
  `@jinn-network/evidence-indexer@0.1.0`.
- Use Node `>=22`, Yarn `4.13.0`, ES2022, strict TypeScript, ESM, and MIT licensing, matching the
  existing Evidence Protocol and Repository foundation packages.
- `evidence-catalog` depends only on Evidence Protocol and Evidence Repository. Its optional
  `./testing` export may declare Vitest as an optional peer dependency.
- `evidence-indexer` depends only on Evidence Protocol, Evidence Repository, and Evidence Catalog.
- Do not import filesystem, OCI, IPFS, Ponder, marketplace, plugin, recorder, issuer, SQLite, or
  PostgreSQL code into either package.
- Catalog projections contain only protocol-defined structured fields. Unknown extension fields
  stay in repository bytes and are not promoted into portable Catalog properties.
- The Catalog never stores authoritative evidence bytes, decides trust, ranks evidence, creates
  corpus membership, or globally merges entities.
- Use exact Evidence Protocol validators; do not add a second conformance implementation.
- Process announcements at least once and checkpoint only after every event in a batch reaches a
  terminal indexed, rejected, or withdrawn result.
- Preserve `EvidenceRepositoryError` and `EvidenceCatalogError` instances rather than wrapping
  their codes.
- Use test-driven development and DCO sign-off on every commit.
- Do not publish npm packages, provision databases, or add credentials.

---

## File and responsibility map

### `packages/evidence-catalog`

| File | Responsibility |
| --- | --- |
| `package.json`, `yarn.lock`, `tsconfig*.json`, `vitest.config.ts` | Independent package and build configuration |
| `specification.md` | Concise normative Catalog contract derived from the approved design |
| `src/types.ts` | Projections, queries, locations, announcements, receipts, and ports |
| `src/errors.ts` | Stable Catalog errors and cancellation helper |
| `src/keys.ts` | Reference, projection, location, and cursor keys |
| `src/query.ts` | Query validation, filtering, ordering, and opaque cursors |
| `src/in-memory.ts` | Reusable exact contract implementation for tests and composition |
| `src/testing.ts` | Fixture projections and Vitest implementation contract kit |
| `src/index.ts` | Root public exports |
| `src/*.test.ts` | Contract, query, and in-memory behavior tests |
| `scripts/pack-smoke.mjs` | Packed-install and dependency-boundary verification |
| `README.md` | Boundary, API, and composition examples |

### `packages/evidence-indexer`

| File | Responsibility |
| --- | --- |
| `package.json`, `yarn.lock`, `tsconfig*.json`, `vitest.config.ts` | Independent package and build configuration |
| `src/errors.ts` | Stable Indexer operational errors |
| `src/graph.ts` | Pure flattened RO-Crate traversal helpers |
| `src/projection-terms.ts` | Fixed protocol-owned JSON-LD relationship terms |
| `src/project-execution.ts` | Execution Evidence to Catalog projection |
| `src/project-evaluation.ts` | Result Evaluation to Catalog projection |
| `src/project-verification.ts` | Execution Verification to Catalog projection |
| `src/project-record.ts` | Family validation dispatch and common projection entry point |
| `src/index-announcement.ts` | Available/withdrawn event orchestration |
| `src/run-source.ts` | Ordered batch replay and checkpointing |
| `src/index.ts` | Root public exports |
| `src/*.test.ts` | Golden projection, failure, replay, and recovery tests |
| `scripts/pack-smoke.mjs` | Packed-install, fixture, and dependency-boundary verification |
| `README.md` | Integration and operational contract |

### Repository-level files

| File | Responsibility |
| --- | --- |
| `.github/workflows/evidence-discovery-ci.yml` | Foundation, Catalog, Indexer, build, test, and pack verification |

---

### Task 1: Freeze the Evidence Catalog public contracts

**Files:**
- Create: `packages/evidence-catalog/package.json`
- Create: `packages/evidence-catalog/yarn.lock`
- Create: `packages/evidence-catalog/tsconfig.json`
- Create: `packages/evidence-catalog/tsconfig.build.json`
- Create: `packages/evidence-catalog/vitest.config.ts`
- Create: `packages/evidence-catalog/specification.md`
- Create: `packages/evidence-catalog/src/types.ts`
- Create: `packages/evidence-catalog/src/errors.ts`
- Create: `packages/evidence-catalog/src/keys.ts`
- Create: `packages/evidence-catalog/src/index.ts`
- Create: `packages/evidence-catalog/src/contracts.test.ts`

**Interfaces:**
- Consumes: `EvidenceRecordReference`, `EvidenceRecordFamily`, `EvidenceRepository`,
  `RepositoryOperationOptions`, and `Sha256Digest` from
  `@jinn-network/evidence-repository`.
- Produces: all Catalog projections, announcements, ports, errors, and receipts used by every
  subsequent task.

- [ ] **Step 1: Scaffold the independent package and write failing root-contract tests**

Create the manifest by following `packages/evidence-repository/package.json`, with:

```json
{
  "name": "@jinn-network/evidence-catalog",
  "version": "0.1.0",
  "description": "Backend-neutral discovery contracts for Jinn evidence records.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": { "node": ">=22" },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/evidence-catalog"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./testing": {
      "import": "./dist/testing.js",
      "types": "./dist/testing.d.ts"
    }
  },
  "files": ["dist/", "README.md", "specification.md"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": {
    "@jinn-network/evidence-protocol": "0.1.0",
    "@jinn-network/evidence-repository": "0.1.0"
  },
  "peerDependencies": { "vitest": "^4.1.8" },
  "peerDependenciesMeta": { "vitest": { "optional": true } },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/evidence-protocol": "portal:../evidence-protocol",
    "@jinn-network/evidence-repository": "portal:../evidence-repository"
  }
}
```

In `src/contracts.test.ts`, import the names below from `./index.js` and assert that the error-code
arrays and record-family discriminants are stable. The test must initially fail because the source
files do not exist.

- [ ] **Step 2: Install and verify the contract test fails**

Run:

```bash
cd packages/evidence-catalog
yarn install
yarn test src/contracts.test.ts
```

Expected: FAIL because `./index.js` or its requested exports are absent.

- [ ] **Step 3: Define the exact projection and query types**

Add these public shapes to `src/types.ts`:

```ts
import type {
  EvidenceRecordReference,
  EvidenceRepository,
  RepositoryOperationOptions,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface CatalogOperationOptions {
  readonly signal?: AbortSignal;
}

export const CATALOG_SCHEMA_VERSION = "1.0.0" as const;

export interface CatalogGeneration {
  readonly catalogSchemaVersion: typeof CATALOG_SCHEMA_VERSION;
  readonly projectorVersion: string;
  readonly createdAt: string;
}

export interface DeclaredEntityOccurrence {
  readonly entityId: string;
  readonly types: readonly string[];
  readonly name?: string;
}

export interface DeclaredRelationshipOccurrence {
  readonly sourceEntityId: string;
  readonly predicate: string;
  readonly targetEntityId: string;
}

export interface CatalogArtifactProjection {
  readonly entityId: string;
  readonly digest: Sha256Digest;
  readonly name?: string;
  readonly mediaType?: string;
}

export interface CatalogResourceSubject {
  readonly name: string;
  readonly digest: Sha256Digest;
  readonly uri?: string;
  readonly mediaType?: string;
}

export interface CatalogRecordBase {
  readonly reference: EvidenceRecordReference;
  readonly byteSize: number;
  readonly declaredEntities: readonly DeclaredEntityOccurrence[];
  readonly declaredRelationships: readonly DeclaredRelationshipOccurrence[];
}

export interface ExecutionEvidenceProjection extends CatalogRecordBase {
  readonly family: "execution-evidence";
  readonly executionId: string;
  readonly task: CatalogArtifactProjection;
  readonly executorId: string;
  readonly runtime: CatalogArtifactProjection;
  readonly results: readonly CatalogArtifactProjection[];
  readonly nativeTrace: CatalogArtifactProjection;
  readonly outcome: "completed" | "failed" | "abandoned";
  readonly startedAt: string;
  readonly endedAt: string;
  readonly publishedAt: string;
}

export interface ResultEvaluationProjection extends CatalogRecordBase {
  readonly family: "result-evaluation";
  readonly taskSubject: CatalogResourceSubject;
  readonly resultSubjects: readonly [
    CatalogResourceSubject,
    ...CatalogResourceSubject[],
  ];
  readonly evaluatorId: string;
  readonly verdict: "pass" | "fail" | "inconclusive";
  readonly evaluatedAt: string;
  readonly supersedes: readonly CatalogResourceSubject[];
  readonly disputes: readonly CatalogResourceSubject[];
}

export interface ExecutionVerificationProjection extends CatalogRecordBase {
  readonly family: "execution-verification";
  readonly subjectRecord: EvidenceRecordReference & {
    readonly family: "execution-evidence";
  };
  readonly executionId: string;
  readonly verifierId: string;
  readonly verdict: "verified" | "rejected" | "inconclusive";
  readonly verifiedAt: string;
  readonly supersedes: readonly CatalogResourceSubject[];
  readonly disputes: readonly CatalogResourceSubject[];
}

export type CatalogRecordProjection =
  | ExecutionEvidenceProjection
  | ResultEvaluationProjection
  | ExecutionVerificationProjection;
```

Define bounded query types with common fields:

```ts
export interface CatalogPageQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly availability?: "available" | "any";
}

export interface ExecutionCatalogQuery extends CatalogPageQuery {
  readonly executionId?: string;
  readonly taskId?: string;
  readonly taskDigest?: Sha256Digest;
  readonly resultId?: string;
  readonly resultDigest?: Sha256Digest;
  readonly executorId?: string;
  readonly outcome?: ExecutionEvidenceProjection["outcome"];
  readonly startedAfter?: string;
  readonly startedBefore?: string;
}

export interface EvaluationCatalogQuery extends CatalogPageQuery {
  readonly taskDigest?: Sha256Digest;
  readonly resultDigest?: Sha256Digest;
  readonly evaluatorId?: string;
  readonly verdict?: ResultEvaluationProjection["verdict"];
  readonly evaluatedAfter?: string;
  readonly evaluatedBefore?: string;
}

export interface VerificationCatalogQuery extends CatalogPageQuery {
  readonly executionId?: string;
  readonly subjectRecordDigest?: Sha256Digest;
  readonly verifierId?: string;
  readonly verdict?: ExecutionVerificationProjection["verdict"];
  readonly verifiedAfter?: string;
  readonly verifiedBefore?: string;
}
```

Use:

```ts
export type EntityRecordQuery = CatalogPageQuery & {
  readonly family?: EvidenceRecordReference["family"];
};

export interface CatalogPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}
```

- [ ] **Step 4: Define announcements, locations, receipts, and ports**

Add the approved announcement and location types:

```ts
export interface PublishedEvidenceLocation {
  readonly bindingProfile: string;
  readonly locator: Readonly<Record<string, JsonValue>>;
}

export interface EvidenceRecordLocation {
  readonly repositoryId: string;
  readonly publishedLocation?: PublishedEvidenceLocation;
}

export interface RecordLocationObservation extends EvidenceRecordLocation {
  readonly sourceId: string;
  readonly announcementId: string;
}

export interface RecordLocationWithdrawal {
  readonly sourceId: string;
  readonly announcementId: string;
  readonly retractsAnnouncementId: string;
}

export type EvidenceRecordAnnouncement =
  | ({
      readonly kind: "available";
      readonly sourceId: string;
      readonly announcementId: string;
      readonly reference: EvidenceRecordReference;
    } & EvidenceRecordLocation)
  | ({
      readonly kind: "withdrawn";
    } & RecordLocationWithdrawal);

export interface AnnouncementBatch {
  readonly announcements: readonly EvidenceRecordAnnouncement[];
  readonly cursor: string;
}

export interface EvidenceRecordAnnouncementSource {
  read(options?: {
    readonly after?: string;
    readonly signal?: AbortSignal;
  }): AsyncIterable<AnnouncementBatch>;
}

export interface EvidenceRepositoryResolver {
  resolve(
    repositoryId: string,
    options?: RepositoryOperationOptions,
  ): Promise<EvidenceRepository | null>;
}

export interface EvidenceIndexerCheckpointStore {
  get(sourceId: string): Promise<string | undefined>;
  put(sourceId: string, cursor: string): Promise<void>;
}
```

Define Writer receipts with stable statuses:

```ts
export interface CatalogWriteReceipt {
  readonly reference: EvidenceRecordReference;
  readonly status: "created" | "existing";
}

export interface CatalogLocationReceipt {
  readonly status: "created" | "existing" | "withdrawn" | "absent";
}
```

Define the ports exactly:

```ts
export interface EvidenceCatalogReader {
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

export interface EvidenceCatalogWriter {
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

- [ ] **Step 5: Add errors, keys, cancellation, and the concise package specification**

In `src/errors.ts`, export:

```ts
export const EVIDENCE_CATALOG_ERROR_CODES = [
  "INVALID_QUERY",
  "INVALID_PROJECTION",
  "PROJECTION_CONFLICT",
  "LOCATION_CONFLICT",
  "OPERATION_ABORTED",
  "IO_FAILURE",
] as const;

export type EvidenceCatalogErrorCode =
  (typeof EVIDENCE_CATALOG_ERROR_CODES)[number];

export class EvidenceCatalogError extends Error {
  override readonly name = "EvidenceCatalogError";
  constructor(
    readonly code: EvidenceCatalogErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
```

Add `assertCatalogOperationActive(options)` and use `OPERATION_ABORTED` for an already-aborted
signal. In `src/keys.ts`, implement and test:

```ts
recordKey(reference) =>
  `${reference.family}\0${reference.digest}`;

observationKey(observation) =>
  `${observation.sourceId}\0${observation.announcementId}`;
```

Use a recursive, key-sorted JSON serializer only for deterministic projection and locator equality;
do not label it RFC 8785.

Write `specification.md` as the package-local normative summary of exact projection ownership,
Reader/Writer behavior, active-location semantics, and exclusions. Include a non-runtime DCAT 3
alignment table mapping an evidence resource, exact-byte distribution, repository data service,
and Catalog registration metadata; do not add an RDF serializer. Re-export all public contracts
and errors from `src/index.ts`.

- [ ] **Step 6: Run the Catalog contract checks**

Run:

```bash
cd packages/evidence-catalog
yarn typecheck
yarn test src/contracts.test.ts
yarn build
```

Expected: all commands PASS and `dist/index.d.ts` contains no concrete repository or database
binding imports.

- [ ] **Step 7: Commit the frozen contracts**

```bash
git add packages/evidence-catalog
git commit -s -m "feat(evidence-catalog): define discovery contracts"
```

---

### Task 2: Add the in-memory Catalog and reusable contract kit

**Files:**
- Create: `packages/evidence-catalog/src/query.ts`
- Create: `packages/evidence-catalog/src/query.test.ts`
- Create: `packages/evidence-catalog/src/in-memory.ts`
- Create: `packages/evidence-catalog/src/in-memory.test.ts`
- Create: `packages/evidence-catalog/src/testing.ts`
- Create: `packages/evidence-catalog/src/testing.test.ts`
- Modify: `packages/evidence-catalog/src/index.ts`
- Modify: `packages/evidence-catalog/package.json`

**Interfaces:**
- Consumes: every frozen type from Task 1.
- Produces: `InMemoryEvidenceCatalog`, `createCatalogContractFixtures`, and
  `describeEvidenceCatalogContract` for later concrete Catalog implementations.

- [ ] **Step 1: Write failing query and implementation-contract tests**

Create fixture projections with fixed canonical digests:

```ts
const PRIVATE_EXECUTION = executionProjection({
  digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
  startedAt: "2026-07-24T10:00:00Z",
});

const PUBLIC_DERIVATIVE = executionProjection({
  digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  executionId: PRIVATE_EXECUTION.executionId,
  startedAt: PRIVATE_EXECUTION.startedAt,
});
```

Use actual 64-character digests in the source. The contract kit must assert:

- exact-reference `put`/`get` round trips all three projection families;
- two Execution records sharing one Execution IRI remain distinct;
- execution, evaluation, verification, and entity filters return only matching projections;
- default typed queries hide records without an active location;
- `availability: "any"` includes known unavailable projections;
- deterministic pagination returns each item exactly once;
- duplicate equal projections return `existing`;
- unequal projections under one reference throw `PROJECTION_CONFLICT`;
- returned values cannot mutate stored state;
- already-aborted operations throw `OPERATION_ABORTED`.

Run `yarn test`; expected: FAIL because query and in-memory modules are absent.

- [ ] **Step 2: Implement query validation and opaque deterministic cursors**

In `src/query.ts`:

- accept `limit` from 1 through 100 and default to 50;
- reject invalid limits, timestamps, digest filters, and cursors with `INVALID_QUERY`;
- order Execution projections by `startedAt` descending then record digest ascending;
- order Evaluation projections by `evaluatedAt` descending then record digest ascending;
- order Verification projections by `verifiedAt` descending then record digest ascending;
- order entity lookups by family then record digest;
- encode a base64url JSON cursor containing version `1`, a canonical query fingerprint, and the
  final ordering tuple;
- reject a cursor reused with a different query fingerprint.

Normalize valid RFC 3339 timestamps to epoch milliseconds for filtering, ordering, and cursor
tuples; do not compare offset-bearing timestamps lexicographically. Test equivalent instants with
different offsets, same-timestamp digest tie-breaking, changed-filter cursor rejection, empty
final pages, and limits `0` and `101`.

- [ ] **Step 3: Implement atomic record projections**

`InMemoryEvidenceCatalog` implements both Reader and Writer. Store deep immutable clones in a Map
keyed by `recordKey`. `putRecordProjection`:

1. validates that `projection.family === projection.reference.family`;
2. validates canonical digest syntax, non-empty role identifiers, strict RFC 3339 timestamps,
   non-empty required arrays, and every family-specific verdict and outcome;
3. compares a deterministic normalized projection string;
4. returns `created` for the first insertion and `existing` for an equal replay; and
5. throws `PROJECTION_CONFLICT` for any unequal replay.

Never merge fields from two projections sharing an entity IRI.

- [ ] **Step 4: Implement source-scoped location observations and withdrawals**

Store observations by `(sourceId, announcementId)`. An equal replay is `existing`; the same key
with another reference or location throws `LOCATION_CONFLICT`.

Reject `observeRecordLocation` with `INVALID_PROJECTION` when its record reference has no stored
projection. Validate that `bindingProfile` is an absolute identifier and that `locator` is a
finite JSON value without `undefined`, functions, symbols, or non-finite numbers.

`withdrawRecordLocationObservation` must:

- be idempotent for the same withdrawal event;
- reject an announcement ID reused for another withdrawal target;
- return `absent` when the source never produced the targeted available event;
- reject an attempt to retract an event under another `sourceId`;
- deactivate only the targeted observation; and
- return `withdrawn` on its first successful transition.

`getRecordLocations` returns de-duplicated active locations. Published locators use the
binding-profile-defined canonical locator object; local-only locations de-duplicate by
`repositoryId`.

- [ ] **Step 5: Implement typed filters and entity occurrence lookup**

Implement every query field declared in Task 1 using exact equality and inclusive/exclusive time
boundaries documented in `specification.md`: `After` is exclusive and `Before` is exclusive.

`findRecordsForEntity` matches:

- `declaredEntities[].entityId`;
- Execution IRI, Task entity ID, Result entity IDs, Executor IRI, Runtime entity ID, and native
  trace entity ID;
- Evaluation actor and any subject `uri`; and
- Verification actor and Execution IRI.

It must not tokenize names, descriptions, or arbitrary extension data.

- [ ] **Step 6: Export and run the reusable contract kit**

`src/testing.ts` exports the in-memory implementation, exact fixture factory, context factory
type, and:

```ts
describeEvidenceCatalogContract(
  createContext: EvidenceCatalogContractFactory,
): void;
```

Match the lifecycle pattern in
`packages/evidence-repository/src/testing.ts`: create a fresh context in `beforeEach`, invoke
optional cleanup in `afterEach`, and run the complete contract against any Reader/Writer pair.

Run:

```bash
cd packages/evidence-catalog
yarn typecheck
yarn test
yarn build
```

Expected: PASS with the in-memory implementation running the shared contract kit.

- [ ] **Step 7: Commit the test implementation**

```bash
git add packages/evidence-catalog
git commit -s -m "feat(evidence-catalog): add contract test implementation"
```

PR 1 ends here. It is independently reviewable and provides a packed, testable Catalog contract
without choosing a durable database.

---

### Task 3: Scaffold the generic Indexer and project Execution Evidence

**Files:**
- Create: `packages/evidence-indexer/package.json`
- Create: `packages/evidence-indexer/yarn.lock`
- Create: `packages/evidence-indexer/tsconfig.json`
- Create: `packages/evidence-indexer/tsconfig.build.json`
- Create: `packages/evidence-indexer/vitest.config.ts`
- Create: `packages/evidence-indexer/src/errors.ts`
- Create: `packages/evidence-indexer/src/graph.ts`
- Create: `packages/evidence-indexer/src/projection-terms.ts`
- Create: `packages/evidence-indexer/src/project-execution.ts`
- Create: `packages/evidence-indexer/src/project-execution.test.ts`
- Create: `packages/evidence-indexer/src/index.ts`

**Interfaces:**
- Consumes: `ExecutionEvidenceDocument`, `ValidationReport`, and protocol constants from Evidence
  Protocol; projection contracts from Evidence Catalog.
- Produces:

```ts
export const EVIDENCE_PROJECTOR_VERSION = "1.0.0" as const;

export declare function projectExecutionEvidence(
  reference: EvidenceRecordReference & { family: "execution-evidence" },
  byteSize: number,
  document: ExecutionEvidenceDocument,
): ExecutionEvidenceProjection;
```

- [ ] **Step 1: Scaffold the independent package and failing golden-fixture test**

Mirror the Catalog manifest, but use dependencies:

```json
{
  "@jinn-network/evidence-catalog": "0.1.0",
  "@jinn-network/evidence-protocol": "0.1.0",
  "@jinn-network/evidence-repository": "0.1.0"
}
```

and portal resolutions for all three sibling packages. Do not add Vitest as a peer dependency
because the Indexer root API does not export a contract kit.

Load the private and public golden metadata fixtures through the Evidence Protocol package export:

```ts
const fixtureRoot = new URL(
  ".",
  import.meta.resolve(
    "@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/README.md",
  ),
);
const privateBytes = await readFile(
  new URL("execution/ro-crate-metadata.json", fixtureRoot),
);
```

Validate with `validateExecutionEvidence`, call `projectExecutionEvidence`, and assert exact Task,
Executor, Runtime, Results, native trace, outcome, timestamps, declared entities, and declared
relationships. Assert the public derivative has the same Execution IRI and another record digest.

Run the test; expected: FAIL because the projector is absent.

- [ ] **Step 2: Implement immutable flattened-graph helpers**

In `src/graph.ts`, implement:

- `types(entity): readonly string[]`;
- `hasType(entity, type): boolean`;
- `references(entity, property): readonly string[]`;
- `requiredEntity(byId, id, role)`;
- `requiredSingleReference(entity, property, role)`;
- `artifactProjection(entity)`, converting raw hex `sha256` into repository
  `sha256:<hex>` syntax; and
- deterministic sorting by entity ID, predicate, and target ID.

These helpers operate only on a document that already passed
`validateExecutionEvidence`; an impossible missing relationship throws
`new EvidenceIndexerError("VALIDATED_RECORD_INCONSISTENT",
"Validated graph is missing a required primary relationship.")`.

- [ ] **Step 3: Freeze projected JSON-LD relationship terms**

`src/projection-terms.ts` exports the exact sorted set:

```ts
export const CATALOG_RELATIONSHIP_PREDICATES = [
  "about",
  "agent",
  "conformsTo",
  "creator",
  "environment",
  "hasPart",
  "instrument",
  "jinn:dispositionCount",
  "license",
  "mentions",
  "object",
  "prov:wasDerivedFrom",
  "prov:wasGeneratedBy",
  "provider",
  "resourceUsage",
  "result",
  "softwareRequirements",
  "subjectOf",
] as const;
```

Project only reference-object relationships under these terms. Emit entity occurrences for the
source and resolved targets of those relationships plus the Metadata Descriptor and Root Dataset.
Do not traverse unknown extension properties.

- [ ] **Step 4: Implement the Execution projector**

Build one immutable `@id` Map and:

1. select Root Dataset `./`;
2. follow its single `mentions` reference to the primary Execution;
3. identify the exact Task among `Execution.object` by required `File`, `CreativeWork`, and
   `prov:Plan` types;
4. follow `agent`, `instrument`, `result`, and `subjectOf`;
5. map schema.org completed/failed and Jinn abandoned status IRIs;
6. read `startTime`, `endTime`, and Root `datePublished`;
7. project Task, Runtime, Results, and native trace with exact digests; and
8. sort every occurrence, relationship, and Result deterministically.

The projector must not copy descriptions, unknown extensions, duration metrics, resource
observations, or raw graph entities into the portable projection.

- [ ] **Step 5: Add mutation, order, and public-derivative tests**

Assert:

- changing the returned projection cannot mutate the validated document;
- graph input order does not alter the projected value;
- an extension-only entity and relationship are not projected;
- protocol-owned `prov:wasDerivedFrom` is projected;
- full and scrubbed records sharing an Execution IRI remain distinct by reference; and
- completed, failed, and abandoned fixture variants map to the three Catalog outcomes.

Run:

```bash
cd packages/evidence-indexer
yarn typecheck
yarn test src/project-execution.test.ts
yarn build
```

Expected: PASS.

- [ ] **Step 6: Commit the Execution projector**

```bash
git add packages/evidence-indexer
git commit -s -m "feat(evidence-indexer): project execution evidence"
```

---

### Task 4: Project Evaluation and Verification records

**Files:**
- Create: `packages/evidence-indexer/src/project-evaluation.ts`
- Create: `packages/evidence-indexer/src/project-evaluation.test.ts`
- Create: `packages/evidence-indexer/src/project-verification.ts`
- Create: `packages/evidence-indexer/src/project-verification.test.ts`
- Create: `packages/evidence-indexer/src/project-record.ts`
- Create: `packages/evidence-indexer/src/project-record.test.ts`
- Modify: `packages/evidence-indexer/src/index.ts`

**Interfaces:**
- Consumes: validated `ResultEvaluationEvidence` and `ExecutionVerificationEvidence`.
- Produces:

```ts
export declare function projectResultEvaluation(
  reference: EvidenceRecordReference & { family: "result-evaluation" },
  byteSize: number,
  evidence: ResultEvaluationEvidence,
): ResultEvaluationProjection;

export declare function projectExecutionVerification(
  reference: EvidenceRecordReference & {
    family: "execution-verification";
  },
  byteSize: number,
  evidence: ExecutionVerificationEvidence,
): ExecutionVerificationProjection;

export declare function validateAndProjectEvidenceRecord(
  reference: EvidenceRecordReference,
  bytes: Uint8Array,
): EvidenceProjectionValidationResult;
```

- [ ] **Step 1: Write failing exact claim-projection tests**

Read the two golden DSSE envelopes through the protocol fixture export. Assert exact subject
digests, actor IRIs, times, verdicts, correction lists, and Verification subject record binding.

Add minimal conforming envelopes without optional method, evidence, measurements, checks,
explanation, limitations, corrections, or disputes. Assert they project with empty correction
arrays and no invented fields.

Run the focused tests; expected: FAIL because the modules do not exist.

- [ ] **Step 2: Implement Resource Descriptor projection**

Create a private structural alias and shared helper in `project-record.ts`:

```ts
type ResourceDescriptor =
  ResultEvaluationEvidence["statement"]["subject"][number];

function projectResourceDescriptor(
  descriptor: ResourceDescriptor,
): CatalogResourceSubject {
  return {
    name: descriptor.name,
    digest: `sha256:${descriptor.digest.sha256}`,
    ...(descriptor.uri === undefined ? {} : { uri: descriptor.uri }),
    ...(descriptor.mediaType === undefined
      ? {}
      : { mediaType: descriptor.mediaType }),
  };
}
```

Never project `content`, `downloadLocation`, annotations, or unknown fields.

- [ ] **Step 3: Implement Result Evaluation projection**

Look up `predicate.taskSubject` and every `predicate.resultSubjects` name in `statement.subject`.
Preserve predicate result order, actor, verdict, evaluated time, and projected `supersedes` and
`disputes`.

Declared entity occurrences include the Evaluator IRI and any subject URI. The typed subject
fields remain the authoritative projection for name-only in-toto subjects. Do not infer an
Execution IRI or globally merge the subjects with an Execution record.

- [ ] **Step 4: Implement Execution Verification projection**

Map the sole `ro-crate-metadata.json` subject to:

```ts
subjectRecord: {
  family: "execution-evidence",
  digest: `sha256:${statement.subject[0].digest.sha256}`,
}
```

Project the declared Execution IRI, Verifier IRI, verdict, verified time, corrections, and
disputes. Declared entity occurrences include the Execution and Verifier IRIs.

- [ ] **Step 5: Implement validation dispatch**

`validateAndProjectEvidenceRecord` selects exactly one Evidence Protocol validator from
`reference.family`, verifies `report.recordDigest === reference.digest`, and returns:

```ts
export type EvidenceProjectionValidationResult =
  | {
      readonly conforms: true;
      readonly projection: CatalogRecordProjection;
    }
  | {
      readonly conforms: false;
      readonly diagnostics: readonly ConformanceDiagnostic[];
    };
```

A validator-produced digest mismatch throws `REFERENCE_MISMATCH`; a conforming report without a
value throws `VALIDATED_RECORD_INCONSISTENT`. Structural signature verification is not performed
and signature trust is not inferred.

- [ ] **Step 6: Test deterministic matching inputs and invalid records**

Assert:

- Evaluation Task and Result digest fields can query the matching private and public Execution
  projections without selecting one as preferred;
- Verification binds only its exact Execution Evidence record digest and declared Execution IRI;
- unknown permitted in-toto fields do not enter the projection;
- malformed DSSE and subject binding return sorted protocol diagnostics rather than throwing;
- wrong caller family or digest throws the stable Indexer error; and
- projection does not verify signatures or resolve actor identities.

Run the entire Indexer suite; expected: PASS.

- [ ] **Step 7: Commit the claim projectors**

```bash
git add packages/evidence-indexer
git commit -s -m "feat(evidence-indexer): project attestation evidence"
```

PR 2 ends here. The pure projector is independently usable without a daemon, repository binding,
or concrete Catalog.

---

### Task 5: Index one available or withdrawn announcement

**Files:**
- Modify: `packages/evidence-indexer/src/errors.ts`
- Create: `packages/evidence-indexer/src/index-announcement.ts`
- Create: `packages/evidence-indexer/src/index-announcement.test.ts`
- Modify: `packages/evidence-indexer/src/index.ts`

**Interfaces:**
- Consumes: `EvidenceRepositoryResolver`, `EvidenceCatalogWriter`, and
  `EvidenceRecordAnnouncement`.
- Produces:

```ts
createEvidenceIndexer({
  repositories,
  catalog,
}): EvidenceIndexer;

EvidenceIndexer.index(
  announcement,
  options?,
): Promise<EvidenceIndexingResult>;
```

- [ ] **Step 1: Write failing orchestration and fault-boundary tests**

Use `InMemoryEvidenceRepository` and `InMemoryEvidenceCatalog`. Cover:

- available golden Execution, Evaluation, and Verification announcements;
- missing repository configuration;
- missing record bytes;
- nonconforming exact bytes;
- already-aborted operation;
- repository access and I/O errors;
- Catalog projection conflict;
- failure after projection but before location observation; and
- available-event replay after that partial success.

Assert artifacts are never fetched and exact record bytes are never written into the Catalog.

- [ ] **Step 2: Define stable Indexer outcomes and errors**

In `src/errors.ts` export:

```ts
export const EVIDENCE_INDEXER_ERROR_CODES = [
  "ANNOUNCEMENT_INVALID",
  "REPOSITORY_NOT_CONFIGURED",
  "RECORD_UNAVAILABLE",
  "REFERENCE_MISMATCH",
  "VALIDATED_RECORD_INCONSISTENT",
  "OPERATION_ABORTED",
] as const;
```

Define:

```ts
export type EvidenceIndexingResult =
  | {
      readonly status: "indexed";
      readonly reference: EvidenceRecordReference;
      readonly projectionStatus: "created" | "existing";
      readonly locationStatus: "created" | "existing";
    }
  | {
      readonly status: "rejected";
      readonly reference: EvidenceRecordReference;
      readonly diagnostics: readonly ConformanceDiagnostic[];
    }
  | {
      readonly status: "withdrawn";
      readonly locationStatus: "withdrawn" | "absent" | "existing";
    };
```

Define the Indexer port and factory:

```ts
export interface EvidenceIndexer {
  index(
    announcement: EvidenceRecordAnnouncement,
    options?: CatalogOperationOptions,
  ): Promise<EvidenceIndexingResult>;
}

export interface CreateEvidenceIndexerOptions {
  readonly repositories: EvidenceRepositoryResolver;
  readonly catalog: EvidenceCatalogWriter;
}

export declare function createEvidenceIndexer(
  options: CreateEvidenceIndexerOptions,
): EvidenceIndexer;
```

Repository and Catalog errors propagate unchanged. Indexer errors represent only failures owned by
this layer.

Implement `EvidenceIndexerError` with the same `code`, `message`, and `ErrorOptions` constructor
shape as `EvidenceCatalogError`.

- [ ] **Step 3: Implement available-event indexing in exact order**

For `kind: "available"`:

1. validate non-empty `sourceId`, `announcementId`, and `repositoryId`;
2. resolve the repository;
3. get the record bytes;
4. independently recompute and compare record digest;
5. validate and project;
6. return `rejected` without Catalog writes when conformance fails;
7. `putRecordProjection`;
8. `observeRecordLocation`; and
9. return the combined receipt.

Check cancellation before and after each external await. A missing repository instance is
`REPOSITORY_NOT_CONFIGURED`; `getRecord` returning `null` is `RECORD_UNAVAILABLE`.

- [ ] **Step 4: Implement withdrawal-event indexing**

Validate the source and announcement identities, then call
`withdrawRecordLocationObservation`. Withdrawal never resolves a repository or fetches bytes.
Map the Catalog receipt into a terminal `withdrawn` result.

- [ ] **Step 5: Verify partial-write recovery and dependency errors**

Inject a Catalog Writer that fails the first location write after accepting the projection. On
replay, assert:

- projection status becomes `existing`;
- location status becomes `created`;
- the Catalog contains one projection and one location; and
- no record bytes are persisted by the Indexer.

Inject `new EvidenceRepositoryError("ACCESS_DENIED", "Fixture access denied.")` and
`new EvidenceCatalogError("IO_FAILURE", "Fixture Catalog write failed.")`; assert object identity
and code are preserved.

- [ ] **Step 6: Run and commit the single-event Indexer**

```bash
cd packages/evidence-indexer
yarn typecheck
yarn test
yarn build
git add packages/evidence-indexer
git commit -s -m "feat(evidence-indexer): ingest record announcements"
```

---

### Task 6: Add ordered source replay and checkpoint recovery

**Files:**
- Create: `packages/evidence-indexer/src/run-source.ts`
- Create: `packages/evidence-indexer/src/run-source.test.ts`
- Modify: `packages/evidence-indexer/src/index.ts`

**Interfaces:**
- Consumes: `EvidenceRecordAnnouncementSource`, `EvidenceIndexerCheckpointStore`, and
  `EvidenceIndexer`.
- Produces:

```ts
export interface RunEvidenceAnnouncementSourceOptions {
  readonly sourceId: string;
  readonly source: EvidenceRecordAnnouncementSource;
  readonly indexer: EvidenceIndexer;
  readonly checkpoints: EvidenceIndexerCheckpointStore;
  readonly onResult?: EvidenceIndexingResultObserver;
  readonly signal?: AbortSignal;
}

export declare function runEvidenceAnnouncementSource(
  options: RunEvidenceAnnouncementSourceOptions,
): Promise<EvidenceSourceRunReceipt>;
```

- [ ] **Step 1: Write failing replay, ordering, and checkpoint tests**

Create deterministic fake sources and checkpoint stores. Cover:

- starting without a checkpoint;
- passing the stored opaque cursor back as `after`;
- processing events and batches in source order;
- checkpointing only after the entire batch succeeds;
- checkpointing a batch containing permanent nonconformance rejections;
- not checkpointing after repository, Catalog, callback, or cancellation failure;
- replaying already-written events after a crash;
- withdrawal replay; and
- rejection of an announcement whose `sourceId` differs from the configured source.

- [ ] **Step 2: Implement sequential at-least-once batch processing**

Read the existing checkpoint, call `source.read({ after, signal })`, and process every announcement
sequentially. Call `onResult` after each terminal result. Persist `batch.cursor` only after every
event and callback in that batch succeeds.

Return:

```ts
export interface EvidenceSourceRunReceipt {
  readonly batches: number;
  readonly announcements: number;
  readonly indexed: number;
  readonly rejected: number;
  readonly withdrawn: number;
  readonly finalCursor?: string;
}
```

Do not add retries, sleeps, backoff, polling, concurrency, or a perpetual daemon loop. The
deployment owns invocation and retry timing.

- [ ] **Step 3: Enforce source identity and callback ordering**

Define the result callback as:

```ts
export type EvidenceIndexingResultObserver = (
  result: EvidenceIndexingResult,
) => void | Promise<void>;
```

Reject an announcement whose `sourceId` differs from the `sourceId` supplied to
`runEvidenceAnnouncementSource`. Await `onResult` after the Catalog reaches a terminal state but
before the batch cursor is checkpointed. If the callback fails, propagate the failure and leave
the cursor unchanged; replay is safe through Catalog idempotency.

- [ ] **Step 4: Test rebuild from the golden announcement stream**

Build one source stream containing:

1. the private Execution record;
2. its public derivative under another repository ID;
3. one Result Evaluation;
4. one Execution Verification;
5. a location withdrawal; and
6. an equal replay batch after a simulated crash.

Assert the rebuilt Catalog has four record projections, record-scoped private/public Execution
projections sharing one Execution IRI, exact claim relationships, and only active locations.

- [ ] **Step 5: Run and commit replay support**

```bash
cd packages/evidence-indexer
yarn typecheck
yarn test
yarn build
git add packages/evidence-indexer
git commit -s -m "feat(evidence-indexer): replay announcement sources"
```

PR 3 ends here. It proves at-least-once recovery without choosing a queue, scheduler, or concrete
announcement adapter.

---

### Task 7: Make both packages distribution-ready

**Files:**
- Create: `packages/evidence-catalog/README.md`
- Create: `packages/evidence-catalog/scripts/pack-smoke.mjs`
- Create: `packages/evidence-indexer/README.md`
- Create: `packages/evidence-indexer/scripts/pack-smoke.mjs`
- Create: `.github/workflows/evidence-discovery-ci.yml`
- Modify: `packages/evidence-catalog/package.json`
- Modify: `packages/evidence-indexer/package.json`

**Interfaces:**
- Consumes: completed Catalog and Indexer packages.
- Produces: installable tarballs and one isolated CI workflow.

- [ ] **Step 1: Write the packed-install smoke scripts**

Follow `packages/evidence-repository/scripts/pack-smoke.mjs`. Pack the foundation dependencies and
the package under test into a temporary directory, install with
`npm install --ignore-scripts --no-audit --no-fund`, and verify:

For Catalog:

- root and `./testing` imports resolve;
- `InMemoryEvidenceCatalog` passes a projection and location round trip;
- `README.md` and `specification.md` ship;
- the only Jinn runtime dependencies are Evidence Protocol and Evidence Repository; and
- `dist/` contains no `*.test.js` files.

For Indexer:

- root imports resolve;
- the installed protocol golden fixture validates and projects;
- an in-memory repository and Catalog complete one announcement round trip;
- the only Jinn runtime dependencies are Protocol, Repository, and Catalog; and
- `dist/` contains no tests or undeclared binding imports.

- [ ] **Step 2: Write boundary-focused READMEs**

Catalog README sections:

- “Catalog is derived, not evidence”;
- Reader and Writer examples;
- active versus known-unavailable records;
- record-scoped private/public representations;
- implementing the shared contract kit; and
- exclusions for search, ranking, trust, and corpus policy.

Indexer README sections:

- dependency-injected repository and Catalog example;
- announcement and withdrawal lifecycle;
- terminal rejection versus retryable operational failure;
- at-least-once checkpoint ordering;
- Ponder as an announcement source rather than the generic Indexer; and
- exclusions for daemons, retries, databases, and source adapters.

- [ ] **Step 3: Add isolated Evidence Discovery CI**

Create `.github/workflows/evidence-discovery-ci.yml`, triggered for PRs and pushes to `next` when
either new package, either foundation package, or the workflow changes.

Use Node 22 and Yarn 4.13.0. Run in order:

```bash
packages/evidence-protocol:
  yarn install --immutable
  yarn check:profile
  yarn typecheck
  yarn test
  yarn build

packages/evidence-repository:
  yarn install --immutable
  yarn typecheck
  yarn test
  yarn build

packages/evidence-catalog:
  yarn install --immutable
  yarn typecheck
  yarn test
  yarn build
  yarn pack:smoke

packages/evidence-indexer:
  yarn install --immutable
  yarn typecheck
  yarn test
  yarn build
  yarn pack:smoke
```

Do not add databases, registries, secrets, publishing, or service containers.

- [ ] **Step 4: Run the complete local acceptance gate**

Run:

```bash
cd packages/evidence-protocol
yarn install --immutable
yarn check:profile
yarn typecheck
yarn test
yarn build

cd ../evidence-repository
yarn install --immutable
yarn typecheck
yarn test
yarn build

cd ../evidence-catalog
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke

cd ../evidence-indexer
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

Expected: every command PASS.

- [ ] **Step 5: Commit documentation and CI**

```bash
git add packages/evidence-catalog packages/evidence-indexer \
  .github/workflows/evidence-discovery-ci.yml
git commit -s -m "ci(evidence-discovery): verify catalog and indexer packages"
```

PR 4 ends here.

---

## PR and execution structure

Ship four sequential PRs to `next`:

1. **Catalog contracts:** Tasks 1–2.
2. **Pure projectors:** Tasks 3–4.
3. **Announcement ingestion:** Tasks 5–6.
4. **Distribution readiness:** Task 7.

Implementation begins from updated `next` after the Evidence Protocol and Evidence Repository
packages are present. It does not depend on the Execution Recorder or Attestation Issuer
implementation.

For subagent-driven execution:

- the integration agent owns package manifests, lockfiles, root exports, and CI;
- after Task 2 freezes Catalog types, one isolated worker may implement the Execution projector
  while another implements both claim projectors;
- merge those projector lanes before Task 5;
- run announcement orchestration and replay sequentially because they share state and error
  contracts; and
- perform fresh specification-boundary and durability/replay reviews before PR 4.

## Final acceptance checklist

- Catalog facts are record-scoped and never globally merged.
- Catalog schema and projector versions are explicit, independent generation identifiers.
- Private and scrubbed records can share an Execution IRI without sharing identity.
- Every projection is deterministic and attributable to one exact record reference.
- All three protocol families round-trip through the in-memory Catalog contract.
- Evaluation matching uses exact Task and Result digests.
- Verification matching uses the exact Execution Evidence digest and Execution IRI.
- Unknown protocol extensions do not become Catalog fields.
- Default typed queries require an active location; exact lookup can return known unavailable
  projections.
- Source-scoped withdrawals cannot remove another source's observation.
- Replays are idempotent; conflicting event or projection reuse fails.
- Checkpoints advance only after a complete successful batch.
- Nonconforming immutable records are terminal rejections and do not enter the Catalog.
- Missing repositories, missing bytes, access failures, and I/O failures do not advance the
  checkpoint.
- Repository and Catalog errors retain their original class and code.
- The generic Indexer imports no concrete repository or Catalog binding.
- Neither package contains corpus, trust, ranking, marketplace, plugin, Ponder, or database policy.
- Both tarballs install independently with declared Jinn dependencies only.
- No npm publication, hosted service, durable database, or source adapter is introduced.
