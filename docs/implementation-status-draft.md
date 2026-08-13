---
title: Implementation map — draft
status: DRAFT (machine-assisted; for Oak + Ritsu to curate into a canonical IMPLEMENTATION.md)
last_audit: 2026-05-27 against origin/next @ 2f0c0e1c
scope: what is wired and load-bearing on the testnet stack
shape: durable architecture map + pointers to live state, not a snapshot of counts
---

# Implementation map — draft

This document is a **draft** describing what is **wired and load-bearing** on the Jinn
testnet stack — meaning a daemon, indexer, or explorer actively uses it in the path of
a non-test request.

The shape is deliberate: the doc records **architecture and wiring** (durable), and
points at **live state** (fast-moving) rather than restating it. Where you would
otherwise want a count or a status, you will find a query against the live indexer or
a path into the explorer. This is so the doc does not need continual updates as
SolverNets come and go, attempts pile up, or harness mixes shift.

Speculative code, abandoned adapters, and unreferenced deployment artifacts are listed
separately so maintainers can see what is safe to delete.

---

## 1. How to read live state

The production Ponder indexer is at `https://jinn-indexer-production.up.railway.app/`.
It exposes:

- `POST /graphql` — full GraphQL over the [10-entity schema](packages/indexer/ponder.schema.ts).
- `GET /explorer/network` — fleet KPIs.
- `GET /explorer/solvernets` — list of SolverNet manifests, by status.
- `GET /explorer/solvernet/:cid` — per-net detail (KPIs, leaderboard, learning curves,
  checkpoint timeline, freeze-integrity violations).
- `GET /explorer/operators`, `GET /explorer/operator/:addr` — operator leaderboards.
- Plug-in + builder routes (`GET /plugins`, `GET /builders/...`) exist but return `[]`
  today — see §6.

Useful one-shot queries (substitute your own clients):

```graphql
# Headline counts — what the protocol has touched
{ tasks(limit:1){totalCount}
  attempts(limit:1){totalCount}
  verdicts(limit:1){totalCount}
  rewardDistributions(limit:1){totalCount}
  envelopes(limit:1){totalCount}
  attemptEnvelopeMetas(limit:1){totalCount}   # IPFS-enriched attempts
  verdictEnvelopeMetas(limit:1){totalCount}   # IPFS-enriched verdicts
  pluginPublications(limit:1){totalCount}
  harnessCheckpoints(limit:1){totalCount}
  _meta{ status } }
```

```graphql
# Live SolverNet manifests — names, statuses, anchors
{ solverNetManifests {
    items { name solverNetId status statusUpdatedAt manifestHash anchorBlock } } }
```

```graphql
# Most recent attempts — harness, model, mode, evidence tier mix
{ attemptEnvelopeMetas(limit:50, orderBy:"enrichedAtBlock", orderDirection:"desc") {
    items { solverType implName mode model language evidenceTier } } }
```

The `solverNetId` convention is `<launcherAgentId>_<solverType-hyphenated>_<hash>`,
where the hyphenated form (`prediction-v1`) matches the dotted SolverType key
(`prediction.v1`) in [`client/src/solver-types/index.ts`](client/src/solver-types/index.ts).

---

## 2. Chain layer

### 2.1 Base Sepolia (84532) — execution chain

| Contract | Address | Indexed? | Role |
|---|---|---|---|
| **JinnRouter V3** | `0xdC9BCcEB7aca21Ad4Ca2Fc5B4d7aea6b4F6CedD9` | yes | Task router; emits `TaskCreated`, `TaskAttemptCreated`, `SolutionDeliveryClaimed`, `VerdictDeliveryClaimed`, `TaskBudgetRefunded`. |
| **IdentityRegistry** | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | yes | ERC-8004 agent NFTs + arbitrary `MetadataSet` keys whose payloads are IPFS CIDs. The indexer routes by key prefix (`solvernet-manifest:`, `envelope:` / `evaluation:` / `capture:`, `plugin:`, `harness.checkpoint:`). |
| Phase 1b token + staking stack | bundled in [`client/deployments/`](client/deployments/) | partial | Forked OLAS components — JINN ERC-20, staking proxy + service registry, Mech Marketplace, TaskCoordinator + JinnRouter V3, stOLAS distributor, faucet, `TaskClaimEmitter`. Loaded by `DEFAULT_TESTNET_ARTIFACTS` in [`client/src/earning/contracts.ts`](client/src/earning/contracts.ts) and consumed by [`FleetBootstrapper`](client/src/earning/bootstrap.ts). |

