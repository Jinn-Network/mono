# Scenario T2.2 — Producer/evaluator (Anvil-fork, real on-chain loop)

**Tier:** 2 (Anvil-fork of Base, in-process daemons, runs in release-prep)
**Wall-clock budget:** ~18 minutes (two `FleetBootstrapper` runs + a slow-RPC-tolerant on-chain loop)
**Catches:** producer → solve → deliver → evaluate → verdict loop regressions; on-chain activity-counter increments; the verdict pipeline end-to-end through a real daemon.

## Goal

Drive the full producer/evaluator loop **the real on-chain way**. A producer
operator's daemon claims a task posted on-chain, solves it, and delivers a
solution on-chain. A separate evaluator operator's daemon discovers that
solution, claims the evaluation request, runs the real evaluator, and settles a
verdict on-chain. Assert the on-chain verdict code and that the on-chain
activity counters increment for both operators.

This is the Anvil-fork mechanical counterpart to Tier 3's real-testnet variant
— same loop, but on a forked chain with deterministic, offline harnesses (no
LLM/API spend).

## Why this is not an HTTP-endpoint scenario

The first cut of T2.2 assumed an HTTP task-control plane (`POST /v1/tasks`,
`GET /v1/tasks/:id`, `GET /v1/verdicts`, `GET /v1/activity`). **None of those
exist, and none should.** Jinn is an on-chain protocol:

- Tasks enter via a `createTask` tx on the JinnRouter V3. The daemon's
  `CreatorLoop` posts generator-produced tasks on-chain — there is no operator
  HTTP entry point for posting protocol tasks.
- Solving, delivery, evaluation and verdicts are all driven by daemon loops
  reacting to on-chain events; verdicts settle on-chain.
- Activity counters are on-chain state (`TaskActivityCheckerV3.eligibleActivityWeight`).
  The daemon only *mirrors* a snapshot into `GET /v1/status`; the gate asserts
  the on-chain source of truth.

