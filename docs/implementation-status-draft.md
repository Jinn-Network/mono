---
title: Implementation status — draft
status: DRAFT (machine-assisted audit; for Oak + Ritsu to curate into a canonical IMPLEMENTATION.md)
audit_date: 2026-05-27
audit_branch: origin/next @ 2f0c0e1c
scope: what is currently live and load-bearing on the testnet stack
caveat: snapshot of one moment in time; entity counts and SolverNet statuses will drift
---

# Implementation status — draft

This document is a **draft** produced from a one-shot audit of the Jinn Network monorepo at
`origin/next` (commit `2f0c0e1c`, 2026-05-27). It describes what is **live and load-bearing**
on the Jinn testnet stack — meaning a daemon, indexer, or explorer actively uses it on
testnet today, against real on-chain state, in the path of a non-test request.

Speculative code, abandoned adapters, retired SolverTypes, and unreferenced deployment
artifacts are listed separately at the end so maintainers can see what is safe to delete.

Verification policy: every claim below is back-stopped by either (a) a `git grep` hit
against a default-config wiring path, (b) a non-zero count on the live Ponder indexer
at `https://jinn-indexer-production.up.railway.app/graphql`, or (c) an explicit "could
not verify" note. Where a claim about "the team thinks X is shipped" did not survive
verification, it appears under **Gaps surfaced by the audit**.

---

## 1. At a glance — live numbers

Pulled from the live Ponder indexer on 2026-05-27. The indexer ingests Base Sepolia
(chainId 84532, head block 42060354) and Sepolia L1 (chainId 11155111, head block
10933584).

| Surface | Count |
|---|---:|
| Tasks (`JinnRouter.TaskCreated` on Base Sepolia) | 515 |
| Attempts (`JinnRouter.TaskAttemptCreated`) | 980 |
| Verdicts (`JinnRouter.VerdictDeliveryClaimed`) | 475 |
| Reward distributions (`JinnDistributor.Claimed` on Sepolia L1) | 247 |
| SolverNet manifests (live + retired) | 4 |
| Envelopes (any kind) | 1002 |
| Attempt envelopes enriched from IPFS | 609 / 1002 (60%) |
| Verdict envelopes enriched from IPFS | 364 / 475 (77%) |
| Plugin publications | 0 |
| Harness checkpoints | 0 |

The 4 SolverNet manifests, in order of activity:

| Name | SolverType | Status | Anchored |
|---|---|---|---|
| SWE-rebench v2 | `swe-rebench-v2.v1` | launched | block 41762301 (2026-05-20) |
| T3.1 isolated | `swe-rebench-v2.v1` | launched | block 41861303 (2026-05-22) |
| Dogfood Prediction Net | `prediction-v1` | **retired** (2026-05-06) | block 41156361 |
| Verify Net | `prediction-v1` | **retired** (2026-05-07) | block 41196771 |

All four were launched by `launcherAgentId = 5474`. **Only the two swe-rebench-v2.v1 nets
are currently "launched";** the two prediction-v1 nets are retired and no longer accept
new attempts. A sample of the 20 most recent attempt envelopes is uniformly
`solverType = swe-rebench-v2.v1`, executed by `codex` (mostly, `model = gpt-5.4-mini`)
or `hermes-agent` (`model = deepseek/deepseek-v4-flash`), `mode = train`,
`evidenceTier = committed`.

---

## 2. Chain layer

### Base Sepolia (84532) — execution chain

**JinnRouter** (`0xdC9BCcEB7aca21Ad4Ca2Fc5B4d7aea6b4F6CedD9`) — the V3 task router. Creates
tasks, registers attempts, claims solution and verdict deliveries, increments per-channel
activity counts read by OLAS staking.
*Callers:* daemon (`client/src/adapters/mech/`, all loops that touch task lifecycle);
indexer (`packages/indexer/ponder.config.ts`).
*Verification:* 515 tasks + 980 attempts + 475 verdicts on the live indexer.

**IdentityRegistry** (`0x8004A818BFB912233c491871b3d84c89A494BD9e`) — ERC-8004 registry.
Mints operator agent NFTs, binds agent wallets, and (the load-bearing part for the
indexer) anchors arbitrary `MetadataSet` keys whose payloads are CIDs to IPFS-hosted
JSON. The indexer uses the key prefix to route to one of four entity types
(`solvernet-manifest:`, `envelope:` / `evaluation:` / `capture:`, `plugin:`,
`harness.checkpoint:`).
*Callers:* daemon (`client/src/erc8004/`, bootstrap registration, envelope publish);
indexer.
*Verification:* 4 manifests + 1002 envelopes anchored.

