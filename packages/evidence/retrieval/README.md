# `@jinn-network/evidence-retrieval`

A host-neutral, in-process application library that turns known references or
provider-owned candidate queries into exact, digest-verified,
Protocol-conforming Evidence results, with explicit provenance, artifact
state, bounded failures, and replay metadata.

See [`specification.md`](./specification.md) for the package's full
normative contract.

## What this package owns

- Two operations: `retrieve(reference)` for known-reference retrieval and
  `query(candidateSource, sourceQuery)` for candidate-based retrieval.
- Canonical `{family,digest}` deduplication across every candidate
  observation, while retaining each observation's provenance.
- Bounded location fallback across a host-registered `EvidenceRecordLocator`
  and `EvidenceLocationPolicy`, with SHA-256 verification and dispatch to the
  matching Protocol family validator.
- Explicit artifact selection, integrity checking, and typed completeness
  states — no artifact bytes are fetched unless requested.
- Typed, bounded failures and diagnostics; a deadline, byte budget, and
  concurrency ceiling on every operation.
- Deterministic saved-query envelopes and honest replay receipts.
- Content-minimizing telemetry: counts, classifications, and durations only.

## What candidate providers own

A `CandidateSource<Query, ProviderData>` owns its own query type, store,
index, ranking, cursoring, checkpointing, and combination logic. Retrieval
never interprets a provider query — it passes it through unchanged and
preserves the provider's result order. There is no retrieval-method enum
and no built-in relevance score: ranking is always the provider's decision.

## What hosts and consumers own

The host constructs `EvidenceRetrieval` by injecting a locator, a location
policy, and a repository resolver, and configures every candidate store a
federated source may reach. Consumers (a plugin, an evaluator, a miner, a
dataset builder) own their own projections — `KnowledgePacket` construction,
prompt assembly, verdict generation, and dataset materialization all happen
outside this package, against the validated results Retrieval returns.

## Known-reference example

```ts
import { createEvidenceRetrieval } from "@jinn-network/evidence-retrieval";

const retrieval = createEvidenceRetrieval({
  locator,           // EvidenceRecordLocator — host-owned
  locationPolicy,    // EvidenceLocationPolicy — host-owned
  repositoryResolver, // EvidenceRepositoryResolver — host-owned
});

const outcome = await retrieval.retrieve({ reference });
if (outcome.status === "validated") {
  const { validatedRecord, canonicalBytes } = outcome.result;
}
```

`retrieve` never invokes a candidate source — it resolves exactly the
reference given, verifies its bytes, and validates it against the matching
Protocol family.

## Provider-owned query example

A provider defines its own query shape — there is no method enum to pick
from:

```ts
interface HistoryQuery {
  readonly terms: readonly string[];
  readonly taskDigest?: `sha256:${string}`;
}

const historySource: CandidateSource<HistoryQuery, {
  readonly score: number;
  readonly snippet: string;
}> = {
  identity: { id: "host-history", version: "1.0.0" },
  async find(query, options) {
    const hits = await hostIndex.search(query, {
      signal: options.signal,
      limit: options.maximumCandidates,
      cursor: options.cursor?.value,
    });
    return {
      source: this.identity,
      candidates: hits.items.map((hit) => ({
        reference: hit.evidenceReference,
        providerData: { score: hit.score, snippet: hit.snippet },
      })),
      nextCursor: hits.next === undefined ? undefined : {
        source: this.identity,
        value: hits.next,
      },
    };
  },
};

const outcome = await retrieval.query({
  candidateSource: historySource,
  sourceQuery: { terms: ["bounded", "retrieval"] },
  resultLimit: 10,
  candidateBudget: 50,
});
```

`hostIndex`, its query shape, its snippets, and its ranking are entirely
provider-owned. Every hit is re-fetched, bounded, SHA-256 verified, and
validated against its Protocol family before it can appear in
`outcome.results` — a provider score or snippet never becomes canonical
data.

## Federating configured stores

`createFederatedCandidateSource` fans a query out to every host-configured
child source and lets the host decide combined ordering — there is no
default rank fusion:

```ts
const source = createFederatedCandidateSource({
  identity: { id: "plugin-history", version: "1.0.0" },
  sources: [localStore, publicStore],
  allocate: (maximum, sources) =>
    sources.map(() => Math.floor(maximum / sources.length)),
  order: (groups) => groups.map(({ reference }) => ({ reference })),
});
```

