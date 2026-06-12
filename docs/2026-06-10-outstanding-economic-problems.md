# Outstanding economic problems

- **Version:** 0.1 (working draft)
- **Date:** 2026-06-10
- **Author:** Oak (drafted with assistant), for the economic-design session with Ritsu
- **Status:** Problem statements, not decisions. Two economic-design problems that sit *outside* the four testnet conditions and have to be resolved at the level of genesis mechanism. Each is isolable.
- **Related:** [`docs/2026-06-09-simplified-launch-logic.md`](2026-06-09-simplified-launch-logic.md); [`spec/2026-06-10-genesis-condition.md`](../spec/2026-06-10-genesis-condition.md) (the four testnet conditions); `SPEC.md` §Tokenomics; `PRINCIPLES.md` (Neutral, Governance Minimal, Permissionless, Prestige, Legible).

---

## Framing — why these are separate from the testnet conditions

The genesis-condition proposal has four rows — blockchain, inference, security, productivity — and they are deliberately simple, mechanistic, and **testnet-observable**. They prove one thing: *the machine works.* The client runs, the loop closes, the chain holds, a stranger can set up unaided, real verified work flows.

Testnet cannot prove the *equilibrium holds*, because the equilibrium only exists once the token is worth attacking. The adversary — the sybil, the mercenary, the capital trying to capture direction — is not present on a valueless testnet. So the properties that depend on adversarial economic behaviour are not testnet conditions you pass. They are **economic-design problems you solve in genesis mechanism**, and the two below are the load-bearing ones.

A principle that cuts across both: **mechanism over magic number.** Every founder-chosen threshold is a small legitimacy tax ("why that number?") and is gameable to whatever we happened to hit. Where a number can be replaced by a structural property — fault tolerance, a permissionless path, bonding on the critical path, cost-to-capture — replace it. Where a number is genuinely irreducible, make it a mechanism parameter (e.g. a voting-power cap) with the consequences derived from it, not a target we assert.

---

## Problem 1 — Non-capture

**Concentration, founder capture, and economic security are one problem wearing three hats:** how do we stop any single party — including the two of us — from capturing disproportionate power after genesis, *without* an identity system we do not have and should not build?

### Why it is one problem, and why testnet cannot settle it

All three are equilibrium properties. Concentration of power, self-dealing by founders, and the cost to attack consensus only become real once JINN has value. None of them can be observed on testnet. They have to be designed into the mechanism at genesis and then monitored — not gated on a testnet number.

### Disaggregate "concentration" first

There are three concentrations, and conflating them is the common error:

1. **Earned work-rewards** — one operator does most of the oracle-verified work and earns most of the JINN. This is *legitimate*. It is Prestige — earned deference. Capping it is perverse; you would be penalising your best operator, which is anti-neutral and anti-permissionless.
2. **Consensus power** — who holds enough validator stake to halt or rewrite. The real security concern; handled by the protocol-level voting-power cap in the blockchain row.
3. **Emissions direction** — who steers where future JINN flows via veJINN gauge votes. The genuine capture surface, and the one a naive "no operator earns more than X%" rule does not touch.

A reward-share cap targets (1), the legitimate kind, and is in any case sybil-defeated (split into N identities at just-under-the-cap each) and reliant on the founders personally knowing who is who — a trust-me gate, the opposite of Legible, that dies the moment we are not in the room. Drop it.

### The crux is sybils