**Phase 1b token + staking stack** — bundled in `client/deployments/`:
- `deployment-phase1a-token-baseSepolia-fast.json` — bridged JINN token on L2.
- `deployment-phase1a-l2-baseSepolia-fast.json` — staking proxy + service registry fork
  of OLAS.
- `deployment-phase1b-mech-baseSepolia-fast.json` — Mech Marketplace fork.
- `deployment-task-coordinator-router-v3-baseSepolia-fast.json` — TaskCoordinator +
  JinnRouter V3.
- `deployment-stolas-l2-baseSepolia-fast.json` — stOLAS distributor (operator reward
  side).
- `deployment-jinn-testnet-faucet-baseSepolia-fast.json` — testnet JINN drip used in
  bootstrap.
- `deployment-jinn-mvi-l2-baseSepolia.json` — `TaskClaimEmitter` for cross-chain claim
  emission.

All seven are referenced by `DEFAULT_TESTNET_ARTIFACTS` in `client/src/earning/contracts.ts`
and loaded by `FleetBootstrapper` (`client/src/earning/bootstrap.ts`).

### Sepolia L1 (11155111) — DAO + distribution chain

**JinnDistributor** (`0xaC9CD847660d05e77D82A3684aFC4EbFd94fBfe6`) — distributes JINN
tokens from the L1 DAO to operators against cross-chain claim tickets. Indexer's
`rewardDistribution` rows are 1:1 with its `Claimed` events.
*Callers:* daemon `JinnClaimLoop` (`client/src/daemon/jinn-claim-loop.ts`); indexer.
*Verification:* 247 `rewardDistribution` rows, all `chainId = 11155111`.

**L1 DAO stack** (bundled as `deployment-jinn-mvi-l1-sepolia.json`):
JINN token, `JinnGovernor`, `TimelockController`, `JinnDistributor`, `MockMessenger`. The
mock messenger replaces the canonical Optimism Portal bridge for testnet; the design
keeps the canonical path intact behind an interface (see
`spec/2026-04-06-phase-1a-design.md`).

### Base mainnet (8453) — Phase 0 legacy, NOT indexed today

