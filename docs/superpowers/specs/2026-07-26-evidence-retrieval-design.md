# Evidence Retrieval Design

**Date:** 2026-07-26

**Status:** approved; implementation planning authorized on 2026-07-27

**Scope:** `packages/evidence/retrieval` — a host-neutral application capability that accepts a
known Evidence record reference or an injected candidate source, resolves available repositories,
retrieves and validates exact record bytes, optionally retrieves and integrity-checks requested
artifacts, and returns validated evidence with discovery and availability provenance

**Out of scope:** search-engine implementation; index and embedding lifecycle; evidence production,
mutation, publication, or withdrawal; trust and admission policy; evaluation verdicts; prompt or UI
projection; canonical corpus membership; dataset publication; and a required daemon or hosted
service

## 1. Decision

Jinn will define Evidence Retrieval as a reusable, in-process application library with two primary
operations:

1. retrieve one known `EvidenceRecordReference`; and
2. query one host-supplied candidate source using that source's own typed query, then retrieve and
   validate the selected references.

Retrieval is an application-layer capability, not a new Evidence substrate, database, search
engine, or corpus authority. It composes the existing Evidence Protocol, Repository, Discovery
location contracts, and host-selected candidate sources.

The package adds shared behavior that would otherwise be duplicated by the Jinn Plugin,
evaluators, explorers, mining and derivation applications, and third-party consumers:

- canonical-reference deduplication;
- host-controlled location resolution and bounded fallback;
- exact-byte digest verification;
- family-specific Evidence Protocol validation;
- selective artifact retrieval and integrity checking;
- typed partial-failure behavior;
- provenance preservation;
- saved-query and source-checkpoint envelopes; and
- reusable provider and Retrieval conformance tests.

Candidate generation is an open extension point. Retrieval does not enumerate structured,
keyword, semantic, graph, recommendation, or future retrieval methods. A candidate source owns its
query type, search method, index lifecycle, candidate ordering, scores, snippets, and any internal
composition. Its one mandatory output invariant is an immutable
`EvidenceRecordReference`.

The Jinn Plugin is one host and one consumer of this library. It configures the sources and
repositories available in its process, invokes Retrieval, and turns validated results into its own
`KnowledgePacket`, history, or prompt context. Retrieval does not depend on the plugin.

An HTTP or gRPC host may wrap the same application later. Transport is not part of the foundational
boundary and must not create a second set of Retrieval semantics.

## 2. Substrate stocktake

The authoritative Evidence work inspected for this design is the current open substrate stack,
including the package consolidation, Repository capability refinement, and derivation contracts.
Private or later in-flight IPFS, publication, and derivation-distribution work informed likely
location shapes but is not treated as an approved Retrieval contract.

The settled substrate relevant to Retrieval is:

| Capability | Existing owner | Retrieval consequence |
| --- | --- | --- |
| Canonical record families and validation | `@jinn-network/evidence-protocol` | Retrieval calls the existing family validator and does not reinterpret conformance |
| Record and artifact identity | `EvidenceRecordReference` and `EvidenceArtifactReference` from `@jinn-network/evidence-repository` | Digests, not search hits or locations, define identity |
| Exact-byte reads | `EvidenceRepository.getRecord` and `getArtifact` | Retrieval composes reads and independently verifies returned bytes |
| Repository limits | `EvidenceRepositoryCapabilities` | Retrieval respects binding limits and adds operation-level budgets |
| Filesystem and OCI storage | Repository bindings | Retrieval selects bindings through injected resolution; it does not branch on storage implementation |
| Future IPFS storage | Repository binding and profile | IPFS is another location after its contracts land; it does not alter Retrieval identity |
| Structured projections and queries | `EvidenceCatalogReader` | A Catalog candidate adapter may call these existing queries; Retrieval does not duplicate them |
| Location observations and withdrawals | Evidence Discovery | Retrieval reports availability and withdrawal without treating either as endorsement or mutation |
| Repository resolution | `EvidenceRepositoryResolver` | Retrieval composes this existing contract rather than opening arbitrary URLs |
| Announcement validation and projection | Discovery Indexer | Request-time Retrieval does not re-index or replace the Indexer |
| Local composition and synchronization | `LocalEvidenceRuntime` | A host may expose its Catalog and Repository through candidate and location adapters |
| Artifact integrity report | `checkArtifactIntegrity` and `ArtifactIntegrityReport` | Retrieval reuses protocol integrity utilities and adds request-time operational statuses |

The Repository deliberately has no list or search operation. Discovery and other search projections
find candidate references first; Repository bindings then fetch exact bytes by digest.

The Catalog is derived and rebuildable. Its projections, byte sizes, relationships, locations, and
cursors are useful discovery information, but none replace canonical record bytes. A Catalog
cursor supports deterministic pagination in that Catalog implementation; it is not, by itself, a
historical corpus snapshot.

## 3. Terminology

The design uses the following terms precisely:

| Term | Meaning |
| --- | --- |
| **Host** | The process or composition root that configures Retrieval, candidate sources, location policy, limits, and credentials |
| **Consumer** | Code that invokes `retrieve` or `query` and interprets the validated results |
| **Candidate source** | An injected search capability with a provider-owned query type that returns ordered canonical record references |
| **Candidate store** | One configured Catalog, index, API, or other searchable source used by a candidate source |
| **Federated candidate source** | A host-configured source that searches all of its configured stores and preserves their observations |
| **Candidate** | An unvalidated search result whose only canonical field is an `EvidenceRecordReference` |
| **Discovery provenance** | Untrusted source identity, ordering, scores, snippets, projections, and extensions explaining how a candidate was found |
| **Record locator** | An injected capability that gathers observed repository locations for a reference |
| **Location policy** | Host-owned policy that permits and orders locations without changing relevance |
| **Repository resolver** | The existing capability that maps an allowed repository identity or typed location to an `EvidenceRepository` |
| **Validated evidence result** | Exact digest-verified bytes, the family-specific validated value, availability observations, requested artifact states, and provenance |
| **Consumer projection** | A `KnowledgePacket`, verdict, UI row, dataset row, or other interpretation created after Retrieval |

