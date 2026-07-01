# Phase 2 chain architecture — staged launch, app-chain destination, permanent Ethereum DAO

> **Status (2026-06-30): superseded by DR-2026-06-30 (tokenless, OLAS-native).** Jinn drops the native token and the sovereign chain; OLAS is the economic layer. For the current direction read `spec/2026-06-30-tokenless-olas-native.md` and `log/decisions/2026-06-30-tokenless-olas-native-pivot.md`.

- **Version:** 0.2 (discussion draft)
- **Date:** 2026-05-24
- **Author:** Oak (drafted with Sonnet)
- **Status:** Open for discussion. First ask: *do the ratified decisions hold, and are the migration triggers in §2.8 the right shape?*
- **Changelog:**
  - **v0.2 (2026-05-24)** — reshaped to a three-stage launch (Phase 2.0 on Base / 2.1 on Jinn app-chain / 2.2 deprecate Base). Added §2.8 (migration triggers must be defined before Phase 2.0 ships) and §2.9 (Phase 2.0 contracts designed for portability). Open questions reorganised by stage-binding rather than topic-only.
  - **v0.1 (2026-05-24)** — initial draft proposed app-chain launch at mainnet (Phase 2.0 = app-chain). Superseded by v0.2 once the §2.1 "DAO permanently on Ethereum" decision was recognised as making execution-layer migration structurally cheap, so the chain transition can stage *after* mainnet rather than block it.
- **Related:**
  - `SPEC.md` — Phase 2 description (this spec proposes amendment)
  - `PRINCIPLES.md` — composability + minimum viable extraction
  - `spec/2026-04-06-phase-1a-design.md` — Phase 1a tokenomics (unaffected)
  - `spec/2026-04-30-phase-a-umbrella.md` — current active roadmap (unaffected)
  - `spec/2026-05-14-launch-gating-criteria.md` — needs a Tech-series question covering chain architecture
  - `log/decisions/2026-04-30-knowledge-market-vision-framing.md` — DR-2026-04-30
  - `client/ARCHITECTURE.md` — operator daemon (validator opt-in extends this at Phase 2.1)
  - `client/OPERATOR-APP-SPEC.md` — operator surface (validator opt-in adds a surface at Phase 2.1)

---

## TL;DR

Phase 2 launches as a **three-stage roadmap** rather than a single coordination event:

- **Phase 2.0** — mainnet on Base, current OLAS-style execution architecture, current contracts.
- **Phase 2.1** — deploy a **Jinn-owned EVM app-chain rollup with Ethereum settlement**; JINN as gas; operator daemons opt in as validators / sequencers; migrate execution layer to the app-chain; deprecate Base execution surface over a transition window.
- **Phase 2.2** — sunset Base execution layer once operator gravity has shifted.
- **Phase 3+** — sovereign rollup deferred indefinitely; revisit only under explicit triggers.

JINN token and DAO live on Ethereum mainnet, **permanently** — this decision is what makes the staged shape structurally cheap. Migrating execution layer between chains is a known-shape protocol upgrade, not a relaunch, because token canonicality and governance never move.

The Phase 2.0 → 2.1 trigger conditions are defined *now* (per §2.8) so Phase 2.1 is a known-future milestone, not vibes. Phase 2.0 contracts are designed for portability *as a constraint* (per §2.9) so the migration doesn't accrete path-dependence on Base assumptions.

This supersedes the prior `SPEC.md` Phase 2 framing ("multi-chain — Base, Arbitrum") for the launch shape. Multi-chain reach is a post-2.1 question.

---

## 1. Context: why staged, and why the staging is structurally cheap

The current `SPEC.md` Phase 2 targets mainnet on Base + Arbitrum as contracts. v0.1 of this spec proposed launching on a Jinn-owned app-chain at mainnet. v0.2 splits the difference: launch as we are, move to the app-chain when conditions warrant.

