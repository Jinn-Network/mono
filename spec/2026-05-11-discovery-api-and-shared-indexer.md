# Discovery API and shared indexer

- **Date:** 2026-05-11 (v0.1 → v0.2 → v0.3)
- **Author:** Oak with Opus
- **Status:** Design draft — ready for review
- **Version:** 0.3
- **v0.3 change (revert):** Backed out the v0.2 "daemon-is-the-indexer" collapse. The indexer is a standalone Ponder service deployed via standard Ponder patterns (`deploy/README.md`); the daemon talks to it via GraphQL. Dropped the snapshot-publication-to-IPFS subsystem, the `publishIndexer` config flag, and the near-term scope of embedded mode (moved to §15 Deferred future work). The simpler design matches canonical Ponder deployment and removes engineering that was solving problems Ponder already solves (rolling deploys via `DATABASE_SCHEMA` + views; health endpoints; multi-replica HTTP scaling).
- **v0.2 change (superseded):** Removed the standalone-indexer deployment shape. Reverted in v0.3.
- **v0.1 → v0.2 was a misread of the user's deployment intent.** Recording the reversal for posterity.
- **Related:**
  - `spec/2026-04-30-phase-a-umbrella.md` (corpus library as the "first app" / programmatic library; `routeResolver` seam)
  - `spec/2026-05-05-solvernet-creation-and-launch.md` §13 (registry client interface designed to be swappable)
  - `spec/2026-05-registry-discovery.md` (external impl registry — sibling discovery problem)
  - `client/src/corpus/index.ts`, `client/src/corpus/onchain-query.ts` (existing on-chain discovery path)
  - `client/src/adapters/mech/task-subgraph.ts` (the load-bearing subgraph dependency)
  - `client/src/solvernets/registry-client.ts`, `client/src/solvernets/most-recent-wins.ts` (SolverNet manifest registry)
  - `client/src/erc8004/subgraph.ts` (stub; peer/artifact backfill path, currently inactive)

## 1. Purpose

Define how the daemon performs read-side discovery (claimable tasks, SolverNet manifests, corpus envelopes) without a runtime dependency on a third-party hosted subgraph that requires a centralized API key.

The decision: introduce a `DiscoveryAPI` interface, ship two concrete implementations (`HttpDiscoveryAPI` that talks GraphQL to a Ponder service; `OnchainDiscoveryAPI` that reads directly from RPC), and run Ponder as a standalone service that the daemon consumes over HTTP. The daemon's default configuration points at a Ponder instance **privately operated by the daemon's current maintainer** (Oak), deployed using the canonical Ponder deployment pattern (Postgres-backed, GraphQL endpoint, rolling deploys via `DATABASE_SCHEMA` + views — see `packages/indexer/deploy/README.md`). It is not protocol infrastructure and not Jinn-the-project-operated. Operators who want a different default point at a different URL; operators who want maximum trust-minimisation pin `discovery.mode: 'onchain'` and use the on-chain floor only.

## 2. Problem

The daemon currently has three subgraph callsites. Two are inactive or already have an alternative; one is load-bearing.

### 2.1 Load-bearing: task claim discovery

`client/src/adapters/mech/task-subgraph.ts` → `client/src/adapters/mech/adapter.ts:545-580` (`discoverSubgraphRestorationTasks`).

The `CLAIMABLE_TASKS_QUERY` filters JinnRouter `Task` entities by `manifestDigest`, time-windowed `claimWindowStart_lte` / `claimWindowEnd_gte`, `refunded: false`, `finalized: false`, joined with `attempts` and `operatorAttempts` to compute per-task and per-operator attempt counts. The delivery-watcher loop polls this constantly.

The query is the only place in the daemon where a real *join* is required — attempt counts per `(task, operator)`. Reproducing this against raw RPC requires enumerating `AttemptSubmitted` events and grouping client-side, i.e. building a small purpose-built indexer.

### 2.2 Already neutralised: corpus discovery

`client/src/corpus/query.ts` (subgraph path) coexists with `client/src/corpus/onchain-query.ts` (direct `IdentityRegistry.MetadataSet` event scan via viem `getLogs`). `client/src/corpus/index.ts:79-92` runs whichever is configured, merging refs and surfacing per-source warnings. The corpus library is *not* blocked by this spec — its on-chain mode already works.

### 2.3 Mechanically swappable: SolverNet manifest registry