The investigation on [issue #350](https://github.com/Jinn-Network/mono/issues/350)
confirmed option (b): rewrite T2.2 to drive the loop the real way. T2.2 no
longer probes for or skips on missing endpoints.

## Implementation location

`operator/test/release/tier-2/T2.2-producer-evaluator.ts` (callable) +
`T2.2-producer-evaluator.test.ts` (Vitest wrapper).

## How it works

T2.2 composes the `yarn e2e:daemon-harness` helpers
(`operator/test/e2e/_daemon-harness-helpers.ts`) — the existing pattern that
already does producer → solve → deliver → activity the real way — and extends
them with the genuinely-new **evaluator/verdict leg**.

1. **Anvil fork of Base + a fresh V3 task stack.** `setupAnvilFixture` forks
   Base; `deployMinimalV3Stack` deploys `JinnRouterV3 + TaskCoordinator +
   TaskActivityCheckerV3 + MockTaskMarketplace`. The production V1 JinnRouter
   does not expose the `createTask` interface, so a V3 stack is deployed on the
   fork.
2. **Two staked operators.** `bootstrapStakedOperator` runs the real
   `FleetBootstrapper` twice — op-a (producer/solver) and op-b (evaluator).
   `deployOperatorMech` gives op-b its own mock mech so the V3 router's
   `claimEvaluation` operator check passes for op-b's Safe.
3. **Post a prediction.v1 task on-chain.** `postPredictionV1Task` issues the
   `createTask` tx with a verdict budget. prediction.v1 is chosen over the
   SWE-rebench stub harness because its baseline solver and
   `PredictionV1Evaluator` are both **deterministic, need no Docker and no LLM
   API key**, and are the path the daemon-harness helpers already support —
   keeping T2.2 deterministic and cheap, as the release gate requires.
4. **Producer leg.** op-a's daemon discovers the task on-chain, claims it
   (`waitForDaemonClaim`), solves it with the deterministic
   `prediction-v1-baseline` harness, and delivers on-chain (`waitForDelivery`).
5. **Evaluator/verdict leg (new).** op-b's daemon discovers op-a's on-chain
   solution delivery, claims the evaluation request, runs the real
   `PredictionV1Evaluator`, and settles a verdict on-chain (`waitForVerdict`,
   watching `VerdictDeliveryClaimed`).
6. **Deterministic verdict.** The evaluator resolves the fixture market against
   an in-process **mock Polymarket Gamma server** (`startMockPolymarketGammaServer`),
   wired in via `startDaemon`'s `polymarketGammaBaseUrl` option. The fixture
   market resolves YES, so the evaluator derives a Pass verdict
   (`verdictCode === 1`) deterministically and offline.
7. **Assertions.** On-chain `verdictCode === 1`, and `eligibleActivityWeight`
   incremented for both the solver and the evaluator.

## Assertions (summary)

| # | Assertion | Why |
|---|---|---|
| A1 | op-a claims the task on-chain (`TaskAttemptCreated`) | producer claim loop closes |
| A2 | op-a delivers the solution on-chain (`Deliver`) | producer solve + deliver loop closes |
| A3 | op-b settles a verdict on-chain (`VerdictDeliveryClaimed`) | evaluator claim + eval + verdict loop closes |
| A4 | on-chain `verdictCode === 1` (Pass) | evaluator scoring is correct against the deterministic fixture market |
| A5 | producer `eligibleActivityWeight` incremented | solution-delivery activity accounting works |
| A6 | evaluator `eligibleActivityWeight` incremented | verdict-delivery activity accounting works |

## Why not the substrate multi-op workspace

`setupTier2Scenario` spawns production daemon binaries against substrate gold
operators on a Base Sepolia fork. Those daemons are pinned to the
already-deployed Base Sepolia contracts and **cannot be redirected at a
freshly-deployed V3 router**. Driving the real loop end-to-end therefore uses
the in-process daemon-harness daemons, which can be pointed at the fresh V3
stack. The two-operator shape preserves the producer/evaluator contract.

## Failure modes

| Failure | Class | Triage |
|---|---|---|
| `anvil`/`forge` not on PATH, or fork RPC unreachable | flake-infra | install Foundry; check `BASE_RPC_URL` |
| op-a never claims/delivers within budget | real-bug or flake-timing | inspect evidence log; flake on first, real-bug on retry |
| Delivery/verdict tx revert | real-bug | BLOCKING — JinnRouter V3 regression |
| op-b never settles a verdict | real-bug | BLOCKING — evaluator loop or `claimEvaluation` operator check regression |
| `verdictCode` not 1 | real-bug | BLOCKING — `PredictionV1Evaluator` scoring regression |
| Activity counter not incremented | real-bug | BLOCKING — `TaskActivityCheckerV3` accounting regression |

## Dependencies

- Foundry (`anvil`, `forge`) on PATH.
- An Anvil-forkable Base RPC (`BASE_RPC_URL`, defaults to the public
  `https://mainnet.base.org`).
- Compiled `contracts/` artifacts — `compileContracts` builds them at runtime.
- The shared daemon-harness helpers at `operator/test/e2e/_daemon-harness-helpers.ts`
  (`setupAnvilFixture`, `bootstrapStakedOperator`, `deployMinimalV3Stack`,
  `deployOperatorMech`, `startDaemon`, `postPredictionV1Task`,
  `waitForDaemonClaim`, `waitForDelivery`, `waitForVerdict`, `readActivityCount`,
  `startMockIpfsServer`, `startMockPolymarketGammaServer`).

## What this scenario does NOT catch

- Real LLM-harness behaviour (Tier 3 covers that).
- Real RPC behaviour under load (this uses an Anvil fork; Tier 3 uses real testnet).
- The SWE-rebench Docker evaluator path (prediction.v1 is used for determinism).
- Cross-chain verdict flows.
