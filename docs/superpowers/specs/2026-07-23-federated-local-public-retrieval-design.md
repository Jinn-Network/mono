# Federated local and public retrieval for the Jinn plugin

- **Date:** 2026-07-23
- **Status:** approved design
- **Scope:** one focused implementation: retrieve from the operator's local
  episodes and the public corpus through one Jinn ranking path

## 1. Summary

The Jinn plugin currently binds its `CorpusPort` to the public network while
recording the operator's own work separately through `EvidencePort`. This
change presents both sources through one federated `CorpusPort`.

On an eligible pickup, Jinn searches the retained local `EpisodeV1` records and
the public corpus concurrently, merges the candidates, and applies the existing
evidence-first ranking once across the combined set. The agent receives at most
the existing two knowledge packets.

This is an application change, not a corpus migration. It adds no new
persistence layer and changes no public service. The existing
`retrievalVisible` contract remains in force for this implementation:

- every retained local episode is projected by the local adapter as
  `retrievalVisible: true`;
- public records retain their existing stored or compatibility-derived value;
- both sources pass through the same existing pre-fetch and post-fetch
  visibility guards.

The later removal of `retrievalVisible` is explicitly outside this work.

## 2. Current state

`buildPluginDepsFromEnv` currently constructs:

```text
plugin.corpus   = public network corpus
plugin.evidence = private local EpisodeV1 store
```

The required foundations already exist:

- `EvidencePort` can list and fetch canonical local episodes.
- `CorpusPort` already separates search metadata from fetched record content.
- the public capture-metadata endpoint searches all matching indexed records;
  the Jinn plugin enforces `retrievalVisible`.
- pickup already derives search terms, searches terms concurrently, applies a
  relevance floor, re-scores bounded near misses, excludes skill payloads,
  projects knowledge packets, and enforces a two-packet budget.
- Hermes already invokes pickup through its pre-LLM hook and records delivered
  references in session activity.

The missing piece is composition: local episodes are not exposed through the
same search/get boundary as public evidence.

## 3. Goals

1. Search local and public evidence on the same pickup.
2. Apply one Jinn-owned ranking and one context budget to both sources.
3. Preserve the current `retrievalVisible` behavior consistently.
4. Keep local-only and public-only retrieval useful when the other source
   fails.
5. Avoid reinjecting the same canonical episode during one host task.
6. Reuse the canonical local episode store without adding another database.
7. Keep the change localized enough to ship as one implementation unit.

## 4. Non-goals

This design does not:

- publish local episodes;
- change consent, preview, scrubbing, or contribution flows;
- remove or redefine `retrievalVisible`;
- migrate the episode schema, indexer schema, seed records, or public service;
- select globally "useful" episodes or change local admission;
- change the newest-200 local retention policy;
- add embeddings or model-based retrieval;
- replace or merge Hermes OpenViking memory;
- activate parked session-derived task mining.

## 5. Approaches considered

### 5.1 Chosen: federated `CorpusPort`

Add a local episode adapter and compose it with the existing network adapter
behind one `CorpusPort`. The plugin continues to own ranking and packet
selection.

This reuses the current boundaries, gives both sources one policy, and needs no
new persistence.

### 5.2 Rejected for now: separate Jinn recall catalogue

A side database could attach usefulness and recall state to local and public
references. It would support a future selector, but creates synchronization
and lifecycle work before any selection policy exists.

### 5.3 Rejected: concatenate Hermes and Jinn contexts

Running local memory and public pickup independently is mechanically small but
keeps separate rankings, duplicate records, and competing context budgets.

## 6. Architecture

```text
private EpisodeV1 store ──> LocalEpisodeCorpusAdapter ──┐
                                                       ├─> FederatedCorpusPort
public corpus protocol ───> existing network adapter ──┘
                                                                  │
                                                                  v
                                                      Jinn pickup policy
                                                                  │
                                                                  v
                                                    0..2 knowledge packets
```

The adapters expose facts and content. They do not decide relevance.
`packages/plugin` remains the sole owner of term derivation, ranking,
visibility enforcement, skill exclusion, deduplication, and context budgeting.

## 7. Components

### 7.1 `LocalEpisodeCorpusAdapter`

The layer package adds a `CorpusPort` adapter over the same `EvidencePort`
instance used for capture.

For one pickup process, the adapter lazily calls `evidence.list()` once and
shares that promise across every per-term search. This prevents the existing
ten-term search fan-out from rereading the episode directory ten times.

Each episode becomes a `KnowledgeHit` with:

- `ref`: an adapter-only namespace such as
  `local-episode:<encoded-episode-id>`;
