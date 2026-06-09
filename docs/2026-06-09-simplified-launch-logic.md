# The simplified launch logic — decision log + plan

- **Version:** 0.1 (working draft)
- **Date:** 2026-06-09
- **Author:** Oak (drafted with assistant), for Ritsu review
- **Status:** Open for discussion. A record of reversible decisions taken since our Friday sync, plus the concrete plan that falls out of them. Not canon. Each numbered decision is meant to be isolable — challenge any one without having to accept or reject the rest.
- **Related:** [`spec/2026-06-05-independent-blockchain-launch.md`](../spec/2026-06-05-independent-blockchain-launch.md) (sovereign-chain decision); [`spec/2026-06-08-substrate-spike-cosmos-evm.md`](../spec/2026-06-08-substrate-spike-cosmos-evm.md) (substrate spike — Decided: Cosmos EVM); [`spec/2026-05-14-launch-gating-criteria.md`](../spec/2026-05-14-launch-gating-criteria.md) (testnet→mainnet gates); `SPEC.md` §Tokenomics; [Discussion #69](https://github.com/Jinn-Network/mono/discussions/69).

---

## In plain English

We've been treating the application layer as load-bearing — the learning plugin, the distillation-of-capability story, the marketplace. A conversation with a community member (Misha) made it clear that's an over-build. The protocol itself is the product worth shipping: a network that coordinates spare agentic inference and pays for it in a fairly-launched token. The simplest valuable core already exists.

So the proposal: **get to mainnet on a simpler path.** Ship the protocol on testnet now, on what we already run, and tell people. Keep the application deliberately minimal — agents solving verified coding tasks on our own repo. Build the sovereign chain in parallel, and converge by re-instantiating the proven mechanics at a fair-launch genesis.

The document is two halves: the **decision tree** (§1–7 — what Jinn is and what we ship) and the **plan** (§8–13 — what testnet must prove, what's missing, how the work splits). The genuinely open items and the one unproven claim the whole thing rests on are flagged at the end.

---

# Part A — the decision tree

## 1. Trigger — why now

I mentioned to Misha the idea of him building a learning plugin. He said: *"What I'm going to do is just give it to Claude anyway, so why not just have a SolverNet that does that?"* What excited him wasn't the application we'd been designing — it was the raw promise underneath it: a SolverNet lets you coordinate other people's inference, and he's sitting on a lot of spare inference in his subscription, as we all are now.

That's not one person's quirk. Everyone on a frontier subscription holds idle inference, so Misha is representative, not anecdotal. The takeaway: we don't need to place such an onus on the quality of the application. What we need to show is the network live — the protocol and its on-chain apparatus working, doing something real.

**Therefore I'm proposing a simpler path to mainnet.** The rest of this document is that path.

## 2. What Jinn is, simplified

**Decision: Jinn is the L1 for coordinating agentic inference.** Not the L1 that does learning — learning is one valuable thing you can express on top, not a requirement for a core value proposition. The simplest valuable core is coordinating inference.

We already have a very minimal on-chain core: the DAO/distributor, the staking contract, the activity checker, and the Mech marketplace. It all exists. It is very much shaped like OLAS, with some technical differences we can come to later — but the load-bearing difference is that Jinn is a fair launch.

**On the moat — a three-layer stack, kept distinct:**

- **Fair launch is the pillar, not the moat.** It is fundamental, because it's what lets the economy become the *default* thing people coordinate around. OLAS built the economy but not the trust; without a fair launch it never became that default, so its economy never compounded into a moat.
- **The moat is the economy itself** — its size and establishment. Liquidity, switching cost, and convention are what a competitor can't cheaply replicate.
- **Verified useful work is the floor.** The economy's size is only a moat if real verified work flows through it. Otherwise its size is reflexive — big because valuable, valuable because big — and that unwinds.

Whatever application we start with — to show the network works — is speculative and not load-bearing at launch. **The application's *ambition* isn't load-bearing; only that one application works and is verifiable.** The ambition is optional; the verification is not (see §4).

## 3. How value accrues

Value does not come from external buyers paying for inference — it comes from bonding into the economy. We considered a data marketplace and concluded the data doesn't accrue to the economy: it leaks out as a sellable product rather than deepening the network. Pure delivery of agentic capability is the same — a data product that leaks.

What Jinn points towards is an increasingly *deep* economy. For the network to grow in security it needs two things growing together: valuable work happening on one side, and a comparable amount of bonding into the economy on the other. **The growth invariant: security tracks adoption — the economy can't safely outrun the work flowing through it.** This is the answer to "is it just a bubble?"

The value entering the economy is anchored by picking a task we *know* is valuable to us: a corpus of data and increased agentic capability built around the Jinn repo itself, cross-checked against a simple, free oracle — our own test suite. That's what we're building now.

The economic structure, in its simplest form, is threefold — and the three are **distinct locks securing different things, not to be conflated:**

1. **ve-JINN lock** — operators earning JINN lock it into ve-JINN and point it at the first SolverNet, or launch their own to drive their own tasks. *(Directs emissions.)*
2. **Execution/evaluation bond** — operators bond into their executions and evaluations in a slashable way. *(Per-task honesty.)*
3. **Validator stake** — staking on the blockchain nodes themselves. *(Consensus security.)*

## 4. The launch application — and why it survives Ritsu's challenge

**Decision: the launch application is agents solving real coding tasks, verified by a cheap oracle (the test suite / merge), on a repo we control — the Jinn repo.** No learning claim attached, no marketplace, no multi-repo trust machinery. The oracle is the non-negotiable floor; the repo is a tunable.

**Ritsu's position (steel-manned):** establish a corpus of tasks outright instead. A corpus is a cleaner, more legible, more general asset; the Jinn-repo SolverNet looks narrow and self-serving.

**The answer is a sequencing argument, and it concedes Ritsu's point.** The corpus *is* the asset — and running the Jinn-repo SolverNet *produces* a corpus. The only claim here is about where you bootstrap. The Jinn repo is the one place where:

- **Trust cost is zero.** Taking other people's tasks requires them to expose sensitive data; even with data-stays-local, it still needs ERC-8004 indexing and x402 access — unsolved machinery. Our own repo needs none of it.
- **Quality is known.** We know which tasks in our own repo are valuable. Random tasks from ten different operators are unknown-quality, with low overlap, so the signal is weak.

Corpus-first and Jinn-repo-first aren't opposed; the second is the bootstrap path to the first. Everywhere else needs trust and quality solved before you can even start.

**Why nothing simpler works (the floor defence).** There are exactly four ways to establish that work has value: an **oracle** (check it objectively), **consensus** (many agree), **authority** (a trusted judge), or a **market** (someone pays). That's exhaustive. Below the oracle:

- *Consensus* proves consistency, not correctness — and it's weakest exactly when agents share a base model and make correlated errors. To track truth it needs a ground-truth anchor, which is the oracle again.
- *Authority* (an LLM judge, a committee, a foundation) runs cheaply but is gameable and not independently checkable, so it spends credible-neutrality-from-day-one — the one irreversible launch asset.
- *Market* is the strongest floor but a *heavier* cold-start: there's no buyer today, and "Jinn as first buyer" collapses to paying to maintain our own repo — the oracle plus a payment.

So only the oracle and the market are neutral floors; the market is heavier; **the lightest neutral floor is the oracle, and nothing below it is both bootstrappable and neutral.** "Just collect task data" fails precisely here — it sheds the oracle. The line isn't "code" — it's *objective resolvability*; code is simply the cheapest, most abundant place to start.

## 5. The launch reframe — two launches, decoupled

**Decision: what ships is the protocol/chain — the minimal shippable surface — not the application. And there are two launches, not one.**

- **Testnet, now.** Phase 1a is already deployed and proven on Base Sepolia. We can be live, publicised, and recruiting operators this week, on a stack that works.
- **The sovereign fair-launch, later.** This stays gated by the launch-criteria spec. It is the irreversible, common-knowledge event, and the one thing that must not be rushed.

"Why wait?" applies to the testnet — nothing is stopping it. It does *not* apply to the fair launch, which is one-shot.

## 6. The chain — sovereign Cosmos

The substrate decision is made in principle and documented in full in [`spec/2026-06-05-independent-blockchain-launch.md`](../spec/2026-06-05-independent-blockchain-launch.md): a sovereign Cosmos-SDK chain, native token and DAO from genesis. Not re-derived here.

The one consequence load-bearing for *this* plan: **native-token-from-genesis deletes the L1↔L2 claim machinery** (the storage-proof → messenger → distributor loop) that exists only because mint and activity sit on different chains. That's a simplification dividend — the sovereign chain is, on this axis, simpler than what we run now. It also means "merge the Sepolia work onto the chain" = **re-instantiate the proven mechanics at genesis, not migrate state.**

**Settled:** the substrate sub-choice is no longer open — the spike is done and written up ([`spec/2026-06-08-substrate-spike-cosmos-evm.md`](../spec/2026-06-08-substrate-spike-cosmos-evm.md), Decided — Cosmos EVM), and the parent chain spec already reflects it. The deciding reason: a BeaconKit/reth build is consensus-only and forecloses the bake-to-node plan, so Cosmos EVM's reimplemented EVM is the *enabling* choice, not a compromise.

## 7. The minimal robust core

**Decision: only one thing has to be *strong* at launch — a narrow attestation + bond + slash registry. The rest can be thin and grow.**

Bond, slash, and attestation are one object: **a credible slashing-condition resolver.** For code tasks it can be thin, because the test/merge oracle makes the slashing condition near-objective. This is why the layer-zero posture is right — ve-JINN + slashable bonding + validator staking — and why a heavy canonical-attestation layer is *not* needed at launch: the oracle does the adjudication a trust registry would otherwise have to.

**Robust at launch:** the attestation/bond/slash core; the loop closing end-to-end; the one SolverNet's verification.
**Deferred:** economic (cost-to-attack) staking, the rollup/DAS scaling topology, SolverNet breadth, the marketplace, gold-plating.

---

# Part B — the concrete plan

## 8. What testnet must prove (metrics + targets)

The definition of done — the few metrics that gate testnet→mainnet. Proposed set; **Oak/Ritsu to fix the numbers:**

| Metric | Why it matters | Target |
|---|---|---|
| Loop closes end-to-end for a *stranger* | The protocol actually works unaided | binary — yes |
| Verified merged edits happening on the Jinn repo (oracle-passed) | The loop produces real work, not liveness — replaces operator-count as the "is it real" signal | yes, at a steady rate *(rate: TBD)* |
| Independent operators bootstrapping unaided | Operator diversity + client robustness (launch-gating T7) | ≥ M operators *(M: TBD)* |
| Total JINN bonded + ve-locked | The economy is real, not empty | ≥ baseline *(TBD)* |
| Stability window | KPIs hold over time, not just peak (T5/T6) | hold for X *(TBD)* |

Pick the binding 3–4 and set each number. Everything else is observation, not a gate. In particular, **cost-per-merged-edit and whether it *improves* are a capability signal — tracked, but not a launch gate** (that's the deferred thesis; see the closing section).

## 9. Component gap analysis

Triaged against §8:

| Component | Status | Note |
|---|---|---|
| ve-JINN | **Missing** | Not deployed. Required — it's the locking sink and a security input. |
| Slashing-condition resolver | **Missing / build** | OLAS staking exists but is audited *as no-slash*; adding slashing is a security-critical build, not a patch. |
| Jinn-repo SolverNet + test-suite oracle | **In progress** | The swe-rebench line of work; adapt to the launch framing. |
| SolverNet-creation flow | **Exists** | Launcher SPA (A.4) — confirm it's usable on day one. |
| Operator UX | **Exists, needs-change** | Too heavy → §10. |
| Validator / consensus staking | **Missing** | Cosmos-side; workstream B. |
| Distributor / Mech / activity-checker | **Exists** | Phase 1a, on Base Sepolia. |

Critical path to §8: ve-JINN deployment and the slashing-resolver. *(Confirm.)*

## 10. Operator experience — how minimal

The bet: the current dashboard shows too much. The launch app may be a single screen — **"set how much inference you'll provide, watch the tokens come in"** — a simple Electron app, with everything else (status taxonomy, etc.) hidden or secondary.

*Open:* what is the single screen, the two or three things the operator actually sets and sees, and what gets cut from today's UI?

## 11. Building the operator set

The genesis operator set is a *recruitment* property, not a software one. Plan:

- **Order:** testnet live → publicise → recruit → assemble the genesis set for the sovereign launch.
- **Message:** the raw promise — coordinate your spare inference, watch the tokens come in. (Misha's own reaction is the pitch.)
- **Audience:** Misha-shaped builders sitting on spare subscription inference.

*Open:* who specifically, the one-line pitch, and the minimum viable set size.

## 12. Sequencing — the two workstreams

Two parallel tracks, converging at genesis:

- **Workstream A — EVM / Base Sepolia.** Keep Sepolia live; deploy ve-JINN; build the slashing-resolver and bonding; push Jinn-repo capability to show real progress. Build it **substrate-agnostic** so it ports to the Cosmos EVM (or bakes into a native module) without a rewrite. *First concrete thing: the slashing-condition resolver on Sepolia.* *(Owner: TBD.)*
- **Workstream B — Cosmos node.** Build on **Cosmos EVM** (spike done — it won over BeaconKit/reth): node config → token wiring → validator/staking → genesis params. *First concrete thing: stand up the Cosmos EVM node and port the contracts.* *(Owner: TBD.)*
- **Convergence:** re-instantiate the proven mechanics at the sovereign genesis — not a state migration.

*Open:* which track is critical path, and who owns each.

## 13. Open / reversible

- **Token accounting (substrate now fixed: Cosmos EVM).** On a Cosmos EVM chain there is one balance, two views: JINN is a native bank coin (the value/gas/staking token, single source of truth in `x/bank`), surfaced to the EVM via a bank/ERC-20 precompile so existing Solidity contracts can treat it as `IERC20`. Pull the exact precompile wiring from the spike write-up ([`spec/2026-06-08-substrate-spike-cosmos-evm.md`](../spec/2026-06-08-substrate-spike-cosmos-evm.md)).
- **Cold-start parameters.** Genesis validator count, max single-party voting power, and the *published* security-neutrality threshold (per the chain spec §5). Not yet set.
- **What's reversible vs not.** The testnet, the application choice, the UX, the workstream split — all reversible. **The fair-launch genesis is the one irreversible decision: common knowledge forms there and can't be repaired.** That's where the stakes concentrate, and why everything before it is allowed to be rough.

---

## What we are — and aren't — claiming at launch

The key path is to stand up the network. That rests on two things, both demonstrable now: the **loop closes** — verified work actually happens and is rewarded against the oracle — and the **economy stands up** — people bond and lock. Neither needs the application to be *good*, only to work and be verifiable (§2, §4).

What launch explicitly does **not** rest on: that capability **compounds** — that the network gets measurably better at its tasks over time. That's the deeper-value thesis and the eventual moat, but it is not a launch gate and we are not claiming it on day one. It's the central open workstream for *after* the network is live; the cost-per-merged-edit trend is how we'd eventually show it, not a condition of shipping. (This is the point that earlier framings got wrong by treating "does it learn" as load-bearing at launch.)

The one genuinely relevant unknown at launch is softer: whether bonding demand exists beyond us. Evidenced so far by one conversation — and the way to test it is to stand the network up and see, not to pre-prove it.