**JinnRouter (Phase 0)** (`0xfFa7118A3D820cd4E820010837D65FAfF463181B`),
**IdentityRegistry** (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`),
**OLAS Mech Marketplace** (`0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020`),
**OLAS staking contract** (`0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54`),
**OLAS token** (`0x54330d28ca3357F294334BDC454a032e7f353416`).

These addresses are still referenced in `client/src/earning/contracts.ts` `BASE_CONFIG`
and in `CLAUDE.md`. Mainnet indexing is **gated on a paid RPC** — the free
`mainnet.base.org` endpoint cannot sustain Ponder's historical sync. Until then, the
indexer does not see mainnet, and the daemon's mainnet code path is effectively dormant
(no live SolverNets, no observable activity).

*Could not verify:* whether any operator is still earning on Base mainnet today. The
default `jinn run` against the bundled config selects testnet; mainnet would require a
deliberate override. Treat mainnet as "code still compiles, deployment still on chain,
no live activity in scope of this audit."

---

## 3. Daemon (`client/`)

Production entry point: `client/src/main.ts`. Long-running daemon is
`client/src/daemon/daemon.ts`.

### 3.1 Loops actually started by `Daemon.start()`

All references are to `client/src/daemon/daemon.ts` unless noted.

| Loop | File | Conditional? | Live evidence |
|---|---|---|---|
| `CreatorLoop` | `daemon/creator.ts` | always | 515 tasks |
| Engine watcher | `daemon/daemon.ts:_runEngineWatcherLoop` | always | 980 attempts |
| Engine tick | `harnesses/engine/engine.ts:runTickLoop` | always | drives in-flight tasks |
| `DeliveryWatcherLoop` | `daemon/delivery-watcher.ts` | always | 475 verdicts |
| `RewardClaimLoop` | `daemon/reward-claim-loop.ts` | `rewardClaimIntervalMs > 0` | claims stOLAS rewards |
| `BalanceTopupLoop` | `daemon/balance-topup-loop.ts` | testnet default on | keeps EOA + Safe funded |
| `EvictionLoop` | `daemon/eviction-loop.ts` | standard staking mode + distributorAddress | restakes on eviction |
| `CheckpointLoop` | `daemon/checkpoint-loop.ts` | standard staking mode | permissionless tsCheckpoint |
| `JinnClaimLoop` | `daemon/jinn-claim-loop.ts` | L1 RPC + MVI artifacts | 247 reward distributions |
| `PeerSync` | `api/peers.ts` | `peers` set | optional |
| Recovery (one-shot) | `harnesses/engine/engine.ts:recoverInFlight` | always | startup-only |

That is 9 always-on or routinely-enabled loops + one optional + one startup hook. The
shape matches `client/ARCHITECTURE.md`'s "eight long-running loops" only if you collapse
engine watcher + engine tick into one and elide checkpoint or eviction; the audit found
9 conditional + 1 optional, not 8. **Gap:** architecture narrative is one loop short.

### 3.2 Adapters

| Adapter | Live? | Where |
|---|---|---|
| `MechAdapter` | **live** — sole adapter selected in `main.ts` | `client/src/adapters/mech/` |
| `LocalAdapter` | test-only fixture | `client/src/adapters/local/` |

There is no second production adapter in tree.

### 3.3 SolverTypes (definitions)

`client/src/solver-types/`:

| SolverType | Live? | Evidence |
|---|---|---|
| `prediction-v1` | **retired on-chain** — only powering retired Dogfood Prediction Net + Verify Net | manifest hashes in indexer; both `status = retired` |
| `swe-rebench-v2.v1` | **live** — powers both currently-launched SolverNets | 20/20 most recent attempts |
| `prediction-apy-v0` | **not live today** — no SolverNet currently uses it | grep only; no manifest |
| `session-derived` | **not live** — experimental; no SolverNet | grep only |
| `portfolio-v0` | **not live** as a SolverType, present as evaluator harness only | internal use |

Note: the daemon agent's audit observed a `prediction.v1` catalog stub and a
`prediction-apy-v0` catalog stub in `main.ts`. The on-chain manifests show only
`prediction-v1` and `swe-rebench-v2.v1`. `prediction-apy-v0` is wired in the daemon but
has no live SolverNet pointing at it.

### 3.4 Harnesses (`client/src/harnesses/impls/`)

| Harness | Live? | Live SolverNet evidence |
|---|---|---|
| `prediction-v1-baseline` | live (retired nets) | history only |
| `prediction-v1-evaluator` | live (retired nets) | history only |
| `swe-rebench-v2-evaluator` | **live** | 364 verdict envelopes |
| `learner/` (ClaudeCode adapter) | wired into default registry | grep |
| `learner/` (Codex adapter) | **live** — dominant in recent attempts | majority of last 20 attempt envelopes |
| `hermes-agent` | **live** — minority of recent attempts | sample shows `deepseek-v4-flash` runs |
| `prediction-apy-v0-baseline` + `-evaluator` | wired, **no live SolverNet** | grep |
| `portfolio-v0-evaluator` | wired, internal-only | grep |
| `legacy-claude` | wired only if `env.runner` supplied; learner default takes precedence | dead in default flow |
| `stub` / `external-impls` | env-gated, not on testnet | grep |

The daemon agent's claim that "Hermes is the swe-rebench-v2 default" should be read
with care: the most recent 20 attempt envelopes are dominated by `codex`, not Hermes. The
true default lives in the SolverNet manifest, not in daemon source; operators may also
override per-instance.

### 3.5 Generators

Verified: generators are **launched-record-driven**, not config-flag-gated. There is no
`taskGenerator.enabled` check in `main.ts`; the daemon walks
`~/.jinn-client/solvernets/launched/` and dispatches per-SolverType generators per
launched record (`client/src/main.ts:wireLaunchedRecordGenerators`,
`client/src/solvernets/launched-record-dispatcher.ts`). This matches
`spec/2026-05-05-solvernet-creation-and-launch.md` §11.

### 3.6 Discovery API

`client/src/discovery/`. Two implementations (`onchain.ts`, `http.ts`) plus a
fall-through wrapper (`with-fallback.ts`) built by `factory.ts`. The default testnet
`discovery.url` is `DEFAULT_TESTNET_DISCOVERY_URL` in `client/src/config.ts`, which
points at this audit's live indexer
(`https://jinn-indexer-production.up.railway.app`). Testnet defaults to
`mode = 'http'`; mainnet defaults to the on-chain RPC floor.

Per CLAUDE.md (post-2026-05-23 incident), `fallbackToOnchain` is **off by default**.
When the indexer is unreachable, the daemon raises `DiscoveryUnavailableError` rather
than silently storming the public RPC.

### 3.7 Operator dashboard SPA

`client/src/dashboard/spa/` — bundled into the published `@jinn-network/client`
package and served by the daemon's Hono server at `127.0.0.1:7331` (port `apiPort`).
Two modes: onboarding (bootstrap takeover) and operating dashboard.
*Spec:* `client/OPERATOR-APP-SPEC.md` (canonical).
*Distinct from* the standalone explorer SPA in `packages/indexer/explorer/`.

### 3.8 Cross-cutting modules

| Module | File | Role | Live? |
|---|---|---|---|
| `FleetBootstrapper` | `earning/bootstrap.ts` | 11-step wallet → Safe → service → mech bootstrap | always on |
| `IdentityPublisher` | `erc8004/identity.ts` | publishes envelopes to IdentityRegistry | gated on agent_id |
| `ReputationFeedback` | `erc8004/reputation-feedback.ts` | sets harness agent NFT reputation | wired post-eval |
| `x402` handler | `x402/` | payment-gated artifact delivery | live in corpus |
| `Corpus` | `corpus/` | artifact discovery + IPFS fetch + MCP tools | live |
| Spend caps | `spend/daemon-config.ts` | per-credential daily ceiling at claim gate | wired |
| Harness readiness | `harnesses/readiness-registry.ts` | gates claim by harness probe | wired |
| Operator MCP | `mcp/operator-server.ts` | AI-host-facing MCP wrapper around CLI | CLI-invoked, not part of daemon startup |
| Runner-scoped MCP | `mcp/server.ts` | subprocess-side artifact tools | spawned by ClaudeRunner |

---

## 4. Indexer (`packages/indexer/`)

Ponder 0.16.6. Two chains configured: Base Sepolia (84532) and Sepolia L1 (11155111).
Base mainnet (8453) intentionally not yet indexed; tracked as `jinn-mono-280n.4`.

### 4.1 Handler → entity coverage

| Event | Entity | Live rows | Status |
|---|---|---:|---|
| `JinnRouter.TaskCreated` (84532) | `task` | 515 | firing |
| `JinnRouter.TaskAttemptCreated` (84532) | `attempt` | 980 | firing |
| `JinnRouter.SolutionDeliveryClaimed` (84532) | `task.finalized` flag | — | firing (mutation only) |
| `JinnRouter.VerdictDeliveryClaimed` (84532) | `verdict` | 475 | firing |
| `IdentityRegistry.MetadataSet` `solvernet-manifest:` (84532) | `solverNetManifest` | 4 | firing |
| `IdentityRegistry.MetadataSet` `envelope:` / `evaluation:` / `capture:` (84532) | `envelope` (+ enrichment) | 1002 | firing |
| `IdentityRegistry.MetadataSet` `plugin:` (84532) | `pluginPublication` | 0 | **handler ready, no on-chain writes** |
| `IdentityRegistry.MetadataSet` `harness.checkpoint:` (84532) | `harnessCheckpoint` | 0 | **handler ready, no on-chain writes** |
| `JinnDistributor.Claimed` (11155111) | `rewardDistribution` | 247 | firing |

### 4.2 Entities with no live data today

- **`pluginPublication`** — schema and v1/v2 decode handlers exist
  (`packages/indexer/src/handlers.ts:1164–1275`); explorer routes `/plugins`,
  `/builders/:agentId/runs`, `/plugins/:cid/scores` query it. No builder has published
  on chain yet. Routes degrade to `[]`.
- **`harnessCheckpoint`** — schema and IPFS-enriched manifest handler exist
  (`packages/indexer/src/handlers.ts:887–949`); SolverNetView's CheckpointTimeline
  reads from it. No harness has published a checkpoint on chain yet. Component renders
  empty.

### 4.3 Envelope IPFS enrichment

Two enrichment tables piggyback on the envelope events:

- `attemptEnvelopeMeta` — joined to `attempt` by `requestId`. Holds executor metadata:
  `solverType`, `implName` (harness), `mode`, `model`, `language`, `evidenceTier`,
  `pluginsJson`, `codeDigest`. **609 / 1002 attempt envelopes enriched (60%).**
- `verdictEnvelopeMeta` — joined to `verdict` by `requestId`. Holds the evaluator's
  *actual* outcome: `actualPassed`, `actualScore`, `evaluatorVerdict`. **364 / 475
  verdicts enriched (77%).**

Enrichment uses the IPFS gateway `https://gateway.autonolas.tech` by default (overridable
via `JINN_IPFS_GATEWAY_URL`). Failures are silent — no row, no error — so Ponder
naturally retries on next sync. The "envelope" `verdictEnvelopeMeta.actualPassed` is the
**source of truth** for verdict outcomes because the on-chain `verdict.verdictCode`
field is widely defaulted to `Pass(1)` when the daemon's evaluation pipeline fails (a
known daemon bug, captured in the schema notes).