### 2.2 Sepolia L1 (11155111) — DAO + distribution chain

| Contract | Address | Indexed? | Role |
|---|---|---|---|
| **JinnDistributor** | `0xaC9CD847660d05e77D82A3684aFC4EbFd94fBfe6` | yes | Distributes JINN to operators from L1 against cross-chain claim tickets. `Claimed` events → indexer `rewardDistribution` rows. |
| L1 DAO stack | `deployment-jinn-mvi-l1-sepolia.json` | no | JINN token, `JinnGovernor`, `TimelockController`, `MockMessenger` (testnet stand-in for the canonical Optimism Portal). |

### 2.3 Base mainnet (8453) — Phase 0 legacy

Mainnet addresses (JinnRouter `0xfFa7118A3D820cd4E820010837D65FAfF463181B`,
IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, OLAS Mech Marketplace
`0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020`, OLAS staking
`0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54`, OLAS token
`0x54330d28ca3357F294334BDC454a032e7f353416`) are still resolved by `BASE_CONFIG` in
[`client/src/earning/contracts.ts`](client/src/earning/contracts.ts) and documented in
[CLAUDE.md](CLAUDE.md). **Mainnet is not indexed** — `mainnet.base.org` cannot sustain
Ponder's historical sync; gated on a paid RPC. The default `jinn run` selects testnet;
mainnet is a deliberate override.

*Could not verify:* whether any operator earns on mainnet today. The audit's working
assumption is "Phase 0 is dormant; testnet is where activity lives." See gap §7.

---

## 3. Daemon (`client/`)

Entry: [`client/src/main.ts`](client/src/main.ts). Long-running orchestrator:
[`client/src/daemon/daemon.ts`](client/src/daemon/daemon.ts).

### 3.1 Loops started by `Daemon.start()`

Every loop is conditional — none is unconditional. The started set is computed in
`Daemon.start()` (search `started.add(`); `LOOP_REGISTRY` in
[`daemon/loop-heartbeat.ts`](client/src/daemon/loop-heartbeat.ts) is the single source of
loop names, heartbeat intervals, and admission class.

| Loop | File | Conditional? |
|---|---|---|
| `CreatorLoop` | [`daemon/creator.ts`](client/src/daemon/creator.ts) | legacy mode |
| `DeliveryWatcherLoop` | [`daemon/delivery-watcher.ts`](client/src/daemon/delivery-watcher.ts) | legacy mode |
| `WorkLoop` | [`daemon/work-loop.ts`](client/src/daemon/work-loop.ts) | `composition` + `work` configured |
| `EvaluatorLoop` | [`daemon/evaluator-loop.ts`](client/src/daemon/evaluator-loop.ts) | `evaluator` configured |
| `PostingLoop` | [`daemon/posting-loop.ts`](client/src/daemon/posting-loop.ts) | native mode + non-empty `posting[]` |
| `ProjectorLoop` | [`daemon/projector-loop.ts`](client/src/daemon/projector-loop.ts) | `composition` configured |
| `EvidenceDriverLoop` | [`daemon/evidence-driver.ts`](client/src/daemon/evidence-driver.ts) | `composition` configured |
| `RewardClaimLoop` | [`daemon/reward-claim-loop.ts`](client/src/daemon/reward-claim-loop.ts) | `rewardClaimIntervalMs > 0` |
| `BalanceTopupLoop` | [`daemon/balance-topup-loop.ts`](client/src/daemon/balance-topup-loop.ts) | testnet default on |
| `EvictionLoop` | [`daemon/eviction-loop.ts`](client/src/daemon/eviction-loop.ts) | standard staking + distributor |
| `CheckpointLoop` | [`daemon/checkpoint-loop.ts`](client/src/daemon/checkpoint-loop.ts) | standard staking |
| `HarvestLoop` | [`daemon/harvest-loop.ts`](client/src/daemon/harvest-loop.ts) | `harvest` enabled with repos or `sessions` |
| `PeerSync` | [`daemon/peer-sync.ts`](client/src/daemon/peer-sync.ts) | `peers` configured |
| Recovery (one-shot) | [`daemon/native-operator-host.ts`](client/src/daemon/native-operator-host.ts) `start`, [`daemon/work-loop.ts`](client/src/daemon/work-loop.ts) `initialize` | at startup, before any loop takes work |

