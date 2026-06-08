# Launching Jinn as an independent blockchain — decision record and reasoning

- **Version:** 0.2 (discussion draft — major revision)
- **Date:** 2026-06-05
- **Author:** drafted with Opus, for Oak + Ritsu review
- **Status:** Open for discussion. Captures a long Oak↔Ritsu↔assistant working session. Records the conclusions reached and the reasoning behind them. Several items are *decided in principle* (flagged **Decided**); the rest are **Open**. This re-opens two load-bearing decisions of [`spec/2026-05-24-phase-2-chain-architecture.md`](2026-05-24-phase-2-chain-architecture.md) (§2.1 DAO-on-Ethereum, §2.3 settled-rollup-not-sovereign) and extends the ratified tokenomics in [`SPEC.md` §Tokenomics](../SPEC.md) / [Discussion #69](https://github.com/Jinn-Network/mono/discussions/69).
- **Changelog:**
  - **v0.2 (2026-06-05)** — major revision after the working session. Reverses v0.1's "DAO on Ethereum, migrate later" recommendation (rejected by Oak/Ritsu as too arbitrary and too hard to coordinate). Lands: sovereign Cosmos-SDK family as the substrate, native token+DAO from genesis, the "island" stance, the two-axis neutrality model, the cold-start security model, the inference-refinery framing, and the task-selection SolverNet analysis.
  - **v0.1 (2026-06-05)** — initial survey: two-axis neutrality, candidate matrix, P-vs-M architectures, recommended Ethereum-DAO-then-migrate. Superseded.
- **Related:** [`PRINCIPLES.md`](../PRINCIPLES.md); [`SPEC.md` §Tokenomics](../SPEC.md); [Discussion #69](https://github.com/Jinn-Network/mono/discussions/69); [`spec/2026-05-24-phase-2-chain-architecture.md`](2026-05-24-phase-2-chain-architecture.md); [`spec/2026-05-14-launch-gating-criteria.md`](2026-05-14-launch-gating-criteria.md); the sidecar / telemetry spec ([`spec/2026-05-07-telemetry-collector-and-task-generator.md`](2026-05-07-telemetry-collector-and-task-generator.md)); the solver-learning specs (`spec/2026-05-25-demonstrate-solver-learning.md`, `spec/2026-05-28-harness-as-policy-learning-architecture.md`).

---

## Most important conclusions

1. **Launch Jinn as its own sovereign chain — not an L2, not a tenant of anyone.** The neutrality argument is real but two-sided (see §1): an L2 gives *settlement* neutrality but fails *mechanism/governance* neutrality (every live L2 keeps a Security Council key; Base is leaving the OP Stack over the shared-governance dependency). For Jinn, mechanism neutrality is the load-bearing axis, because the whole value claim is "the protocol rewards whoever does scored work, by formula, with no discretionary override." That requires sovereignty.

2. **Substrate: the sovereign Cosmos-SDK family.** **Decided in principle.** It is "purely, plainly neutral" — a standalone Cosmos chain depends only on open-source code (CometBFT, IBC), not on any other chain's security, governance, or ecosystem. It uniquely satisfies our three hard constraints at once: a real EVM so existing contracts run unchanged (no porting yet), a clean path to "bake protocol logic down into the node" later (modules + stateful precompiles — the dYdX v4 precedent), and single-binary operator simplicity. Avalanche L1 was rejected (you're inside Avalanche's ecosystem); Ethereum/Tempo forks were rejected (no clean bake-to-node, two-client ops). **Open:** Cosmos EVM (one binary, reimplemented EVM, pre-v1) vs a BeaconKit/reth build (real EVM, two components) — settle by spike.

3. **Token and DAO are native to the Jinn chain from genesis.** **Decided.** No token on Ethereum, no migration. This deletes the entire cross-chain claim loop (OP-Stack storage proofs → messenger → distributor) — the biggest single source of complexity in today's architecture — because mint and activity live on the same chain. It also removes the "arbitrary threshold + network-wide migration" coordination problem.

4. **The chain is an "island."** **Decided.** People can bridge to it; we do not build or operate bridges ourselves, and we do not import exogenous collateral to inflate the security budget. Security is allowed to *emerge from real productive throughput* rather than be engineered with stablecoin/yield machinery (the jUSD route was considered and dropped — §6).

5. **Cold-start security is permissioned-BFT, honestly named — not economic.** **Decided framing.** A capped, operator-gated genesis set is "honest super-majority of a known set," a trust assumption, *not* a cost-of-corruption guarantee. Economic security and cold start are mutually exclusive (nobody has economic security at genesis). Security grows through three phases (permissioned BFT → hybrid → economic) and we **publish the threshold** at which the claim graduates (Legible).

6. **The real moat is not the chain — it's two questions.** **Decided focus.** *(a) Does the network get measurably better at its target tasks?* and *(b) are those tasks valuable?* They multiply (refining margin = task value × capability gain), and value disciplines learning (a real value signal is what makes "getting better" ungameable). Everything about chain/security/tokenomics should be sized to **not block** these two, not gold-plated.

7. **Jinn is an inference refinery.** **Decided framing.** Raw, commoditising inference goes in; through task selection, evaluation, and accumulating capability it comes out as refined, verified, valuable work; the network captures the refining margin and JINN is the claim on it. This is the answer to the "are we just rebuilding Bittensor?" worry: the architecture *is* Bittensor-shaped (fine — proven pattern), but the differentiator is delivering *productive, compounding, captured* inference where Bittensor is criticised for emissions-farming with a useful-work veneer.

---

## 1. The neutrality reframe (the conceptual crux)

Credible neutrality (Buterin's sense, which `PRINCIPLES.md` invokes) splits into two independent properties:

- **Security / settlement neutrality** — "can a coalition rewrite our *history*?" Maximised by a large external validator set you don't control (Ethereum). An L2 inherits this.
- **Mechanism / governance neutrality** — "can a small group rewrite our *rules*?" Maximised by formulaic, role-based, ungoverned logic with no admin key, on a chain you don't share. Every live L2 in 2026 *fails* this: a universal Security Council upgrade key, plus shared-stack governance (Superchain / AggLayer / Elastic). **Base announced it is leaving the OP Stack (Feb 2026)** — the strongest player walked over exactly this dependency.

The prior spec's "Ethereum settlement is a free neutrality anchor" is correct about the *first* axis. The Oak↔Ritsu thesis ("Ethereum + L2 is the violation") is correct about the *second*. **For Jinn the second axis is load-bearing**, because the protocol's legitimacy claim is "anyone who does scored work gets minted to, by formula, no discretionary payout" — only credible if no Security Council, host-chain governance, or founder multisig can override the formula. Hence sovereignty.

The honest cost: a fresh sovereign chain is *more* mechanism-neutral but *less* security-neutral at launch (small validator set is capturable). "Minimal initial security" is therefore a neutrality *aspiration*, not a fact, until the validator set is large/distributed enough — which §5 handles by staging and publishing the threshold.

## 2. Substrate decision and the candidates considered

Constraints that drove the choice: **(a)** a real EVM so the ~10 existing Solidity contracts run unchanged (no porting now); **(b)** the option to "bake protocol logic into the node" later; **(c)** minimise node-operator complexity; **(d)** maximal, *legible* neutrality (not a tenant of any ecosystem).

- **Sovereign Cosmos SDK + Cosmos EVM — chosen direction.** Depends only on open-source code; not in anyone's ecosystem (IBC / Hub / ICS are all opt-in). EVM is a module inside one node binary; "bake to node" = move logic into native Go modules behind stateful precompiles (proven by **dYdX v4**, which moved core logic out of an Ethereum contract into a validator-run module). Single-binary ops; mature validator tooling; `x/staking`+`x/slashing`+custom modules make "earned token = slashable stake" native. Cost/risk: the canonical Cosmos EVM module is pre-v1.0 / under audit.
- **Avalanche L1 — rejected.** Technically sovereign and EVM-native, but you are *inside Avalanche's ecosystem* (P-Chain registration + AVAX fee; perceived/discovered as "an Avalanche subnet"). Fails the *legible* neutrality test even if the technical dependency is thin. Baking into the node is also harder (custom VM/precompiles, not clean modules).
- **Ethereum / Tempo fork — rejected.** Genuinely sovereign and gives the *real* EVM (best contract fidelity), but: post-Merge ops = two clients (heavier for operators), and "bake into the node" means patching geth/reth and maintaining a client fork forever — the node is a general EVM, not an app framework. The thing you most want (clean bake-to-node) is the thing a pure fork is worst at. The real-EVM worry it surfaces is recoverable *inside* the Cosmos family via a **BeaconKit/reth build** (real EVM + CometBFT + SDK modules), at a two-component ops cost.
- **Substrate / Bittensor's stack — considered, not chosen.** Bittensor picked Substrate for reasons that don't transfer to Jinn (it didn't need EVM and bolted Frontier on years later; it was path-dependent from a Polkadot parachain start; forkless runtime upgrades suit a fast-iterating lab). Forkless upgrades are also a *governance* surface, which cuts slightly *against* our ossification/governance-minimisation goal — Cosmos's "rule change requires a coordinated binary upgrade" is closer to the Bitcoin-style ossification we want.
- **Rejected as deployment targets:** canonical OP Stack (no native gas token; Collective dependency; Base exiting), permanent RaaS-operated sequencing (commercial third party in the trust path), Polkadot parachains (shared relay security+governance), deploying *on* Monad/Berachain/Hyperliquid (tenant, not sovereign).

**Open sub-question (spike):** Cosmos EVM (one binary, reimplemented EVM, pre-v1) vs BeaconKit/reth (real EVM, two components). Decide on a real port of JINN + JinnRouter + an activity checker, a JINN-bond slash prototype, one veJINN gauge, and a throughput check.

## 3. Native token, native DAO, and veJINN in the node

**Token + DAO native from genesis (Decided).** Putting the token on Ethereum forces the cross-chain proof machinery (`JinnClaimEmitter` → OP-Stack storage proof → `CanonicalOpStackMessenger` → `JinnDistributor`) that exists *only* because mint and activity sit on different chains. Native token deletes all of it. The cold-start security cost is handled by gating *launch* on the operator set (§5), not by launching weak and migrating — which removes the "arbitrary threshold + coordinate a network-wide migration" problem Oak/Ritsu rejected.

**veJINN baked into the node.** veJINN's *concept* is unchanged — lock JINN for time-decaying weight, gauge-vote to direct emissions. What changes is the enforcement layer:
- Emission becomes a **consensus rule** (a fixed per-epoch mint the validators execute), not an upgradeable distributor contract.
- Gauge tallying + the split happen in node logic; whoever did scored work in each channel is credited natively (no cross-chain proof — same chain).
- **Start veJINN/distributor/governance as ordinary EVM contracts on the Jinn chain (no porting), and bake the value-bearing ones into native modules later** — operators run the same binary either way (a bake-down is a versioned binary upgrade via cosmovisor, not an operator re-architecture). The rule then moves from "upgradeable contract a quorum can swap" to "consensus rule that changes only by a visible fork" — which *strengthens* governance-minimal/Legible.
- Option worth holding: emission *direction* as a market (Bittensor's dTAO removed its committee-vote layer in favour of staking-flow markets) rather than a gauge vote — the purest governance-minimisation.

## 4. Scaling — lean base + horizontal execution

For a "global settlement layer for agents," do **not** decide on single-chain TPS. Settlement (token, veJINN, emission, final attestations, slashing) is low-frequency; the high-volume traffic is agent execution, which is naturally shardable per SolverNet. So: a **lean sovereign base + many execution environments** (own appchains via IBC; Cosmos can also go fat-and-fast à la Sei's ~28k-TPS parallel EVM if wanted). The highest raw-TPS chains (MegaETH, Monad) buy throughput with centralisation that conflicts with our operator/neutrality goals. **Celestia and modular DA** are an *optional, swappable* scaling tier for execution-edge rollups *if* they ever need extreme DA throughput — never a base-layer dependency (DA is swappable across Celestia/EigenDA/Avail, so "Celestia dies" can't touch the base).

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

1. **Substrate spike:** Cosmos EVM vs BeaconKit/reth — real contract port + JINN-bond slash + one veJINN gauge + throughput/horizontal-scaling test (§2).
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