---

## 5. Explorer (`packages/indexer/explorer/`)

Vite SPA, bundled and served by the same Ponder process at the indexer URL. The
client-rendered shell means a `curl` to `/` only returns the HTML scaffold — all data
loads via the routes below.

### 5.1 SPA routes

| Route | Backing entities | Backing API |
|---|---|---|
| `/` (NetworkView) | all entities | `GET /explorer/network` |
| `/solvernets` | `solverNetManifest` + `task` + `verdict` | `GET /explorer/solvernets` |
| `/solvernet/:cid` | `task` + `attempt` + `verdict` + envelope-meta tables | `GET /explorer/solvernet/:cid` |
| `/operators` | `attempt` + `verdict` + `rewardDistribution` | `GET /explorer/operators` |
| `/operator/:addr` | `attempt` + `verdict` + `rewardDistribution` | `GET /explorer/operator/:addr` |
| `/explore/:cid` | redirect to `/solvernet/:cid` (back-compat for legacy deep links) | — |
| `/*` (404) | — | — |

All five primary routes resolve against non-zero live data today; the operators and
per-net leaderboard rankings use envelope-truth verdict outcomes
(`verdictEnvelopeMeta.actualPassed`) rather than on-chain `verdictCode`.

### 5.2 GraphQL + REST surface

