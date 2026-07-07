# Demand-gated emissions with veJINN amplification

- **Version:** 0.1 (working draft)
- **Date:** 2026-06-11
- **Author:** Oak (drafted with assistant), for the economic-design session with Ritsu
- **Status:** Design proposal, not a decision. The resolution that came out of working through the selection problem in [`docs/2026-06-10-outstanding-economic-problems.md`](2026-06-10-outstanding-economic-problems.md). Replaces gauge-vote-directed emissions. Not canon — `SPEC.md` §Tokenomics currently specifies the design this supersedes; changing it is a CODEOWNERS-reviewed canonical edit.
- **Related:** [`docs/2026-06-10-outstanding-economic-problems.md`](2026-06-10-outstanding-economic-problems.md) (the two problems this addresses); [`docs/2026-06-09-simplified-launch-logic.md`](2026-06-09-simplified-launch-logic.md) (§3 value accrual, §4 the oracle floor); `SPEC.md` §Tokenomics; `PRINCIPLES.md` (Governance Minimal, Permissionless, Prestige, Legible).

---

## 1. What this replaces, and why

The original design directs emissions by **veJINN gauge vote** — locked-token holders vote on which SolverNets receive freshly-minted JINN. That mechanism selects for **vote accumulation, not net quality**: the Curve/Convex result, observed not theoretical. A party running a low-value-but-oracle-passing net can buy votes or split identities, point emissions at its own net, pocket the mint, and socialise the dilution across all holders. The supposed safeguards (self-vote-void, work-gating) don't close it — self-vote-void is sybil-porous and bribery routes around it; work-gating still mints real JINN against junk work.

The deeper diagnosis: **the network had no mechanism that reliably starves bad nets and feeds good ones.** Oracle quality is a per-net design choice and the protocol should not try to police it. What the protocol must supply is *selection* — and the only honest selector is **real demand**: someone putting outside money behind work they actually want done.

This design makes demand the gate and reduces veJINN from steering wheel to amplifier.

## 2. The mechanism

1. **A creator funds a task in stablecoin (USDC).** This is the demand signal — real outside money that leaves the creator's hands.
2. **A fixed slice of that USDC is non-recoverable** — burned, or routed to evaluators and validators. The creator never gets it back regardless of who solves the task. (This slice is the anti-wash floor; §6.)
3. **The creator acquires and locks veJINN, pointing it at their own task or task-type.** Locking it amplifies the JINN the protocol emits to the **solvers and evaluators** who participate in those tasks.
4. **Emissions are drawn from a capped per-epoch budget `B`.** Tasks compete for shares of `B`; pointing veJINN pulls a larger slice of a fixed pie, it does not print new tokens on demand.
5. A solver who completes the task collects the USDC due plus that task's share of `B` in JINN; an assigned evaluator collects their share likewise.

**Worked example.** Creator funds task T with 100 USDC: 80 to the solver, 20 non-recoverable. The protocol emits a fixed budget `B` this epoch. The creator locks veJINN and points it at T. T's share of `B` rises with both the non-recoverable USDC behind it and the veJINN pointed at it. The solver collects 80 USDC + T's JINN share; the assigned evaluator collects a share of the same.

## 3. The allocation rule

> A task's share of the epoch budget `B` = (its non-recoverable USDC) **×** (veJINN pointed at it).

Two properties carry the safety, and both are load-bearing:

- **It is a product, not a sum.** veJINN pointed at a task with no funded demand multiplies zero. You cannot conjure emissions onto a net nobody pays for. Real USDC is the gate; veJINN only weights *among* tasks that have already cleared it.
- **`B` is capped.** Pointing veJINN redistributes a fixed budget, it does not mint on demand. Locking is competitive, not inflationary-on-command. (Removing the cap is the single change that reopens the original hole — "lock to print" — so the cap is not optional.)

## 4. Why veJINN now has a rational function

The earlier justifications for locking — "sink" and "skin in the game" — are dead on their own. Nobody illiquifies capital for a vague claim that it supports the token. Locking has to pay, or it doesn't happen.

Here it pays, and the payer is the **creator**: locking veJINN makes their USDC command more solver and evaluator firepower than it would alone, because the emission tops up what they fund. A creator who holds and locks JINN gets more work done per dollar than one who doesn't — and far more than running the task in-house. So JINN becomes a **productivity tool for creators**, and demand to acquire it is *utility* demand, not speculation.

