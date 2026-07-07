# Launching Jinn as an independent blockchain — decision record and reasoning

> **Status (2026-06-30): superseded by DR-2026-06-30 (tokenless, OLAS-native).** Jinn drops the native token and the sovereign chain; OLAS is the economic layer. For the current direction read `spec/2026-06-30-tokenless-olas-native.md` and `log/decisions/2026-06-30-tokenless-olas-native-pivot.md`.

- **Version:** 0.4.3 (discussion draft — major revision)
- **Date:** 2026-06-05
- **Author:** drafted with Opus, for Oak + Ritsu review
- **Status:** Open for discussion. Captures a long Oak↔Ritsu↔assistant working session. Records the conclusions reached and the reasoning behind them. Several items are *decided in principle* (flagged **Decided**); the rest are **Open**. This re-opens two load-bearing decisions of [`spec/2026-05-24-phase-2-chain-architecture.md`](2026-05-24-phase-2-chain-architecture.md) (§2.1 DAO-on-Ethereum, §2.3 settled-rollup-not-sovereign) and extends the ratified tokenomics in [`SPEC.md` §Tokenomics](../SPEC.md) / [Discussion #69](https://github.com/Jinn-Network/mono/discussions/69).
- **Changelog:**
  - **v0.4.3 (2026-06-08)** — reframed §3's bake-to-node story: **two construction modes** (consensus logic native-from-genesis à la dYdX, so nothing migrates; application logic stays EVM contracts, possibly forever) and made explicit that any bake-down is a *scheduled* upgrade (never "on the fly"), the state-move step is novel + earns its own spike, and **the substrate decision does not depend on the migration being easy**.
  - **v0.4.2 (2026-06-08)** — substrate spike **empirically confirmed**: all five port-target contracts deploy and run unchanged on a Cosmos EVM `evmd` v0.7.0 devnet with identical state + gas vs an independent EVM baseline. §2/§9.1 pointers updated from "pending" to "confirmed".
  - **v0.4.1 (2026-06-08)** — substrate spike (§9.1) **done**: resolved the §2 open sub-question in favour of **Cosmos EVM** and linked the finding [`spec/2026-06-08-substrate-spike-cosmos-evm.md`](2026-06-08-substrate-spike-cosmos-evm.md). Deciding factor: BeaconKit/reth is consensus-only (no Cosmos SDK modules), which forecloses the §3 bake-to-node plan.
  - **v0.4 (2026-06-08)** — added an **"In plain English (read this first)"** summary at the top covering both the *outcome* (what we decided) and the *process* (how we got there), in plain language for a non-specialist reader. No reasoning changed; the detailed sections remain the full backing.
  - **v0.3.1 (2026-06-08)** — expanded §4 with the **SolverNets-as-rollups** topology and the *security-multiplier* argument (the decisive axis is security-cost-per-SolverNet, not TPS; the table of three fragmentation topologies; "sovereign IBC appchain per SolverNet" is the trap that multiplies §5 by N). Added the DA≠settlement correction (the base must provide *narrow settlement*, not DA alone), the "Celestia is a Cosmos SDK chain, so the door stays open" point, and the "don't fork Celestia now — it's a swappable scaling tier" recommendation.
  - **v0.3 (2026-06-08)** — rewrote §1 around the actual driver: *legitimacy-rooting* (the "planting in someone else's garden" objection), demoting the settlement-vs-mechanism two-axis split to downstream evidence. Added the garden-vs-commons test ("can you leave silently?") and a "But couldn't we run our own L2?" rebuttal (own-L2 fixes the Base-specific defect and buys cold-start security, but *deepens* the legitimacy-rooting problem — "you cannot buy the thing you are selling"). Updated conclusion #1 to match.
  - **v0.2.1 (2026-06-08)** — added "Operator hardware — the laptop target" to §2 (a moderate laptop should run both the agent node and the chain node, because AI execution runs via API rather than local inference for the foreseeable future).
  - **v0.2 (2026-06-05)** — major revision after the working session. Reverses v0.1's "DAO on Ethereum, migrate later" recommendation (rejected by Oak/Ritsu as too arbitrary and too hard to coordinate). Lands: sovereign Cosmos-SDK family as the substrate, native token+DAO from genesis, the "island" stance, the two-axis neutrality model, the cold-start security model, the inference-refinery framing, and the task-selection SolverNet analysis.
  - **v0.1 (2026-06-05)** — initial survey: two-axis neutrality, candidate matrix, P-vs-M architectures, recommended Ethereum-DAO-then-migrate. Superseded.
- **Related:** [`PRINCIPLES.md`](../PRINCIPLES.md); [`SPEC.md` §Tokenomics](../SPEC.md); [Discussion #69](https://github.com/Jinn-Network/mono/discussions/69); [`spec/2026-05-24-phase-2-chain-architecture.md`](2026-05-24-phase-2-chain-architecture.md); [`spec/2026-05-14-launch-gating-criteria.md`](2026-05-14-launch-gating-criteria.md); the sidecar / telemetry spec ([`spec/2026-05-07-telemetry-collector-and-task-generator.md`](2026-05-07-telemetry-collector-and-task-generator.md)); the solver-learning specs (`spec/2026-05-25-demonstrate-solver-learning.md`, `spec/2026-05-28-harness-as-policy-learning-architecture.md`).

---

## In plain English (read this first)

**The question:** should Jinn launch as its own blockchain — and if so, how? **The short answer: yes, its own independent chain.** Below: what we decided, then how we got there. The rest of the document is the full reasoning behind each point; the numbered conclusions are the outcome, and §1–§8 are the process.

### What we decided (the outcome)

- **Build Jinn's own blockchain.** Not on Ethereum, not as a "layer-2" on top of Ethereum, not on anyone else's network. The reason isn't mainly technical — it's that Jinn's whole goal is to be *the most legitimate* network of its kind, and **you can't be the most legitimate while renting your legitimacy from someone else's ecosystem.** Living on Ethereum makes Jinn "an Ethereum project," capped by Ethereum's brand and beholden to its politics. Even running our *own* Ethereum layer-2 doesn't escape this, because its security story is "Ethereum backs us" — borrowed legitimacy, baked in permanently. *(Decided.)*
- **Build it with the Cosmos SDK toolkit.** It's the most plainly neutral option (depends only on open-source code, not on anyone's ecosystem), it can run our existing Ethereum contracts unchanged, it lets us later move the important rules *down into the chain software itself*, and it's simple for operators — one program to run. *(Decided in principle; one technical sub-choice still open.)*
- **Put the token and the DAO on the Jinn chain from day one.** No token on Ethereum, no risky migration later. This deletes the most complicated part of today's design (a cross-chain bridge for rewards). *(Decided.)*
- **Treat the chain as an "island."** People can move assets onto it, but we won't build or run bridges ourselves, and we won't prop up security with borrowed outside money. Security grows naturally as real, valuable work flows through the network. *(Decided.)*
- **Be honest that a brand-new chain starts out only lightly secured.** At launch it's protected by a known, vetted, capped set of operators trusting each other — *not* by economic cost-to-attack (no new chain has that on day one). We say so openly and **publish the exact milestone** at which we can fairly claim to be "credibly neutral." *(Decided framing; the actual numbers are open.)*
- **Scale by fragmentation, not by one fast chain.** Hundreds of SolverNets won't fit on a single chain. They "roll up" to a lean base chain, so **adding a SolverNet never adds a new security problem.** *(Decided direction.)*
- **The chain is just the stage; the real product is two questions.** (1) Does the network actually get better at its tasks? (2) Are those tasks valuable to real people? Everything about the chain should be built "good enough" to let us answer those two — not gold-plated. *(Decided focus.)*

### How we got here (the process)

This is the write-up of a long working session. We started from the team's gut feeling — *"launching on Ethereum violates our neutrality principle"* — and kept pushing until we understood **why**, then designed outward from there:

1. **Why not Ethereum?** We first blamed the technical stack, then found the real reason: it's about *where legitimacy comes from* — renting it vs owning it. "Our own L2" doesn't fix it (§1).
2. **What do we build on?** Compared Cosmos, an Avalanche subnet, forking Ethereum/Tempo, and Bittensor's Substrate — chose the Cosmos SDK family on neutrality + operator simplicity + the ability to bake rules into the node (§2).
3. **Where do the token and DAO live?** Native to the chain, which deletes the cross-chain reward bridge (§3).
4. **Will it scale to hundreds of SolverNets?** Yes — make SolverNets roll up to a lean base so security is solved once, not N times (§4).
5. **How is a brand-new chain secured on day one?** Honestly: "trust a known operator set," with a published graduation threshold (§5).
6. **Doesn't work-backed money secure it automatically?** No — we corrected that tempting-but-wrong idea (cost-to-*make* ≠ cost-to-*attack*) and showed why the "island" route is still coherent (§6).
7. **Does our existing tokenomics still hold?** Mostly — we listed the specific conflicts the sovereign move creates (§7).
8. **What actually matters most?** The two questions and the "inference refinery" framing — the real moat, and the answer to "are we just rebuilding Bittensor?" (§8).

**Status:** some points are **Decided**, the rest are flagged **Open** and collected in §9. This is a proposal for discussion — it re-opens two earlier decisions and extends our existing tokenomics; it is **not canon yet.**

---

## Most important conclusions

1. **Launch Jinn as its own sovereign chain — not an L2, not a tenant of anyone.** The real driver is *legitimacy-rooting*, not the technical stack (see §1). Jinn's meta-principle is to be *the most legitimate* agentic-AI network; **borrowed legitimacy is structurally capped** ("best tenant" — you can't be *the most* legitimate on legitimacy you rent) **and structurally captured** (a master outside the protocol you must court). "Our own L2" does *not* escape this — it settles to Ethereum, so its security narrative literally *is* borrowed legitimacy, formalised permanently into the protocol; it fixes the Base-specific defect but deepens the root problem. The settlement-vs-mechanism two-axis split (every live L2 keeps a Security Council key; Base is leaving the OP Stack) is downstream *evidence*, not the root. **You cannot buy the thing you are selling**: sovereignty is the only configuration where legitimacy is self-rooted — and security, the one real cost, is engineerable down over time (§5).