The loop table in [`client/ARCHITECTURE.md`](client/ARCHITECTURE.md) §6 carries the same set
with per-loop job descriptions.

### 3.2 Adapters ([`client/src/adapters/`](client/src/adapters/))

Only `MechAdapter` is selected in `main.ts` against testnet. `LocalAdapter` is a
test-only fixture.

### 3.3 SolverTypes ([`client/src/solver-types/`](client/src/solver-types/))

Registered in [`client/src/solver-types/index.ts`](client/src/solver-types/index.ts):

```
portfolio.v0
prediction.v1
prediction.apy.v0
learner-loop-test
swe-rebench-v2.v1
session-derived.v1
```

**To see which SolverTypes have live activity right now**, query the indexer:

```graphql
{ attemptEnvelopeMetas(limit:200, orderBy:"enrichedAtBlock", orderDirection:"desc") {
    items { solverType } } }
```

`learner-loop-test` and `session-derived.v1` are by their names experimental/test types.
`portfolio.v0` is in tree but used internally as an evaluator harness, not as a
SolverNet-driving type.

### 3.4 Harnesses ([`client/src/harnesses/impls/`](client/src/harnesses/impls/))

| Harness | Path | Wired into default `buildHarnesses()`? |
|---|---|---|
| `learner` (Claude Code adapter) | `impls/learner/` | yes |
| `learner` (Codex adapter) | `impls/learner/` | yes |
| `hermes-agent` | `impls/hermes-agent/` | yes |
| `prediction-v1-baseline` | `impls/prediction-v1-baseline/` | yes |
| `prediction-v1-evaluator` | `impls/prediction-v1-evaluator/` | yes |
| `prediction-apy-v0-baseline` | `impls/prediction-apy-v0-baseline/` | yes |
| `prediction-apy-v0-evaluator` | `impls/prediction-apy-v0-evaluator/` | yes |
| `swe-rebench-v2-evaluator` | `impls/swe-rebench-v2-evaluator/` | yes |
| `portfolio-v0-evaluator` | `impls/portfolio-v0-evaluator/` | yes (internal use) |
| `legacy-claude` | `impls/legacy-claude/` | only when `env.runner` supplied; superseded |
| `stub` | `impls/stub.ts` | env-gated test |
| `external-impls/` | `external-impls/` | operator-supplied npm packages |

The **default harness** for a given SolverNet is set in the manifest, not in daemon
source. Query the live mix via the GraphQL example in §1. Harness readiness gates
claim eligibility at runtime via
[`harnesses/readiness-registry.ts`](client/src/harnesses/readiness-registry.ts).

### 3.5 Generators

Per [`spec/2026-05-05-solvernet-creation-and-launch.md`](spec/2026-05-05-solvernet-creation-and-launch.md) §11:
generators are **launched-record-driven**, not config-flag-gated. The daemon walks
`~/.jinn-client/solvernets/launched/` at startup and dispatches per-SolverType
generators via
[`solvernets/launched-record-dispatcher.ts`](client/src/solvernets/launched-record-dispatcher.ts).
No `taskGenerator.enabled` check remains in `main.ts`. Hot-apply of generator-config
edits is regression-tested (`jinn-mono-p1t4.2`).

### 3.6 Discovery API ([`client/src/discovery/`](client/src/discovery/))

Two implementations (`onchain.ts`, `http.ts`) plus a fall-through wrapper
(`with-fallback.ts`) built by `factory.ts`. The default testnet `discovery.url` is
`DEFAULT_TESTNET_DISCOVERY_URL` in
[`client/src/config.ts`](client/src/config.ts), which points at the production Ponder
indexer.

`fallbackToOnchain` is **off by default** (per post-2026-05-23 incident, see CLAUDE.md
§Config) — when the indexer is unreachable the daemon raises
`DiscoveryUnavailableError` rather than storming the shared public RPC.

### 3.7 Operator dashboard SPA

[`client/src/dashboard/spa/`](client/src/dashboard/spa/) — bundled into the published
`@jinn-network/client` package and served by the daemon's Hono server at
`127.0.0.1:7331`. Two modes: onboarding (bootstrap takeover) and operating dashboard.
Canonical spec: [`client/OPERATOR-APP-SPEC.md`](client/OPERATOR-APP-SPEC.md).