- `POST /graphql` — Ponder-generated GraphQL over all 10 entities, with
  pagination and filters. The daemon's `HttpDiscoveryAPI` reads this.
- `GET /explorer/network` — fleet KPIs.
- `GET /explorer/solvernets`, `GET /explorer/solvernet/:cid` — SolverNet list +
  per-net detail (KPIs, leaderboard, learning curves, checkpoint timeline, freeze-integrity
  violations).
- `GET /explorer/operators`, `GET /explorer/operator/:addr` — operator leaderboard +
  per-operator detail.
- `GET /plugins`, `GET /plugins/:cid/scores` — plug-in catalogue + per-plug-in score
  history. **Returns `[]` today** (no live publications).
- `GET /builders/:agentId/runs`, `GET /builders/:address/artifacts`,
  `GET /builders/:address/scores` — builder-attributed run + artifact views. **Returns
  `[]` today.**
- `GET /health`, `GET /ready`, `GET /status` — Ponder defaults.

---

## 6. External / cross-cutting dependencies

| Service | What it is | Used by | Verified reachable today? |
|---|---|---|---|
| IPFS via `gateway.autonolas.tech` | content fetch for envelopes, manifests, plug-ins, harness manifests | daemon + indexer | indirectly: 60%–77% envelope enrichment |
| Base Sepolia public RPC chain | `base-sepolia.publicnode.com` + `sepolia.base.org` | daemon + indexer | live indexer headed to block 42060354 |
| Sepolia L1 RPC | publicnode + others | daemon + indexer | live indexer headed to block 10933584 |
| OLAS Mech Marketplace fork | testnet-local fork in `deployment-phase1b-mech-baseSepolia-fast.json` | daemon | implicit in 980 attempts |
| OLAS staking fork | testnet-local fork in `deployment-phase1a-l2-baseSepolia-fast.json` | daemon (eviction + checkpoint loops) | implicit in reward flow |
| stOLAS L2 distributor | `deployment-stolas-l2-baseSepolia-fast.json` | daemon `RewardClaimLoop` | not directly verified |
| Testnet JINN faucet | `deployment-jinn-testnet-faucet-baseSepolia-fast.json` | bootstrap | not directly verified |
| `TaskClaimEmitter` (L2) | `deployment-jinn-mvi-l2-baseSepolia.json` | daemon `JinnClaimLoop` | implicit in 247 distributions |