**Why staged works.** The migration-is-brutal argument against post-launch chain transitions is calibrated to scenarios where **DAO + token move**. Once §2.1 ratifies "JINN + DAO live on Ethereum permanently," that scenario is excluded. What's left to migrate at Phase 2.1 is the execution layer:

- Token doesn't move. JINN is canonical wherever it sits.
- DAO doesn't move. Governance, ve-JINN, emissions unaffected.
- Distribution contracts are per-chain by design — adding a new distributor on the app-chain is the existing pattern, not a break.
- What actually migrates: execution-layer contracts (Mech Marketplace fork, JinnRouter, ClaimRegistry, ActivityChecker, x402 endpoints) and operator daemon config (point at new chain).

That's a known-shape protocol upgrade event, not a relaunch. Comparable to a major contract version bump, not to Maker → Sky.

**Why staging is cheaper than launching on the app-chain.** Validator bootstrap gets easier by waiting. At Phase 2.1 the operator set is known with known stake distribution — a deliberate genesis validator set can be committed, rather than gambling on opt-in from cold. Chain at low volume with thin operator-validator security is the worst of both worlds; chain at known operator population is the design point.

Phase 2.0 also lets the team validate JINN-as-gas economics on a Phase 2.1 testnet before committing mainnet to a stack choice that has multi-year consequences. Stack maturity (proof systems, sequencer governance, ecosystem politics) continues to evolve quickly — locking in a 2026 stack choice for mainnet launch over-indexes on present conditions.

**What staging costs.** Three things, addressed by §2.8, §2.9, and §3.4 respectively:

1. **Drift risk** — "Phase 2.1 deferred indefinitely" is the default failure mode for pre-announced staged plans. §2.8 ratifies migration triggers up front so the milestone is binding, not vibes.
2. **Path-dependence risk** — Phase 2.0 contracts can quietly bake in Base / OLAS assumptions that make Phase 2.1 migration harder. §2.9 declares portability as a Phase 2.0 design constraint.
3. **Common-knowledge framing risk** — launch creates common knowledge about what category Jinn is in; launching on Base risks the frame "Jinn is an OLAS-ecosystem protocol" hardening before Phase 2.1. §3.4 commits the staged roadmap to be prominent in the launch narrative, not buried.

**The chain is substrate, not protocol.** The chain at Phase 2.1 is "just an EVM chain with the relevant Jinn contracts deployed." Consensus is not the protocol. The "chain IS evaluation" question (Bittensor pattern) is a Phase B.2 evaluator-economics matter, not a chain-architecture matter, and is not reopened here.

---

## 2. Decisions ratified

These are settled by this draft (subject to discussion review) and form the load-bearing commitments the rest of the spec assumes.

### 2.1 JINN token and DAO live on Ethereum mainnet, permanently

- ERC-20, Treasury, ve-JINN, Distribution contracts, DAO governance — all on Ethereum mainnet.
- "Permanently" means: not on the foreseeable roadmap. Revisited only at protocol scale where the multi-quarter cost of DAO migration is justified by ongoing settlement / fee tax to Ethereum. Currently treated as effectively never.
- **This is the load-bearing decision that makes the rest of the staged shape cheap.** It isolates the DAO layer from any execution-chain choice; chains can migrate underneath without disturbing the durable artefact.

### 2.2 Phase 2 launches as a three-stage roadmap, not a single event

- **Phase 2.0 (mainnet launch)** — execution layer on Base, current OLAS-style architecture. DAO + token on Ethereum.
- **Phase 2.1 (app-chain deployment)** — deploy Jinn-owned EVM app-chain rollup, migrate execution layer, transition window with both chains running.
- **Phase 2.2 (Base deprecation)** — sunset Base execution surface once operator gravity has shifted.
- **Phase 3+ (deferred indefinitely)** — sovereign rollup if triggers met.
- The staging is the launch commitment. The launch narrative names all three stages with their triggers; Phase 2.1 is a known-future event, not a possibility.