2. **Substrate: the sovereign Cosmos-SDK family.** **Decided in principle.** It is "purely, plainly neutral" — a standalone Cosmos chain depends only on open-source code (CometBFT, IBC), not on any other chain's security, governance, or ecosystem. It uniquely satisfies our three hard constraints at once: a real EVM so existing contracts run unchanged (no porting yet), a clean path to "bake protocol logic down into the node" later (modules + stateful precompiles — the dYdX v4 precedent), and single-binary operator simplicity. Avalanche L1 was rejected (you're inside Avalanche's ecosystem); Ethereum/Tempo forks were rejected (no clean bake-to-node, two-client ops). **Open:** Cosmos EVM (one binary, reimplemented EVM, pre-v1) vs a BeaconKit/reth build (real EVM, two components) — settle by spike.

3. **Token and DAO are native to the Jinn chain from genesis.** **Decided.** No token on Ethereum, no migration. This deletes the entire cross-chain claim loop (OP-Stack storage proofs → messenger → distributor) — the biggest single source of complexity in today's architecture — because mint and activity live on the same chain. It also removes the "arbitrary threshold + network-wide migration" coordination problem.

4. **The chain is an "island."** **Decided.** People can bridge to it; we do not build or operate bridges ourselves, and we do not import exogenous collateral to inflate the security budget. Security is allowed to *emerge from real productive throughput* rather than be engineered with stablecoin/yield machinery (the jUSD route was considered and dropped — §6).