`client/src/solvernets/registry-client-erc8004.ts` reads `IdentityRegistry.setMetadata` events keyed `solvernet-manifest:*` and folds them via `most-recent-wins.ts` into current lifecycle status. The fold is a pure function over an event array. Swapping the event source from subgraph to `getLogs` is mechanical. `spec/2026-05-05-solvernet-creation-and-launch.md` §13 already calls this out as a day-1 backing meant to be replaceable.

### 2.4 Inactive: peer-discovery / artifact backfill

`client/src/erc8004/subgraph.ts` is a stub returning empty arrays pending the rebuilt Jinn subgraph (bead `jinn-mono-fud`). Not load-bearing.

### 2.5 What "centralized API key" actually buys us today

A hosted Graph subgraph with an API key gives the daemon: indexed task tables with joins, low latency, no per-operator infra, no cold-start sync. The cost is a single Jinn-controlled API key that operators implicitly depend on, with no failover when the key is revoked, the hosted service is deprecated, or quotas are exceeded. This is the dependency this spec removes.

## 3. Non-goals

- **Decentralised indexer network selection.** Subsquid, The Graph decentralised network, peer-gossip indexing — out of scope. They remain available as future `DiscoveryAPI` implementations.
- **Marketplace UI / consumer app.** This spec defines the discovery substrate the marketplace will consume; the marketplace itself is a separate spec.
- **Removing IPFS / content-layer dependencies.** Manifest fetches still go through IPFS gateways (Autonolas by default). x402 still gates per-artifact bytes. This spec is about *discovery*, not *retrieval*.
- **Changing the on-chain schema.** No new contracts, no new events. The daemon already produces all the data this spec consumes.

## 4. Decision summary

1. **One interface, two concrete implementations + a transitional one.** A new `DiscoveryAPI` interface in `client/src/discovery/` abstracts the read-side queries the daemon currently issues against the subgraph. Shipped: `HttpDiscoveryAPI` (calls a Ponder service over GraphQL), `OnchainDiscoveryAPI` (direct RPC; the always-live floor), and `HttpSubgraphDiscoveryAPI` (transitional, retained for the migration window only).
2. **Indexer is a standalone Ponder service.** `packages/indexer/` is deployed using Ponder's canonical patterns (Postgres + `DATABASE_SCHEMA` + views for zero-downtime rolling deploys). Not bundled into the daemon. Not invented infrastructure. Standard `Dockerfile` at `packages/indexer/deploy/Dockerfile`; deployment guide at `packages/indexer/deploy/README.md`.
3. **HTTP-to-Ponder is the default.** Default daemon configuration points at the URL of a Ponder instance privately operated by the daemon's current maintainer (Oak). This is one operator's deployment, not protocol infrastructure. Operators flip `discovery.mode: 'onchain'` for maximum trust-minimisation, or change `discovery.url` to point at a different operator's deployment.
4. **On-chain fallback is always live.** If the configured HTTP indexer is unreachable (5xx, timeout, 429), the daemon falls back to `OnchainDiscoveryAPI` for the duration of the outage. Slower but functional. Operators stay live during indexer outages.
5. **Hosted Graph subgraph is removed, not retained as a fallback.** Once `DiscoveryAPI` ships, `subgraphUrl` callsites move to the new interface. The Graph dependency leaves the runtime.

## 5. The DiscoveryAPI interface

The interface captures *what the daemon needs to know*, not the storage backend. The shape is deliberately narrow:

```ts
// client/src/discovery/types.ts (illustrative)

export interface DiscoveryAPI {
  /**
   * Claimable tasks for a set of SolverNet manifests, filtered by operator.
   * Replaces `queryClaimableTaskCandidates` in task-subgraph.ts.
   */
  findClaimableTasks(args: {
    solverNetManifestCids: string[];
    operatorAddress: `0x${string}`;
    nowSeconds?: number;
    pageSize?: number;
    maxPages?: number;
  }): Promise<ClaimableTaskCandidate[]>;

  /**
   * SolverNet manifest registry — launched-instance summaries with
   * current lifecycle status. Replaces the subgraph fetcher in
   * `registry-client-erc8004.ts`.
   */
  listLaunchedSolverNets(args?: {
    launcherAgentId?: string;
    status?: Array<'launched' | 'paused' | 'retired'>;
  }): Promise<SolverNetManifestSummary[]>;

  getLifecycleStatus(
    manifestCid: string,
  ): Promise<SolverNetLifecycleStatus | undefined>;

  /**
   * Corpus envelope discovery — refs only, not bytes. The corpus
   * library wraps this and adds manifest fetch / acquire / hash verify.
   */
  queryEnvelopes(query: CorpusQuery): Promise<EnvelopeRef[]>;
}
```