Any per-identity rule is defeated by splitting into more identities. Per-address caps and per-address convex costs are dead on arrival in a pseudonymous network. Whatever we build has to bite on something **un-splittable**. There are only two such resources available: **verified work** (gated by the oracle's throughput) and **locked time** (a long veJINN lock is a real, un-fakeable cost). Everything below leans on those two.

### Resolution direction

**Move 1 — reward work, not capital. The big one, and nearly free.**
If emissions are strictly proportional to oracle-verified work, sybils gain nothing: to earn 5× you must do 5× the real work whether you are one identity or five, because the oracle is the bottleneck, not your identity count. Concentration here is the legitimate kind. The largest attack surface vanishes the moment emissions track work rather than holdings. Wherever capital must be rewarded (you need some, to pay for security), keep it minimal — that is the only surface the other moves have to defend.

**Move 2 — premine-free genesis plus renounced admin keys. Collapses founder capture into the general problem.**
We cannot credibly *promise* restraint — promising is the weak move. The strong move is to leave ourselves no privileged path to restrain. With no premine and no admin/upgrade keys, founders are just operators with a head-start in *knowledge*, not in *allocation* or *control*. The knowledge head-start is real but Prestige-legitimate and self-correcting. "We are founders and will act accordingly" then becomes fine — not because we promised, but because the mechanism gives us no special way to act. Renouncing keys at genesis is the cheapest-if-genuine, most expensive-to-fake signal available, because it is irreversible.

**Move 3 — on the residual capital surfaces, make power cost locked time, not just money.**
- *Validator power:* the voting-power cap plus convex cost in *locked* capital, so dominance means illiquidity — skin in the game.
- *Emissions direction (veJINN):* votes for a SolverNet you operate are void (kills the most direct self-dealing); direction power requires long locks (a long-locked founder is an aligned founder; the lock is the cost).

**Move 4 — monitor in public, because we cannot pre-prove the equilibrium.**
Ship the mechanism *and* an on-chain monitor: validator concentration, gauge concentration, the work-vs-capital emissions split. It does not enforce — it makes capture common knowledge fast, which is both a reputational deterrent and the abort trigger.

### Open residual — name it as the frontier

The one thing none of this fully solves: **emissions direction captured via sybil identities voting.** Work-gating blunts it (steering still only mints on real verified work, so the worst case is "your own net is subsidised to do real work," not free money), and lock-cost raises the price — but without an identity system it cannot be *eliminated*. This is the open problem worth the most thought, not a solved one.

---

## Problem 2 — Genesis bootstrap circularity

At sovereign-mainnet genesis the emissions machinery is circular and has no entry point:

```
earn JINN
  ← a SolverNet receiving emissions
    ← veJINN directing emissions to that SolverNet
      ← veJINN locked
        ← JINN earned   ← (back to the top)
```

Per `SPEC.md`, emissions are directed by veJINN gauge votes and veJINN is locked JINN. At genesis there is no JINN, so no veJINN, so nothing directs emissions, so no SolverNet receives them, so no JINN can be earned. Left unbroken, the network is dead at birth.

### Where it bites — and where it does not

- **Bites only at sovereign-mainnet genesis** — a fresh chain with no prior JINN.
- **Does not bite on testnet.** Phase 1a is already earning on Base Sepolia; testnet is past this point. Circularity is a *genesis-mechanism* problem, not a testnet-condition problem.

### Standard resolution direction (Curve/OLAS-style gauge bootstrap)

- Genesis hard-wires **one designated bootstrap SolverNet** with a **fixed genesis gauge weight**, so the first emissions flow without pre-existing veJINN.
- The **first earning round is bondless / veJINN-less.** Operators earn the initial JINN by doing verified work on the bootstrap net.
- **Bonding and veJINN-direction gate everything after** the bootstrap round. Once JINN exists and can be locked, gauge voting takes over from the genesis default.

### Magic numbers this introduces (the session owns these)

- The **bootstrap gauge weight** (how much emission the seeded net receives).
- The **size and duration of the bondless bootstrap window**.
- **Which SolverNet** is the designated bootstrap net.
- The **handoff schedule** — how and how fast direction passes from the genesis default to veJINN voting.

### Legitimacy tension — resolve jointly with Problem 1

The bootstrap allocation is, by construction, a **privileged founder-chosen starting point**: whoever the genesis gauge points at, and whoever earns in the bondless window, gets the network's first emissions with no prior stake. That is exactly the genesis advantage the non-capture work has to neutralise. So the bootstrap-net choice and the handoff speed are **legitimacy-sensitive, not merely mechanical** — a slow handoff or a self-serving bootstrap-net choice is a capture surface. Resolve against Problem 1's moves (reward work not capital, no premine, no privileged path), not in isolation.

### Footprint on the testnet conditions (keep the two in sync)

The only touch-point on the genesis-condition doc: the **security condition must read "earning beyond the genesis bootstrap round is reachable only through bonding/locking"** — it must not assume veJINN pre-exists, or it contradicts the bootstrap. That phrasing is already carried in the proposal; if the bootstrap design changes, re-check that line.

---

## Problem 3 — Consensus security budget

**Who secures the chain, and how does the cost of attacking it stay above the value it settles?** The sovereign chain is secured by JINN validator stake but settles real USDC task flows. Nothing in the design ties the cost of attacking consensus to the value at risk on it.

### Why it is a problem, and why testnet cannot settle it

A settlement layer is only safe while acquiring enough stake to halt or rewrite it costs more than an attacker could steal or extort by doing so. On a valueless testnet there is nothing to steal and no acquisition cost, so the question cannot be observed — it is an equilibrium property, like Problems 1 and 2, and only becomes real once USDC flows and JINN has a market price.

The parent doc names the invariant — "security tracks adoption; the economy can't safely outrun the work flowing through it" — but naming it is not enforcing it. No mechanism holds cost-of-attack above value-at-risk as task volume grows. If settled value grows faster than JINN's market cap, attacking settlement turns profitable, and nothing in the current design notices or resists that.

### Two structural tensions it creates

1. **A third claim on the budget.** If validators are funded from the same emission budget `B` as solvers and evaluators, that is three mouths on one pie. Over-feeding validators starves the work the chain exists to coordinate; under-feeding them drops cost-of-attack below value-at-risk. The split is itself an economic-design decision with no obvious answer.

2. **Consensus security is necessarily a capital-reward stream — the one Problem 1 cannot disperse.** Validator yield is proportional to stake: rich-get-richer by construction, and unavoidable in proof-of-stake. Problem 1's "reward work, not capital" disperses the *work* rewards but cannot touch this, because a chain pays validators for locked stake, not for verified work. So the most concentration-prone emission stream is the one securing the chain, and the non-capture design has to bound exactly the stream it cannot redesign (the voting-power cap is part of this — but see Problem 1's note that per-validator caps are sybil-porous).