5. **Cold-start security is permissioned-BFT, honestly named — not economic.** **Decided framing.** A capped, operator-gated genesis set is "honest super-majority of a known set," a trust assumption, *not* a cost-of-corruption guarantee. Economic security and cold start are mutually exclusive (nobody has economic security at genesis). Security grows through three phases (permissioned BFT → hybrid → economic) and we **publish the threshold** at which the claim graduates (Legible).

6. **The real moat is not the chain — it's two questions.** **Decided focus.** *(a) Does the network get measurably better at its target tasks?* and *(b) are those tasks valuable?* They multiply (refining margin = task value × capability gain), and value disciplines learning (a real value signal is what makes "getting better" ungameable). Everything about chain/security/tokenomics should be sized to **not block** these two, not gold-plated.

7. **Jinn is an inference refinery.** **Decided framing.** Raw, commoditising inference goes in; through task selection, evaluation, and accumulating capability it comes out as refined, verified, valuable work; the network captures the refining margin and JINN is the claim on it. This is the answer to the "are we just rebuilding Bittensor?" worry: the architecture *is* Bittensor-shaped (fine — proven pattern), but the differentiator is delivering *productive, compounding, captured* inference where Bittensor is criticised for emissions-farming with a useful-work veneer.

---

## 1. The neutrality reframe (the conceptual crux)

The instinct is to argue this on the *technical* stack — settlement security, upgrade keys. That argument is real but secondary. The deeper driver — the one that actually forces a sovereign chain — is about **where Jinn's legitimacy is rooted.** The stack-level neutrality axes are downstream evidence of it (§1.4).

### 1.1 The root cause: legitimacy must be self-rooted

Jinn's meta-principle (`PRINCIPLES.md`) is to become *the most legitimate* decentralised agentic-AI network — "even at the edges, everyone believes Jinn is the right network to coordinate around." **Legitimacy borrowed from a host ecosystem is structurally capped and structurally captured**, so a hosted Jinn cannot satisfy its own meta-principle. "Planting in someone else's garden" — being read as "an Ethereum ecosystem project," having to court the host's ecosystem team — is not an aesthetic discomfort; it is a principles violation along four concrete lines:

1. **The meta-principle caps out.** The honest answer to "is Jinn the thing to coordinate around?" becomes "it's the right *Ethereum* agentic-AI thing" — a smaller, dependent, sub-lease claim. You cannot be *the most* legitimate on legitimacy you rent; your ceiling is "best tenant," and the landlord sets the ceiling. Jinn's addressable legitimacy market is *all* agentic-AI coordination — far larger than any one chain's tent — so rooting in Ethereum trades a **universal** claim for a **partisan** one.
2. **Structural benefit to the host** (Neutral, bullet 2: "does not structurally benefit any individual or entity above any other"). Hosted, Jinn structurally benefits exactly one entity above all others — gas/settlement denominated in the host's asset, value/MEV/sequencing accruing to it, the economy promoting someone else's money, the host's brand gravity pulling on ours. The network's success becomes a *structural subsidy to its host*. That is precisely what the bullet forbids.
3. **The costly-signal inverts** (Neutral, bullet 1: "signal qualities cheaply in a way expensive to fake"). Ecosystem membership is rented credibility — cheap to acquire, not a signal of *our* quality, and *expensive to leave* (exit is a narrative defection event). Standing up our own chain and bootstrapping our own legitimacy is the expensive-to-fake signal: we bore the cost ourselves.
4. **A master outside the protocol** (Governance Minimal). "Suck up to the ecosystem team" is a real, recurring governance dependency on parties *outside* the protocol — capture surface no in-protocol mechanism removes. Governance-minimal means few *masters*, not just few admin keys; a tenant has a master.

### 1.2 The garden-vs-commons test

The strongest counter is that Ethereum L1 is a credibly-neutral *commons*, not a garden — building on a public road doesn't make you a road-company supplicant. Three reasons it doesn't rescue the current plan:

- **The current setup is Ethereum + L2, and an L2 has no commons defence at all** — Base is a Coinbase-operated sequencer with a corporate roadmap and brand.
- **Legitimacy and value don't settle at the settlement layer.** The commons defence covers *block inclusion*; "Ethereum ecosystem project" is established at the *social and economic* layers, which are not credibly neutral. You can be a tenant of a neutral *protocol* and a supplicant of its *ecosystem* at the same time, because legitimacy is conferred socially.
- **The discriminator — can you leave silently?** A true commons (TCP/IP) you exit at zero social cost. Leaving Ethereum's ecosystem is a *narrative event* that forfeits accumulated social capital. **Switching-cost-as-social-pressure is the signature of a garden, not a commons.** Commons don't punish exit; landlords do.

### 1.3 "But couldn't we run our own L2?"

