---
id: DR-2026-06-04
title: OLAS staking is non-load-bearing Phase-0 substrate — JINN earning is already decoupled from it; demote staking failures to silent background and deprecate the machinery rather than tune it
date: 2026-06-04
verb: Steer
status: proposed
authors: opus (spike #925, claude/heuristic-elgamal-e0ad9d); steer by Ritsu
relates-to: issue [#925](https://github.com/Jinn-Network/mono/issues/925) (this spike) · [#915](https://github.com/Jinn-Network/mono/issues/915) (replaced by this spike) · [#917](https://github.com/Jinn-Network/mono/issues/917) / PR [#940](https://github.com/Jinn-Network/mono/pull/940) · [#916](https://github.com/Jinn-Network/mono/issues/916) / PR [#937](https://github.com/Jinn-Network/mono/pull/937) · [#789](https://github.com/Jinn-Network/mono/issues/789) / PR [#803](https://github.com/Jinn-Network/mono/pull/803) (reStake already non-fatal) · [#580](https://github.com/Jinn-Network/mono/issues/580) (OPEN — intermittent reStake reverts) · [#505](https://github.com/Jinn-Network/mono/issues/505) / PR [#511](https://github.com/Jinn-Network/mono/pull/511) (checkpoint loop) · [#773](https://github.com/Jinn-Network/mono/issues/773) / PR [#800](https://github.com/Jinn-Network/mono/pull/800), [#992](https://github.com/Jinn-Network/mono/issues/992) / PR [#1005](https://github.com/Jinn-Network/mono/pull/1005) (staking already removed from operator surfaces) · [#605](https://github.com/Jinn-Network/mono/issues/605) (M1 tracker) · discussion [#685](https://github.com/Jinn-Network/mono/discussions/685) (testnet cadence — superseded by this posture) · `docs/planning/2026-04-olas-staking-reward-semantics.md` (Architecture B — the decoupling that already happened)
---

## Context

M1 (#605) keeps tripping over OLAS-side staking edges — evictions, reStake timing, `NotEnoughTimeStaked`. #915 ("pause the eviction loop when no tasks are created") was closed because the eviction loop "is OLAS-controlled, not something we can gate on our task-creation," and was **replaced by this spike** to take the eviction/checkpoint/re-stake posture holistically. #917 and #916 are symptoms of the same fact.

This spike investigated the machinery end-to-end and reached a sharper conclusion than "tune the parameters." **OLAS staking is non-load-bearing Phase-0 substrate. Jinn's value — the Creation → Execution → Evaluation → Knowledge loop, and the JINN an operator earns — does not depend on it.** Everything works fine despite the eviction churn precisely because the churn touches a rail nobody is paid on.

**The load-bearing evidence — JINN earning is already decoupled from staking-state.** There are two *independent* reward rails, and conflating them is the trap #925 exists to remove:

| Rail | Claims against | Keyed on | Operator-facing? | Eviction affects it? |
|---|---|---|---|---|
| **JINN claim** — `client/src/daemon/jinn-claim-loop.ts` → `TaskClaimEmitter.emitClaim` → `JinnDistributor.claim` (mints JINN on L1) | `JinnDistributor.claim(proof)` | activity counters (`taskCreationWeight` / `solutionDeliveryWeight` / `verdictDeliveryWeight`) — **no staking gate** | **Yes** — this is "TESTNET JINN EARNED" | **No** |
| **stOLAS reward claim** — `client/src/daemon/reward-claim-loop.ts` → `client/src/earning/stolas-claim.ts` | stOLAS distributor `claim([proxy],[id])` | `calculateStakingReward(serviceId)` — OLAS liveness / checkpoint / eviction | **No** — OLAS substrate yield, never shown to operators | Yes |

- `contracts/src/jinn/cross-chain/TaskClaimEmitter.sol:57-88` — `emitClaim` reads the three activity weights keyed on the service's `multisig` and requires only `multisig != address(0)`. **No staking-state, eviction, or liveness check.**
- `contracts/src/jinn/distribution/JinnDistributor.sol:237-317` — `claim(proof)` mints the delta vs. a per-service monotonic accumulator, **unconditional on the weighted snapshot** (only short-circuit is `owed == 0`). JINN is freshly minted, not accrued by any staking contract.
- `contracts/src/staking/TaskActivityCheckerV3.sol:109-137` — the three counters are **append-only** (`+=`, no reset/decrement), written exclusively by `JinnRouterV3` on verified work. The OLAS staking checkpoint only *reads* them (`getMultisigNonces` / `isRatioPass`); eviction has no write path into the JINN-relevant counters. **An evicted service keeps its full JINN entitlement.**
- The codebase already states this in-line — `client/src/earning/bootstrap.ts:1397-1416`: *"Re-staking is orthogonal to the protocol loop and to JINN earning (JinnDistributor mints on delivered-work counts, not OLAS stake state)… when staking is intentionally dropped (`evictionCheckIntervalMs=0`) the service simply stays evicted, which does not affect earning (#789)."*
- This was a deliberate design lock: `docs/planning/2026-04-olas-staking-reward-semantics.md` ("Architecture B", 2026-04-28) killed the original v1 design (read OLAS `reward` → mint JINN proportionally) in favour of mint-on-verified-work-counters with "**no eligibility check**." OLAS staking became pure substrate scaffolding that JINN issuance has already been lifted off of.

**So the symptom issues are the daemon mistaking substrate noise for signal.** The team has been correcting this for months from the UI side — staking was removed from the operator dashboard (#773/PR #800) and from the `/v1/status` hot path (#992/PR #1005). The daemon's failure-handling is already non-blocking: bootstrap reStake is non-fatal (#789/PR #803), `handleReStakeReceipt` reads the receipt status (#916/PR #937), and the eviction loop throttles + swallows reStake reverts (#917/PR #940). What remains is **log severity and posture**, not correctness: routine eviction/checkpoint/reStake events are logged at `console.error` — `client/src/earning/bootstrap.ts:2640` logs reStake **success** at error level — and the daemon still runs three staking-only loops by default.

There is no prior DR stating an OLAS staking posture; this spike is greenfield on posture. Discussion #685 proposed tuning the testnet cadence (Option B) to make M1's checkpoints survivable — but that invests effort in a rail we are choosing to stop depending on, and is superseded by this posture (see Alternatives).

## Decision (proposed)

**1. Reclassify OLAS staking as non-load-bearing Phase-0 substrate.** It is not protocol signal. JINN earning, the protocol loop, and operator success do not depend on a service being staked, passing checkpoints, or avoiding eviction. The only thing staking-state gates is the unseen sTOLAS substrate yield. Treat staking the way we treat any best-effort background housekeeping: it may fail, and its failure is a non-event.

**2. Demote every staking failure to silent background (cheap, daemon-only, near-term).** The handling is already non-blocking; this is a log-severity and surfacing change at the known sites:
- Eviction is **not an error** — it is an expected substrate event. Demote `client/src/daemon/eviction-loop.ts` eviction/throttle/tick logs from `console.error` to debug/info.
- Re-staking **just happens in the background**, quietly. Demote the reStake confirm/call/revert logs (`client/src/earning/bootstrap.ts:2640-2684`, incl. the success-logged-as-error line at 2640) and the `checkpoint-loop.ts` / `stolas-claim.ts` / `reward-claim-loop.ts` failure logs to debug/info. The contained `handleReStakeReceipt` throw (`bootstrap.ts:2647`) stays caught by the EvictionLoop; it never escapes to block anything.
- No new operator-facing surface for any of this (consistent with #773/#992).
- This resolves the open **#580** ("intermittent reStake reverts") as **understood-and-expected**, not a bug to chase — the reverts are the `NotEnoughTimeStaked` window plus stale-RPC-read races, on a rail that does not affect earning.

**3. Turn the staking loops OFF by default on testnet via the existing kill-switch — the smallest, reversible deprecation step.** Set `evictionCheckIntervalMs=0`, `checkpointIntervalMs=0`, and `rewardClaimIntervalMs=0` in the testnet defaults. The service stays evicted; earning is unaffected (`bootstrap.ts:1397-1416` already documents exactly this). This stops the churn at the source rather than just quieting its logs, and is trivially reversible by restoring the intervals.

**4. Chart full deprecation — delete the staking-only machinery — as the direction (a `refactor` follow-up, not this spike).** The removable, staking-ONLY surface (serves no protocol-loop function):
- bootstrap steps `service_staked` / `staked` and `stepStolasStake` (`client/src/earning/bootstrap.ts`, `earning/types.ts:42-43`);
- the `EvictionLoop`, `CheckpointLoop`, `RewardClaimLoop` and `recoverEvictedService` / `handleReStakeReceipt` / `stolas-claim` / `jinn-rewards`;
- `STAKING_ABI` / `STOLAS_DISTRIBUTOR_ABI`, `staking_address`, `stakingMode`;
- the OLAS-facing read functions on `TaskActivityCheckerV3` (`getMultisigNonces`, `isRatioPass`, `eligibleActivityWeight`, `livenessRatio`).

Must be **preserved** (dual-purpose — serve the core loop, not staking): `JinnRouterV3` (drives the loop + records counters), the `TaskActivityCheckerV3` counter-keeping (`recordX` + the three weights — this *is* the JINN signal), and the OLAS **service registration** steps (wallet/Safe/service_created/service_deployed/mech_deployed give the agent its on-chain identity; only the *staking* on top is removed). Deprecating staking ≠ deprecating service registration.

**5. Scope this posture to testnet + the daemon. Treat mainnet OLAS-emissions as a separate, deliberate value decision.** The mainnet Jinn program (`0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54`) is a Governance-approved OLAS-emissions nominee, so staying staked there harvests real OLAS yield (substrate, still not JINN). Walking away from that is a money decision, not a daemon-hygiene one. This DR does not decide it; it only requires that even on mainnet, staking is best-effort-silent and never blocks the loop. (Open question 4.)

## Why this shape

- **It matches reality.** "Everything works fine" is not luck — earning rides a rail eviction cannot touch (the JINN claim path, gated on append-only work counters). The honest posture is to stop spending attention on a substrate the protocol was deliberately lifted off of in April.
- **It's mostly subtraction.** The expensive-looking version (redeploy a new staking proxy with survivable params + migrate live services, per #685) invests in tuning something we're deprecating. The cheap version — demote logs, flip a kill-switch, then delete — is strictly less code and less on-chain ceremony, and removes a whole class of recurring incidents (#915/#916/#917/#789/#580).
- **It finishes a direction already in motion.** Staking was already pulled from the dashboard (#773) and the status hot path (#992); the reward architecture already decoupled JINN from OLAS rewards (Architecture B). This DR names the endpoint those moves were heading toward and extends it from the UI into the daemon.
- **It de-risks M1.** If earning doesn't depend on checkpoint-passing, then M1's "consecutive checkpoints" proxy was measuring the wrong thing. M1's real substance — two operators sustaining **paired settlement** (verified deliveries + verdicts on the JINN rail) for 48 wall-clock hours — is unaffected by eviction. (Open question 3.)

## Open questions to ratify

1. **Kill-switch vs. keep-quiet for the first step.** Decision §3 proposes turning the loops off on testnet (`*IntervalMs=0`) *and* demoting logs (§2). Confirm we go straight to off-by-default, vs. only demoting logs first and leaving the loops running. (Recommendation: off-by-default — it removes the churn, not just the noise.)
2. **Does any test / e2e / earning flow assume a staked service?** Before flipping defaults, confirm nothing depends on staked state — e.g. `yarn staking`, `yarn e2e:daemon-harness`, the bootstrap state machine's terminal step, or any reward-claim assertion. (This is the one concrete pre-flight for §3.)
3. **Reframe M1 (#605) off "checkpoint count."** If staking is deprecated, M1 should measure paired settlement on the JINN rail, not checkpoint-passing. Ratify the reframe (and supersede discussion #685's Option-B proposal accordingly).
4. **Mainnet OLAS-emissions: keep harvesting silently, or walk away entirely?** Separate money decision (§5). Default until decided: keep it, but best-effort-silent.
5. **Full deletion now or after a soak?** §4 (delete the staking-only code) is a `refactor`. Decide whether to file it now or let the off-by-default + demoted-logs posture soak first and delete once we've confirmed in the wild that nothing misses staking.

## Alternatives considered (rejected)

- **Tune the testnet staking parameters to make checkpoints survivable (discussion #685, Option B — new proxy + service migration).** Rejected: invests engineering and on-chain migration effort in a rail we are choosing to stop depending on. Correct *if* M1 must pass checkpoints; this DR removes that premise.
- **Keep the loops on and just make eviction quieter.** Partial — fixes the noise but not the churn (wasted gas, RPC load, the recurring revert class). Off-by-default (§3) is barely more work and removes the source. Retained as the fallback if open question 2 surfaces a dependency on staked state.
- **Pause the eviction loop on task supply (#915's original framing).** Rejected (again): eviction is checkpoint-cadence-driven, not task-driven; gating our loop doesn't stop the contract evicting us. Moot once the loop is off.
- **Write more daemon code to "handle" the reverts.** Rejected: the residual reverts are benign and contained today; the right move is less code (deprecate), not more.
- **Delete the staking machinery in one big-bang change now.** Rejected as the *first* step: the handbook mandates stacked PRs + design-upfront for `refactor`, and a soak on off-by-default (§3) cheaply de-risks the deletion. The deletion is the direction (§4), sequenced after the kill-switch.

## Status / next steps

`proposed` — spike finding awaiting maintainer ratification (`needs-decision`). On ratification:

1. **Daemon hygiene PR (`fix`/`chore`, small):** demote the staking-failure log severity at the §2 sites; confirm eviction reads as a non-event.
2. **Testnet default flip (`chore`, gated on open question 2):** set `evictionCheckIntervalMs` / `checkpointIntervalMs` / `rewardClaimIntervalMs` to `0` in the testnet config defaults; verify earning is unaffected on a daemon-harness run.
3. **Close #580** as resolved-by-this-DR (benign, expected, on a non-earning rail).
4. **File the `refactor` deprecation issue (§4)** to delete the staking-only surface, design-upfront, after the soak; keep the dual-purpose pieces.
5. **Reframe M1 (#605)** off checkpoint-count onto paired-settlement, and supersede discussion #685.

No code ships from this spike; the deliverable is this finding.