“Application” means a reusable use-case layer. It does not imply a separately deployed network
service.

## 4. Ownership boundary

### 4.1 Retrieval owns

Retrieval owns only behavior shared across its consumers:

- orchestration of known-reference and candidate-based retrieval;
- invocation of a host-supplied candidate source;
- preservation of provider ordering and metadata;
- deduplication by exact `EvidenceRecordReference`;
- bounded candidate examination toward a validated-result limit;
- record-location collection through an injected locator;
- host-policy filtering and ordering of locations;
- repository resolution and bounded fallback;
- record-byte digest checking;
- family-specific Evidence Protocol validation;
- post-validation application of an optional consumer-supplied acceptance predicate;
- request-driven artifact hydration and integrity checking;
- typed outcomes, failures, warnings, and diagnostics;
- saved-query and source-checkpoint envelopes;
- content-minimizing telemetry hooks; and
- contract kits for candidate sources and Retrieval scenarios.

### 4.2 Candidate sources own

Every candidate source owns:

- its query type and query validation;
- its retrieval method or pipeline;
- its searchable stores and backend clients;
- query rewriting, graph traversal, filters, lexical matching, embeddings, or other search logic;
- index creation, update, invalidation, and rebuilding;
- embedding models and embedding privacy;
- snippets and disposable projections;
- ranking, reranking, and hybrid combination;
- provider scores and their meanings;
- provider cursors and checkpoint semantics;
- provider-specific retries within the operation deadline;
- backend credentials and connection lifecycle; and
- serialization and migration of its saved provider queries, if it supports saved queries.

### 4.3 Hosts own

The host owns:

- which candidate stores and repositories are configured;
- which configured stores receive a query;
- the authorization implied by configuring a remote store;
- credentials and tenant boundaries;
- location permission and preference;
- operation defaults and hard resource ceilings;
- provider construction and lifecycle;
- cache construction and confidentiality boundaries;
- registration of named providers for a future transport; and
- observability sinks and redaction.

### 4.4 Consumers own

The consumer owns:

- why evidence is being retrieved;
- construction of the provider-specific query;
- selection of the candidate source configured by its host;
- optional acceptance or admission predicates;
- trust, evaluator reputation, and marketplace policy;
- interpretation of `supports`, `supersedes`, `disputes`, and other relationships;
- evaluation verdicts;
- `KnowledgePacket`, prompt, UI, dataset, benchmark, and skill projections;
- whether retrieved content may be shown to a person or supplied to an agent; and
- any record-producing operation performed after retrieval.

### 4.5 Existing substrate retains

Retrieval does not absorb:

- Protocol semantics or validators;
- Repository persistence and binding behavior;
- Discovery announcement ingestion, withdrawal authority, or Catalog projection;
- Local Runtime synchronization;
- publication, derivation, execution recording, or attestation issuance; or
- identity, signature, or key trust.

## 5. Alternatives considered

### 5.1 Chosen: reusable in-process application with optional future transport

The in-process library gives the plugin and private/local applications a small operational surface,
allows hosts to inject their own search and storage integrations, and centralizes the safety-critical
exact-byte path. A later server adapter can expose the same semantics when a concrete cross-language
or centrally operated consumer justifies authentication, tenancy, quotas, and network operations.

### 5.2 Rejected as the foundation: standalone Retrieval service

A mandatory service would prematurely own credentials, authentication, tenancy, caches, index
lifecycle, embeddings, rate limits, and deployment operations. It would make local/private plugin
use harder and would conflate the reusable application contract with one operational topology.

### 5.3 Rejected: consumer-specific composition only

Having every consumer call Discovery, resolve repositories, verify digests, validate records, and
hydrate artifacts directly would duplicate the most important correctness and failure behavior. It
would preserve the current ambiguity in plugin `CorpusPort.search/get` rather than create a shared
evidence boundary.

### 5.4 Rejected: universal search query or method enumeration

Structured, keyword, and semantic search are examples, not an exhaustive taxonomy. Graph traversal,
fuzzy search, external APIs, learned retrieval, recommendation, and arbitrary composite methods are
also valid. A universal query would either constrain providers or become a general query language.
Provider-owned typed queries avoid both failures.

### 5.5 Rejected: a foundational rank-fusion framework

Scores from different providers are not inherently comparable. The candidate source or an explicit
composite source has the context required to order its candidates. Retrieval preserves that order,
deduplicates canonical references, and keeps scores as provenance. It does not calculate a generic
relevance score.

## 6. Component and dependency structure

```text
host application
  ├── consumer behavior
  ├── candidate source(s)
  │    ├── Catalog/search/API adapter
  │    ├── provider-owned query and ranking
  │    └── configured local/public stores
  ├── record locator
  ├── location policy
  ├── repository resolver and bindings
  └── Evidence Retrieval
       ├── candidate orchestration and deduplication
       ├── exact record resolution
       ├── Protocol validation
       ├── artifact hydration
       ├── outcomes and diagnostics
       └── saved-query/snapshot envelopes
```

Dependencies point downward:

```text
plugin / evaluator / explorer / third-party host
  ├── evidence-retrieval
  └── one or more candidate adapters
       ├── evidence-retrieval candidate-source contract
       ├── evidence-discovery or another search system
       └── provider-specific dependencies

evidence-retrieval
  ├── evidence-protocol
  ├── evidence-repository
  └── established Discovery location/resolver types where reused

evidence-protocol
evidence-repository
evidence-discovery
  └── never depend on evidence-retrieval
```

The root Retrieval package imports no full-text engine, vector database, embedding runtime, plugin,
marketplace, Autopilot, or consumer projection.

## 7. Application-facing operations

The interface sketches freeze responsibility and semantics, not final TypeScript spelling.