### 2.3 Phase 2.1 destination is a Jinn-owned EVM app-chain rollup with Ethereum settlement

- Stack TBD (open question A1).
- Settlement: Ethereum mainnet, via the chosen stack's canonical proof system.
- Pattern: app-chain rollup. *Not* sovereign rollup. *Not* custom L1. *Not* contracts on another L2.
- The chain at Phase 2.1 is "just an EVM chain with the relevant Jinn contracts deployed." Consensus carries no protocol-specific semantics. All protocol logic remains in EVM contracts. This preserves the composability principle from `PRINCIPLES.md`.

### 2.4 JINN is the gas token on the Phase 2.1 app-chain

- All transactions on the Jinn app-chain pay gas in JINN, from Phase 2.1 onward.
- Gas mechanics (burn / treasury route / validator split) are an open question (B2).
- Phase 2.0 transactions pay gas in ETH (Base default); JINN-as-gas demand sink begins at Phase 2.1.

### 2.5 Operator daemons may opt in as validators / sequencers at Phase 2.1; no separate "Jinn node" role

- The operator daemon is the node. There is no second node role.
- Validator / sequencer participation is **optional** at the operator level. Subset opt-in.
- Operators who opt in earn sequencer / validator revenue in addition to evaluation / restoration revenue.
- Opt-in mechanism is an open question (C-series).

### 2.6 Distributor pattern (per-chain, Ethereum-anchored) is preserved across all stages

- Distribution contracts remain per-chain.
- At Phase 2.1, a new distributor is added on the Jinn app-chain; the Base distributor remains during the transition window; it is removed at Phase 2.2.
- This is consistent with the existing three-layer architecture — only the *which chains have distributors* changes.

### 2.7 Migration from app-chain to sovereign rollup is deferred indefinitely

- Not in Phase 2 scope.
- Sovereignty triggers (open question G1) define the conditions under which this is reopened. Default assumption: Ethereum settlement is an asset (free credible-neutrality anchor during low-stake years), not a liability.

### 2.8 Migration triggers (Phase 2.0 → Phase 2.1) are defined before Phase 2.0 ships

