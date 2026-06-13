# Finding — New operator hits an empty registry (issue #980)

- **Date:** 2026-06-13
- **Author:** Claude (spike for issue #980)
- **Status:** Spike finding — needs-decision (recommends a fix; does not implement)
- **Shape:** `spike` (output is a finding, not merged code)
- **Related:**
  - `spec/2026-05-05-solvernet-creation-and-launch.md` (§12 operator join flow; the registry/Discover surface this finding is about)
  - `spec/2026-05-registry-discovery.md` (manifest-anchored discovery)
  - `client/src/discovery/http.ts` (the indexer read path)
  - `client/src/dashboard/spa/src/pages/operator-catalog/RegistryCatalog.tsx` (the empty-state surface)
  - issues #985 (indexer enrichment + degrade path), #997/#998 (indexer deploy hygiene), #1038 (unbounded indexer fetch / net-stall)

---

## Question

A new operator, immediately after first-run onboarding, sees the registry/Discover view show **"No launched SolverNets available"** and **"0 discoverable"** — nothing to join. The issue asks: **why is the registry empty on testnet** — is it (a) genuinely no SolverNets live on testnet, or (b) a discovery/render gap? And: how do we make a new operator **always** reach at least one joinable SolverNet?

## Verdict (one line)

**It is a discovery/curation gap, not an absence of launched SolverNets.** There are **7 launched SolverNets live on Base Sepolia testnet** right now — the operator-visible emptiness comes from (1) those nets being ephemeral, blank-named smoke-test artifacts rather than a curated joinable demo, and (2) a fragile discovery/enrichment path that can render a populated registry as empty. The issue's own hypothesis ("maybe no SolverNets are live") is **refuted by on-chain/indexer evidence**.

---

## Evidence

### 1. The registry is NOT empty on-chain — 7 launched nets exist

Querying the production testnet indexer (`DEFAULT_TESTNET_DISCOVERY_URL = https://jinn-indexer-production.up.railway.app`, `client/src/config.ts:741`) — the exact source the operator app reads — returns **9 manifests on chainId 84532 (Base Sepolia): 7 `launched`, 2 `retired`.**

| name | launcherAgentId | status | anchorBlock |
|---|---|---|---|
| `smoke-0608-123130` | 5941 | launched | 42573261 |
| `smoke-1780573615911` | 5941 | launched | 42402665 |
| `smoke-1780571686024` | 5941 | launched | 42401791 |
| `smoke-1780569813206` | 5941 | launched | 42400764 |
| `smoke-1780569089739` | 5941 | launched | 42400402 |
| `T3.1 isolated` | 5474 | launched | 41861303 |
| `SWE-rebench v2` | 5474 | launched | 41762301 |
| `Verify Net` | 5474 | **retired** | 41196771 |
| `Dogfood Prediction Net` | 5474 | **retired** | 41156361 |

`totalCount: 9`; `status: "launched"` filter → `totalCount: 7`. So the data layer is healthy and populated. **This rules out "no launched SolverNets."**

### 2. But the launched nets are test/smoke artifacts, not a joinable demo (the primary, certain gap)

Of the 7 launched nets:
- **5 are ephemeral `smoke-*` E2E/smoke-test SolverNets** (launcher agent 5941) — created by automated smoke runs, with machine-generated names, not intended for operators to join.
- **2 are internal test nets** — `T3.1 isolated` and `SWE-rebench v2` (launcher agent 5474).
- The one human-legible, operator-relevant net, **`Dogfood Prediction Net`, is `retired`.**

So even when discovery works perfectly, a fresh operator is shown a list of blank/smoke rows with nothing obviously joinable. There is **no persistent, curated, operator-friendly demo SolverNet** on testnet. Confirmed by code search: there is **no seed/bootstrap/default SolverNet** anywhere in the client (no hardcoded manifest CID, no onboarding auto-join), and onboarding leaves `joinedSolverNets` empty and drops the operator straight at the Discover view.

### 3. The discovery/enrichment path is fragile and can render a populated registry as empty (contributing gap)

The operator who filed this (issue created **2026-06-02**) was on the then-latest release **v0.1.8**. Tracing the v0.1.8 read path:

- v0.1.8's `listLaunchedSolverNets` query (`client/src/discovery/http.ts` @ `a4e75249b^`) requests only the **minimal indexer columns** (`id, launcherAgentId, status, statusUpdatedAt, manifestHash, anchorBlock, chainId`) — all of which the indexer has — then returns rows with **sentinel `name: ''`** and notes *"Consumers enrich via IPFS fetch."* So names/prices depend on a **per-CID IPFS round-trip**, which is latency- and availability-fragile.
- The catalog cache (`createCatalogCache`, `client/src/solvernets/daemon-init.ts:406` — present in v0.1.8) chain-scope-filters every row on `row.chainId === networkToChainId(config.network)`. **If the operator's `network` string did not map to `84532`, all 7 rows are filtered out → a 200 response with an empty `summaries` array → the exact "0 discoverable / No launched SolverNets available." empty state with no error.**
- On a discovery **error**, the snapshot stays at its initial `[]` and a `lastError` is set, so the SPA shows the empty state **plus** a `RegistryStaleWarning` (`RegistryCatalog.tsx:382`). The operator reported the plain empty state, which points at a **success-with-zero-rows** path (chain-scope filter or post-enrichment drop) rather than a hard fetch error.

Two adjacent, empirically-confirmed fragilities compound this:

- **The production indexer is un-migrated.** It rejects the #985 enriched columns: querying `network, solutionPriceWei, verdictPriceWei, openRoles, launcherSafeAddress, contractId, contractVersion` against the live indexer returns `GRAPHQL_VALIDATION_FAILED — Cannot query field …`. The current `next`/v0.1.9 build adds an **enriched** primary query that hard-fails on this indexer; it is rescued only by a degrade catch shipped in the **same** commit (`a4e75249b`, v0.1.9, 2026-06-03 — *after* this issue). Any build that has the enriched query but **not** the degrade catch would see a hard-empty registry. This is a live client/indexer skew that will keep biting until the indexer is migrated (tracked by #985/#997/#998).
- Even with v0.1.9's working degrade path, the 7 nets come back **unenriched (blank name, `0` prices)** — a degraded, confusing list, not a clean joinable demo.

### Root-cause classification (acceptance criterion 1)

| Candidate | Verdict |
|---|---|
| (a) No launched SolverNets live on testnet | **Refuted** — 7 launched nets on Base Sepolia. |
| (b) Discovery / render / curation gap | **Confirmed** — the launched nets are uncurated smoke/test artifacts, and the discovery+IPFS-enrichment+chain-scope path can surface a populated registry as empty. |

---

## Recommendation (acceptance criterion 2)

The durable answer — *a new operator always reaches at least one joinable SolverNet* — needs **both** a curated thing to join **and** a robust path that always shows it. Recommended package, in priority order:

### Recommended option — seed a persistent, curated demo SolverNet on testnet (the unblock)

Launch (or re-launch `Dogfood Prediction Net`) as a **permanent, monitored, generator-on** "Prediction (demo)" SolverNet via the existing Launcher flow, kept funded and live, with a human-legible name and open `solver`/`evaluator` roles. This is the only option that directly guarantees the acceptance criterion, and it exercises the real publish→index→discover→join loop (no special-casing).

- **Rough effort: Low–Medium.** No code: one launch via the existing Launcher, plus an operational commitment to keep it funded/live and its manifest pinned. Medium only if we also add lightweight liveness monitoring so it never silently retires again (as `Dogfood Prediction Net` did).

### Pair with — feature the demo net + a curation-aware empty/guided state (durability)

1. **Featured pin:** a `featuredSolverNets` (manifest-CID list) the Discover view surfaces first, so the demo net is unmissable and order-independent of indexer freshness. **Effort: Low** (SPA + a config list).
2. **Filter smoke/test nets** out of the operator-facing registry (e.g. drop `smoke-*`-named or test-launcher rows, or gate on an explicit "operator-visible" manifest flag), so the list isn't dominated by E2E artifacts. **Effort: Low.**
3. **Guided empty state:** if the curated list is genuinely empty, replace the bare "No launched SolverNets available." with a guided message (what a SolverNet is, a link to launch one, a "check back" affordance) rather than a dead end. **Effort: Low.**

### Hardening (separately tracked, not blocking)

- **Migrate the production indexer** so enriched fields populate and the hot path no longer depends on per-CID IPFS enrichment — removes the blank-name/empty-render failure mode at the source (#985/#997/#998).
- **Make the chain-scope/`network`→chainId mapping fail-loud**: if a refresh returns rows but all are filtered out by chain scope, log it and surface a distinct "wrong network?" hint instead of a silent empty registry.

**Why this package:** the seed net satisfies the acceptance criterion immediately and cheaply; the featured pin + filter + guided state make "always reaches ≥1 joinable net" robust to indexer freshness, IPFS hiccups, and smoke-net noise; the indexer migration removes the underlying fragility but is heavier and already tracked elsewhere, so it should not gate the unblock.

---

## What this finding does not prove

- The **exact** v0.1.8 filter that zeroed this specific operator's registry (chain-scope mismatch vs. an IPFS-enrichment drop) is inferred from the read path, not confirmed from the operator's logs/config — both reduce to the same "discovery gap, nets exist" verdict and the same recommendation, so pinpointing it is not load-bearing for the fix.
- Indexer counts were read from the production indexer GraphQL endpoint (the operator app's own source), not independently re-derived from raw `IdentityRegistry` `MetadataSet` logs; the indexer is the authoritative discovery surface here.