```ts
export interface EvidenceRetrieval {
  retrieve(
    input: RetrieveEvidenceInput,
    options?: RetrievalOperationOptions,
  ): Promise<RetrieveEvidenceOutcome>;

  query<Query, ProviderData = unknown>(
    input: QueryEvidenceInput<Query, ProviderData>,
    options?: RetrievalOperationOptions,
  ): Promise<QueryEvidenceOutcome<ProviderData>>;
}
```

### 7.1 Known-reference retrieval

```ts
export interface RetrieveEvidenceInput {
  readonly reference: EvidenceRecordReference;
  readonly locationHints?: readonly RetrievalLocationHint[];
  readonly artifacts?: ArtifactHydrationRequest;
}
```

`retrieve` does not search for candidate membership. It locates the supplied reference, retrieves
exact bytes, validates them, and hydrates only requested artifacts.

### 7.2 Candidate-based retrieval

```ts
export interface QueryEvidenceInput<Query, ProviderData = unknown> {
  readonly candidateSource: CandidateSource<Query, ProviderData>;
  readonly sourceQuery: Query;

  /** Maximum validated evidence results returned. */
  readonly resultLimit: number;

  /** Maximum candidates that may be examined to fill resultLimit. */
  readonly candidateBudget: number;

  readonly cursor?: CandidateCursor;
  readonly checkpoint?: CandidateCheckpoint;
  readonly acceptance?: ValidatedEvidenceAcceptance;
  readonly artifacts?: ArtifactHydrationRequest;
  readonly diagnostics?: "summary" | "detailed";
}
```

Retrieval does not inspect or translate `sourceQuery`. The static type relationship between the
source and its query prevents a Catalog query from accidentally being supplied to a graph or vector
source. Runtime codecs are required only when a query is persisted or crosses a transport.

### 7.3 Operation controls

```ts
export interface RetrievalOperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRecordBytes?: number;
  readonly maxArtifactBytes?: number;
  readonly maxTotalArtifactBytes?: number;
  readonly maxProviderMetadataBytes?: number;
}
```

Hosts apply hard ceilings even when callers request larger budgets. Remaining deadline and
cancellation propagate into candidate, locator, resolver, repository, and artifact operations.
No operation may wait indefinitely by default.

### 7.4 Optional post-validation acceptance

Search criteria belong to providers. Retrieval may also apply a consumer-supplied predicate to the
validated record:

```ts
export interface ValidatedEvidenceAcceptance {
  readonly id: string;
  readonly version: string;

  evaluate(
    evidence: ValidatedRecord,
  ): EvidenceAcceptanceDecision | Promise<EvidenceAcceptanceDecision>;
}

export type EvidenceAcceptanceDecision =
  | { readonly status: "accepted" }
  | { readonly status: "rejected"; readonly reasonCode: string };
```

This port lets a caller enforce exact properties such as license or artifact declaration against
canonical data. Retrieval owns only invocation and classification. The predicate remains consumer
policy and must not be confused with Protocol conformance, trust, or marketplace admission.

## 8. Candidate-source extension model

### 8.1 Open, provider-owned query

```ts
export interface CandidateSourceIdentity {
  readonly id: string;
  readonly version: string;
}

export interface CandidateSource<Query, ProviderData = unknown> {
  readonly identity: CandidateSourceIdentity;

  find(
    query: Query,
    options: CandidateSourceOperationOptions,
  ): Promise<CandidatePage<ProviderData>>;
}

export interface CandidateSourceOperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maximumCandidates: number;
  readonly cursor?: CandidateCursor;
  readonly checkpoint?: CandidateCheckpoint;
}
```

There is no `method: "structured" | "keyword" | "semantic"` field. Provider identity identifies a
specific contract and configuration; it does not grant canonical meaning to provider metadata.

### 8.2 Minimal candidate

```ts
export interface EvidenceCandidate<ProviderData = unknown> {
  readonly reference: EvidenceRecordReference;
  readonly providerData?: ProviderData;
}

export interface CandidatePage<ProviderData = unknown> {
  readonly source: CandidateSourceIdentity;
  readonly candidates: readonly EvidenceCandidate<ProviderData>[];
  readonly nextCursor?: CandidateCursor;
  readonly checkpoint?: CandidateCheckpoint;
  readonly diagnostics?: CandidateSourceDiagnostics;
}
```

Only `reference` is mandatory per candidate. Page order expresses provider ranking. Source identity
belongs to the page/source envelope rather than being repeated on each candidate.

`providerData` may include a score, snippet, Catalog projection, location hint, child-source
contributions, or namespaced extension. It is:

- untrusted;
- optional;
- size-bounded;
- preserved for provenance when requested;
- forbidden from changing canonical identity or Protocol conformance; and
- never automatically logged, rendered, or injected into an agent.

A candidate without a syntactically valid `EvidenceRecordReference` violates the provider
contract. A reference with unavailable, corrupt, or nonconforming bytes is a valid candidate
observation but does not become a normal Retrieval result.

### 8.3 Structured, keyword, semantic, and future sources

The following are examples of the same extension boundary:

| Candidate source | Provider-owned input | Typical provider data |
| --- | --- | --- |
| Catalog structured source | Existing Catalog query or an application wrapper around it | `CatalogRecordProjection`, Catalog cursor, location hints |
| Keyword/full-text source | Engine-specific text query and filters | score, snippet, matched fields, index version |
| Semantic/vector source | text, vector, model-specific filters, or provider request | similarity score, embedding/index version |
| Graph source | starting references, relationship predicates, traversal rules | path or contributing relationships |
| External API source | API-specific request | remote result metadata |
| Composite source | a provider-owned composite query | child-source observations and composite ordering data |

A thin adapter adopts an existing engine; it does not turn that engine into Jinn infrastructure.
Replacing one backend with another requires no consumer change only when the new adapter
intentionally implements the same provider query contract.

Filtering by license, source, evaluator, outcome, runtime, time, relationship, or projected
artifact availability belongs to the provider query when it is a search concern. When a consumer
requires an exact property rather than a search hint, it supplies a post-validation acceptance
predicate and Retrieval evaluates that property against the canonical record.

