# Tier 2 scenarios

Three scenarios, all multi-operator, all running against substrate-derived workspaces with an Anvil-fork-of-Base-Sepolia RPC. Tier 2 is invoked by `release-prep` during release-readiness Phase 5; not on every push.

The "what does this scenario actually exercise" contracts live in `testing-jinn-app` (one doc per scenario, Plan B). The "how is it wired and what's the runtime shape" details are below.

## T2.1 — cross-operator-donation

**Catches:** x402 + ERC-8128 handshake regressions; corpus indexer attribution bugs; payment-gated artifact access bugs. Designed to catch the #310 class of silent failure.

**Contract:** [`testing-jinn-app/references/scenario-cross-op-donation.md`](../../testing-jinn-app/references/scenario-cross-op-donation.md)

**Implementation:** `client/test/release/tier-2/T2.1-cross-op-donation.ts`

**Wall-clock budget:** 5 minutes

**Prerequisites:**
- Substrate workspace via Plan A's `substrate-copy`.
- Local Ponder indexer (helper at `client/test/_support/indexer/ponder.ts`).
- Daemon endpoints: `/v1/corpus/produce`, `/v1/corpus/:cid`, `/v1/corpus/:cid/pay`, `/v1/discovery/corpus`.

**Current status (v0.1.6):** Returns `verdict=skip` because the producer-side HTTP surface (`/v1/corpus/produce`) is not present in the daemon today. See GH issue [#349](https://github.com/Jinn-Network/mono/issues/349). The probe is forward-compatible: when the endpoint ships, T2.1 transitions to the happy path.

## T2.2 — producer-evaluator-anvil-fork

**Catches:** Claim → solve → deliver → evaluate loop regressions; activity-counter incorrectness; verdict pipeline mechanics.

**Contract:** [`testing-jinn-app/references/scenario-producer-evaluator.md`](../../testing-jinn-app/references/scenario-producer-evaluator.md)

**Implementation:** `client/test/release/tier-2/T2.2-producer-evaluator.ts`

**Wall-clock budget:** 5 minutes

**Prerequisites:**
- Substrate workspace via Plan A's `substrate-copy`.
- Stubbed harness via `JINN_HARNESS_STUB_INSTANCE` env (Task 3).
- SWE-rebench v2 fixture at `client/test/release/tier-2/fixtures/` (Task 4).
- Daemon endpoints: `/v1/tasks`, `/v1/tasks/:id`, `/v1/verdicts`, `/v1/activity`.

**Current status (v0.1.6):** Returns `verdict=skip` because `POST /v1/tasks` is not present (real task posting goes via on-chain Mech Marketplace, not HTTP). Activity surfaces via `GET /v1/status` rather than a standalone `/v1/activity`. See GH issue [#350](https://github.com/Jinn-Network/mono/issues/350).

## T2.3 — multi-op-spa-flow

**Catches:** Cross-op UI flows that pass with mocks but break with real daemons; SPA state synchronization; Launcher → Operator catalog visibility.

**Contract:** [`testing-jinn-app/references/scenario-multi-op-spa-flow.md`](../../testing-jinn-app/references/scenario-multi-op-spa-flow.md)

**Implementation:** `client/test/dashboard/multi-op/launcher-join-flow.e2e.test.ts` (Playwright, invoked via subprocess from the orchestrator)

**Wall-clock budget:** 5 minutes

**Prerequisites:**
- Substrate workspace via Plan A's `substrate-copy`.
- SPA test-id attributes (`manifest-cid`, `operator-count`) — `manifest-cid` alias added in Task 9; `operator-count` surface NOT YET ADDED, see GH issue [#351](https://github.com/Jinn-Network/mono/issues/351).
- The Playwright two-substrate-ops fixture at `client/test/dashboard/multi-op/fixtures/two-substrate-ops.ts`.

**Current status (v0.1.6):** Will fail on the `operator-count` selector until the SPA grows that surface (issue #351).

## Parallelism

All three scenarios run in parallel via `client/scripts/release/run-tier-2.ts`. Each gets its own:
- Substrate workspace (port-isolated daemons)
- Anvil fork
- Ponder indexer (T2.1, T2.3; T2.2 doesn't need it)

Total wall-clock at full parallelism ≈ max(scenario wall-clocks) ≈ 5 minutes.

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
| Verdict mismatch in T2.2 | real-bug | BLOCKING — substrate/scoring regression |
| Playwright selector miss in T2.3 | real-bug | UI changed without test-id update |

## Invocation

```bash
# All three scenarios via the orchestrator
yarn release:tier-2 <candidate-version>

# Per-scenario standalone
yarn release:tier-2:T2.1
yarn release:tier-2:T2.2
yarn release:tier-2:T2.3
```

Output: `tier-2-evidence/<timestamp>/` with `summary.json`, `marker.txt`, per-scenario `.log` files.