- `kind`: `trace`;
- `snippet`: `episode.task.summary`;
- `tags`: `episode.task.distributionTags`;
- `tier`: `episode.outcome.verificationStrength`;
- `publishedAt`: `Date.parse(episode.session.capturedAt)`;
- `origin`: `local:<episode-id>`;
- `retrievalVisible: true`.

Local search is a case-insensitive substring match over task summary and
distribution tags, matching the public capture-metadata search surface. It
does not inspect full trajectories during search.

`get()` decodes the local namespace, fetches the episode from `EvidencePort`,
and projects it into `CorpusRecord` using the same pure Episode-to-record
projection used for public `jinn.episode.v1` payloads. The record also carries:

- `retrievalVisible: true`;
- an optional app-level canonical episode identity used after fetch for
  local/public deduplication.

The adapter does not rewrite local episode files. In particular, it does not
backfill their stored `retrievalVisible` value. The `true` value is the
temporary Jinn-local admission policy at the adapter boundary: all retained
private episodes participate in recall.

Malformed records follow the existing `EvidencePort.list()` behavior: valid
episodes remain available in a degraded result.

The public capture-metadata response already includes `verifiabilityTier`.
The existing network adapter must carry that fact through to
`KnowledgeHit.tier` when it is one of the three recognized pickup tiers.
Legacy and manifest-fallback hits without the fact leave `tier` undefined.
This keeps the verification-strength tie-break source-neutral; adding a tier
only to local hits would accidentally create a local-source bonus.

### 7.2 `FederatedCorpusPort`

The federated adapter accepts named child ports:

```text
local  -> LocalEpisodeCorpusAdapter
public -> existing network CorpusPort
```

`search(query)` calls both children concurrently and merges their values in
stable local-then-public order. Stable source order is only a deterministic
tie behavior; source is not a relevance feature.

Status combination is:

| Child outcomes | Federated search |
|---|---|
| both `ok` | `ok` with both values, including an honest empty array |
| at least one `degraded`, neither `unavailable` | `degraded` with all available values |
| one `unavailable`, the other `ok` or `degraded` | `degraded` with the surviving values, which may be empty |
| both `unavailable` or timed out | `unavailable` |

Reasons identify the failing child. Duplicate references are removed, but
semantic ranking is left to the plugin.

`get(ref)` routes `local-episode:` references to the local child and all other
references to the public child. It does not fan out.

The adapter has an injectable per-child timeout shorter than Hermes's existing
15-second process timeout. Production wiring uses five seconds. A timed-out
child opens a per-invocation circuit, so later calls to that child fail
immediately and pickup can continue down candidates from the healthy source.
The circuit and timeout are operational safeguards, not corpus policy.

### 7.3 Jinn pickup policy

The existing pickup path remains structurally unchanged:

1. derive at most ten search terms;
2. search every term concurrently through the federated port;
3. merge by reference;
4. drop skills and records not carrying `retrievalVisible: true`;
5. score one combined candidate set;
6. boundedly fetch and content-rescore near misses;
7. walk the globally ranked candidates;
8. post-fetch guard visibility and skill payload shape;
9. project at most two non-empty packets.

Local evidence receives no score bonus. A public record can outrank a local
one, and vice versa.

The plugin adds post-fetch deduplication by canonical episode identity. Public
`EpisodeV1` records and legacy trace envelopes expose their episode/session
identity through the application record projection; local records expose the
same identity. When both forms of one episode are candidates, they consume one
slot. The local record is preferred for that duplicate because it retains the
operator's fuller private evidence. The plugin continues walking the ranked
list until it has two unique packets or exhausts the candidates.

Reference deduplication and the existing summary/origin key remain as earlier,
cheaper guards.

### 7.4 Wiring

`buildPluginDepsFromEnv` constructs the evidence port before the default corpus
so the same evidence instance can back both capture and local retrieval:

```text
evidence      = createEvidenceAdapter(...)
localCorpus   = createLocalEpisodeCorpusAdapter({ evidence })
publicCorpus  = createCorpusAdapter({ layer: buildDefaultLayer() })
corpus        = createFederatedCorpusAdapter({ localCorpus, publicCorpus })
```

An explicit `overrides.corpus` continues to replace the whole default corpus,
preserving test and embedder behavior. An explicit `overrides.evidence` is the
evidence instance used by both plugin persistence and the default local
adapter.

No default discovery URL, IPFS gateway, corpus cache, public endpoint, or
network request behavior changes. The layer adapter only preserves the
already-returned public verification fact described in section 7.1.

### 7.5 Hermes pickup checkpoint

The Hermes hook stores a per-logical-session checkpoint containing:

- stable host task identity, when supplied;
- repository identity;
- canonical episode identities already delivered.