### 8.4 Provider-owned ranking

Candidate ordering belongs to the source. A composite source owns any score normalization, rank
fusion, reranking, query expansion, or fallback that it performs.

Retrieval:

- preserves the source's order;
- groups exact duplicate `EvidenceRecordReference` values;
- retains all source observations for the group;
- uses a stable canonical-reference tie break only where the configured source has left a tie
  unresolved; and
- never promotes a provider score into integrity, trust, identity, or endorsement.

A consumer that wants different relevance behavior supplies a differently configured source or
wraps a source with its own reranker.

When a composite source emits a combined relevance score, that score remains provider data. The
validated result may preserve it in discovery provenance, but Retrieval defines neither its scale
nor its semantics.

### 8.5 Host-configured federation

Local and public candidate stores use the same conceptual boundary. The host configures the stores
that one federated candidate source searches:

```text
host-configured federated source
  ├── local candidate store
  ├── public candidate store
  └── any other authorized candidate store
             │
             └── provider-owned ordered candidate page
```

Operationally, Retrieval searches all stores configured for the selected source. Architecturally,
the federation is a candidate-source implementation so it can retain its provider-owned query and
ordering semantics.

The package may provide bounded fan-out and observation-preservation scaffolding, but it supplies
no universal merge algorithm. The configured source owns the order of the combined candidates.

The rules are:

- no local/public mode is exposed to the consumer;
- local and public are provenance or topology facts, not different evidence semantics;
- configuring a remote store is the host's affirmative authorization to send that source's query;
- no unconfigured store is discovered or contacted implicitly;
- identical references from several stores become one candidate group with all observations;
- different derivative records remain different because their digests differ;
- source failure degrades independently; and
- location selection occurs later and is independent from source relevance.

### 8.6 Index lifecycle

Retrieval is read-only. Candidate providers own all search projection lifecycle:

- which records and fields are indexed;
- how announcements or Catalog projections are consumed;
- how embeddings and snippets are generated;
- model and engine upgrades;
- invalidation and rebuild;
- checkpoint and index-generation identity; and
- consistency between the projection and its canonical references.

Search indexes, embeddings, snippets, scores, and cached projections are disposable hints. Every
search hit must still resolve to exact record bytes.

## 9. Candidate limits, pagination, and checkpoints

`resultLimit` counts validated results. `candidateBudget` bounds the amount of untrusted candidate
work Retrieval may perform.

If the first ten candidates contain three unavailable or invalid records and the result limit is
ten, Retrieval may continue through provider pages until it obtains ten validated results or
reaches the candidate budget, deadline, cancellation, or source exhaustion. The result limit is a
maximum, not a guarantee.

Cursors are opaque and provider-owned:

- Retrieval does not parse or synthesize numeric offsets;
- a federated source owns the continuation state of all its configured stores;
- a cursor is valid only for the same source identity, version, configuration, and query;
- rejected or unavailable candidates already examined are consumed by the cursor;
- cursor size is bounded; and
- changing source configuration invalidates the cursor explicitly.

A cursor is not a reproducibility token. A checkpoint is an opaque provider assertion that the
same provider can evaluate against the same logical source state. Providers that cannot capture or
replay checkpoints must say so explicitly.

## 10. Location resolution and exact record retrieval

Candidate relevance and byte location are independent.

```text
EvidenceRecordReference
  └──▶ record locator gathers observations and candidate hints
       └──▶ host location policy filters and orders locations
            └──▶ repository resolver opens a registered binding
                 └──▶ repository.getRecord(reference)
                      └──▶ byte limit and digest verification
                           └──▶ family-specific Protocol validation
                                └──▶ validated record
```

### 10.1 Record locator

Retrieval accepts an injected locator rather than assuming one Catalog or physical store:

```ts
export interface EvidenceRecordLocator {
  locate(
    reference: EvidenceRecordReference,
    hints: readonly RetrievalLocationHint[],
    options?: RetrievalOperationOptions,
  ): Promise<readonly RetrievalLocationObservation[]>;
}
```

A locator may compose:

- `EvidenceCatalogReader.getRecordLocations`;
- the local runtime's known repository;
- host-known private repositories;
- candidate location hints; and
- future authorized availability sources.

Candidate hints remain untrusted observations. They cannot bypass location policy or create a new
binding dynamically.

### 10.2 Location policy

```ts
export interface EvidenceLocationPolicy {
  select(
    reference: EvidenceRecordReference,
    locations: readonly RetrievalLocationObservation[],
  ): readonly RetrievalLocationAttempt[];
}
```

The host owns policy because locality, network permission, cost, tenant access, and credentials vary
by deployment. A typical policy may prefer a local repository, but Retrieval defines no
local-before-public rule.

Only registered repository identities and typed binding profiles are resolvable. Arbitrary URLs,
inline credentials, and candidate-controlled resolver construction are forbidden.

### 10.3 Fallback and verification

Retrieval attempts allowed locations in policy order until:

- one returns verified, conforming bytes;
- all locations are exhausted;
- a hard integrity policy stops further attempts;
- the byte or attempt budget is exhausted; or
- the operation is cancelled or times out.

For every returned byte sequence Retrieval:

1. enforces repository and operation byte limits;
2. calculates the SHA-256 digest;
3. compares it to `EvidenceRecordReference.digest`;
4. invokes the validator selected by `EvidenceRecordReference.family`; and
5. accepts the record only when the validation report conforms.

A corrupt or nonconforming copy at one location does not invalidate a valid copy at another
location. Retrieval preserves the failed observation diagnostically and may continue within policy.

Multiple locations for one reference produce one validated result. The selected location states
where verified bytes were obtained; it is not an endorsement.

Withdrawal is an availability observation. It does not mutate or invalidate immutable record bytes.
A record available at another allowed location remains retrievable.

## 11. Artifact hydration

No artifact bytes are fetched by default. The caller explicitly selects artifact entities or roles
and declares each selection required or optional:

```ts
export interface ArtifactHydrationRequest {
  readonly selections: readonly ArtifactSelection[];
}

export interface ArtifactSelection {
  readonly selector: ArtifactSelector;
  readonly requirement: "required" | "optional";
}
```

Retrieval validates the record before trusting its artifact declarations. It then resolves the
declared `EvidenceArtifactReference`, applies independent count and byte limits, retrieves allowed
copies, and calls the existing integrity utility.

Each requested artifact receives one operational state:

```ts
export type ArtifactRetrievalStatus =
  | "verified"
  | "not-requested"
  | "unavailable"
  | "access-denied"
  | "integrity-mismatch"
  | "too-large"
  | "timed-out";
```

These states refine, rather than replace, the Protocol integrity report:

- `verified` maps to matching exact bytes;
- `integrity-mismatch` maps to a digest mismatch;
- operational reasons such as access denial, size, or timeout remain distinguishable from generic
  unavailability.

Only complete, digest-verified bytes are exposed as a verified artifact. An unavailable private
artifact is not corrupt. A corrupt artifact does not make the enclosing record nonconforming.

A required-artifact failure marks the evidence result incomplete for that request. An optional
failure is a warning. In both cases the exact record may remain a valid result, with artifact
completeness represented separately.

## 12. Result and outcome model

### 12.1 Validated evidence result

Known-reference and query operations share one semantic result:

```ts
export interface ValidatedEvidenceResult<ProviderData = unknown> {
  readonly reference: EvidenceRecordReference;
  readonly canonicalBytes: Uint8Array;
  readonly validatedRecord: ValidatedRecord;

  readonly discoveryProvenance:
    readonly CandidateObservation<ProviderData>[];
  readonly availability:
    readonly RetrievalLocationObservation[];
  readonly selectedLocation?: RetrievalLocationObservation;

  readonly artifacts: readonly ArtifactRetrievalResult[];
  readonly completeness: "complete" | "artifact-incomplete";
  readonly warnings: readonly RetrievalWarning[];
}
```

`ValidatedRecord` is the family-specific successful value returned by the existing Protocol
validator. Retrieval does not create a fourth generic Evidence schema.

The result makes these distinctions structural:

| Fact | Must not be mistaken for |
| --- | --- |
| Candidate or snippet | Validated evidence |
| Catalog projection | Canonical bytes |
| Available location | Endorsement |
| Provider score or ordering | Trust or quality |
| Protocol conformance | Consumer admission |
| Unavailable private artifact | Corrupt artifact |
| Withdrawal at one source | Deletion of immutable evidence |

Catalog projections and snippets remain inside `discoveryProvenance`. They are never merged into
the canonical record.

### 12.2 Query outcome

```ts
export interface QueryEvidenceOutcome<ProviderData = unknown> {
  readonly status: "complete" | "partial" | "failed";
  readonly results: readonly ValidatedEvidenceResult<ProviderData>[];
  readonly sourceReports: readonly CandidateSourceReport[];
  readonly nextCursor?: CandidateCursor;
  readonly snapshotReceipt?: QuerySnapshotReceipt;
  readonly diagnostics?: RetrievalDiagnostics;
}
```

- `complete` means all configured candidate stores completed within the request policy.
- `partial` means one or more source, candidate, location, or required-artifact operations failed
  while the response remains meaningful.
- `failed` means no configured candidate store could execute successfully.
- A successful source with no candidates yields a complete empty result, not a failure.
- Invalid request, cancellation, and host misconfiguration are explicit operation-level failures.

### 12.3 Known-reference outcome

```ts
export type RetrieveEvidenceOutcome =
  | {
      readonly status: "validated";
      readonly result: ValidatedEvidenceResult;
    }
  | {
      readonly status: "failed";
      readonly failure: EvidenceRetrievalFailure;
    };
```

Known-reference retrieval never returns unvalidated record bytes as a successful value.

### 12.4 Expected failures

Expected failures are typed values, not undifferentiated exceptions:

- no observed location;
- access denied;
- withdrawn or unavailable;
- source, location, or artifact timeout;
- candidate or byte budget exceeded;
- record or artifact too large;
- record digest mismatch;
- Protocol nonconformance;
- acceptance rejection;
- required artifact unavailable; and
- artifact integrity mismatch.

Programmer defects and invalid construction may throw typed errors. Provider and repository
adapters own bounded transient retries; Retrieval owns location fallback and never performs
unbounded retry.

Detailed rejected-candidate information is diagnostic-only. Normal results contain validated
records. Diagnostics must not automatically contain raw queries, snippets, record contents, or
artifact contents.

## 13. Ranking, relationships, trust, and admission

### 13.1 Ranking

Ranking is relevance behavior owned by the candidate source. Retrieval preserves it and performs
canonical deduplication. A score is always provider metadata.

### 13.2 Evidence relationships

Candidate sources may use Catalog or graph indexes to discover Tasks, Results, Executions,
evaluations, verifications, and related claims. Retrieval fetches and validates the resulting
references.

Retrieval preserves Protocol-declared relationships but does not:

- automatically attach an authoritative evaluation to an Execution;
- decide which claim supersedes another;
- resolve disputes;
- collapse related records;
- choose the best evaluator or verifier; or
- infer a verdict from the presence of a relationship.

An evaluator or explorer reconstructs the graph it needs from validated records. A specialized
candidate source may perform inbound or outbound relationship expansion.

### 13.3 Trust and admission

Digest verification answers “are these the bytes identified by this reference?” Protocol
validation answers “does this record conform?” Neither answers:

- whether an identity is trusted;
- whether a signature or key is acceptable;
- whether an evaluator is reputable;
- whether a claim is correct;
- whether evidence is admissible in a marketplace or benchmark; or
- whether content is safe to inject into an agent.

Those decisions remain consumer policy. Retrieval may invoke an injected post-validation
acceptance predicate, but it does not define the predicate's meaning.

## 14. Saved queries and reproducible snapshots