Distinct from the standalone Network Explorer at
[`packages/indexer/explorer/`](packages/indexer/explorer/) (§5).

### 3.8 Cross-cutting modules

| Module | Path | Role |
|---|---|---|
| `FleetBootstrapper` | [`earning/bootstrap.ts`](client/src/earning/bootstrap.ts) | 11-step wallet → Safe → service → mech bootstrap |
| `IdentityPublisher` | [`erc8004/identity.ts`](client/src/erc8004/identity.ts) | publishes envelopes to IdentityRegistry; gated on `agent_id` |
| `ReputationFeedback` | [`erc8004/reputation-feedback.ts`](client/src/erc8004/reputation-feedback.ts) | sets harness agent NFT reputation post-eval |
| `x402` handler | [`x402/`](client/src/x402/) | payment-gated artifact delivery |
| `Corpus` | [`corpus/`](client/src/corpus/) | artifact discovery + IPFS fetch + MCP tools |
| Spend caps | [`spend/daemon-config.ts`](client/src/spend/daemon-config.ts) | per-credential daily ceiling at claim gate |
| Operator MCP | [`mcp/operator-server.ts`](client/src/mcp/operator-server.ts) | AI-host-facing MCP wrapper; CLI-invoked |
| Runner-scoped MCP | [`mcp/server.ts`](client/src/mcp/server.ts) | subprocess-side artifact tools; spawned by runners |

---

## 4. Indexer (`packages/indexer/`)

Ponder 0.16.6. Two chains configured (Base Sepolia, Sepolia L1) in
[`ponder.config.ts`](packages/indexer/ponder.config.ts). Schema in
[`ponder.schema.ts`](packages/indexer/ponder.schema.ts).

### 4.1 Event → entity mapping

| Source event | Entity | Chain |
|---|---|---|
| `JinnRouter.TaskCreated` | `task` | 84532 |
| `JinnRouter.TaskAttemptCreated` | `attempt` | 84532 |
| `JinnRouter.SolutionDeliveryClaimed` | `task.finalized = true` (mutation) | 84532 |
| `JinnRouter.VerdictDeliveryClaimed` | `verdict` | 84532 |
| `JinnRouter.TaskBudgetRefunded` | `task.refunded = true` (mutation) | 84532 |
| `IdentityRegistry.MetadataSet` `solvernet-manifest:` | `solverNetManifest` | 84532 |
| `IdentityRegistry.MetadataSet` `envelope:` / `evaluation:` / `capture:` | `envelope` + enrichment | 84532 |
| `IdentityRegistry.MetadataSet` `plugin:` | `pluginPublication` | 84532 |
| `IdentityRegistry.MetadataSet` `harness.checkpoint:` | `harnessCheckpoint` | 84532 |
| `JinnDistributor.Claimed` | `rewardDistribution` | 11155111 |

Two enrichment tables piggyback on envelope events:

- **`attemptEnvelopeMeta`** — keyed by `(requestId, chainId)`, joined to `attempt`.
  IPFS-fetched executor metadata (`solverType`, `implName` = harness, `mode`, `model`,
  `language`, `evidenceTier`, `pluginsJson`, `codeDigest`).
- **`verdictEnvelopeMeta`** — keyed by `(requestId, chainId)`, joined to `verdict`.
  Evaluator's *actual* outcome (`actualPassed`, `actualScore`, `evaluatorVerdict`).
  **Source of truth** for verdict outcomes — the on-chain `verdict.verdictCode` field
  is widely defaulted to `Pass(1)` when the daemon's evaluation pipeline fails
  ([known daemon bug, documented in the schema](packages/indexer/ponder.schema.ts)).

Enrichment uses the IPFS gateway `https://gateway.autonolas.tech` by default
(override via `JINN_IPFS_GATEWAY_URL`; disable via `JINN_INDEXER_ENRICH_ENVELOPES=0`).
Failures are silent so Ponder naturally retries on next sync.

### 4.2 Indexed but currently empty

Two entities have full handlers and no live writes from the protocol yet:

- **`pluginPublication`** — handlers in
  [`packages/indexer/src/handlers.ts`](packages/indexer/src/handlers.ts) implement v1
  publish + v2 revocation decode. Explorer routes that read it (`/plugins`,
  `/builders/...`) degrade to `[]`.