A federated source invokes every configured child exactly once per call and
never discovers or contacts an unconfigured source. Local and public stores
use identical retrieval and validation semantics — local/public is
provenance, never relevance or trust.

## Artifact hydration

No artifact bytes are fetched by default. Request explicit artifacts by
entity ID, digest, or declared role, and each selection resolves to one of
`verified`, `not-requested`, `unavailable`, `access-denied`,
`integrity-mismatch`, `too-large`, or `timed-out`:

```ts
const outcome = await retrieval.retrieve({
  reference,
  artifacts: {
    selections: [{
      selector: { kind: "role", role: "result" },
      requirement: "required",
    }],
  },
});
```

## Saved queries and checkpoints

`createSavedEvidenceQuery` produces a versioned, JSON-safe envelope around a
provider query — never a live provider object — using the provider's own
`ProviderQueryCodec`. `createQuerySnapshotReceipt` reports whether a run is
honestly replayable, derived only from the leaf checkpoints that run
actually returned. Cursors are not checkpoints, and a receipt's timestamp
does not freeze membership.

## Failure and partial-result semantics

`retrieve` returns `{ status: "validated" | "failed" }`. `query` returns
`{ status: "complete" | "partial" | "failed" }` plus per-source reports.
Expected failures (`NO_LOCATION`, `RECORD_DIGEST_MISMATCH`,
`ACCEPTANCE_REJECTED`, and so on) are typed `EvidenceRetrievalFailure`
values, never thrown. Invalid construction or invalid operation input
throws a single typed `EvidenceRetrievalError`.

## Security and telemetry

Provider-supplied location hints and scores are untrusted provenance — they
can never construct or select a binding the host has not registered.
Optional `RetrievalTelemetry` receives only classifications, counts, byte
totals, identities, and durations; it never receives raw queries, snippets,
provider projections, record or artifact bytes, prompts, credentials, or
private locators. A failing telemetry sink never changes retrieval
semantics.

## Plugin migration boundary

The Jinn Plugin is a host and a consumer of this package, not a component
inside it. The plugin host configures every local and public store its
selected candidate source searches, and Retrieval treats those stores
uniformly. Plugin-owned ranking, context selection, prompt policy, and
`KnowledgePacket` construction stay in the plugin. The plugin's legacy
CID-oriented `CorpusPort` cannot be pointed at this package as-is — a CID is
not an `EvidenceRecordReference`, and treating one as the other would create
a second identity system. A `CorpusPort` replacement requires a separate
provider adapter that emits canonical references, planned and reviewed
independently of this package.

## Third-party hosts and optional transport

Any TypeScript host may construct `EvidenceRetrieval` by injecting its own
locator, location policy, and repository resolver — nothing in this package
assumes a particular deployment. A later HTTP or gRPC server exposing
Retrieval remotely is only a host wrapper over these same semantics: it
would use registered provider/source-set IDs and runtime query codecs on
the wire, and it would own authentication, tenancy, quotas, and network
retry itself — none of that is this package's concern.

## Testing provider implementations

`@jinn-network/evidence-retrieval/testing` exports reusable conformance
kits:

- `describeCandidateSourceContract(name, createContext)` — a Vitest suite
  any `CandidateSource` implementation can run against to verify identity
  stability, reference parseability, provider order, bounded pages, cursor
  and checkpoint round-tripping, and abort/timeout/failure handling.
- `describeEvidenceRetrievalContract(name, createContext)` — a Vitest suite
  that exercises a full `EvidenceRetrieval` instance across known-reference
  retrieval, querying, cancellation, and limits.
- `StaticCandidateSource`, `loadGoldenEvidenceRecords`, and
  `createSyntheticRetrievalFixture` — fixtures for building test contexts
  quickly.

`vitest` is an optional peer dependency required only by this entrypoint.

## Non-goals

Retrieval does not own a universal query language, a retrieval-method
enum, a full-text or vector search engine, embeddings or their lifecycle,
generic ranking or trust scoring, Discovery announcement ingestion, Catalog
writing, Repository persistence bindings, Protocol schema definitions,
record or artifact mutation, execution capture, derivation or publication
authority, signature issuance or key management, evaluation or verification
verdict generation, marketplace admission or settlement, relationship
adjudication, task scheduling, canonical corpus membership, dataset or
skill publication, or plugin-specific prompt/UI/`KnowledgePacket` behavior.
`KnowledgeHit`, `CorpusRecord`, `KnowledgePacket`, prompt construction, and
UI projection remain outside this package. See
[`specification.md`](./specification.md) for the complete normative list.