### Open — but one promising lead

Unlike Problems 1 and 2, this has no settled direction. The candidate questions for the session: is validator reward a slice of `B`, a separate inflation stream, or funded from the **non-recoverable USDC fee**? The last is the most promising lead — it ties security income directly to settled volume, so the cost the network can afford for security scales with exactly the thing it must stay ahead of, enforcing the growth invariant by construction. It is unexplored, and it only exists because the demand-gated design introduces that fee.

---

## How they interact

All three are genesis-mechanism problems, and they are coupled.

- **Problem 1 ↔ 2.** The bootstrap is the first and most concentrated capture surface the non-capture design has to cover: it hands the network's first emissions to a founder-chosen task source and a bondless cohort. Same defence — emissions track verified work even in the bootstrap window, no premine, no privileged path, public monitoring from block one.
- **Problem 1 ↔ 3.** Validator yield is the one capital-reward stream Problem 1 cannot disperse. So the chain's security budget is structurally the most concentration-prone emission stream, and the non-capture work has to bound exactly the stream it cannot redesign.
- **Problem 3 ↔ the demand-gated design.** Problem 3's most promising lead — fund validators from the non-recoverable USDC fee — only exists because the [demand-gated design](2026-06-11-demand-gated-emissions-design.md) introduces that fee. Security income would then scale with settled volume.

Size all three in the same session: the budget `B` is claimed by solvers, evaluators, *and* validators at once, so it cannot be split without resolving all three together.

> Note: this doc predates [`2026-06-11-demand-gated-emissions-design.md`](2026-06-11-demand-gated-emissions-design.md). Where Problems 1–2 above refer to veJINN *directing* emissions by gauge vote, that role is superseded — veJINN now amplifies funded demand, it no longer steers. The capture surfaces named here carry over; the mechanism that creates them has changed.
