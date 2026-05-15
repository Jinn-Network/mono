---
id: DR-2026-05-12-a
title: Network explorer — rides the indexer, reads public surfaces (GraphQL + aggregation routes), quality-first leaderboard, rdod is the N=1 instance
date: 2026-05-12
verb: Steer
status: ratified
authors: oak (proposed and ratified) with opus
spec: docs/superpowers/specs/2026-05-12-network-explorer-design.md; spec/2026-05-11-discovery-api-and-shared-indexer.md
related: jinn-mono-ebu7, jinn-mono-ebu7.1, jinn-mono-rdod, jinn-mono-uy6v
---

## Context

`jinn-mono-ebu7` is a public, daemon-free surface showing what the Jinn network as a whole is doing — work done and performance across operators and SolverNets — built over the privately-operated Ponder indexer shipped as `jinn-mono-280n` (`spec/2026-05-11-discovery-api-and-shared-indexer.md`). `jinn-mono-ebu7.1` is the design task; its output is the design doc (`docs/superpowers/specs/2026-05-12-network-explorer-design.md` v0.2), this DR, and the implementation child beads `ebu7.2`–`ebu7.7`. This DR records the four major picks the design settled so they don't get re-litigated in the children.

## Decision

1. **The explorer rides the indexer service — one deployable, the one that already exists.** `@jinn-network/indexer` gains the explorer static SPA served at `/` and `/explorer/*` JSON aggregation routes mounted alongside Ponder's auto-generated GraphQL endpoint (Hono routes). There is no separate site to deploy and no new infrastructure. The "team-hosted canonical instance" is the daemon maintainer's existing indexer instance; anyone who runs `@jinn-network/indexer` serves an explorer for free, and the static SPA can be pointed at any indexer URL. The operator app may link out to a canonical explorer URL; it does not embed it.

2. **The explorer reads the indexer's public surfaces — Ponder's auto GraphQL + the `/explorer/*` aggregation routes — not an extended `DiscoveryAPI`.** `DiscoveryAPI` stays daemon-shaped (claim discovery: point lookups, operator-filtered, claim-window-windowed, polled). The explorer uses Ponder's auto GraphQL for flexible entity list/filter/sort/cursor-paginate (leaderboard rows under arbitrary facets, attempt feeds, checkpoint lists, operator history) and thin custom JSON routes for rollups and server-bucketed time series (the learning curve, KPI bundles, cross-entity aggregates). It never reaches past these public surfaces — no direct Postgres, no Ponder internals, no on-chain RPC of its own. The single-source invariant is the Ponder *schema*, not the read interfaces. The Ponder schema grows additively (`RewardDistribution`; activation of the spec'd-but-inert `HarnessRollup` / `LanguageRollup` / `FreezeViolation` from on-chain reputation payload v2; `HarnessCheckpoint`; a deferred `AttemptEnvelopeMeta` populated by an IPFS-enrichment pass).

3. **Leaderboard ranking is quality-first, with a min-attempts floor.** The headline sort is the SolverNet's own scoring metric where one is defined (e.g. SWE-rebench resolved-rate), else verdict-success rate; throughput, settled-task count, JINN earned, and dominant-harness are sortable columns but not the headline. Train and frozen are separate boards. Operators below a minimum number of resolved attempts (`N` ~5–10, pinned at impl) are listed but not ranked among leaders — they sit in a separate "new / low-volume" section with raw numbers. The aggregate the explorer exists to make legible is the **best frozen-checkpoint resolved-rate** trending up over successive checkpoints — "as your agent learns, the network learns" made observable via a rolling-rate learning curve + checkpoint timeline.

4. **`jinn-mono-rdod` is the explorer at N=1 scope, not a separate artifact.** v1 (`jinn-mono-uy6v`) ships exactly one SolverNet (SWE-rebench v2); at N=1 the network view and the per-SolverNet view are the same data. `rdod` is "this explorer, with the SolverNet filter pinned to SWE-rebench v2"; it remains the tracking bead for the `uy6v` release gate and gains a dependency on the explorer children (`ebu7.2` → `ebu7.3` → `ebu7.4` → `ebu7.5`). The multi-net pages (SolverNets index, cross-net operator leaderboard, summed network rollups) are designed now but only have data to chew on once a second SolverNet exists; they ship as `ebu7.7`. (This confirms the resolution already noted on `jinn-mono-ebu7`.)