`packages/claim-relayer/` and `packages/eng-loop/` are local internal-tool packages and
out of scope for the operator-facing protocol audit.

`apps/broadcast-bot/` is present and not load-bearing for the on-chain loop.

---

## 7. Built but not load-bearing today

These exist in the tree and compile, but no live request path on testnet touches them
in the default `jinn run` against `origin/next`.

**Adapters**
- `client/src/adapters/local/` — test-only `LocalAdapter`; not selected anywhere in
  `main.ts`.

**SolverTypes**
- `client/src/solver-types/session-derived.ts` and friends — experimental; no SolverNet
  manifest references it.
- `client/src/solver-types/portfolio-v0.ts` — present as evaluator harness, no
  SolverNet driving it.
- `client/src/solver-types/prediction-apy-v0.ts` and `-auto.ts` — wired in
  `main.ts` catalog and in `buildHarnesses`, but no live SolverNet manifest currently
  points at it. (Note: the daemon agent claimed "Dogfood Prediction Net" uses
  `prediction-apy-v0`; the on-chain manifest record says `solverNetId =
  5474_prediction-v1_8b226228` — `prediction-v1`, not `prediction-apy-v0`. Worth a
  closer look by Oak/Ritsu before publishing.)

**Harnesses**
- `legacy-claude` (`harnesses/impls/legacy-claude/`) — only wired when `env.runner` is
  supplied; the learner adapter takes precedence in the default registry.
- `stub` (`harnesses/impls/stub.ts`) — env-gated test harness.
- `external-impls/` — operator-supplied npm-package harnesses; not on testnet today.

**Contracts**
- `contracts/src/staking/` `RestorationActivityChecker*` versions — Phase 0 activity
  checkers; superseded by V3 stack.
- `JinnRouter` V1/V2 source — superseded by V3.
- `CanonicalOpStackMessenger` — interface kept for the canonical Optimism Portal path;
  testnet runs the mock messenger.
- `JinnClaimEmitter` — legacy; replaced by `TaskClaimEmitter` in the MVI L2 deployment.

**Deployment artifacts**
- `client/deployments/deployment-claim-registry-baseSepolia.json` — referenced only
  from a CLI update-config test path; not loaded by the daemon or the indexer. Strong
  candidate for removal unless an upgrade path is documented somewhere not found.

**Indexed entities with no live data**
- `pluginPublication` — handler and explorer routes ready; no on-chain writes yet.
- `harnessCheckpoint` — handler and CheckpointTimeline ready; no on-chain writes yet.

**Mainnet (Phase 0)**
- Base 8453: JinnRouter, IdentityRegistry, OLAS Mech Marketplace, OLAS staking — code
  paths still compile; no live activity in scope of this audit; not indexed.

---

## 8. Gaps surfaced by the audit

Items where the docs say or imply something is shipped, and the audit could not verify
it; or where live state contradicts a written claim.

1. **Architecture narrative is one loop short.** `client/ARCHITECTURE.md` and CLAUDE.md
   describe "eight long-running loops." The audit found 9 always-on or conditionally-on
   loops in `Daemon.start()` (creator, engine-watcher, engine-tick, delivery-watcher,
   reward-claim, balance-topup, eviction, checkpoint, jinn-claim) plus optional
   peer-sync. Update or reconcile.

2. **Dogfood Prediction Net's SolverType.** On-chain manifest records the
   `prediction-v1` SolverType (`solverNetId = 5474_prediction-v1_8b226228`); the daemon
   audit assumed `prediction-apy-v0` because `prediction-apy-v0-auto` is wired in
   `main.ts`. Worth a closer look — either the daemon wiring or the documentation is
   describing an unreleased state.

3. **Verify Net's status and purpose.** Retired 2026-05-07 on chain; the README and
   spec set make no mention of a "Verify Net" SolverNet. May be a historical experiment
   that should be documented as retired.