- **`harnessCheckpoint`** — handler implements on-chain anchor + IPFS-enriched
  manifest fetch (`codeDigest`, `parentCheckpointCid`, `implStateDirCid`,
  `sourceBundleCid` for freeze-eval eligibility). Explorer's `CheckpointTimeline`
  renders empty.

Check live state with the GraphQL count query in §1.

---

## 5. Network Explorer (`packages/indexer/explorer/`)

Vite SPA, bundled and served by the same Ponder process at the indexer URL.
Client-rendered shell, so `curl /` returns scaffold only — all data loads via the
routes below.

| Route | Backing API | Backing entities |
|---|---|---|
| `/` (NetworkView) | `GET /explorer/network` | all |
| `/solvernets` | `GET /explorer/solvernets` | `solverNetManifest` + `task` + `verdict` |
| `/solvernet/:cid` | `GET /explorer/solvernet/:cid` | `task` + `attempt` + `verdict` + envelope-meta |
| `/operators` | `GET /explorer/operators` | `attempt` + `verdict` + `rewardDistribution` |
| `/operator/:addr` | `GET /explorer/operator/:addr` | `attempt` + `verdict` + `rewardDistribution` |
| `/explore/:cid` | redirect → `/solvernet/:cid` | back-compat for legacy deep links |
| `/*` (404) | — | — |

The operator and per-net leaderboards rank by **envelope-truth** verdict outcomes
(`verdictEnvelopeMeta.actualPassed`) rather than on-chain `verdictCode`. The
NetworkView surfaces both for audit.

Plug-in / builder REST surface (`GET /plugins`, `GET /plugins/:cid/scores`,
`GET /builders/:agentId/runs`, `GET /builders/:address/artifacts`,
`GET /builders/:address/scores`) is wired and returns `[]` until §4.2's empty
entities accumulate live data.

---

## 6. External dependencies

| Dependency | Used by | Note |
|---|---|---|
| IPFS via `gateway.autonolas.tech` | daemon + indexer | envelopes, manifests, plug-ins, harness manifests; override via `JINN_IPFS_GATEWAY_URL` |
| Base Sepolia public RPCs | daemon + indexer | `base-sepolia.publicnode.com` + `sepolia.base.org`; viem `fallback({rank:false})` chain |
| Sepolia L1 public RPCs | daemon + indexer | publicnode + others |
| OLAS-derived contracts | daemon | forked into the bundled testnet deployments — not external dependencies at runtime |

Local internal-tool packages out of scope for the operator-facing audit:
[`packages/claim-relayer/`](packages/claim-relayer/),
[`packages/autopilot/`](packages/autopilot/),
[`apps/broadcast-bot/`](apps/broadcast-bot/).

---

## 7. Built but not load-bearing today

Code that compiles in the tree but no live request path on testnet touches it in the
default `jinn run` against `origin/next`. Candidates for deletion or explicit
deprecation.

| Surface | Status |
|---|---|
| `client/src/adapters/local/` | test-only fixture |
| `client/src/solver-types/session-derived.v1`, `learner-loop-test`, `portfolio.v0` | experimental / internal-evaluator-only |
| `client/src/harnesses/impls/legacy-claude/` | superseded by learner adapter |
| `client/src/harnesses/impls/stub.ts`, `external-impls/` | env-gated / operator-supplied |
| `contracts/src/staking/RestorationActivityChecker*`, JinnRouter V1/V2, `JinnClaimEmitter`, `CanonicalOpStackMessenger` | superseded by V3 / testnet uses mock messenger |
| Phase 0 mainnet (Base 8453) | not indexed; no observable live activity |
| Indexer entities `pluginPublication`, `harnessCheckpoint` | handlers + explorer routes ready; no on-chain writes yet |
| `client/deployments/deployment-claim-registry-baseSepolia.json` | bundled and synced by `scripts/sync-deployments.sh` but not in `DEFAULT_TESTNET_ARTIFACTS` and not loaded by daemon or indexer hot path |

---

## 8. Gaps surfaced by the audit

Architectural disagreements between docs and code, and design-vs-deployed gaps. These
persist until someone fixes them — short-lived counts have been pushed to §1 so this
section is the one that needs maintenance.