Notes:

- The interface returns the same shapes the existing subgraph callers already consume (`SubgraphTaskCandidate` → renamed `ClaimableTaskCandidate`; `SolverNetManifestSummary` already exists; `EnvelopeRef` is the corpus library's existing type). No call-site changes beyond swapping the injected dependency.
- Each method is independently implementable. An implementation may throw `DiscoveryUnavailableError` for any subset of methods; the fallback chain catches and retries against the next implementation.
- No write surface. Manifest publication, lifecycle transitions, and ERC-8004 metadata writes continue to go directly on-chain through the existing publishers (`registry-client-erc8004.ts`, `IdentityPublisher`, etc.). `DiscoveryAPI` is read-only.

## 6. Implementations

### 6.1 `HttpDiscoveryAPI` — default

Thin HTTP client. Lives at `client/src/discovery/http.ts`. Talks GraphQL to a standalone Ponder service (`@jinn-network/indexer` deployed via `packages/indexer/deploy/`). The current default points at an instance privately operated by the daemon's maintainer (Oak). Default URL ships in `client/src/config.ts` (`DEFAULT_TESTNET_DISCOVERY_URL`, `DEFAULT_MAINNET_DISCOVERY_URL`), env-overridable via `JINN_DISCOVERY_URL` so any operator can repoint at a different host without touching the binary.

The GraphQL queries that the daemon issues are vendored in `http.ts` itself — symmetric to how `onchain.ts` vendors its own event-scan queries against the same on-chain data. The `@jinn-network/indexer` package contains the schema those queries target; both sides depend on a matching schema shape and update in lockstep.

API stability: the HTTP endpoint is a real versioned API. Breaking changes require a new path prefix (`/v2/...`) and a deprecation window for `/v1/...`. The operator running the Ponder service owns the API contract — operators who point at a third-party host inherit that host's stability discipline, which is a per-host trust decision. Ponder ships built-in `/health` (process started) and `/ready` (caught up to realtime) endpoints; the daemon's fallback chain treats a non-200 `/ready` as unhealthy.

### 6.2 `OnchainDiscoveryAPI` — fallback floor

Direct RPC via viem `getLogs` + multicall, no indexer state. Implements the same interface but with caveats:

- `findClaimableTasks`: enumerates `TaskCreated` events from a known start block, multicalls current `finalized` / `refunded` state, enumerates `TaskAttemptCreated` events and groups client-side. Bounded result set (only active claim windows), but slow on cold scans. Caches results in the daemon's existing SQLite for the duration of the daemon process.
- `listLaunchedSolverNets` / `getLifecycleStatus`: reads `IdentityRegistry.MetadataSet` events directly (the same path `corpus/onchain-query.ts` already implements), folds via `most-recent-wins.ts`.
- `queryEnvelopes`: delegates to the existing `runOnchainCorpusQuery` in `corpus/onchain-query.ts`.

The on-chain implementation is the **always-live floor**. The daemon ships with it enabled and uses it as the primary if no Ponder service URL is configured. This is the property that lets the daemon boot working even before the maintainer's Ponder instance is up.

## 7. Ponder schema

The Ponder package indexes four event sources, each producing one entity:

| Entity | Source events | Used by |
|---|---|---|
| `Task` | `JinnRouter.TaskCreated`, `TaskFinalized`, `TaskRefunded` | `findClaimableTasks` |
| `Attempt` | `JinnRouter.AttemptSubmitted`, `AttemptResolved` | `findClaimableTasks` (joined with Task) |
| `SolverNetManifest` | `IdentityRegistry.MetadataSet` (key prefix `solvernet-manifest:`) | `listLaunchedSolverNets`, `getLifecycleStatus` |
| `Envelope` | `IdentityRegistry.MetadataSet` (envelope keys per ERC-8004 spec) | `queryEnvelopes` |

The schema is **deliberately narrow at v0.1**: it replaces today's three subgraph callsites and nothing more. Phase B.2 reputation entities, Phase C marketplace-specific entities, and any other future query domains are additive — they slot in as new entities + handlers without renaming or restructuring the existing four.

Schema version is bumped on any breaking change to existing entities; re-syncs go through Ponder's canonical rolling-deploy pattern (`DATABASE_SCHEMA` + views — see `packages/indexer/deploy/README.md`). Pure-additive changes do not bump the version; Ponder handles them automatically.

## 8. Deployment shapes

Two services exist in this design: the **indexer** (a standalone Ponder app) and the **daemon** (the operator's process). They are deployed independently.

### 8.1 Indexer (standalone Ponder service)

- The daemon's maintainer (Oak) privately deploys `@jinn-network/indexer` on a personal VPS using `packages/indexer/deploy/Dockerfile`.
- Domain: maintainer-chosen; current default URL ships in `config.ts` and is operator-overridable. Not anchored to a `jinn.network` subdomain — the indexer is not protocol infrastructure and should not appear to be.
- Backed by: HyperSync-backed RPC URL (recommended) for fast cold-start, Postgres for steady state (via `DATABASE_URL`), `DATABASE_SCHEMA` per deployment for rolling deploys via Ponder's canonical views pattern.
- Ponder's built-in `/health` and `/ready` endpoints are the liveness/readiness signals. No custom snapshot publication subsystem.
- Cost owner: the maintainer personally. Not material at current scale (~$20-200/month). The protocol does not subsidise it and Jinn-the-project carries no obligation for its uptime.
- Anyone who wants to be a public indexer for other operators deploys this same package the same way.

### 8.2 Operator daemon in HTTP mode (default)

- Operator sets `discovery.mode: 'http'` and `discovery.url: <chosen-indexer-host>`.
- Daemon issues GraphQL queries to the configured URL via `client/src/discovery/http.ts`.
- Smallest resource footprint. No indexer runs in this daemon.

### 8.3 On-chain (always-live floor)

- Daemon falls back to this automatically when the configured HTTP primary is unhealthy.
- Operators can pin to on-chain mode explicitly via `discovery.mode: 'onchain'`; useful for testing, air-gapped setups, or maximum-trust-minimisation operators willing to eat latency.

## 9. Daemon-side integration

### 9.1 Config surface

Two new fields under a single `discovery` block (replaces today's loose `subgraphUrl`):

```jsonc
{
  "discovery": {
    "mode": "http" | "onchain",              // default: "http" on testnet, "onchain" on mainnet
    "url": "https://<operator-chosen-host>", // when mode = http
    "fallbackToOnchain": false               // default: false (opt-in; see addendum below)
  }
}
```

Env overrides: `JINN_DISCOVERY_MODE`, `JINN_DISCOVERY_URL`, `JINN_DISCOVERY_FALLBACK`. `subgraphUrl` is removed (breaking config change — flagged in release notes; `DEFAULT_TESTNET_SUBGRAPH_URL` deletion in `config.ts:825` is part of the migration).

**Addendum (2026-05-23 — substrate incident):** `fallbackToOnchain` was originally specified as default-true. After the 2026-05-20 indexer outage cascade — the indexer's Tenderly key hit its monthly quota, every operator daemon silently fell through to direct `eth_getLogs`, which then prevented the indexer from recovering on the same exhausted key for three days — the default is flipped to `false`. Silent fall-through hides indexer outages and turns every daemon into its own indexer, which storms shared RPC quota. Operators opt in explicitly when they need it (typically only when self-hosting an RPC with generous `getLogs` quotas). The factory emits a one-time `console.warn` at boot when the opt-in is active so the choice is visible. With the default-off setting, an indexer outage propagates as `DiscoveryUnavailableError` to the operator-app, which is the correct observable failure mode.

### 9.2 Callsite migration

Three current callsites move from "construct subgraph client; pass URL" to "inject `DiscoveryAPI`; call method":

1. `adapters/mech/adapter.ts:545-580` — `discoverSubgraphRestorationTasks` → `discoverClaimableTasks`. The HTTP `taskDiscovery` config block collapses into the `discovery` block.
2. `solvernets/registry-client-erc8004.ts` — currently constructs its own subgraph fetcher; switches to consuming the injected `DiscoveryAPI`.
3. `corpus/index.ts` — `createCorpus({ subgraphUrl, onchain, ... })` becomes `createCorpus({ discovery, ... })`. The corpus library no longer owns the subgraph-vs-onchain split; that's `DiscoveryAPI`'s job.

### 9.3 Fallback chain

```
primary = build(mode)                  // http | onchain
floor   = build('onchain')             // always
discovery = withFallback(primary, floor, { unhealthyThreshold, retryAfter })
```

`withFallback` is a small wrapper that catches `DiscoveryUnavailableError` and network errors from the primary, routes to the floor for the duration of the outage, and probes the primary periodically to re-engage. Exposed through telemetry so operators can see which path served each query.

## 10. Trust model

What each implementation guarantees:

- **`HttpDiscoveryAPI`**: trusts the operator of the configured URL to report tasks and envelopes accurately. Worst-case lie: hide existing tasks/envelopes from the operator (denial of opportunity) or surface stale entries (wasted claim attempts). Cannot fabricate envelopes that pass downstream verification — the corpus library hash-verifies content against the manifest at retrieval time. Cannot fabricate task state that passes downstream verification — the daemon multicalls the JinnRouter contract before claiming (`canClaimTask` in `adapter.ts`).
- **`EmbeddedPonderDiscoveryAPI`** (deferred — see §14): would trust only the operator's own RPC endpoint. No third-party in the discovery path. Not in current scope.
- **`OnchainDiscoveryAPI`**: trusts only the operator's RPC endpoint.

Hash-verification at the content layer (corpus library) and on-chain state verification at the claim layer (`canClaimTask`) bound the damage any discovery-layer dishonesty can do. This is the property that makes the default `HttpDiscoveryAPI` mode safe for the network: a misbehaving shared indexer can degrade UX but cannot corrupt outcomes.

## 11. Migration plan (high level)

Detailed steps land as beads issues. The shape:

1. **Ponder package + schema.** Stand up `packages/indexer/` with the four-entity schema. CI builds it. ✅ Shipped (jinn-mono-280n.1).
2. **DiscoveryAPI interface + OnchainDiscoveryAPI.** Land the interface and the always-live floor implementation in `client/src/discovery/`. Wire it behind a feature flag; existing subgraph paths untouched. ✅ Shipped (jinn-mono-280n.2).
3. **Callsite migration.** Move the three callsites (task discovery, SolverNet registry, corpus) to consume `DiscoveryAPI`. Subgraph paths become one implementation of the interface, gated by `discovery.mode: 'http-subgraph'` (a transitional implementation that delegates to the existing subgraph client — kept only for the migration window). ✅ Shipped (jinn-mono-280n.3).
4. **HttpDiscoveryAPI client.** Land `client/src/discovery/http.ts` and wire `discovery.mode: 'http'` through the factory. The wire-contract queries are vendored in the daemon. ✅ Shipped (jinn-mono-280n.4, client portion).
5. **Deploy `@jinn-network/indexer` to a VPS.** Standard Ponder deployment using `packages/indexer/deploy/Dockerfile`. Postgres backend; `DATABASE_SCHEMA` for rolling deploys; Ponder's built-in `/health` and `/ready` for monitoring. Cut over the default `discovery.url` in `client/src/config.ts` once the instance is live. **Operator-side ops work; no daemon code changes required.** (jinn-mono-280n.4, deployment portion — checklist in `packages/indexer/deploy/README.md`.)
6. **Remove subgraph callsites.** Drop `task-subgraph.ts`, the subgraph branch in `corpus/index.ts`, the subgraph fetcher in `registry-client-erc8004.ts`, the `subgraphUrl` config field, the transitional `http-subgraph` mode, and the stub `erc8004/subgraph.ts`. The Graph API key dependency leaves the system. (jinn-mono-280n.6.)

## 12. Federation path (out of scope for v0.1)

The HTTP service is intentionally not branded as protocol infrastructure. It's a privately-operated indexer that the daemon's current maintainer happens to run, and the daemon's `discovery.url` is operator-chosen — the default just happens to point at the maintainer's instance.

This matters: there is no "Jinn-operated indexer" anywhere in the runtime. The protocol does not run infrastructure; participants do. The current default exists because one participant (Oak) chose to run one and ship the daemon pointing at it. That choice is observable in the default config and reversible by any operator at any time.

When a second party wants to run their own public indexer, they:

1. Deploy `@jinn-network/indexer` on their VPS using `packages/indexer/deploy/Dockerfile`. Standard Ponder deployment, no special protocol involvement.
2. Operators who want to align with that party set `discovery.url: 'https://<their-host>/'`.

No protocol changes. No coordination. This is the headless-brand shape: protocol stays minimal, surfaces vary, operators choose alignment. Multiple privately-operated indexers can coexist on the same protocol from day one — the only thing v0.1 doesn't ship is a *discovery-of-discovery* layer to help operators find alternatives. They find them by word-of-mouth or by reading config docs, which is fine for the current participant count.

A future spec may introduce a discovery-of-discovery layer (a list of known indexer endpoints anchored on-chain or in IPFS, possibly weighted by some operator-signal). v0.1 does not need it; pointing at a URL is enough.

## 13. Operator UX surface

Discovery is config-file-only today. The SPA dashboard (`client/src/dashboard/spa/`) does not expose any discovery state or controls. With the simplified design (HTTP-to-Ponder + RPC floor; no embedded mode in scope), the UX is small:

1. **Status indicator** (somewhere visible — shell header or Overview): shows whether the configured indexer URL is reachable. Two states suffice — `Discovery: healthy` (HTTP primary responding) and `Discovery: degraded — using RPC fallback` (fallback chain engaged).
2. **Configuration page surface**: one editable field for `discovery.url`, one toggle for `fallbackToOnchain`, one read-only display showing current mode. No multi-mode picker needed — there are two practical states (`http` with a URL, or `onchain`-only when no URL is configured).
3. **Error states**: toast on transition into and out of fallback; inline validation in Configuration on save.

That's it. Polished features (mode selector with rich tradeoff descriptions, snapshot controls, federated-host directory) are deferred until either embedded mode lands or operator demand justifies the build. Today's scope is "make the URL + reachability visible without editing JSON."

## 14. Deferred future work

The following were in v0.1/v0.2 scope and have been deferred because they were over-engineering for the current need. Tracked in **`jinn-mono-tejo`** (Decentralize the discovery layer):

- **`EmbeddedPonderDiscoveryAPI` (Ponder in-process inside the daemon).** Would let operators run an indexer locally for full trust-minimisation. Real demand for this hasn't materialised. If/when an operator asks, the implementation is: add `@jinn-network/indexer` as a daemon dep, spawn Ponder as a child process, point it at local PGlite. The `DiscoveryAPI` interface is already shaped to accommodate this implementation. No interface changes required.
- **Snapshot publication and verification.** Would let new operators skip the cold-start sync time. Ponder's canonical answer is to use a HyperSync-backed RPC URL — cold sync from genesis becomes minutes. If that's insufficient, a Postgres dump/restore pipeline could be added; the snapshot-on-IPFS-with-on-chain-CID scheme was over-engineered for the actual need.
- **Operator dashboard polish.** Multi-mode selector with rich tradeoff descriptions, connected-consumer counts when running as a public indexer, federated-host directory. All depend on either embedded mode or genuine federation, neither of which is in current scope.

Related cleanup beads, not part of this spec's scope:
- **`jinn-mono-euyi`** — audit and retire the `subgraph/` directory once `280n.6` lands and nothing consumes the hosted Graph subgraph.
- **`jinn-mono-h8bq`** — consolidate envelope-level `solverType` into SolverNet identity (`{id, version}` / `manifestCid`). Orthogonal to discovery, but surfaced during this work because `CorpusQuery.solverType` is one of the filter fields.

## 15. Open questions

1. **Telemetry on fallback engagement** — *resolved.* Yes, report it, minimally: a log line on transition into and out of fallback; a single `discovery_fallback_active` gauge (0/1) in the existing telemetry channel; the §13 binary dashboard status indicator picks this up for free. Pin the exact telemetry topic during implementation; no need for duration tracking or per-query path attribution at v0.1.
2. **What to do with `erc8004/subgraph.ts`** — *resolved.* Confirmed dead during the v0.3 investigation: `queryArtifacts` is the wrong-shaped predecessor to corpus envelope discovery (the corpus library does it correctly via `DiscoveryAPI.queryEnvelopes`); `queryNodes` peer-discovery never functioned and its downstream merge into peer-sync is also stubbed. The stub + `daemon.ts:backfillFromSubgraph` get deleted in `280n.6` (now in that issue's scope). Bead `jinn-mono-fud` is already closed (the Graph subgraph it tracked was built and lives in `subgraph/`); the fate of `subgraph/` is `jinn-mono-euyi`.

## 16. References

- `spec/2026-04-30-phase-a-umbrella.md` — corpus library as the first programmatic-library "app"; `routeResolver` seam that this spec generalises into `DiscoveryAPI`.
- `spec/2026-05-05-solvernet-creation-and-launch.md` §13 — registry client interface designed to be swappable; the day-1 subgraph backing this spec replaces.
- `client/src/corpus/onchain-query.ts` — the working on-chain discovery path that `OnchainDiscoveryAPI` extends to cover all three query domains.
- `client/src/adapters/mech/task-subgraph.ts` — the load-bearing callsite this spec migrates.
- Ponder — https://ponder.sh — the indexer framework chosen for both deployment shapes.
