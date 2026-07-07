# Genesis bootstrap circularity — brief for the economic-design fork

- **Version:** 0.1
- **Date:** 2026-06-10
- **Author:** Oak (drafted with assistant)
- **Status:** Input for the economic-design session. Not a decision — a problem statement plus the standard resolution direction and the magic numbers it introduces.
- **Related:** [`docs/2026-06-09-simplified-launch-logic.md`](2026-06-09-simplified-launch-logic.md) (§6 sovereign chain, §13 token accounting); `SPEC.md` §Tokenomics (JINN's jobs 1–4); the genesis-condition proposal (`spec/2026-06-10-genesis-condition.md`).

## The cycle

At sovereign-mainnet genesis the emissions machinery is circular and has no entry point:

```
earn JINN
  ← a SolverNet receiving emissions
    ← veJINN directing emissions to that SolverNet
      ← veJINN locked
        ← JINN earned   ← (back to the top)
```

Per `SPEC.md`: emissions are directed by veJINN gauge votes (job 1), and veJINN is locked JINN. At genesis there is no JINN, so there is no veJINN, so nothing directs emissions, so no SolverNet receives them, so no JINN can be earned. The loop never starts. Left unbroken, the network is dead at birth.

## Where it bites — and where it doesn't

- **Bites only at sovereign-mainnet genesis** — a fresh chain with no prior JINN.
- **Does not bite on testnet.** Phase 1a is already earning on Base Sepolia; testnet is past this point. So circularity is a *genesis-mechanism* problem, not a testnet-condition problem.

## Standard resolution direction (for the fork to decide and size)

Break the cycle with a genesis-seeded entry point. The well-trodden pattern (Curve/OLAS-style gauge bootstrap):

- Genesis hard-wires **one designated bootstrap SolverNet** with a **fixed genesis gauge weight**, so the first emissions flow *without* pre-existing veJINN.
- The **first earning round is bondless / veJINN-less.** Operators earn the initial JINN by doing verified work on the bootstrap net.
- **Bonding and veJINN-direction gate everything after** the bootstrap round. Once JINN exists and can be locked, gauge voting takes over from the genesis default.

## Magic numbers this introduces (the fork owns these)

- The **bootstrap gauge weight** (how much emission the seeded net receives).
- The **size and duration of the bondless bootstrap window** (how long earning runs before bonding gates it).
- **Which SolverNet** is the designated bootstrap net.
- The **handoff schedule** — how and how fast direction passes from the genesis default to veJINN voting.

## Legitimacy tension (ties into the non-capture problem)

The bootstrap allocation is, by construction, a **privileged founder-chosen starting point**: whoever the genesis gauge points at, and whoever earns in the bondless window, gets the network's first emissions with no prior stake. That is exactly the kind of genesis advantage the non-capture work has to neutralise. So the bootstrap-net choice and the handoff speed are **legitimacy-sensitive, not merely mechanical** — a slow handoff or a self-serving bootstrap-net choice is a capture surface. Resolve this jointly with the non-capture design (reward work not capital, no premine, no privileged path), not in isolation.

## Footprint on the testnet conditions (keep the two in sync)

The only place this touches the genesis-condition doc: the **security condition must read "earning beyond the genesis bootstrap round is reachable only through bonding/locking"** — it must not assume veJINN pre-exists, or it contradicts the bootstrap. That phrasing is already carried in the proposal; if the fork changes the bootstrap design, re-check that line.