1. **Plug-in + harness-checkpoint write paths are unexercised.** The "knowledge market"
   framing in [`spec/2026-04-30-phase-a-umbrella.md`](spec/2026-04-30-phase-a-umbrella.md)
   and the plug-in builder design in
   [`spec/2026-05-13-plug-in-builder-entry-point-design.md`](spec/2026-05-13-plug-in-builder-entry-point-design.md)
   describe these surfaces as part of Phase A. Contracts emit, indexer ingests, and
   explorer renders them — but no actor writes them on chain yet. Largest "designed
   vs deployed" gap.

2. **On-chain verdict code is structurally lossy.** The daemon defaults
   `JinnRouter.verdictCode` to `Pass(1)` when its evaluation pipeline fails; the
   off-chain `verdictEnvelopeMeta.actualPassed` holds the real outcome. This is
   documented in the schema and surfaced in the NetworkView (envelope-truth vs
   on-chain), but it changes how readers should interpret the `verdict` table.
   Deserves a first-class callout in canonical docs.

3. **Envelope enrichment has no batch retry.** Failures during IPFS fetch produce no
   row and no error marker; Ponder reprocesses on next sync. There is no
   `enrichmentStatus='failed'` worker that retries the long tail. Coverage is
   therefore "current sync state" rather than "best-effort floor."

4. **Daemon does not yet stamp `executor.model` on all envelopes** (tracked as
   `jinn-mono-gbut` / [GitHub #191](https://github.com/Jinn-Network/mono/issues/191)).
   Explorer's `byModel` facet is gated on this; auto-lights when daemon catches up.

5. **Mainnet Phase 0 framing is unclear.** CLAUDE.md still lists mainnet addresses as
   "Phase 0 complete (Base mainnet)" and the daemon resolves them by default in
   `BASE_CONFIG`. Without an indexer there is no way to verify live activity, and the
   intended status (permanent legacy? dormant? to-be-deprecated?) is not written down.

6. **Task.claimWindowStart / claimWindowEnd / refunded fields are structurally
   underpopulated.** Not emitted by JinnRouter V3 events at v0.1; require call-trace
   decoding (tracked as `jinn-mono-280n.4`). Daemon's `canClaimTask` simulation
   compensates at claim time, but the indexer columns stay null/false.

7. **`SPEC.md` is a stub.** Canonical "read before reasoning about the protocol loop"
   per CLAUDE.md. Most operational truth currently lives in
   [`client/OPERATOR-APP-SPEC.md`](client/OPERATOR-APP-SPEC.md),
   [`spec/2026-04-30-phase-a-umbrella.md`](spec/2026-04-30-phase-a-umbrella.md), and
   the engineering handbook. A future canonical IMPLEMENTATION.md and an updated
   `SPEC.md` together would close most of the "where is the truth" problem.

---

## 9. Methodology + caveats

This draft was produced from a one-shot audit at `origin/next @ 2f0c0e1c` on
2026-05-27, by:

1. Pulling entity counts and sample records from the production indexer's GraphQL
   endpoint to anchor expectations against live state.
2. Cross-referencing every wiring claim with the source tree via `git grep`, file
   reads, and default-config traces in
   [`client/src/main.ts`](client/src/main.ts),
   [`client/src/config.ts`](client/src/config.ts),
   [`packages/indexer/ponder.config.ts`](packages/indexer/ponder.config.ts),
   and [`packages/indexer/src/`](packages/indexer/src/).
3. Dispatching three parallel `Explore` sub-agents (chain · daemon · indexer +
   explorer) with no shared context, each briefed with the same live ground-truth,
   each producing an independent fact-table. Outputs were reconciled against the live
   indexer where they disagreed.

What this audit **does not** cover: test architecture, CI configuration, release
cadence (see the [engineering handbook](docs/engineering/handbook.md));
internal-tool packages; the `growth/` material; anything outside `origin/next` at
the time of audit.

Things this audit **explicitly could not verify** and leaves as open:

- Live operator activity on Base mainnet (Phase 0).
- The intended fate of
  `client/deployments/deployment-claim-registry-baseSepolia.json`.
- Whether the manifest naming convention (`solverNetId` uses hyphens, SolverType keys
  use dots) is canonical or transitional.

Update policy for this doc: the wiring map and gaps section need maintenance only
when code changes or gaps close. Live state lives at the indexer; if you find
yourself adding counts or status badges to this doc, push them back to §1's queries
instead.
