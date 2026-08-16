# Tier 2 scenarios

The automated gate runs **T2.2 + T2.4** (producer/evaluator loops against an Anvil-fork-of-Base-Sepolia RPC). T2.1 and T2.3 are retired/removed; their sections below are kept for provenance. Tier 2 is invoked by `release-prep` during release-readiness Phase 5; not on every push.

The "what does this scenario actually exercise" contracts live in `testing-jinn-app` (one doc per scenario, Plan B). The "how is it wired and what's the runtime shape" details are below.

## T2.1 — cross-operator-donation (removed — retired)

T2.1 was **retired** with the x402 payment layer (tokenless-OLAS pivot). Its impl `operator/test/release/tier-2/T2.1-cross-op-donation.ts` is deleted; the x402 / corpus-donation surface it exercised is gone with the pivot. The original scenario contract is retained for provenance: [`testing-jinn-app/references/scenario-cross-op-donation.md`](../../testing-jinn-app/references/scenario-cross-op-donation.md).

## T2.2 — producer-evaluator-anvil-fork

**Catches:** producer → solve → deliver → evaluate → verdict loop regressions; on-chain activity-counter incorrectness; the verdict pipeline end-to-end through a real daemon.

**Contract:** [`testing-jinn-app/references/scenario-producer-evaluator.md`](../../testing-jinn-app/references/scenario-producer-evaluator.md)

**Implementation:** `operator/test/release/tier-2/T2.2-producer-evaluator.ts`

**Wall-clock budget:** ~18 minutes