4. **Base mainnet (Phase 0) status.** CLAUDE.md still lists mainnet addresses as
   "Phase 0 complete (Base mainnet)" and the daemon still resolves them by default in
   `BASE_CONFIG`. The audit could not confirm any live operator earnings on mainnet
   today, and mainnet is unindexed. If Phase 0 mainnet is effectively dormant, the
   docs should say so plainly (or "Phase 0 is permanent legacy, see X for active
   network").

5. **Envelope enrichment coverage is partial.** 60% of attempt envelopes and 77% of
   verdict envelopes are enriched from IPFS. The remainder fail silently (no row, no
   marker). The explorer's harness / mode / model / plug-in facets show partial data
   on the unenriched rows; the `language` facet is sparsely populated; the `model`
   facet is empty for many rows because the daemon does not yet stamp `executor.model`
   on all envelopes (tracked as `jinn-mono-gbut` / GitHub #191). A batch-retry
   enrichment worker is not yet present.

6. **Verdict on-chain vs envelope-truth disagreement is structural.** The daemon
   defaults the on-chain `verdictCode` to `Pass(1)` when its evaluation pipeline
   fails; the off-chain envelope holds the real evaluator outcome. The explorer
   prefers envelope-truth, but the indexer's `verdict` table still reflects the
   defaulted on-chain code. This is documented in the schema; it deserves a
   first-class callout in IMPLEMENTATION.md because it changes how to read the 475
   verdicts versus the 364 enriched verdict envelopes.

7. **`pluginPublication` and `harnessCheckpoint` are indexed-but-empty.** The
   "knowledge market" framing in `spec/2026-04-30-phase-a-umbrella.md` and the
   plug-in builder design in `2026-05-13-plug-in-builder-entry-point-design.md`
   both describe these surfaces as part of Phase A. They are *prepared* end-to-end
   (contracts emit them, indexer ingests them, explorer renders them) but no actor has
   exercised the write path on chain yet. This is the largest gap between "designed"
   and "deployed" the audit surfaced.

8. **`claim-registry-baseSepolia.json` appears orphaned.** Bundled in
   `client/deployments/` but not referenced by `DEFAULT_TESTNET_ARTIFACTS` and not
   loaded in the daemon or indexer hot paths. Either there is a load path the audit
   missed, or it is dead weight to remove.

9. **`SPEC.md` is a stub.** Canonical "read before reasoning about the protocol loop"
   doc per `CLAUDE.md` exists but is a stub at audit time. Most operational truth lives
   in `client/OPERATOR-APP-SPEC.md`, `spec/2026-04-30-phase-a-umbrella.md`, the
   handbook, and the design system. A future canonical IMPLEMENTATION.md and an
   updated SPEC.md together would close most of the "where do I find what's true"
   problem.

---

## 9. Methodology + caveats

This audit is a snapshot. Entity counts, SolverNet statuses, harness mix, and
enrichment coverage will drift within hours.

The audit was conducted by:

1. Pulling live entity counts and sample records from the production indexer's
   GraphQL endpoint.
2. Cross-referencing every claim with the source tree at commit `2f0c0e1c` via
   `git grep`, file reads, and default-config wiring traces in `client/src/main.ts`,
   `client/src/config.ts`, `packages/indexer/ponder.config.ts`, and
   `packages/indexer/src/`.
3. Dispatching three parallel `Explore` sub-agents (chain layer, daemon hot path,
   indexer + explorer) with no shared context, each briefed with the same live
   ground-truth, each producing an independent fact-table. The author then
   reconciled their outputs against the live indexer where they disagreed.

What this audit **does not cover**:
- Test code quality, CI configuration, release cadence (see the engineering handbook).
- The internal-tool packages `packages/claim-relayer/`, `packages/eng-loop/`,
  `apps/broadcast-bot/` beyond noting their presence.
- The `growth/` material and `legacy/` archive.
- Anything outside `origin/next` at the time of audit.

What this audit **explicitly could not verify** and left as open:
- Live operator activity on Base mainnet (Phase 0).
- Whether `Dogfood Prediction Net` actually used `prediction-apy-v0` or
  `prediction-v1` (the on-chain record disagrees with the daemon-side wiring; see Gap
  2).
- The intended fate of `client/deployments/deployment-claim-registry-baseSepolia.json`.

Treat every line above as a starting point, not a guarantee. Curate, correct, and cut.