Pickup runs:

- on the first turn;
- again when a non-empty stable host task identity changes;
- again when repository identity changes.

If Hermes supplies no stable task identity, Jinn remains first-turn-only for
that session rather than guessing task changes from ordinary message text.
Repeated calls for the same task/repository checkpoint do nothing.

The process contract adds an optional `excludeCanonicalEpisodeIds` array to the
pickup request. Hermes sends the identities in its checkpoint. The pickup
result adds `deliveredCanonicalEpisodeIds`, derived from the records that
produced packets, and Hermes merges them into the checkpoint. This makes
repeat exclusion explicit across the existing one-process-per-pickup boundary.
The activity record continues to record the actual searched and delivered
references.

Both fields are additive and default to an empty array, so the process contract
remains version 1 under the repository's existing additive-contract rule.

## 8. Retrieval flow

1. Hermes identifies an eligible pickup checkpoint.
2. Jinn derives search terms from the current task message and repository.
3. Each term reaches the federated port.
4. The local adapter scans its one in-memory snapshot while the public adapter
   performs its existing network search.
5. The federated port returns all usable hits and an honest combined status.
6. Jinn ranks the combined hits without a source bonus.
7. Candidate fetches route through their originating adapter.
8. Visibility, skill shape, canonical identity, and empty-packet guards run.
9. Jinn injects zero, one, or two unique packets.
10. Hermes records the checkpoint and delivered canonical identities.

## 9. Failure behavior

- **Public unavailable or timed out:** local results remain eligible and can be
  delivered.
- **Local directory absent:** local search is an empty success; public pickup
  continues.
- **Some local episodes malformed:** valid local values are retained and the
  combined result is degraded.
- **One candidate cannot be fetched:** Jinn continues to the next ranked
  candidate.
- **Both sources unavailable:** pickup injects nothing and the host task
  proceeds.
- **Partial success:** useful packets are delivered and session activity is
  marked degraded with the first concrete reason.
- **Duplicate local/public episode:** one local packet is delivered and the
  duplicate does not spend the second slot.

No failure in this read path mutates either corpus.

## 10. Testing

### 10.1 Local adapter

- maps summary, tags, tier, timestamp, canonical identity, and visibility;
- searches summary and tags case-insensitively;
- shares one `evidence.list()` call across concurrent term searches;
- routes encoded local references through `get()`;
- returns valid episodes when the evidence list is degraded;
- projects local and public `EpisodeV1` through the same record helper;
- never rewrites stored episode bytes.

### 10.2 Federated adapter

- searches children concurrently;
- covers the complete status-combination table;
- preserves deterministic local-then-public merge order;
- routes local and public references correctly;
- times out one child without discarding the other's value;
- opens the per-invocation circuit after a timeout;
- never applies relevance or visibility policy.

### 10.3 Pickup policy

- globally ranks mixed local/public candidates;
- allows either source to win on relevance;
- applies `retrievalVisible` equally to both sources;
- excludes an unmarked public record;
- includes every retained local record through the adapter's `true` projection;
- excludes skill payloads and empty packets as today;
- deduplicates local/public forms by canonical episode identity;
- prefers the local form of a duplicate;
- continues until two unique packets are found.

### 10.4 Hermes integration

- first turn triggers pickup;
- unchanged task/repository checkpoint does not;
- changed stable task identity triggers pickup;
- changed repository triggers pickup;
- absent stable task identity remains first-turn-only;
- a later pickup does not redeliver a prior canonical episode;
- public unavailability still produces local context;
- local absence still produces public context.

## 11. Acceptance criteria

The implementation is accepted when:

1. one pickup can return local and public packets from one global ranking;
2. the total delivery cap remains two packets;
3. both sources obey the current `retrievalVisible` guards;
4. every retained local episode is projected as visible without file
   migration;
5. one source can deliver while the other is unavailable or timed out;
6. a local/public duplicate is delivered once, preferring local;
7. the local episode store is listed once per pickup process;
8. public search volume does not increase relative to the existing per-term
   pickup;
9. task/repository checkpoint changes can retrigger pickup without repeat
   delivery;
10. no publishing, schema, indexer, retention, OpenViking, or usefulness-policy
    behavior changes.

## 12. Expected implementation impact

This is a medium, localized feature:

- one local episode corpus adapter;
- one federated corpus adapter;
- a small shared Episode-to-record projection extraction;
- default wiring composition;
- canonical-identity deduplication in pickup;
- a small Hermes checkpoint extension;
- focused unit and integration tests.

It requires no new service, database, public reindex, or stored episode
migration. Removing `retrievalVisible`, enabling publication, and adding a
usefulness selector remain separate future designs.