## Rationale

- **Riding the indexer is the minimal-infra path consistent with the headless posture.** The indexer is already a required running service (privately operated, not protocol infra — `spec/2026-05-11-...` §8.1). Mounting a static bundle + JSON routes on it adds zero new deployables, zero new ops surface, and zero new trust assumptions; it also means "operator-runnable" falls out for free. A separate static deploy decouples release cadence but costs another thing to keep alive — not worth it at current scale.
- **GraphQL is the standard onchain-analytics read path and gives faceting for free.** A subgraph-style auto-generated GraphQL API over the schema is exactly the shape a faceted explorer wants for entity queries (cursor pagination, arbitrary filters, sorts). Custom routes are only needed where GraphQL can't express the aggregation (rolling rates, bucketed series). Two thin layers over one schema; the daemon's `DiscoveryAPI` stays narrow.
- **Quality-first ranking matches the thesis.** The explorer's job is to show a self-improving agent getting better — that's a quality trend, not a throughput count. Ranking by throughput or by (testnet, play-money) JINN earned would headline the wrong thing. The min-attempts floor stops a single lucky pass topping the board without statistical machinery the UI would have to explain.
- **rdod-as-N=1-instance avoids building the same surface twice.** The SWE-rebench v2 dashboard and the fleet explorer are the same code with a filter applied; treating `rdod` as a distinct deliverable would duplicate work and risk drift between the two.

## Alternatives considered and rejected

- **Separate static explorer deploy** (own host, points at the indexer URL). Rejected: one more thing to deploy and keep alive; the indexer already exists and can serve it; decoupled release cadence isn't worth the ops cost at current scale. (Revisit if traffic or release-cadence pressure justifies it.)
- **Extend `DiscoveryAPI` with aggregate/leaderboard methods** so the explorer "reads through DiscoveryAPI" literally. Rejected: bloats a deliberately narrow daemon interface with a different consumer's query shapes; the DRY invariant is the schema, not the interface.
- **Explorer SPA hits Ponder GraphQL with no aggregation layer at all.** Rejected: rolling rates / bucketed time series / cross-entity rollups are awkward-to-impossible in GraphQL and would push aggregation into the browser (shipping raw events) — the `/explorer/*` routes exist precisely for these.
- **Throughput-first or JINN-earned-first leaderboard ranking.** Rejected: headlines activity or play-money rather than the quality trend the explorer is for; both available as sortable columns.
- **Wilson lower-bound / Bayesian shrinkage as the leaderboard sort key.** Rejected for v1: more statistically correct but more to explain in the UI; the simple min-attempts threshold + low-volume section is enough. Revisit if it proves unsatisfying.
- **Operator-app-only explorer (a tab in the operator dashboard).** Rejected: contradicts the "daemon-free public surface" requirement — a non-operator couldn't see it.

## Consequences

- **`docs/superpowers/specs/2026-05-12-network-explorer-design.md`** is the design of record (v0.2).
- **Implementation children** `jinn-mono-ebu7.2`–`ebu7.7` are filed off this design; `ebu7.4` is the `rdod`-shaped deliverable and `jinn-mono-rdod` gains a dependency on it.
- **`spec/2026-05-11-discovery-api-and-shared-indexer.md`** §7's "narrow at v0.1, additive later" promise is exercised — the explorer's schema additions are the first additive extension.
- **`@jinn-network/indexer`** acquires an explorer SPA + `/explorer/*` routes; `packages/indexer/deploy/README.md` gains the explorer note (`ebu7.5`).
- **Open questions** carried into implementation are listed in the design doc §9 (SWE-rebench eval/frozen task-split delineation; the on-chain→envelope CID link for enrichment; `LanguageRollup` source; "active operator" window + min-attempts value; materialized rollups vs compute-on-read; `HarnessCheckpoint` publication surface; GraphQL-vs-route boundary per query; chart-library choice).