**Approach (real on-chain loop, per GH issue [#350](https://github.com/Jinn-Network/mono/issues/350)):** T2.2 drives the producer/evaluator loop the way the protocol actually works — there is no HTTP task-control plane and none should exist. It composes the `yarn e2e:daemon-harness` helpers (`operator/test/e2e/_daemon-harness-helpers.ts`):

- Forks Base into Anvil and deploys a fresh JinnRouter V3 task stack (`deployMinimalV3Stack`) — the production V1 router has no `createTask` interface.
- Bootstraps two staked operators via the real `FleetBootstrapper` — op-a (producer/solver) and op-b (evaluator); `deployOperatorMech` gives op-b its own mock mech so the V3 `claimEvaluation` operator check passes.
- Posts a `prediction.v1` task on-chain via `createTask` (`postPredictionV1Task`). prediction.v1 is used because its baseline solver and `PredictionV1Evaluator` are deterministic and need no Docker/LLM key — keeping the gate deterministic and cheap.
- op-a's daemon claims + solves + delivers on-chain (`waitForDaemonClaim`, `waitForDelivery`); op-b's daemon discovers the on-chain solution, claims the evaluation request, runs the real evaluator, and settles a verdict on-chain (`waitForVerdict`, the genuinely-new leg).
- The evaluator resolves the fixture market against an in-process mock Polymarket Gamma server (`startMockPolymarketGammaServer`), so the verdict is deterministic and offline — the market resolves YES → `verdictCode === 1` (Pass).
- Asserts the on-chain `verdictCode` and that `eligibleActivityWeight` incremented for both operators (the on-chain source of truth, not the `GET /v1/status` mirror).

**Prerequisites:**
- Foundry (`anvil`, `forge`) on PATH.
- An Anvil-forkable Base RPC (`BASE_RPC_URL`, defaults to the public `https://mainnet.base.org`).
- Compiled `contracts/` artifacts — `compileContracts` builds them at runtime.

The substrate multi-op workspace from `setupTier2Scenario` is **not** used: those production daemons are pinned to the already-deployed Base Sepolia contracts and cannot be redirected at a freshly-deployed V3 router. The two in-process daemon-harness daemons can be, and the two-operator shape preserves the producer/evaluator contract. T2.2 returns `pass`/`fail` only — the missing-endpoint skip path is removed.

## T2.4 — producer-evaluator-swe-rebench

**Catches:** swe-rebench-v2 on-chain producer → solve → deliver → evaluate → verdict loop regressions at the cheap tier.

**Implementation:** `operator/test/release/tier-2/T2.4-producer-evaluator-swe-rebench.ts`

**Approach:** the sibling of T2.2 for the `swe-rebench-v2.v1` solver type. A hermetic + deterministic StubHarness SOLVE leg (known-good `sympy__sympy-27510.patch` fixture, no LLM / network) drives the real `SweRebenchV2EvaluatorHarness` (Docker `eval.py`) EVALUATOR leg, which returns a classified `skip` (non-blocking) when Docker / the upstream repo / a scorable admission record is absent ([#898](https://github.com/Jinn-Network/mono/issues/898)). T3.1 asserts the real grading on real Base Sepolia.

## T2.3 — multi-op-spa-flow (removed — superseded)

The automated live-fork T2.3 gate was **removed** by DR-2026-06-03 / [#1014](https://github.com/Jinn-Network/mono/issues/1014) (deletion landed in [#960](https://github.com/Jinn-Network/mono/pull/960)). It was a Playwright browser E2E driven against a live Anvil fork + live daemons — a non-deterministic shape that flaked on multiple independent legs. `operator/test/dashboard/multi-op/` (including `launcher-join-flow.e2e.test.ts`) is gone.

**Root cause it exposed:** the cross-operator IPFS-visibility bug (op-b fetching op-a's manifest by CID). Resolved by the shared-mock-IPFS helper — the `sharedMockIpfs` opt-in in `operator/test/release/tier-2/tier-2-helpers.ts` (commit `727d133c6`), which points both daemons at one in-process `startMockIpfsServer()`. It is available for any Tier-2 scenario that wants a real cross-daemon manifest round-trip; no current gate scenario invokes it.

**Deterministic replacement:** the operator-journey coverage now lives in `operator/test/dashboard/solvernet-flow.e2e.test.ts` + `operator/test/dashboard/join.e2e.test.ts` (`yarn e2e:app-flow`, hermetic gate).

**Real cross-operator experience:** the MANUAL paired-flow gate — [`testing-jinn-app/references/scenario-multi-op-spa-flow.md`](../../testing-jinn-app/references/scenario-multi-op-spa-flow.md) — run by the Captain per DR-2026-06-08 (a human-run spot check, not automated).

## Parallelism

The gate runs **T2.2 + T2.4** in parallel via `operator/scripts/release/run-tier-2.ts`. Each gets its own port-isolated Anvil fork and evidence path.

Total wall-clock at full parallelism ≈ max(scenario wall-clocks).

## RPC budget

Tier 2 is the tier that historically saturates Tenderly (jinn-mono-lrey). The architectural fix is:
- Use substrate-derived workspaces (no re-bootstrap inside the gate).
- One Anvil fork per scenario; both daemons in a scenario share that fork.
- The fork lazy-fetches state from the upstream RPC, but workspace ops already have their identity state cached.

This should keep one Tier 2 run under the per-key rate limit. Concurrent Tier 2 runs (e.g. parallel CI workers) can still saturate. For now, run-tier-2 is single-instance.

## Failure modes

| Failure | Class | Triage |
|---|---|---|
| Substrate stale | n/a | Block run, instruct re-adopt |
| Anvil fork lazy-fetch stalls | flake-infra | Retry once; if persistent, jinn-mono-lrey territory |
| Ponder spawn timeout | flake-infra (env) or real-bug (Ponder config) | Inspect Ponder logs |
| Daemon endpoint 4xx/5xx unrelated to scenario | real-bug | BLOCKING — API surface regression |
| Cross-op visibility lag exceeds budget | flake-timing | Retry once with extended timeout |
| On-chain `verdictCode` not 1 in T2.2 | real-bug | BLOCKING — `PredictionV1Evaluator` scoring regression |
| T2.2 op never claims/delivers/settles within budget | real-bug or flake-timing | inspect evidence log; flake on first, real-bug on retry |

## Invocation

```bash
# T2.2 + T2.4 via the orchestrator
yarn release:tier-2 <candidate-version>

# Per-scenario standalone
yarn release:tier-2:T2.2

# Deterministic operator-journey E2E (hermetic, outside the tier-2 orchestrator)
yarn e2e:app-flow
```

Output: `tier-2-evidence/<timestamp>/` with `summary.json`, `marker.txt`, per-scenario `.log` files.