Retrieval owns a versioned saved-query envelope, not a saved-query database:

```ts
export interface SavedEvidenceQuery {
  readonly retrievalSchemaVersion: string;

  readonly candidateSourceSet: {
    readonly id: string;
    readonly version: string;
  };

  readonly providerQuery: {
    readonly kind: string;
    readonly schemaVersion: string;
    readonly value: JsonValue;
  };

  readonly resultLimit: number;
  readonly candidateBudget: number;
  readonly acceptancePolicy?: {
    readonly id: string;
    readonly version: string;
    readonly configuration?: JsonValue;
  };
}
```

The provider owns encoding, decoding, validation, and migration of `providerQuery.value`. Retrieval
stores the kind and schema version needed to select that codec.

Saved queries contain logical source-set identity, not:

- credentials;
- tenant secrets;
- physical private endpoints;
- arbitrary executable code; or
- provider objects.

The host resolves the logical source-set identity to an authorized current configuration. If the
identity or version cannot be resolved exactly, replay fails explicitly.

Artifact hydration is not corpus membership and is selected at execution time.

### 14.1 Live saved query

A live saved query means:

> Evaluate this versioned query definition against the configured candidate sources as they exist
> now.

Its membership may change as historical records, evaluations, disputes, announcements, and
availability observations arrive.

### 14.2 Frozen query snapshot

A reproducible snapshot records an opaque checkpoint for every contributing leaf source:

```ts
export interface QuerySnapshotReceipt {
  readonly savedQueryDigest: Sha256Digest;
  readonly sourceSet: {
    readonly id: string;
    readonly version: string;
  };
  readonly sources: readonly {
    readonly source: CandidateSourceIdentity;
    readonly checkpoint: CandidateCheckpoint;
  }[];
  readonly evaluatedAt: string;
  readonly reproducibility: "replayable" | "not-replayable";
}
```

`evaluatedAt` is observational and never freezes membership by itself. A snapshot is `replayable`
only when every contributing source guarantees evaluation against its recorded checkpoint.

A pagination cursor is not a checkpoint. A current high-water timestamp is not enough unless the
provider contract defines and can replay that exact source state.

If any source cannot capture or replay a checkpoint, Retrieval must not label the result a frozen
corpus. The query can still run live.

### 14.3 Portable frozen dataset

Retrieval may reproduce query membership from checkpoints. A Dataset or Benchmark Builder may
materialize the resulting record references into a provenance-linked manifest. That manifest and
dataset publication remain outside Retrieval and do not become canonical corpus membership.

## 15. Required data flows

### 15.1 Known-reference retrieval

```text
consumer supplies EvidenceRecordReference
  └──▶ locator returns observed locations
       └──▶ host policy permits and orders locations
            └──▶ resolver opens repository
                 └──▶ exact record bytes fetched
                      └──▶ digest checked
                           └──▶ family validator called
                                └──▶ requested artifacts checked
                                     └──▶ validated result returned
```

No candidate source is required.

### 15.2 Local structured history

1. The host constructs a Catalog candidate adapter over `LocalEvidenceRuntime.catalog`.
2. The plugin or evaluator supplies that adapter's existing structured query.
3. The adapter returns Catalog projections containing canonical references.
4. Retrieval retrieves selected records through the local Repository and revalidates them.
5. The consumer receives validated results; no text or vector engine is present.

### 15.3 First-turn plugin retrieval

1. The plugin translates current task context into its own candidate query.
2. Its host-configured source searches every configured local and public candidate store.
3. The source performs any plugin-required ranking or composite search.
4. Retrieval deduplicates canonical references.
5. Retrieval retrieves and validates records in provider order within the candidate budget.
6. Requested trace or result artifacts are hydrated and integrity-checked.
7. The plugin applies its own context-selection and prompt-injection policy.
8. The plugin creates a `KnowledgePacket`.

Retrieval never emits a `KnowledgePacket` and never places snippets or trace content into a prompt.

### 15.4 Local and public evidence

1. The host configures local and public stores in one candidate source.
2. The source queries all configured stores.
3. The same canonical reference from several stores is one candidate group.
4. All contributing source observations are preserved.
5. Distinct derivative records remain distinct.
6. Location policy independently selects an allowed repository copy.
7. A failed public store or location yields a partial outcome without discarding local success.

No local/public trust or relevance preference is implied.

### 15.5 Evaluator retrieval

1. An evaluator-specific candidate source queries for the exact Task, Results, Execution record,
   evaluations, verifications, or supporting claims it needs.
2. Retrieval returns exact validated records and requested artifact states.
3. Protocol relationships remain intact.
4. The evaluator determines its own verdict.

Retrieval neither generates nor signs the verdict.

### 15.6 Semantic-search extension

1. A vector provider builds and owns a disposable projection of evidence.
2. It accepts its own typed query and returns ordered canonical references plus provider metadata.
3. Retrieval does not inspect the embeddings or similarity score.
4. Retrieval fetches and validates selected records.
5. Replacing the vector backend while preserving the provider query contract changes neither
   Evidence identity nor Repository behavior.

### 15.7 Derivation, Task Miner, Skill Factory, or Dataset consumer

1. The application supplies its own candidate provider and query.
2. Retrieval returns validated records and explicitly requested verified artifacts.
3. The application mines, derives, distills, or materializes its own output.
4. Any new Evidence record is produced through the appropriate producer or derivation package.

Retrieval remains read-only and does not publish or persist the consumer's output.

### 15.8 Reproducible snapshot

1. The caller supplies a saved query and recorded per-source checkpoints.
2. The host resolves the exact source-set version.
3. Each source evaluates at its own checkpoint.
4. Retrieval returns validated results and a snapshot receipt.
5. A Dataset Builder may materialize the references separately.

If any source cannot replay the checkpoint, the operation reports non-reproducibility rather than
silently evaluating current state.

## 16. Security and privacy boundary

### 16.1 Trust zones