This sharpens the one genuinely open unknown the launch doc names ("is there bonding demand beyond us?") into something concrete and testable: **will creators pay to acquire and lock JINN to get their work prioritised?** That single question is what the token's value rests on.

## 5. Why this is the selection mechanism

Emissions flow only where real creators commit real USDC. A net with a gameable oracle but no paying creators multiplies to zero and starves — **regardless of oracle quality.** This is the point that dissolves the oracle-gameability worry: the oracle does not have to be ungameable, because demand does the selecting. A weak net dies because nobody funds it, not because we policed its verifier.

It is also more aligned with **Governance Minimal** than the design it replaces: a vote is governance surface; demand-coupling is mechanism. We are pushing the decision to mechanism, where the principles say it belongs.

## 6. Safety: the wash-trade knob

The adversary is a creator who is also the solver and evaluator (sybil), funding their own task to extract the mint. Their unavoidable cost is the **non-recoverable USDC slice** + lock illiquidity + work. Self-dealing only loses money if:

> emission a self-dealer can capture on one task **<** its non-recoverable USDC + its lock cost

That inequality is the **single calibration knob**: size `B` and the multiplier curve so one self-dealt task cannot out-earn its own burned-USDC floor. The non-recoverable slice (step 2) is what makes faking demand cost something; without it, creator-equals-solver is free and the whole design leaks.

## 7. Two hard constraints

These are requirements, not refinements:

1. **Evaluator assignment must sit outside the creator's control.** Boosting evaluator rewards pulls more evaluation firepower to a task — useful against honest low-attention. But if the creator can choose to *be* the evaluator, the boost just pays them to rubber-stamp their own task. Evaluators must be protocol-assigned (random selection, staked-and-slashable), never creator-chosen.
2. **A whale creator can dominate the budget.** Combining a lot of USDC with a lot of locked veJINN pulls most of `B` onto one party's tasks, starving smaller creators of solver attention. It is not free — sustaining the share burns real non-recoverable USDC and illiquifies JINN — so it is capture-by-resources, not a vote-buy. But it is the **surviving form of emissions-direction capture** from Problem 1. The blunt fix is a per-creator share cap on `B`; that is a magic number, so it goes through the mechanism-over-magic-number treatment rather than being picked here.

## 8. What this changes in `SPEC.md`

- **Emissions direction:** from veJINN gauge votes → demand-gated allocation (USDC × veJINN against a capped budget).
- **veJINN role:** keeps the lock as an *amplifier on funded demand*; loses the steering-by-vote role entirely.
- **Mandatory stablecoin leg:** task creation requires a USDC commitment with a non-recoverable slice. (New surface — confirm it composes with the existing creator-funds-restoration loop.)
- **Evaluator assignment:** must be protocol-controlled, not creator-controlled (constraint §7.1).

## 9. Open parameters (size these jointly, don't assert them)

- The epoch budget `B` and its schedule.
- The non-recoverable fraction of the creator's USDC.
- The multiplier curve — how veJINN converts to share-of-`B` (linear in locked-JINN-time is the sybil-neutral default; convexity rewards splitting, so avoid it).
- The per-creator share cap on `B` (constraint §7.2).
- Lock duration / unlock curve for veJINN.

Every one of these is a calibration knob, not a target to declare. The wash-trade inequality in §6 is the constraint that ties `B`, the multiplier curve, and the non-recoverable fraction together.

## 10. How it lands on the two outstanding problems

- **Problem 1 (non-capture).** Demand-gating closes the gauge-capture residual: you can no longer steer emissions to a net nobody funds. What survives is whale-creator budget domination (§7.2) — bounded by real, recurring USDC cost, and capped if we choose. The legitimate concentration (earning the most by doing the most verified work) is untouched, as it should be.
- **Problem 2 (genesis bootstrap).** This does **not** escape the bootstrap. At genesis the only creator funding USDC is us, on the Jinn repo. Demand-coupling makes that **honest and visible** — "we are the only buyer so far" — rather than hiding it behind a vote. Genesis still needs the bootstrap round (one seeded task source, a bondless first window); the difference is that the hand-off target is now "real external creator demand appears," which is a clean, observable graduation signal.

## What this proves, and what stays a bet

It proves the *mechanism* can select: funded work earns, unfunded work starves, locking pays only when it amplifies real demand. What it cannot prove ahead of time is the **demand** itself — whether creators beyond us will pay to acquire and lock JINN to get work done. That is the one bet the whole design rests on, and the only way to test it is to stand the network up and watch creators arrive, or not.