The most credible alternative to a sovereign chain, and the one a reader raises first. Running our own rollup (own sequencer, renounced upgrade keys, even JINN-as-gas via OP Stack / Arbitrum Orbit custom-gas) **does** fix the Base-specific defect — Coinbase as a discretionary operator in our trust path, a *mechanism*-neutrality fix — and it **buys the one thing sovereignty costs us: cold-start security for free** (inherit Ethereum's reorg resistance from genesis; no §5 staging). That is the real prize, and it is the "borrow security" option in plain sight.

But it fixes the wrong axis and *deepens* the root problem:

- An own-L2 is *more* explicitly an Ethereum project — the L2 category is definitionally "scaling Ethereum." You can leave Base; you **cannot leave "being an L2 of Ethereum"** while remaining one. The garden membership is constitutive of the form factor.
- Its security narrative *is* "we inherit Ethereum's security" — so legitimacy is **derivative by construction, permanently.** An own-L2 doesn't escape the garden; it *formalises tenancy into the protocol's security model.* You stop being a guest who could leave and become a structure whose foundation is poured on the landlord's land.
- It fails "leave silently" *harder*: exiting L2-hood later means a full sovereign migration (state export, token migration, security re-bootstrap) — the exact coordination nightmare already rejected for DAO-on-Ethereum.
- To the Ethereum-aligned, "settles to Ethereum" reads as *more* legitimate — but that is legitimacy *to one tent*, exactly the partisan ceiling the meta-principle can't accept. **Bittensor is the proof point:** sovereign, and read as *the* decentralised-AI chain, not "an Ethereum AI project" — its independence is part of *why* it's the Schelling point in that category.

**The resolving line: you cannot buy the thing you are selling.** An own-L2 borrows security and legitimacy in the *same move* — the inherited security *is* the borrowed legitimacy. Sovereignty pays cash for both: it accepts a real cold-start *security* deficit (§5, solvable by staging + a published threshold) in exchange for owning its *legitimacy* outright. Security is the cost you can engineer down over time; borrowed-legitimacy-by-construction you cannot.

*Sharpening:* the garden is created by **settling to Ethereum for security**, not by the rollup form factor. A *sovereign* rollup (own consensus, swappable external DA — §4) is the sovereign-chain path wearing a rollup's clothes; a *settled* rollup (proves to Ethereum) is the garden.

### 1.4 The technical axes are downstream evidence

The two-axis split still holds — it's the *mechanism* by which the root cause shows up on the stack:

- **Security / settlement neutrality** — "can a coalition rewrite our *history*?" Maximised by a large external validator set you don't control (Ethereum); an L2 inherits it. This is the axis a sovereign chain is *weaker* on at launch (§5).
- **Mechanism / governance neutrality** — "can a small group rewrite our *rules*?" Maximised by formulaic, role-based, ungoverned logic with no admin key, on a chain you don't share. Every live L2 in 2026 *fails* this: a universal Security Council upgrade key, plus shared-stack governance (Superchain / AggLayer / Elastic). **Base announced it is leaving the OP Stack (Feb 2026)** — the strongest player walked over exactly this dependency.

The prior spec's "Ethereum settlement is a free neutrality anchor" is correct about the *first* axis; the Oak↔Ritsu thesis ("Ethereum + L2 is the violation") is correct about the *second*. But both are *symptoms*: settlement- and mechanism-neutrality are properties of the *stack*, while the thing that actually forces the decision is one level up — **is our legitimacy ours to earn, or someone's to grant?** For a project whose entire thesis is legitimacy, that question forces the chain.

The honest cost: a fresh sovereign chain is *more* mechanism-neutral but *less* security-neutral at launch (small validator set is capturable). "Minimal initial security" is therefore a neutrality *aspiration*, not a fact, until the validator set is large/distributed enough — which §5 handles by staging and publishing the threshold.

## 2. Substrate decision and the candidates considered

Constraints that drove the choice: **(a)** a real EVM so the ~10 existing Solidity contracts run unchanged (no porting now); **(b)** the option to "bake protocol logic into the node" later; **(c)** minimise node-operator complexity; **(d)** maximal, *legible* neutrality (not a tenant of any ecosystem).

- **Sovereign Cosmos SDK + Cosmos EVM — chosen direction.** Depends only on open-source code; not in anyone's ecosystem (IBC / Hub / ICS are all opt-in). EVM is a module inside one node binary; "bake to node" = move logic into native Go modules behind stateful precompiles (proven by **dYdX v4**, which moved core logic out of an Ethereum contract into a validator-run module). Single-binary ops; mature validator tooling; `x/staking`+`x/slashing`+custom modules make "earned token = slashable stake" native. Cost/risk: the canonical Cosmos EVM module is pre-v1.0 / under audit.
- **Avalanche L1 — rejected.** Technically sovereign and EVM-native, but you are *inside Avalanche's ecosystem* (P-Chain registration + AVAX fee; perceived/discovered as "an Avalanche subnet"). Fails the *legible* neutrality test even if the technical dependency is thin. Baking into the node is also harder (custom VM/precompiles, not clean modules).
- **Ethereum / Tempo fork — rejected.** Genuinely sovereign and gives the *real* EVM (best contract fidelity), but: post-Merge ops = two clients (heavier for operators), and "bake into the node" means patching geth/reth and maintaining a client fork forever — the node is a general EVM, not an app framework. The thing you most want (clean bake-to-node) is the thing a pure fork is worst at. The real-EVM worry it surfaces is recoverable *inside* the Cosmos family via a **BeaconKit/reth build** (real EVM + CometBFT + SDK modules), at a two-component ops cost.
- **Substrate / Bittensor's stack — considered, not chosen.** Bittensor picked Substrate for reasons that don't transfer to Jinn (it didn't need EVM and bolted Frontier on years later; it was path-dependent from a Polkadot parachain start; forkless runtime upgrades suit a fast-iterating lab). Forkless upgrades are also a *governance* surface, which cuts slightly *against* our ossification/governance-minimisation goal — Cosmos's "rule change requires a coordinated binary upgrade" is closer to the Bitcoin-style ossification we want.
- **Rejected as deployment targets:** canonical OP Stack (no native gas token; Collective dependency; Base exiting), permanent RaaS-operated sequencing (commercial third party in the trust path), Polkadot parachains (shared relay security+governance), deploying *on* Monad/Berachain/Hyperliquid (tenant, not sovereign).

**Open sub-question (spike):** Cosmos EVM (one binary, reimplemented EVM, pre-v1) vs BeaconKit/reth (real EVM, two components). Decide on a real port of JINN + JinnRouter + an activity checker, a JINN-bond slash prototype, one veJINN gauge, and a throughput check. → **Resolved — Cosmos EVM** (empirically confirmed on `evmd` v0.7.0: all five contracts deploy and run unchanged, identical state + gas vs an independent EVM baseline) by the spike finding [`spec/2026-06-08-substrate-spike-cosmos-evm.md`](2026-06-08-substrate-spike-cosmos-evm.md): the deciding factor is that BeaconKit/reth is *consensus-only* (execution in reth behind the Engine API, **no Cosmos SDK modules**), which forecloses the bake-to-node-via-precompiles plan in §3 — so the reimplemented EVM is the *enabling* choice, not a compromise; and our actual contracts use none of the EVM features where reimplementations diverge.

### Operator hardware — the laptop target

**Design intent: a single moderate laptop (a mid-range M-series MacBook Pro or equivalent) should run *both* halves of a Jinn node — the agent/AI node and the Cosmos chain node — at once.** A low hardware bar is not a nicety; it is what makes the broad, *distributed* genesis validator set in §5 actually achievable. A high bar concentrates the validator set, which directly undercuts the cold-start neutrality claim.

This is realistic for one structural reason: **the AI half is orchestration, not local inference.** For the foreseeable future, agent execution runs against model *APIs*, so the heavy AI compute is off-box and the local agent footprint is light (measured steady state ≈0.6–1.6 GB RAM and a fraction of a core — see Discussion [#1027](https://github.com/Jinn-Network/mono/discussions/1027)). Operators who later want to serve local / open-weight models can opt into heavier hardware, but that is a choice, never the baseline.

That leaves the **chain node as the heavier half — and for an early, low-traffic, pruned Cosmos node it is still modest** (single-digit-GB working set). The one hard Cosmos requirement — low disk latency, or a validator gets jailed — is met natively by a laptop's NVMe SSD, and Go/CometBFT compile to Apple-Silicon arm64 with no emulation. Combined, ≈32 GB RAM with a 512 GB–1 TB SSD runs both comfortably; 16 GB is a workable early floor. The substrate spike should measure the *actual* Cosmos EVM node footprint (and the heavier BeaconKit/reth alternative) against this target.

*Scope note:* a given SolverNet's evaluation workload may at any moment be heavier than this — today's happens to use amd64 Docker images that emulate poorly on Apple Silicon — but that is an artifact of a *specific, temporary* SolverNet implementation, not a structural property of running a Jinn node. Heavier specialist roles (whatever a SolverNet's evaluation demands) stay **opt-in** and run on appropriate hardware; the durable, everyone-can-do-it baseline is *API-backed agent + modest early chain node = laptop-runnable*.

## 3. Native token, native DAO, and veJINN in the node

**Token + DAO native from genesis (Decided).** Putting the token on Ethereum forces the cross-chain proof machinery (`JinnClaimEmitter` → OP-Stack storage proof → `CanonicalOpStackMessenger` → `JinnDistributor`) that exists *only* because mint and activity sit on different chains. Native token deletes all of it. The cold-start security cost is handled by gating *launch* on the operator set (§5), not by launching weak and migrating — which removes the "arbitrary threshold + coordinate a network-wide migration" problem Oak/Ritsu rejected.

**veJINN baked into the node.** veJINN's *concept* is unchanged — lock JINN for time-decaying weight, gauge-vote to direct emissions. What changes is the enforcement layer:
- Emission becomes a **consensus rule** (a fixed per-epoch mint the validators execute), not an upgradeable distributor contract.
- In the baked-down end state, gauge tallying + the split happen in node logic; whoever did scored work in each channel is credited natively (no cross-chain proof — same chain).
- **Two construction modes, chosen per piece — not one big migration.** Consensus-level logic (the per-epoch emission rule; validator-stake slashing, §5) *cannot* be an EVM contract and is written **native from genesis** as Go modules (the dYdX `x/clob` pattern) — so there is nothing to migrate. Application-level logic (veJINN locks, gauge tallying, the distributor's accounting, the router/activity-checker) runs as **ordinary EVM contracts, unchanged and possibly indefinitely**; baking any of it down into a native module is *optional* and motivated (gas, governance-minimisation), never required. Operators run the same binary in all cases.
- Option worth holding: emission *direction* as a market (Bittensor's dTAO removed its committee-vote layer in favour of staking-flow markets) rather than a gauge vote — the purest governance-minimisation.

**On the bake-down — it is a scheduled upgrade, never "on the fly."** Migrating an EVM contract into a native module is a coordinated binary upgrade at a block height (cosmovisor + an `x/upgrade` handler) — the standard Cosmos flow, not a live hot-swap. The one genuinely novel piece is the *state move* (EVM contract storage → SDK module store) inside that handler; it has **no turnkey precedent** (dYdX went native-from-scratch, not migration — see the spike finding §2), so any such migration earns its own spike + testnet rehearsal and is best done early, while the contract's state is small. Crucially, **the substrate decision does not depend on this being easy**: what Cosmos EVM uniquely provides (vs BeaconKit/reth) is the *capability* to run native modules beside the EVM — which we exploit mainly by writing native-from-genesis, and only optionally by migrating. If a given bake-down were ever too costly, that logic simply stays an EVM contract. The scary version — hot-swapping live, high-value contracts on the fly — is neither how Cosmos works nor something we need.

## 4. Scaling — lean base + SolverNets as rollups (the security-multiplier argument)

For a "global settlement layer for agents," do **not** decide on single-chain TPS. Settlement (token, veJINN, emission, final attestations, slashing) is low-frequency; the high-volume traffic is agent execution, which is naturally shardable per SolverNet. A single CometBFT chain tops out in the low-thousands of TPS, and a faster single chain (Sei-style ~28k-TPS parallel EVM) only *moves* the ceiling. **You don't scale by making one chain faster; you fragment horizontally — many execution environments, one thin base.** So: a **lean sovereign base + many execution environments.** With hundreds of SolverNets the monolith (all SolverNet execution on one state machine) is a dead end; the topology question is how to fragment.

**The decisive axis is security cost per SolverNet, not TPS.** There are three ways to fragment, and the one that matters is what *adding a SolverNet* costs in security:

| Topology | Per-SolverNet security cost | Verdict |
|---|---|---|
| **Sovereign IBC appchains** (each SolverNet its own chain + validators) | Bootstraps its *own* validator set | ✗ multiplies §5's cold-start problem by *N* |
| **Rollups on a Jinn DA + settlement base** (Celestia-shaped) | None — inherits DA + settlement from the base | ✓ one security problem, *N* execution envs |
| **L2s above a standard Cosmos base** | None — inherits from the base | ✓ same family as the row above |

This is why the Celestia-shaped model is right *for Jinn specifically*: not mainly because DA throughput is high, but because **it decouples "add a SolverNet" from "stand up new security."** §5's whole problem is that bootstrapping security is hard; the rollup topology means a new SolverNet *never* re-incurs it. The natural-sounding Cosmos answer — "every SolverNet is a sovereign IBC appchain" — is exactly the trap to avoid: it's the version that multiplies §5 by *N*. (DA-sampling is the cherry on top: data-availability sampling lets block space grow as light nodes join — the one layer that scales near-horizontally, because light clients *sample* rather than re-execute.)

**Correction to the naive Celestia analogy: DA-free ≠ security-free.** Pure Celestia gives rollups *data availability* for free, not *settlement security* — a pure Celestia rollup is *sovereign* (Celestia orders + makes data available but never validates execution; disputes resolve at the rollup's own social layer). To get the "one security problem" benefit, the Jinn base must provide **narrow settlement** — canonical attestation anchoring + bond custody/slashing — not DA alone. This dovetails with §7's insight that the base need only *strongly* secure two things (attestation issuance, bond/slashing). So the precise target shape:

> **Lean base = DA + a *narrow* settlement registry (token, veJINN, attestations, bonds, slashing). SolverNets = rollups that post execution data to the base's DA and anchor their attestations/bond-slashes to the base's settlement.** Not vanilla Celestia (DA-only), not a fat execution chain.

**"Cosmos SDK vs Celestia's model" is a false choice — Celestia *is* a Cosmos SDK chain** (so are Dymension's settlement layer and Saga's chainlets). The Celestia model is a *destination inside the Cosmos SDK family*, so picking Cosmos SDK at genesis does not foreclose it; the bottleneck-breaking path stays one family the whole way: **monolithic base → lean base + rollup/IBC execution → DA-centric base (DAS) + SolverNet rollups.**

**Recommendation — don't fork Celestia now.** At launch (a handful of SolverNets) a plain Cosmos SDK base just *executing* everything is fine, and the modular topologies are indistinguishable; don't pay the modular tax early. DA bandwidth (every SolverNet's execution trace + evidence must be made available for evaluation/challenge) only becomes the binding constraint at *hundreds* of high-data SolverNets — that's when forking-in Celestia's `x/blob` + DAS earns its keep. Treat "evolve the base toward DAS" as the **swappable scaling tier** reached for when DA bandwidth is *proven* to be the bottleneck. DA stays swappable across Celestia/EigenDA/Avail (and our own fork), so "Celestia dies" can never touch the base. The highest raw-TPS chains (MegaETH, Monad) buy throughput with centralisation that conflicts with our operator/neutrality goals and are not the model.

## 5. Cold-start security model

- **A capped, operator-gated genesis is permissioned-BFT security, not economic security.** The cap stops any single party reaching ⅓ of voting power; the *gating* (closed entry) is what blocks an external economic attack (no open stake to buy into). The model is "honest super-majority of a known, vetted, capped set" — a trust assumption. On CometBFT: ⅓ Byzantine halts liveness, ⅔ breaks safety. Residual threat is **insider collusion / key compromise**, so genesis-set composition, diversity, and accountability are *security* properties (the launch-gating-criteria questions are load-bearing here, not cosmetic).
- **Economic security and cold start are mutually exclusive.** Economic security needs a valuable, distributed token; at genesis the token is neither. Nobody has economic security at genesis — which is why Bittensor used foundation authority instead. The honest path is a security *lifecycle*: **(1) permissioned BFT** (honest-set assumption, optionally hardened with slashable external-asset bonds) → **(2) hybrid** (open entry + JINN bonds as JINN gains value/distribution) → **(3) economic / permissionless** (cost-to-acquire-⅓-of-stake, slashing, social-fork backstop).
- **The no-tenancy choice commits us to this path.** The only way to have real economic security *at* genesis is to borrow it (Interchain Security, restaking, Babylon) — all of which reintroduce the tenant dependency we rejected. Choosing sovereignty = accepting permissioned-BFT-then-transition.
- **Publish the threshold (Legible).** State up front the validator count / max-single-party-voting-power / Nakamoto-coefficient (and optional stake cap) at which the claim graduates from "secured by a known operator set (weak)" to "credibly neutral," and report where we are. Below it, comms must say "not yet capture-resistant." This is the one thing Bittensor never did (its decentralisation was roadmap-by-vibes over four years; still not full PoS in 2026).
- **Bittensor cold-start lessons:** it bought legitimacy through **fair distribution** (no premine, no VC, 21M cap, halving, earn-only) while *centralising* security (foundation PoA + a 64-validator root network), then decentralised slowly. **Copy the fair-distribution half; reject the foundation-PoA half** — we have a real, recruited operator set, so we can do a *distributed* genesis (gated by the operator-supermajority launch signal) instead of foundation authority.

## 6. The PoW-analogy correction, and why the "island" route is self-securing

The idea "JINN is earned by real work, so staked JINN secures the chain from day 1" is **legitimacy-true but security-false**:

- **Cost-of-production ≠ cost-of-attack.** In PoW the *work is the security* — the same real-time energy flow mints and defends simultaneously. In Jinn's PoS the work *mints* JINN but *staked market value* secures the chain — they are decoupled. An attacker buys ⅓ of staked JINN at market price, indifferent to the work behind it. So security = staked market cap, not embodied work.
- At genesis the staked total is tiny regardless of per-unit value; and market price ≠ work value without a demand sink. The premise "tasks have real value from day 1" is itself the hardest open question (the first-buyer problem), so the security claim quietly assumes PMF.
- **Reframe it as a growth invariant, not a genesis guarantee:** security should *track adoption*. Make JINN required to use/produce the work (demand sink), so real demand raises JINN value and the attack surface grows with usage; and hold the invariant **value-secured ≤ security-earned** at all times (early on both are low — fine; the danger is value outrunning security).

**This is exactly why the "island" route is coherent (and why jUSD was dropped).** Coupling security to real productive throughput makes cold start *dissolve* rather than need a fix: low throughput → low value-at-stake → low security needed, and all three grow together. The **jUSD / exogenous-collateral idea** (stake a USDT-backed jUSD for stable cold-start security; recycle the collateral's yield into a JINN/jUSD pool) was evaluated and **dropped**: it gives the best cold-start security *quality*, but it reintroduces a bridge honeypot, a yield-bearing-stablecoin **regulatory surface**, an Ethereum/DeFi dependency on the economic layer, a depeg/run risk *under consensus*, and a governance surface (who holds bridge keys / picks the yield venue) — too much permanent complexity for a launch optimisation. The island keeps the chain simple and lets security emerge from value.

## 7. Tokenomics — what Discussion #69 gives us, and what must be reconciled

The ratified tokenomics (Discussion #69 → `SPEC.md` §Tokenomics) is anti-circular and **already supplies much of what we need**:

- **It already solves the *economic* half of cold start** with the exact mechanism we re-derived: terminate the loop in an **exogenous stable** (slot rent in LUSD/DAI, explicitly not JINN) because "an activity checker that measures its own currency is not a loop." Same principle as external-asset bonds.
- **It shrinks the security surface — the key gift.** The technically-enforced-vs-economically-held split means the chain must *strongly* protect only two things: **who can issue canonical attestations** (veJINN-slot gating) and **bond custody/slashing**. Everything else rides on operator self-interest and tolerates a weaker chain. So cold-start security is "secure a narrow attestation-and-bond registry," not "secure a global settlement chain" — which is *why* "minimal initial security" can be true, and tells us which minimal.
- **The demand sink we wanted already exists:** publication-requires-veJINN-slot + execution/evaluation bonds + priority locks are the "JINN required to do work" half. The right cold-start *target* is a small **live bonded attestation flow**, not a big corpus (the corpus is a public good).

**Conflicts the sovereign pivot creates, to reconcile (Open):**
1. **Two missing JINN jobs:** gas and validator/consensus stake. #69 assumed an external base chain provided chain security; sovereignty adds these, and validator-stake is exactly where the cold-start security problem lives.
2. **Direct contradiction:** `SPEC.md` says "no transaction-layer rent; transactions stay forkable" — but **JINN-as-gas is transaction-layer rent.** Pick which principle wins, or find the narrow reconciliation (e.g. minimal/burned gas, value still concentrated at coordination surfaces).
3. **The attestation anchor's neutrality collapses into the chain's own cold-start security.** On Ethereum, a "Jinn-blessed attestation" borrowed Ethereum's neutrality as its unforkeable anchor; on a sovereign chain the anchor's credibility *equals the chain's own* credibility — tying the token's primary demand sink to the §5 threshold. Sovereignty makes the attestation *machinery* cleaner (native module) but its *trust* harder to bootstrap.
4. jUSD is a "Jinn-issued stable," which #69 put out of scope ("separate later product") — moot if the island route holds (we dropped jUSD), but noted.

## 8. The real heart — the two questions, the refinery, and task selection

**Jinn is an inference refinery (§Most-important-conclusions 7).** Security, value, and the anti-Bittensor differentiation all reduce to two questions that **multiply**:

- **Does the network get measurably better at its target tasks?** (Learning Maximised; currently the central *unproven* workstream — `demonstrate-solver-learning`, `harness-as-policy-learning`, eval-measurement.)
- **Are its target tasks valuable?** (Real external willingness-to-pay, not just usage — the first-buyer problem.)

The refining margin = **task value × capability gain**. Either factor at zero zeroes the product: valuable-but-unimprovable tasks = reselling raw inference (no margin); improvable-but-worthless tasks = Bittensor. And **value disciplines learning**: a real value signal carries a hard-to-fake evaluation, which is what makes "getting better" *real* rather than gaming a proxy (the Yuma/reward-hacking failure). Add a third selection axis the two-factor framing implies: **improvability / headroom** — select tasks where the network can measurably beat the baseline, or there's no margin to capture.

**The "are we rebuilding Bittensor?" resolution.** Architecturally, yes — same genus (sovereign chain, work-backed token, chain-is-the-mechanism, subnets/SolverNets). That's fine; it's a proven pattern. The failure mode is the *economic* one: if JINN emissions are why people show up, you *are* Bittensor (emissions-farming with a useful-work veneer). The escape is real external demand (payment for the work, requiring JINN) + a credible evaluation layer + credible neutrality from day one (Bittensor's soft spot) + an accumulating attested corpus (structurally a different product). The worry relocates from architecture to *execution of the two questions*.

**Task-selection SolverNet (the team's design) + issues.** Design: people install Jinn → a **sidecar** makes them addressable on ERC-8004 and captures real agent-usage data → a **meta-SolverNet** sets agents loose over that data to find the most *valuable and evaluatable* tasks to turn into SolverNets, so targets come from real usage rather than guesswork. The right shape. Four issues:
1. **Add improvability** as a third criterion (per above) — valuable + evaluatable tasks already aced by frontier models have no margin.
2. **The meta-eval is the softest, most gameable layer** — judging "is this a good task to add" is a bet about future value, far harder to verify than object-level work, and the easiest place for operators to nominate self-serving tasks. Treat the meta-SolverNet's own evaluation as first-class (#69's open Q3 at the meta-layer).
3. **Usage ≠ willingness-to-pay** — telemetry captures what people *do a lot of*, not what they'd *pay to have done better*; without a WTP signal the loop drifts to popular-but-cheap tasks ("Jinn as first buyer" is the legitimate bootstrap).
4. **"Evaluatable" does most of the filtering** and biases toward the verifiable niche (code, predictions, math), away from larger pools of valuable-but-hard-to-judge work — fine as a wedge, but expanding *what's credibly evaluatable* (Phase B.1/B.2) is a deliberate growth lever.

**Overarching:** the chain, the security model, and the tokenomics are the *stage*; the two questions are the *play*. Build the stage well enough to run the play (pragmatic Cosmos island, kept simple) and put the real energy into proving capability compounds and that the tasks are genuinely valuable.

## 9. Open decisions / next steps

1. **Substrate spike:** Cosmos EVM vs BeaconKit/reth — **done, empirically confirmed** → [`spec/2026-06-08-substrate-spike-cosmos-evm.md`](2026-06-08-substrate-spike-cosmos-evm.md) decides **Cosmos EVM** (contracts run unchanged on `evmd`). Remaining: a later, separate *bake-down* spike (the EVM-contract → native-module migration mechanism).
2. **Cold-start parameters:** genesis validator count, max single-party voting power, stake cap, and the published security-neutrality threshold + graduation triggers (§5).
3. **Tokenomics reconciliation (§7):** add gas + validator-stake jobs; resolve JINN-as-gas vs "transactions stay forkable"; re-anchor "publication" credibility to the §5 threshold. Land as an extension of Discussion #69, not a silent contradiction.
4. **The two questions (§8):** the highest-priority real work — a measurable learning curve against a real value signal, and a willingness-to-pay signal for task value. The task-selection SolverNet needs the improvability axis and a credible meta-eval.
5. **Canon updates if ratified:** revise `spec/2026-05-24-phase-2-chain-architecture.md` §2.1/§2.3; `SPEC.md` Phase 2 + Tokenomics; add the two-axis-neutrality and security-lifecycle terms to `GLOSSARY.md`; gate launch comms on the honest threshold (`BRAND.md` / External-Communication).

## 10. Discussion prompts

1. Does the two-axis neutrality model (§1) hold? It is the load-bearing claim; if security-neutrality actually outranks mechanism-neutrality, the sovereign case weakens.
2. Cosmos EVM vs BeaconKit/reth (§2) — weight bake-to-node cleanliness vs real-EVM fidelity.
3. Is the permissioned-BFT-then-transition security lifecycle (§5), with a *published* threshold, acceptable as the launch posture — and what are the actual numbers?
4. JINN-as-gas vs "transactions stay forkable" (§7.2) — which principle wins?
5. Is the inference-refinery framing (§8) the right north star, and is "valuable + evaluatable + improvable" the right task-selection objective?
