# `@jinn-network/evidence-retrieval` specification

Distilled from the approved design at
[`docs/superpowers/specs/2026-07-26-evidence-retrieval-design.md`](../../../docs/superpowers/specs/2026-07-26-evidence-retrieval-design.md).
Where this document and the design disagree, the design governs; file a
dated addendum against the design rather than editing this file silently out
of sync.

## Operations

`EvidenceRetrieval` exposes exactly two application-facing operations:

- **`retrieve(input, options?)`** — known-reference retrieval. Given an
  `EvidenceRecordReference`, resolve its allowed locations, fetch exact
  bytes, verify the SHA-256 digest, validate against the matching Protocol
  family, and optionally hydrate explicitly selected declared artifacts.
  `retrieve` never invokes a candidate source.
- **`query(input, options?)`** — candidate-based retrieval. Passes a
  provider-owned query through to exactly one `CandidateSource` (which may
  itself be a host-configured federation of child sources) without
  interpreting or translating it, then over-fetches, deduplicates, and
  validates candidates up to `resultLimit` accepted results within
  `candidateBudget` examined observations.

## Invariants

- The root package imports no search engine, vector database, embedding
  runtime, concrete Catalog store, concrete Repository binding, plugin,
  marketplace, Autopilot, network client, filesystem API, or ambient network
  API. Production dependencies are exactly `@jinn-network/evidence-protocol`,
  `@jinn-network/evidence-repository`, and `@jinn-network/evidence-discovery`.
- Retrieval is read-only: it never writes Protocol records, Repository
  objects, Catalog projections, indexes, announcements, checkpoints, saved
  queries, datasets, or caches.
- There is no retrieval-method enum, universal query language, default rank
  fusion, generic relevance score, local/public mode, trust score, or
  corpus-membership authority. Local and public stores use identical
  retrieval and validation semantics — local/public is provenance or
  topology, never relevance, trust, or validation policy.
- The host configures all candidate stores and repository bindings. A
  federated source invokes every configured child source and never discovers
  or contacts an unconfigured source.
- A candidate becomes a normal result only after exact bytes are re-fetched,
  bounded, SHA-256 matched to the canonical reference, and accepted by the
  existing family-specific Protocol validator. Provider scores, snippets,
  projections, locations, and extensions remain untrusted provenance — they
  never alter identity, conformance, trust, or acceptance.
- `resultLimit` counts validated results. `candidateBudget` counts candidate
  observations examined, including duplicates, unavailable records,
  nonconforming records, and acceptance rejections.
- Ranking and combined ordering belong to the candidate provider. Retrieval
  preserves provider order, deduplicates exact `{family,digest}` references,
  and retains every contributing observation.
- No artifact bytes are fetched by default. Requested artifacts are
  independently bounded and reported as `verified`, `not-requested`,
  `unavailable`, `access-denied`, `integrity-mismatch`, `too-large`, or
  `timed-out`. A corrupt or nonconforming record copy at one allowed location
  does not block bounded fallback to another allowed location.
- Expected source, record, acceptance, location, and artifact failures are
  typed values. Invalid construction and invalid operation input throw a
  typed `EvidenceRetrievalError`.
- Every operation has a default deadline and bounded candidates, metadata,
  locations, records, artifacts, concurrency, and diagnostics. Cancellation
  propagates into every injected port.
- Default telemetry contains classifications, counts, byte totals,
  identities, and durations only — never raw queries, snippets, projections,
  record bytes, artifact bytes, prompts, credentials, signed URLs, or private
  locators.
- Saved-query envelopes are versioned values, not persistence. Provider
  codecs own query encoding, decoding, validation, and migration. Cursors are
  not checkpoints, and timestamps do not freeze membership.
- Protocol relationships are preserved in validated records. Retrieval does
  not expand, adjudicate, rank, trust, or generate verdicts from them.

## Typed failure classes

Expected failures are `EvidenceRetrievalFailure` values carrying one of the
`EVIDENCE_RETRIEVAL_FAILURE_CODES`: `NO_LOCATION`, `ACCESS_DENIED`,
`WITHDRAWN_OR_UNAVAILABLE`, `SOURCE_FAILED`, `REPOSITORY_UNRESOLVED`,
`TIMED_OUT`, `OPERATION_ABORTED`, `CANDIDATE_BUDGET_EXCEEDED`,
`BYTE_BUDGET_EXCEEDED`, `RECORD_TOO_LARGE`, `ARTIFACT_TOO_LARGE`,
`RECORD_DIGEST_MISMATCH`, `PROTOCOL_NONCONFORMING`, `ACCEPTANCE_REJECTED`,
`REQUIRED_ARTIFACT_UNAVAILABLE`, `ARTIFACT_INTEGRITY_MISMATCH`, and
`PROVIDER_CONTRACT_VIOLATION`. Each failure carries a `stage`
(`source | candidate | location | record | validation | acceptance |
artifact`), a `retryable` flag, and a safe `message` — never adapter error
text that might carry a private locator.

Invalid construction or invalid operation input (a malformed reference, an
out-of-bounds `resultLimit`, a host policy that violates its own contract)
throws `EvidenceRetrievalError` with code `INVALID_INPUT` or
`HOST_MISCONFIGURED` — this is a programmer error, not an expected runtime
outcome, so it throws rather than returning a typed failure value.

## Explicit non-goals

Retrieval does not own: a universal query language; an enumeration of
retrieval methods; a full-text engine or vector database; embeddings,
snippets, search indexes, or their lifecycle; generic ranking, rank fusion,
recommendation, or trust scoring; Discovery announcement ingestion or
Catalog writing; Repository persistence semantics or bindings; Protocol
schemas or conformance rules; record or artifact mutation; execution
capture; derivation, publication, or withdrawal authority; signature
issuance, verification policy, identity resolution, or key management;
evaluation or verification verdict generation; marketplace reputation,
admission, settlement, or retention; relationship adjudication; task
execution or scheduling; canonical corpus membership; dataset, benchmark, or
skill publication; plugin-specific prompt, UI, history, or `KnowledgePacket`
behavior; a foundational cache; a required daemon; authentication, tenancy,
quotas, or service deployment; or implicit remote search, embedding, or
federation.

`KnowledgeHit`, `CorpusRecord`, `KnowledgePacket`, prompt construction, and
UI projection remain outside this package. The Jinn Plugin's legacy
CID-oriented `CorpusPort` is not changed by this package; a separate
provider adapter must first emit canonical `EvidenceRecordReference` values
before any plugin migration plan can consume this library.