Candidate queries may contain private task information. Candidate metadata may be attacker
controlled. Repository locations may be stale or malicious. Canonical evidence may contain
malicious text even when its digest and Protocol structure are valid.

The design therefore applies these boundaries:

- host configuration authorizes which candidate stores receive a query;
- Retrieval never discovers an unconfigured remote source;
- a host with different confidentiality contexts uses different configured source sets or narrows
  the allowed set explicitly per context;
- provider queries and embeddings are never forwarded to a store other than the configured source
  implementation;
- candidate metadata and snippets are untrusted and never automatically rendered;
- only registered typed repository bindings are resolvable;
- location hints cannot inject arbitrary URLs or credentials;
- exact record and artifact bytes are verified before use;
- validated content remains untrusted as instructions;
- consumers own prompt-injection and display policy; and
- Retrieval never automatically invokes tools based on retrieved content.

### 16.2 Resource protection

Every request is bounded by:

- an abort signal and deadline;
- a result limit and candidate budget;
- candidate-page and provider-metadata limits;
- location-attempt limits;
- record-byte limits;
- artifact count, per-artifact, and total-artifact limits;
- bounded provider and repository concurrency; and
- bounded diagnostics.

Cancellation propagates to ongoing candidate, resolver, repository, and artifact work. A source or
binding that ignores cancellation violates its contract.

### 16.3 Cache confidentiality

Retrieval owns no foundational cache. A host may inject or wrap repositories with a cache only when:

- record and artifact entries are keyed by canonical digest;
- tenant and confidentiality boundaries prevent cross-context disclosure;
- access controls are rechecked where required;
- unverified bytes are never promoted to verified cache entries; and
- cache failures preserve typed availability and integrity semantics.

### 16.4 Telemetry

Default telemetry may include:

- operation identifier;
- source identities;
- operation and per-stage duration;
- candidate, validated-result, and failure counts;
- bytes retrieved;
- location binding profile without credentials;
- classified failure codes; and
- cancellation or deadline outcome.

Default telemetry must not include:

- raw provider queries;
- Tasks or local evidence contents;
- embeddings;
- snippets or provider projections;
- canonical record or artifact contents;
- credentials, signed URLs, or private locators; or
- consumer prompts.

Detailed local diagnostics are explicit, bounded, redacted, and not automatically exported.

## 17. Plugin integration and migration impact

The plugin becomes a host and consumer:

```text
plugin composition root
  ├── configures local/public candidate stores
  ├── constructs plugin candidate source
  ├── configures locator, repositories, policy, and budgets
  └── constructs Evidence Retrieval

plugin behavior
  ├── creates plugin-owned provider query
  ├── calls Retrieval
  ├── receives validated evidence
  └── creates KnowledgePacket/history/prompt context
```

The target ownership changes are:

| Current plugin concept | Target ownership |
| --- | --- |
| `CorpusPort.search` | Plugin candidate source calls its configured stores; Retrieval consumes its canonical references |
| `CorpusPort.get` | Compatibility mapping to known-reference `retrieve` |
| `KnowledgeHit` | Plugin search/projection or migration type, not a Retrieval result |
| `CorpusRecord` | Migration type; canonical Retrieval returns exact validated evidence |
| local/public federation | Host-configured plugin candidate source |
| ranking and dedup logic | Ranking remains plugin provider behavior; canonical dedup is Retrieval behavior |
| `KnowledgePacket` | Plugin-owned projection |
| first-turn prompt insertion | Plugin-owned policy and rendering |

A temporary adapter may preserve `CorpusPort.search/get` for existing plugin callers. The adapter is
not normative and must not cause `KnowledgeHit`, `CorpusRecord`, or `KnowledgePacket` to leak into
the Retrieval package.

Product behavior remains: the plugin searches every host-configured local and public candidate
store and receives a uniform evidence result. The architectural change is that exact-byte
resolution, validation, and artifact integrity no longer live in an ambiguous plugin port.

## 18. Third-party and optional transport use

A TypeScript application may embed the package and supply its own provider and repository
implementations.

If a later host exposes Retrieval over HTTP or gRPC:

- the server is the host;
- clients are consumers, not candidate-provider objects;
- the server registers named provider/source-set identities;
- each registered provider exposes a versioned runtime query schema;
- arbitrary executable provider queries are forbidden;
- the transport represents the same typed outcomes and failures;
- exact bytes use an integrity-preserving binary response or content endpoint;
- authentication, tenancy, quotas, credentials, and network retry belong to the server adapter; and
- transport does not alter canonical Evidence identity or validation.

The server is optional. No consumer must deploy one to use Retrieval.

## 19. Testing and conformance strategy

### 19.1 Candidate-source contract kit

Because provider queries are provider-owned, a candidate source supplies fixture queries and
expected references to a reusable harness. The harness verifies:

- every candidate contains a syntactically valid canonical reference;
- page order is stable under the provider's stated checkpoint;
- cursors resume without corrupting or repeating consumed source state beyond documented behavior;
- checkpoints replay correctly or are explicitly unsupported;
- deadline, cancellation, and maximum-candidate controls are respected;
- source identity and schema versions remain stable;
- provider metadata is bounded and preserved without affecting identity;
- backend failure is classified rather than returned as an empty successful page;
- remote access occurs only through the configured source;
- unknown provider metadata survives the round trip; and
- an equivalent replacement adapter satisfies the same provider query contract.

The harness does not test relevance quality generically. Provider-specific benchmarks own that.

### 19.2 Retrieval-core tests

The core suite covers:

- known-reference success and not-found;
- exact record digest mismatch;
- every Evidence family validator;
- Protocol nonconformance diagnostics;
- multiple locations and fallback;
- repository capability and operation byte limits;
- unavailable and withdrawn locations;
- one corrupt location plus one valid location;
- request-driven artifact selection;
- verified, unavailable, access-denied, mismatched, too-large, and timed-out artifacts;
- optional versus required artifact behavior;
- candidate deduplication with all provenance retained;
- provider ordering preservation;
- bounded over-fetch toward the validated-result limit;
- candidate-budget exhaustion;
- complete, partial, and failed query outcomes;
- source timeout and cancellation propagation;
- unknown provider extension preservation;
- post-validation acceptance;
- malicious snippets and bounded diagnostics;
- private-query isolation;
- saved-query provider-version mismatch;
- source-set mismatch;
- cursor misuse;
- checkpoint replay and explicit non-reproducibility; and
- telemetry content exclusion.

