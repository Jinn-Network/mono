# Corpus search — prior-art survey & recommendation

- **Version:** 0.1
- **Date:** 2026-06-01
- **Author:** corpus-search spike (#931), deep-research synthesis
- **Status:** Spike finding (research output, not a ratified spec). Feeds the corpus-search `feat`.

## 1. Context & question

Corpus discovery today is **structural-only**: `DiscoveryAPI.queryEnvelopes(CorpusQuery)`
([client/src/discovery/types.ts](../client/src/discovery/types.ts), [client/src/corpus/types.ts](../client/src/corpus/types.ts))
filters on exact protocol keys — `solverType`, `artifactType`, `taskCid`, `participant.safeAddress`,
`evidenceTier`, time window, `manifestHash` — served by the Ponder indexer (Postgres) over an always-live
`eth_getLogs` floor (`OnchainDiscoveryAPI`), per [spec/2026-05-11-discovery-api-and-shared-indexer.md](2026-05-11-discovery-api-and-shared-indexer.md).
There is no topical facet, no keyword/full-text, no semantic search, and no relevance ranking. A buyer or
agent arriving with a *need* ("evaluations of prediction tasks about X") has no query path — only coordinates
they'd already have if they knew the artifact.

**Origin.** The spike was prompted by [**mozilla-ai/cq**](https://github.com/mozilla-ai/cq) ("Stack Overflow
for agents") — a shared agent-learning commons whose query surface invited the comparison with ours. Direct
analysis of cq (its source, not just its docs) is the seed data point: knowledge units carry topical **domain
tags + language/framework context + free-text** summary/detail; the *shipped* query (`repositories/_queries.py`)
is domain-tag **set-membership + recency** ordering, taking `(domains, languages, frameworks, pattern, limit)`;
its advertised "hybrid keyword + semantic (pgvector)" search is **design-doc only** — absent from
`server/backend/pyproject.toml` and explicitly out-of-scope of the portable query layer ("vector / full-text…
live in their respective concrete stores"). Two transferable lessons drove the wider survey: **(a)
facets-for-findability** (attach topical/content facets so knowledge is findable by need), and **(b) the search
seam** lives in the indexed-store tier above a deterministic core — which is exactly our Ponder-indexer-vs-
onchain-floor split. cq is treated as a full system below (agent shared-learning category).

This spike surveyed three families of prior art — decentralized data/knowledge markets, production hybrid
search engines, and AI agent-memory / shared-learning systems — to answer four questions per system:
(1) findability by need, (2) how trust/quality is fused with relevance, (3) where the deterministic-core ↔
indexed-search-tier seam is drawn, (4) what is novel/unsolved for a hash-addressed, on-chain-anchored,
**pay-per-access** market. Every non-obvious external claim is cited in §Sources.

## 2. TL;DR recommendation

**Stay in Postgres; layer hybrid search at the indexer tier; keep the on-chain floor deterministic; make
trust-weighted ranking the differentiator.** Concretely, phase it:

- **Phase 0 — facets + keyword (cheap, no new infra):** add public topical facets and a `tsvector`/GIN
  full-text column over *public manifest metadata* at the indexer; extend `CorpusQuery` with a `text` param and
  topical facets. Closes most of the "find by need" gap with zero embedding pipeline.
- **Phase 1 — semantic (when keyword proves insufficient):** add a `pgvector` HNSW column + RRF fusion in SQL.
  This introduces the one genuinely new operational burden — an embedding pipeline (embed metadata at index
  time, embed query at search time). Keep embeddings in the *rebuildable index*, never in the canonical store.
- **Phase 2 — trust-weighted ranking (the novel part):** fold evidence tier, evaluator verdict, signer
  reputation, and recency into the fused `ORDER BY`. **No prior art does this** — and Jinn already owns these
  signals as indexer columns.
- **Defer** a dedicated engine (OpenSearch/Vespa/Weaviate/Qdrant) until a concrete wall: corpus too large for
  HNSW-in-RAM, `ts_rank` relevance proven insufficient vs. real BM25, or learned reranking required.

The architectural fit is exact: every comparable verifiable system has the *same shape Jinn already has* — an
indexer above an immutable anchor — and all reach for the *same next rung* (facets + keyword via Postgres/ES).

## 3. Comparative table

Q1 = findability mechanism · Q2 = trust fused with relevance · Q3 = core↔search seam · Q4 = novel/unsolved for verifiable+paid.
"shipped" vs "design-doc" flags what is actually implemented.

| System | Q1 — find by need | Q2 — trust×relevance | Q3 — seam | Notable |
|---|---|---|---|---|
| **Ocean Protocol** | Facets + keyword/full-text via **Aquarius → Elasticsearch** (raw ES DSL passthrough over DDO metadata). No semantic. *shipped* | Not fused; trust fields (consumes, price, publisher) are sortable, blend is client-defined | ES cache **above** on-chain `MetadataCreated` event log; index rebuildable, not source of truth | Metadata encrypted on-chain → indexer must decrypt to index; "raw ES passthrough" = undefined/unverifiable ranking contract |
| **The Graph** | Structured GraphQL filters + **declared full-text fields** (Postgres `ts_vector`/GIN, `ts_rank` or cover-density). No semantic. *shipped* | **Not fused** — curation/staking governs *which subgraph is served*, not entity rank | Postgres entities deterministically derived from chain; search above immutable derived store | **Key precedent:** full-text relevance is *non-deterministic*, historically rejected on the decentralized net ("not yet deterministic", graph-node #3355) — relevance doesn't compose with consensus |
| **Filecoin/IPFS — IPNI** | **None.** Reverse index CID/multihash → provider only. Must already know the CID. *shipped* | N/A | Routing cache above content-addressed store; indexes *location*, never *meaning* | The boundary marker: **a hash is semantically opaque** — discovery must be built over separately-published metadata, never the CID |
| **Bittensor** (subnets 14/40/47) | **Embeddings/semantic vector** retrieval-as-a-service (off-chain miner compute), via dendrite/axon RPC. *shipped (as subnets)* | **Quality IS the trust signal** — validators score retrieval quality → on-chain weights → emissions | Chain holds only weights/stake/emissions; **no immutable corpus**, each miner holds its own store | Sidesteps determinism by never requiring result determinism, only *score-able quality* — at the cost of any single result's verifiability |
| **Story Protocol** | Graph traversal (lineage edges) + **centralized "Search IP Assets" semantic** add-on. *traversal shipped; semantic backend unconfirmed* | Graph structure (lineage/disputes) = traversal-time trust context, not a blended score | Centralized API above on-chain NFT + hash-anchored off-chain (IPFS) metadata | Treats semantic search as an off-chain trusted black box; graph structure as the verifiable discovery primitive |
| **OpenSearch / Elasticsearch** | BM25 + kNN(HNSW), fused by **RRF** (OS `score-ranker` 2.19; ES `rrf` retriever GA, weights 2.9+) or normalization processor. *shipped* | Mature: `function_score`/`script_score` blends recency-decay, popularity, `field_value_factor` reputation | Separate JVM cluster beside primary DB | Batteries-included but a whole second stateful system to operate |
| **Vespa** | Native unified `bm25()` + `nearestNeighbor`/`closeness`, fused in `rank-profile` phases. *shipped* | **Best-in-class:** ranking is a free-form expression over attributes, `freshness()`, query tensors | Single engine; can be source of truth or index | Most expressive ranking; steepest ops; reach for it only if ranking *is* the product |
| **Weaviate / Qdrant** | BM25(+sparse)+vector, RRF / relative-score / DBSF fusion. Qdrant has **no native BM25** (needs sparse embeddings). *shipped* | Qdrant **Formula Query** (decay + payload multipliers) is strong; Weaviate weak (alpha + filters only) | Separate vector service | Lateral move vs. Postgres — adds a second store without solving trust-blending better than SQL |
| **Meilisearch / Typesense** | FTS-first + optional vectors; single `semanticRatio` / rank-fusion `0.7·K+0.3·S`. *shipped/GA* | Tunable ranking rules + numeric sort fields (lightweight) | Single binary beside primary DB | Lowest-ops dedicated engine; still a second service + embedding source |
| **pgvector + tsvector (Postgres)** | `tsvector`/`ts_rank_cd` keyword + `pgvector` HNSW semantic, **RRF fused in one SQL statement**. *shipped* | **Trivial & expressive** — fused score is a SQL expression; add `w·exp(-age/τ) + w·reputation` from existing columns | **Same DB** as the canonical/derived store; index rebuildable | Not true Lucene BM25 (ParadeDB `pg_search` adds it); HNSW wants RAM; the directly-relevant path since Ponder already runs Postgres |
| **mozilla-ai cq** *(origin)* | Topical **domain-tag facets** + language/framework + free-text `pattern`; *shipped* query = tag set-membership + recency. Semantic/FTS **design-doc only** (absent from deps). *shipped* | **Social trust**: confidence (from 0.5) + confirmations + contributing-org diversity + staleness decay + dispute filter — but *shipped* ranking is **recency-only**; trust is reputational + HITL, not in the search score | Explicit: **portable query layer** (deterministic tag-filter) vs **concrete store** where FTS/vector "live"; local SQLite vs remote Postgres | The project that prompted this spike. **Free social-trust commons** — no pay-per-access, no cryptographic verifiability. Lessons: facets-for-findability + the indexed-tier seam |
| **Letta (MemGPT)** | **Hybrid by default**: vector + full-text, RRF-fused; default store **Postgres+pgvector**, `text-embedding-3-small` | Relevance-only; no importance/recency/confidence in default ranker; tags filter only | Canonical store *is* the index (same Postgres) | **Trap (#3210):** the archive owns its own embedding config and goes stale — *don't let the index own canonical embedding config* |
| **mem0** | Default **vector-only** (Qdrant + `text-embedding-3-small`); BM25/hybrid + rerank **opt-in**; graph optional | Quality via **write-time ADD/UPDATE/DELETE/NOOP** curation, not query-time ranking | Vector store is index + record-of-distilled-facts | Curate-the-store (LLM conflict resolution) as an alternative to query-time trust ranking |
| **Zep + Graphiti** | **Genuine LLM-free hybrid**: cosine + Okapi BM25 + graph BFS; many RRF/MMR/node-distance/cross-encoder recipes | Richest reranking (graph-distance, episode-mention salience, MMR, cross-encoder); no explicit recency-decay | Graph **is** source of truth; heavy **ingest dedup/entity-resolution** keeps index canonical | **Best model for us:** bi-temporal **invalidation-not-deletion** (superseded facts stay auditable/point-in-time queryable); provenance (episodes) first-class; `group_id` namespacing |
| **LlamaIndex / LangChain** | Default **pure vector**; RRF-fused BM25+vector hybrid is the standard **opt-in**; rerank a further bolt-on | None by default | Index separate from app's store-of-record | Confirms the convergent default: vector-only underperforms; hybrid+RRF is the norm |

## 4. Per-category synthesis

**Decentralized markets.** All have Jinn's exact shape — an indexer above an immutable anchor — and all reach
for facets + keyword (Ocean's Elasticsearch over event-logged DDOs; The Graph's Postgres full-text over
chain-derived entities; Story's centralized API over hash-anchored IPFS metadata). **IPNI is the cautionary
boundary:** content addressing gives you "identity → bytes" and pointedly *nothing* for "need → identity," so a
semantic/topical layer must be built over separately-published metadata. **The Graph is the key precedent:**
relevance ranking is non-deterministic and therefore does not compose with consensus/verifiable derivation
(graph-node #3355) — the practical resolution is to push relevance *out* of the verifiable core into an
explicitly best-effort, possibly per-indexer tier. **Bittensor** is the one decentralized system doing genuine
semantic retrieval, by collapsing "is this good" and "is this trustworthy" into one staked incentive loop — but
it buys relevance at the cost of any single result's verifiability and requires no result determinism.

**Hybrid search engines.** The shape is identical everywhere: a lexical retriever (BM25 / `tsvector`) and a
semantic retriever (ANN over embeddings, almost always HNSW) run in parallel, then fuse — RRF (rank-based,
tuning-free, `k≈60`), score-normalization + weighted combination, or distribution-based. The expensive new
dependency in *every* option is the embedding model + an inference pipeline at write and query time, plus a
vector index that wants RAM. **The decisive finding for Jinn: Postgres alone delivers credible hybrid** —
`tsvector` keyword + `pgvector` HNSW + the canonical [RRF-in-SQL pattern](https://github.com/pgvector/pgvector-python/blob/master/examples/hybrid_search/rrf.py)
(two CTEs, `FULL OUTER JOIN`, `1/(k+rank)` summed) — with no second service. And because the fused score is just
a SQL expression, **blending external trust/recency/reputation signals is trivial** when those signals already
live in indexer columns — Vespa-class signal-blending without Vespa's operational weight.

**Agent memory.** The convergent shipped default is **RRF-fused hybrid (dense + BM25)** with reranking as an
opt-in — confirming pure vector underperforms for keyed/technical content (tx hashes, CIDs, addresses), which
matters for Jinn's signed artifacts where exact identifiers must hit reliably. **Letta** validates the Postgres
path (its default store is Postgres+pgvector) and supplies a cautionary trap (#3210: don't let the index own its
own embedding config). **Graphiti is the strongest model for a verifiable shared corpus:** non-destructive
bi-temporal **invalidation-not-deletion** (superseded knowledge stays auditable and point-in-time queryable),
ingest **dedup/entity-resolution** (one canonical index, not per-writer forks), LLM-free low-latency retrieval,
and provenance-as-first-class. **mem0** offers write-time curation (ADD/UPDATE/DELETE/NOOP) as an alternative way
to keep a multi-writer store coherent. **cq — the origin of this spike — sits at the other end of the trust
spectrum from Jinn:** it is the only surveyed system that, like Jinn, treats knowledge as a *shared, multi-
contributor commons* (not single-agent memory), and it solves findability the cheap way every verifiable system
above also lands on — **topical facets + recency**, with semantic search deferred to a "concrete store" tier it
hasn't built. But its trust model is **social/reputational** (confidence scores, peer confirmations, HITL
promotion gates) layered *beside* the ranking, never folded into the search score — and it is a *free* commons,
so it never confronts pay-per-access or cryptographic verifiability. That is the precise contrast that motivates
Jinn's differentiator: replace cq's off-to-the-side social confidence with an **on-chain trust signal folded
into the rank** (evidence tier / evaluator verdict / signer reputation), over a paid, hash-verified corpus. cq
proves the facets+keyword floor is the right first rung; it also marks exactly where a verifiable market must go
further.

## 5. Cross-cutting patterns

1. **The verifiable core never gives findability-by-need.** Identity + integrity, yes; discovery, no. Semantic/
   topical search is *always* a separate, off-chain, best-effort tier over separately-published metadata.
2. **Relevance ranking is non-deterministic** and does not compose with consensus/verifiable derivation
   (The Graph #3355). Keep the canonical/structural layer deterministic; treat ranking as an explicit
   non-verifiable convenience tier.
3. **RRF-fused hybrid (lexical + dense) is the industry default;** pure vector underperforms on exact
   identifiers. Reranking is an opt-in layer, not table stakes.
4. **Separate the rebuildable index from the canonical store** (Letta #3210). The signed envelopes remain the
   source of truth; the search index (and its embedding config) is disposable and re-derivable.
5. **Two ways to fuse trust with relevance:** bolt trust on as a filterable/sortable field (Ocean/Story —
   simple, unverifiable blend) or make quality the staked signal (Bittensor — trust and relevance collapsed, at
   the cost of result verifiability). A third — fold a *verification* signal into a SQL ranking expression — is
   open, and is Jinn's opportunity.
6. **Non-destructive supersession** (Graphiti's bi-temporal invalidation) is the provenance-preserving way to
   handle stale/superseded knowledge — a natural fit for immutable on-chain anchoring.

## 6. Novel / unsolved for a verifiable, pay-per-access market

- **No prior art for ranking gated content.** Every system above searches a free-or-purchasable *commons* where
  metadata is openly indexable. None solves relevance when retrieval is **pay-per-access** and the indexer may
  only legitimately see *metadata*, not the paid bytes. **Resolution for Jinn:** index only the *public manifest
  metadata* (solverType, task description, public tags/summary, evidence tier, verdict); the paid artifact bytes
  stay behind x402 untouched. Search ranks the public surface; acquisition is still gated. This sidesteps the
  open problem rather than solving it in general — and should be stated as such.
- **Trust-as-a-ranking-signal across distinct contributors is unsolved in the wild.** No surveyed system fuses a
  confidence/verification/reputation signal into the relevance score, and none distinguishes *distinct* from
  *independent* contributors. Jinn's substrate uniquely owns these signals (evidence tiers self-signed →
  committed → attested, evaluator verdicts, on-chain attestation, signer reputation). Folding them into ranking
  is the differentiating contribution — and the place to be careful about Legibility (the chain proves
  distinctness, not independence).
- **Non-deterministic ranking across operator-run indexers.** If multiple parties run indexers, hybrid ranking
  will differ between them. This is acceptable *because* ranking is explicitly the non-verifiable tier; the
  deterministic `eth_getLogs` floor + structural query remain the verifiable, reproducible substrate. Worth
  stating as an accepted property, not a bug.

## 7. Recommendation & phasing for the corpus-search feat

Maps the patterns above onto Jinn's existing architecture (Ponder/Postgres indexer tier + `OnchainDiscoveryAPI`
floor + x402 + evidence tiers).

- **Phase 0 — facets + keyword full-text (no new infra).**
  - Decide which *public* manifest fields are indexable (task description, `solverType`, public tags, a public
    summary) and require them at publish time. **This is a data-model change** to envelopes/manifests and touches
    the canonical discovery spec — the feat owns a paired spec/`design` update.
  - Add a `tsvector` GIN column at the indexer; extend `CorpusQuery` with `text` + topical facet params; rank by
    `ts_rank_cd`. The on-chain floor degrades gracefully to today's structural query (no full-text there).
- **Phase 1 — semantic (gated on Phase 0 proving insufficient).**
  - Add a `pgvector` HNSW column; fuse keyword + vector with the RRF-in-SQL pattern (`k≈60`).
  - Stand up the embedding pipeline (the one real new burden): embed public metadata at index time, embed query
    at search time. Keep the embedding config in the *index*, re-embeddable; canonical store stays the signed
    envelopes (avoid Letta #3210). Budget for a full re-embed if the model changes.
- **Phase 2 — trust-weighted ranking (the differentiator).**
  - Add weighted terms to the fused `ORDER BY`: evidence tier, evaluator verdict, signer reputation, recency
    decay — all from columns the indexer already owns. This is what no prior art does.
- **Borrow from Graphiti:** invalidation-not-deletion for superseded envelopes (point-in-time queryable;
  envelopes are already immutable, so this is about *ranking down* superseded/challenged ones, not deleting),
  and ingest-time dedup/canonicalization so the index doesn't fork per-writer.
- **Defer dedicated engines** (OpenSearch/Vespa/Weaviate/Qdrant/Meilisearch) until a concrete wall. They mostly
  trade the single Postgres dependency for a second stateful service without beating SQL at trust-signal
  blending — the thing that matters most here.

## 8. Open questions / risks (for the feat's design session)

- **Who authors topical facets** — publisher-supplied, SolverType-schema-derived, or indexer-derived? What is
  the controlled vocabulary, and how is it kept honest (spam/keyword-stuffing on a paid market)?
- **Exact public-metadata vs gated-content boundary** per artifact type — what is safe to index without leaking
  paid content?
- **Embedding model choice and cost** if/when Phase 1 lands; re-embed strategy on model change.
- **Legibility of trust-weighted ranking** — distinctness vs independence; don't let ranking imply an
  independence claim the chain can't back (see [PRINCIPLES.md](../PRINCIPLES.md)).
- **Whether Phase 0 alone suffices** — keyword + facets may close enough of the gap that semantic is never worth
  the embedding pipeline. Measure before building Phase 1.

## Sources

Decentralized markets — Ocean Aquarius [API.md](https://github.com/oceanprotocol/aquarius/blob/main/API.md) /
[README](https://github.com/oceanprotocol/aquarius/blob/main/README.md); The Graph
[GraphQL API](https://thegraph.com/docs/en/subgraphs/querying/graphql-api/) /
[RFC-0004 full-text](https://graphprotocol.github.io/rfcs/rfcs/0004-fulltext-search.html) /
[graph-node #3355](https://github.com/graphprotocol/graph-node/issues/3355); IPFS
[IPNI](https://docs.ipfs.tech/concepts/ipni/) / [cid.contact](https://cid.contact/); Bittensor
[subnets.json](https://github.com/taostat/subnets-infos/blob/main/subnets.json) /
[Chunking subnet](https://learnbittensor.org/subnets/vectorchat/chunking); Story
[API intro](https://docs.story.foundation/api-reference/protocol/introduction) /
[IP Asset overview](https://docs.story.foundation/concepts/ip-asset/overview).

Hybrid engines — [pgvector](https://github.com/pgvector/pgvector) /
[RRF example](https://github.com/pgvector/pgvector-python/blob/master/examples/hybrid_search/rrf.py);
[OpenSearch hybrid](https://docs.opensearch.org/latest/vector-search/ai-search/hybrid-search/index/) /
[normalization processor](https://docs.opensearch.org/latest/search-plugins/search-pipelines/normalization-processor/) /
[RRF blog](https://opensearch.org/blog/introducing-reciprocal-rank-fusion-hybrid-search/);
[Elasticsearch RRF retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/rrf-retriever) /
[hybrid search](https://www.elastic.co/docs/solutions/search/hybrid-search);
[Vespa hybrid](https://docs.vespa.ai/en/learn/tutorials/hybrid-search.html) /
[nearest neighbor](https://docs.vespa.ai/en/querying/nearest-neighbor-search.html);
[Weaviate hybrid](https://docs.weaviate.io/weaviate/concepts/search/hybrid-search) /
[fusion algorithms](https://weaviate.io/blog/hybrid-search-fusion-algorithms);
[Qdrant hybrid](https://qdrant.tech/documentation/search/hybrid-queries/);
[Meilisearch hybrid](https://www.meilisearch.com/docs/capabilities/hybrid_search/overview);
[Typesense vector](https://typesense.org/docs/30.2/api/vector-search.html).

Agent memory — Letta [archival](https://docs.letta.com/guides/ade/archival-memory/) /
[archival-search](https://docs.letta.com/guides/agents/archival-search/) /
[#3210](https://github.com/letta-ai/letta/issues/3210); mem0
[repo](https://github.com/mem0ai/mem0) / [LLM.md](https://github.com/mem0ai/mem0/blob/main/LLM.md) /
[reranker](https://docs.mem0.ai/open-source/features/reranker-search) / [paper](https://arxiv.org/html/2504.19413v1);
Graphiti [repo](https://github.com/getzep/graphiti) /
[search docs](https://help.getzep.com/graphiti/working-with-data/searching) /
[Zep paper](https://arxiv.org/html/2501.13956v1);
LlamaIndex [RRF fusion](https://developers.llamaindex.ai/python/examples/retrievers/reciprocal_rerank_fusion/);
mozilla-ai cq [repo](https://github.com/mozilla-ai/cq) /
shipped query [repositories/_queries.py](https://github.com/mozilla-ai/cq/blob/main/server/backend/src/cq_server/repositories/_queries.py) +
[services/knowledge.py](https://github.com/mozilla-ai/cq/blob/main/server/backend/src/cq_server/services/knowledge.py) /
deps [pyproject.toml](https://github.com/mozilla-ai/cq/blob/main/server/backend/pyproject.toml) (no pgvector/embeddings — semantic is design-doc-only) /
[architecture.md](https://github.com/mozilla-ai/cq/blob/main/docs/architecture.md) (the unbuilt hybrid/pgvector design). Source analysis: #931 session.