- The trigger set must be **numerical and measurable**, not vibes. Phase 2.0 does not ship to mainnet until this set is ratified.
- The trigger conditions become part of canonical Phase 2 documentation. Phase 2.1 begins when the trigger set evaluates true.
- Candidate triggers (to be sized in open question J-series):
  - Operator count above N (sufficient to seed a genesis validator set with target decentralisation).
  - Sustained monthly on-chain transaction volume above V (sufficient to justify sequencer / MEV revenue capture).
  - Evaluator MEV / fee leakage to Base above X% of protocol revenue (binding extractive pressure).
  - Stack maturity gate (chosen stack's fraud / validity proofs have reached threshold maturity on mainnet).
  - Any combination AND / OR composition (to be decided).
- The trigger set may be amended via governance after Phase 2.0 launches, but the *existence* of a defined trigger set is non-negotiable before mainnet.

### 2.9 Phase 2.0 contracts are designed for portability *as a constraint*

- Phase 2.0 contract design includes "Phase 2.1 migration portability" as an explicit non-negotiable constraint, on par with security and gas efficiency.
- Concretely: no hard-coded Base block-time arithmetic, no Coinbase-bridge-specific fee assumptions, no assumed-immutable OLAS Mech Marketplace coupling, no chain-id-specific logic that doesn't have a migration switch.
- Where Phase 2.0 contracts depend on OLAS (Mech Marketplace, activity-checker, staking economics), the dependency surface is documented as a Phase 2.1 migration cost so the OLAS preserve-vs-shed question (D-series) can be answered with full visibility.
- Phase 2.0 PRs that introduce non-portable assumptions require explicit acknowledgement and justification in the PR body.

---

## 3. Architecture sketch

### 3.1 Phase 2.0 (mainnet launch)

```
Ethereum Mainnet                       Base (execution layer, Phase 2.0)
─────────────────                       ─────────────────────────────────
JINN ERC-20                             Mech Marketplace (OLAS)
Treasury                                JinnRouter
ve-JINN                                 ClaimRegistry
Distribution contract (Base)            ActivityChecker (OLAS-compatible)
DAO governance                          ERC-8004 IdentityRegistry
                                        x402 facilitator endpoints
                                        (operators run daemons against Base)
```

Substantively the current Phase 1a architecture, promoted to mainnet with the DAO + distribution layer activated on Ethereum.

### 3.2 Phase 2.1 (app-chain deployment, transition window)

```
Ethereum Mainnet               Base (execution, deprecating)    Jinn App-Chain (new, EVM, JINN gas)
─────────────────              ──────────────────────────────   ────────────────────────────────────
JINN ERC-20                    Mech Marketplace (OLAS)          Mech Marketplace (forked or replaced)
Treasury           ◄────────►  JinnRouter                       JinnRouter
ve-JINN          bridge        ClaimRegistry                    ClaimRegistry
Distribution (Base)            ActivityChecker                  ActivityChecker
Distribution (Jinn) ◄──────────────────────────────────────────► (proof posted to Ethereum settlement)
DAO governance                                                  Operator-validator opt-in module
                                                                ERC-8004 IdentityRegistry
                                                                x402 facilitator endpoints
```

Operators choose when to migrate during the transition window. Both distributors are live; emission allocation between Base and Jinn distributors is a governance call during the window.

### 3.3 Phase 2.2 (post-deprecation)

```
Ethereum Mainnet                        Jinn App-Chain (EVM, JINN gas)
─────────────────                        ──────────────────────────────
JINN ERC-20                              Mech Marketplace (Jinn-native)
Treasury                       bridge    JinnRouter
ve-JINN                  ◄────────────►  ClaimRegistry
Distribution (Jinn)                      ActivityChecker
DAO governance                           ERC-8004 IdentityRegistry
                                         x402 facilitator endpoints
                                         Operator-validator opt-in
```

Base distributor sunset. All execution on the Jinn app-chain.

### 3.4 Launch narrative commitment

The three-stage roadmap is part of the launch narrative, not buried. Concretely:

- `SPEC.md` Phase 2 section names all three stages with their triggers.
- `BRAND.md` and `GROWTH.md` launch messaging treats "we launch on Base, our chain ships at Phase 2.1, here are the triggers" as a feature (pragmatic, milestone-driven, bitter-lesson-aligned), not as a hedge.
- The launch-gating-criteria spec gains a Tech question covering chain architecture and confirming the staged roadmap is documented in canon.
- This addresses the common-knowledge-framing risk: the migration is pre-announced and trigger-bound, which reframes it as roadmap execution rather than mid-life pivot.

---

## 4. Open questions

Reorganised by **stage-binding** (when the question must be answered), not by topic. Each must have a documented answer by its binding stage, per the launch-gating-criteria pattern.

### 4.1 Must be answered before Phase 2.0 ships

#### J. Migration triggers (the §2.8 set)

- **J1.** Operator count threshold N — what number, and how is "operator" counted (Safe addresses, active daemons, staked operators)?
- **J2.** Transaction volume threshold V — measured how (gas units, tx count, USD-denominated fees), and over what window?
- **J3.** Fee / MEV leakage threshold X — measured how, and against what revenue denominator?
- **J4.** Stack maturity gate — defined how (proof-system production milestones, time-in-production minimums, third-party audit thresholds)?
- **J5.** Composition rule — does the trigger fire on ANY threshold met, ALL thresholds met, or a weighted combination?
- **J6.** Governance amendment process — how is the trigger set amended after Phase 2.0 launches; what's the bar?

#### K. Phase 2.0 portability constraints (the §2.9 surface)

- **K1.** Explicit list of Phase 2.0 contract patterns that are forbidden or require justification (Base block-time arithmetic, Coinbase-bridge assumptions, OLAS immutability, chain-id hard-coding, etc.).
- **K2.** PR review checklist for Phase 2.0 contract changes.
- **K3.** Documentation surface for OLAS dependency cost (so D-series can be answered with visibility).

#### F. Phase 1a → Phase 2.0 migration shape

- **F1.** Migration path from current Sepolia / Base Sepolia (Phase 1a) deployments to Phase 2.0 mainnet. Whether operator state, accumulated history, or contract addresses migrate, or whether Phase 2.0 mainnet is a clean start.
- **F2.** Whether Phase 1a testnet remains live during Phase 2.0 mainnet, or is sunsetted.
- **F3.** Genesis state of Phase 2.0 mainnet: any prefunded balances, any inherited state.

#### I. Operator experience (Phase 2.0 subset)

- **I1.** Whether operator UX surfaces the staged roadmap explicitly (e.g. "you are running Phase 2.0; Phase 2.1 will require a config change").
- **I2.** Whether existing Phase 1a operators need to take action to participate in Phase 2.0, or whether transition is operator-transparent.

### 4.2 Must be answered before Phase 2.1 ships

#### A. Stack choice

- **A1.** Which app-chain stack? Candidates: OP Stack, Arbitrum Orbit, Polygon CDK, zkSync stack, Linea, others. Differs on sequencer governance, fraud / validity proof maturity, ecosystem alignment, customisation surface, political dependencies.
- **A2.** Hosted vs. self-run sequencer at Phase 2.1 deployment. Hosted reduces operational load; self-run keeps sovereignty narrative honest.
- **A3.** Fraud-proof / validity-proof maturity acceptable for deployment (gates J4).

#### B. Token, gas, and bridge

- **B1.** JINN bridging architecture: canonical bridge of the chosen stack, or third-party (LayerZero, Hyperlane, Across). Trust assumptions, latency, governance tradeoffs.
- **B2.** Gas mechanics: burn, route to treasury, split with validators / sequencer, or hybrid. Tokenomics-shaping.
- **B3.** Bridge custody / governance — who controls upgrade keys, how they interact with DAO governance.

#### C. Validator / sequencer opt-in

- **C1.** Opt-in mechanism: stake commitment delta, hardware requirements, geographic distribution requirements.
- **C2.** Slashing surface for sequencer / validator misbehaviour. Interaction with existing operator slashing.
- **C3.** Interaction with OLAS staking activity-checker model — preserve unchanged, extend, or shed (overlaps D).
- **C4.** Revenue split: how sequencer / validator revenue is divided between opted-in operators, treasury, and broader operator set.
- **C5.** Initial genesis validator set composition — committed at Phase 2.1 deployment based on Phase 2.0 operator population.

#### D. OLAS dependency at Phase 2.1

- **D1.** Does Phase 2.1 preserve Mech Marketplace + JinnRouter contracts as-is (forked / redeployed on the app-chain), or replace with Jinn-native equivalents?
- **D2.** If preserved, does activity-checker compatibility transfer; if shed, what replaces the activity-checker model?
- **D3.** Migration path for Phase 2.0 operators whose tooling assumes OLAS contract surface.

#### E. MEV and fee market

- **E1.** MEV capture policy: no MEV (encrypted mempool / fair ordering), captured to treasury, distributed to operators, returned to users.
- **E2.** Fee market design: EIP-1559 default vs. alternative.
- **E3.** Treatment of priority fees / sequencer tips.

#### L. Phase 2.0 → 2.1 migration mechanics

- **L1.** Transition window length: when does the Jinn app-chain go live, when does Base distributor sunset.
- **L2.** Emission allocation between Base and Jinn distributors during the transition window.
- **L3.** Operator migration mechanism: opt-in cutover, mass cutover, gradient incentives.
- **L4.** Active claim / restoration / evaluation state: does it drain, transfer, or fork.
- **L5.** Artifact discoverability across both chains during the transition (subgraph / Discovery API).

#### I (continued). Operator experience for Phase 2.1

- **I3.** Validator opt-in surface: SPA, CLI, both, or neither.
- **I4.** Migration UX: how operators are notified, what action they take, how state continuity is preserved.

#### H. Composability across chains

- **H1.** Cross-chain composability for protocols integrating with Jinn from other chains. Canonical bridges, message-passing primitives, third-party reliance.
- **H2.** Read access: where the subgraph / Discovery API runs, how indexers serve cross-chain reads during and after transition.

### 4.3 Deferred indefinitely (Phase 3+)

#### G. Sovereignty triggers

- **G1.** Conditions justifying consensus migration off Ethereum settlement. Candidate triggers: validator stake weight crosses threshold, settlement cost exceeds % of protocol revenue, Phase B.2 wants consensus-level integration.
- **G2.** Conditions justifying Phase B.2 evaluator economics moving into consensus ("chain is the protocol").

---

## 5. Impact on canonical docs

If ratified, this spec requires updates to:

- **`SPEC.md`** — Phase 2 description rewritten from "Mainnet launch — multi-chain (Base, Arbitrum)" to the three-stage roadmap. All three stages named with their triggers from §2.8.
- **`PRINCIPLES.md`** — no change required. Composability preserved (EVM throughout); minimum viable extraction preserved (no new extraction surfaces added at any stage).
- **`OPERATOR-APP-SPEC.md`** — validator / sequencer opt-in surface added on the Operator component (state, state messages, actions); annotated as Phase 2.1 surface.
- **`BRAND.md`** — paragraph on the staged roadmap as part of the launch narrative. Plain language, not vow-language. Three stages, triggers, destination.
- **`GROWTH.md`** — review whether the staged shape changes the GTM sequence or target cluster (likely small impact; needs explicit confirmation).
- **`GLOSSARY.md`** — entries for "Jinn app-chain", "operator-validator", "Phase 2.0 / 2.1 / 2.2 stage" terminology.
- **`spec/2026-05-14-launch-gating-criteria.md`** — add a Tech-series question covering chain architecture, confirming the staged roadmap is documented in canon and J-series triggers are ratified.

---

## 6. What this spec does *not* do

To keep this draft surgical:

- Does **not** pick a stack (A-series).
- Does **not** size the migration triggers — only commits to their existence (J-series).
- Does **not** design the validator opt-in mechanism (C-series).
- Does **not** resolve OLAS preserve-or-shed (D-series).
- Does **not** specify gas mechanics or MEV policy (B2, E-series).
- Does **not** write the Phase 1a → 2.0 migration plan or the Phase 2.0 → 2.1 migration plan (F, L-series).
- Does **not** change DAO architecture, token contract, ve-JINN, or distribution contracts in any way.
- Does **not** reopen the "consensus is the protocol" question (Phase B.2 matter).
- Does **not** commit to a Phase 2.1 calendar date — triggers, not dates.

Each open question is a candidate child spec or design-record once the ratified decisions in §2 are accepted.

---

## 7. Discussion prompts

For reviewers of this draft:

1. Do the ratified decisions in §2 hold? Any that should be downgraded to open questions, or any that should be tightened?
2. Is §2.1 ("DAO permanently on Ethereum") the right durability commitment? It's the load-bearing call that makes the staged shape cheap; if it's softened, the staging argument weakens.
3. Are the candidate triggers in §2.8 the right shape? Anything missing? Anything that shouldn't be there?
4. Is §2.9 (portability as a Phase 2.0 constraint) operationally enforceable, or does it need more teeth (e.g. an automated lint rule, a designated portability reviewer)?
5. Is the staged shape preferable to launching directly on the app-chain at Phase 2.0 (v0.1 of this spec)? The trade is launch-narrative crispness for validator-bootstrap safety and stack-choice optionality.
6. Is the open-question set in §4 complete? What's missing?
7. Is operator UX (I-series) underspecified given that the migration is operator-visible?