### 19.3 Federation tests

Federation fixtures establish:

- every configured local and public store is queried;
- no unconfigured store is queried;
- local and public candidates have identical identity and validation semantics;
- duplicate references merge without losing source observations;
- distinct derivatives do not merge;
- one failed store yields a partial outcome;
- location choice is independent from source ordering; and
- remote provider failure does not discard valid local results.

### 19.4 Consumer fixtures

Reusable scenarios cover:

- plugin first-turn and history retrieval, ending in a plugin-owned `KnowledgePacket`;
- evaluator retrieval of Tasks, Results, Executions, evaluations, and verifications without
  generating a verdict;
- Task Miner or Skill Factory retrieval with explicit artifacts;
- semantic provider replacement without Repository or Evidence identity changes; and
- Dataset Builder snapshot replay and reference materialization outside Retrieval.

No test may treat provider scores, snippets, projections, cursors, or index contents as a substitute
for exact-byte validation.

## 20. Package and repository structure

The package follows the established Evidence domain nesting:

```text
packages/evidence/
├── protocol
├── repository
├── repository-oci
├── discovery
├── catalog-sqlite
├── execution-recorder
├── attestation-issuer
├── local-runtime
└── retrieval                 # this design
```

The intended package name is:

```text
@jinn-network/evidence-retrieval
```

One cohesive package is sufficient. Conceptual source regions are:

```text
packages/evidence/retrieval/
├── src/
│   ├── application operations
│   ├── candidate contracts and federation scaffolding
│   ├── resolution and validation orchestration
│   ├── artifact hydration
│   ├── outcomes, failures, and diagnostics
│   └── saved-query and snapshot value types
└── testing/
    ├── candidate-source contract kit
    └── Retrieval fixtures
```

Public exports are limited to:

- `.` — application operations, ports, value types, outcomes, and construction;
- `./testing` — contract kits and synthetic fixtures.

Provider integrations remain outside the root package. A shared Catalog, FTS, vector, graph, or
remote adapter may later live in a consumer package, a justified sibling package, or a deliberately
named subpath, but this design does not create those artifacts in advance.

There are no separate packages for candidate merger, ranking, hydration, saved queries, caching, or
transport. A future server package requires a concrete operational consumer and separate review.

## 21. Explicit non-goals

Retrieval does not own:

- a universal query language;
- an enumeration of retrieval methods;
- a full-text engine or vector database;
- embeddings, snippets, search indexes, or their lifecycle;
- generic ranking, rank fusion, recommendation, or trust scoring;
- Discovery announcement ingestion or Catalog writing;
- Repository persistence semantics or bindings;
- Protocol schemas or conformance rules;
- record or artifact mutation;
- execution capture;
- derivation, publication, or withdrawal authority;
- signature issuance, verification policy, identity resolution, or key management;
- evaluation or verification verdict generation;
- marketplace reputation, admission, settlement, or retention;
- relationship adjudication;
- task execution or scheduling;
- canonical corpus membership;
- dataset, benchmark, or skill publication;
- plugin-specific prompt, UI, history, or `KnowledgePacket` behavior;
- a foundational cache;
- a required daemon;
- authentication, tenancy, quotas, or service deployment; or
- implicit remote search, embedding, or federation.

## 22. Deferred work

The following are intentionally deferred until a concrete consumer justifies them:

- HTTP or gRPC hosting;
- cross-language clients;
- shared provider integration packages;
- specific keyword, semantic, graph, or hybrid providers;
- server-side authentication, tenancy, quotas, and caches;
- provider relevance benchmarks;
- portable frozen-dataset manifests in Dataset or Benchmark Builder;
- additional consumer convenience projections; and
- removal of legacy plugin migration types.

These are extensions of the approved boundary, not prerequisites for Retrieval.

## 23. Unresolved follow-ups

There are no blocking architectural questions.

Final TypeScript names, exact source-file decomposition, and the decision to publish the package are
implementation-time choices within this boundary. They must not introduce a universal query,
search-engine dependency, plugin projection, new trust policy, or second canonical identity.

This specification was explicitly reviewed and approved before the implementation plan was
written.

## 24. Design self-review

The completed design was checked against the required failure modes:

| Check | Result |
| --- | --- |
| Duplicates Catalog behavior | No; Catalog queries remain provider adapters and Catalog writes remain Discovery |
| Duplicates Indexer behavior | No; Retrieval is request-time and read-only |
| Duplicates Repository behavior | No; Retrieval composes `getRecord/getArtifact` and adds orchestration and verification |
| Duplicates Protocol behavior | No; existing validators and integrity utilities remain authoritative |
| Couples to plugin or marketplace | No; plugin types and policy remain consumer-owned |
| Treats search results as canonical | No; every normal result contains re-fetched, digest-verified, conforming bytes |
| Confuses ranking with trust | No; source ordering and scores remain untrusted provenance |
| Creates corpus-membership authority | No; saved queries are definitions and frozen membership requires source checkpoints |
| Invents search infrastructure | No; search methods, indexes, embeddings, and combinations are provider-owned |
| Ambiguous local/public ownership | No; hosts configure all stores and Retrieval treats their evidence uniformly |
| Leaks private content implicitly | No; configured stores define egress and telemetry excludes content by default |
| Creates unnecessary packages or processes | No; one in-process package and an optional future transport |
| Leaves contradictory result stages | No; candidates are diagnostic provenance and normal results are validated evidence |
| Treats unavailable artifact as corrupt | No; operational artifact states are distinct |
| Treats withdrawal as mutation | No; withdrawal remains an availability observation |
