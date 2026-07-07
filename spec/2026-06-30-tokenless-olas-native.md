# Tokenless, OLAS-native Jinn

- **Version:** 0.1 — DRAFT (not ratified)
- **Date:** 2026-06-30
- **Author:** Jinn contributor (drafted with Opus)
- **Status:** DRAFT pending governance sign-off. Per `CLAUDE.md` → Canonical Docs and Spec Conventions, promotion to canon requires a GitHub Discussion + CODEOWNERS approval. This spec is the public, implementation-grounded promotion of a private design brief (`.local/protocol/2026-06-29-tokenless-olas-native.md`); the detailed contributor-risk analysis behind the decision is kept in that private brief by design.
- **Decision record:** `log/decisions/2026-06-30-tokenless-olas-native-pivot.md` (DR-2026-06-30).
- **Supersedes / sets aside:** `spec/2026-06-05-independent-blockchain-launch.md`, `spec/2026-05-24-phase-2-chain-architecture.md` (sovereign-chain + multi-chain ZK-distribution direction); consciously reverses `DR-2026-06-04` (OLAS staking as non-load-bearing substrate); drops the Phase 1a fair-launch JINN tokenomics. See the DR for the full reversal inventory.

---

## Summary (read this first)

**Jinn does not launch its own token, and does not run its own chain. OLAS is the permanent economic layer; Jinn runs natively on OLAS (Base).** Operators earn **OLAS** for doing verified work in the loop. The JINN-token economy, the bespoke task-coordination stack, and the sovereign-chain direction are removed.

**The protocol in one breath:** a **SolverNet launcher** funds tasks toward a goal (build a knowledge corpus / optimise agents at an objective). **Solvers** and **Evaluators** stake on OLAS at zero capital (via the stOLAS distributor) and earn OLAS. The loop is launcher-funded **Create → Solve → Evaluate → Learn**. A solver's work "counts" once it has been evaluated — *any* verdict — which is a **loop-completion** gate, not a quality gate. Quality and the get-better incentive are deferred to a future **knowledge-pricing** layer. The only Jinn-custom on-chain code is **one activity checker + one thin recorder**; everything else is OLAS-native.

This is an instance of the knowledge-market substrate framing (DR-2026-04-30): the loop and the knowledge corpus are preserved; what changes is that the reward unit is OLAS, not a native token, and coordination is OLAS-native rather than bespoke.

---

## 1. Decision

1. **No JINN token.** OLAS is the unit of both stake and reward.
2. **No sovereign chain.** Jinn runs natively on OLAS infrastructure on Base; it inherits OLAS's economic and security base rather than bootstrapping its own.
3. **Operators earn OLAS for completed-loop work**, gated on loop completion (a verdict), through OLAS staking liveness and the launcher-funded marketplace delivery fee.
4. **Bespoke on-chain surface collapses to two small contracts** — one activity checker and one thin recorder — with everything else (marketplace, service/mech/Safe infra, the stOLAS distributor, the staking proxy, veOLAS nomination) being OLAS-native and unmodified.

## 2. Rationale

- **Radical simplicity.** The bespoke surface goes from *(TaskCoordinator + JinnRouterV3 + TaskActivityCheckerV3 + JINN token + Distributor + Governor/ve-JINN + the L2→L1 cross-chain claim stack)* to **one checker + one recorder.** Less to build, audit, secure, and govern.
- **Regulatory and operational clarity.** No token means no issuer, no token-distribution surface, and no money-movement apparatus to operate. No sovereign chain means no cold-start chain-security problem. These remove entire categories of legal, operational, and security risk for contributors *by absence* rather than by engineering around them. The detailed risk analysis is recorded in the private design brief; this spec states risk-minimization as a primary design driver without restating that analysis publicly.
- **Leverage a live economic layer.** OLAS already provides emissions, staking, veOLAS nomination, and a zero-capital onboarding rail (stOLAS). Jinn uses it directly instead of re-deriving an equivalent.
- **The conscious trade.** Running on OLAS means *renting* legitimacy from the OLAS ecosystem rather than *owning* it via sovereignty. This spec accepts that trade deliberately: contributor-safety, shipping now, and radical simplicity over self-rooted legitimacy. This reverses the prior sovereign-chain position and is the crux the decision record asks governance to ratify.

## 3. The protocol (implementation-free)

**Purpose.** Produce verified agentic work, turn each task into a learning signal that improves future work, and reward the doers — in OLAS. A training loop wearing a task-market's clothes.

**Roles** (roles, not people; one operator can play several under distinct identities):
- **Launcher / Creator** — launches a SolverNet with a goal and **funds the tasks**. The demand side. Wants the output (a knowledge corpus / optimised capability). Does not stake or earn from staking.
- **Solver** — does a task; submits a result + evidence. Stakes; earns OLAS.
- **Evaluator** — judges a result against the goal; issues a verdict. Stakes; earns OLAS.

**The loop** (one task's life):
1. **Create** — launcher posts a funded goal + acceptance criteria + how many attempts.
2. **Solve** — solver(s) claim and submit results (1 = single solver-of-record; N = competition, richer comparative signal). Attempt-count is creator-funded.
3. **Evaluate** — evaluator(s) judge → verdict(s) recorded.
4. **Learn** — the `(task, solution, verdict)` record accumulates as the knowledge corpus.

**What the protocol guarantees (on-chain enforceable):** distinct identities; a solver cannot judge its own solution (self-eval prevention); reward flows only to identities that completed real loops; task / evidence / verdict are publicly recorded (legible).

**What it does NOT guarantee (stated plainly — Legibility):** *independence* (distinct addresses ≠ distinct people; Sybil is possible); *correctness* (nothing on-chain proves a result is right). It mitigates both (self-eval prevention, novelty/anti-farming, optional consensus-outlier, small prizes, OLAS eviction) — it does not eliminate them.

## 4. Economic model (tokenless)

- **No JINN token.** OLAS is the permanent unit of reward and stake.
- **Reward is for *completed-loop activity*, not for passing.** A solver's activity counter increments once their solution has *any* verdict (a **loop-completion gate**); an evaluator's increments on delivering a verdict. The Pass/Fail outcome is *recorded* (knowledge + reputation) but **does not gate OLAS** — chosen deliberately so a wrong or malicious Fail can never deny a solver their earnings, and so no challenge mechanism is required at v0.
- **Two reward streams:**
  1. **OLAS staking emissions** (free to Jinn, from Jinn's veOLAS directed to its nominee) — the **bootstrap subsidy**. Rewards completed loops via staking liveness.
  2. **Launcher funding** (the marketplace delivery fee the launcher escrows per task) — the **real economy**. Grows as launchers show up; over time it, not the subsidy, sustains the network.
- **Zero-capital onboarding via stOLAS.** Operators stake through the stOLAS `ExternalStakingDistributor`: the bond is *lent* from the depositor pool, the operator is recorded as the **curating agent** and keeps the curating-agent share (≈85% of staking rewards per the live proxy config), funding only ~$15–30 of ETH for gas. No OLAS locked.
- **Verdict gating is cheap, not an escrow.** Gating the *free* stream (the staking counter) on "has a verdict" is done by **delaying the counter increment** in the recorder until a verdict lands — no escrow, no clawback. The *funded* stream (the marketplace delivery fee the launcher escrows) is inherently pay-on-delivery and stays ungated; the marketplace cannot gate it, which is correct — it is the delivery fee, not the quality reward.
- **Quality / get-better incentive is deferred to knowledge-pricing.** "Useful knowledge has a price" becomes the pull toward better work, *later*. For now, quality is carried by (a) the launcher's self-interest — they stop funding SolverNets that produce junk — and (b) reputation.

## 5. Roles & funding in detail

- **The launcher is the engine.** It has a goal and funds tasks because it wants the output. This makes the economy *demand-funded*, not a subsidy treadmill, and makes the launcher's self-interest a built-in quality control: a launcher won't keep funding junk.
- **Solvers / Evaluators are supply.** They stake once (one shared staking contract — see §7), do whatever work is available (role is *per-task*, not per-operator), and earn from both streams.
- **Subsidy bootstraps, demand sustains.** OLAS emissions keep operators earning before launcher demand is thick; as real launchers fund real goals, the demand stream takes over and the subsidy can recede.
- **Residual to watch (disclose):** the *subsidy* stream is farmable independent of any launcher's satisfaction — a colluding solver↔evaluator ring can complete junk loops and draw OLAS staking liveness (self-eval prevention stops one operator double-dipping a single task, not a two-operator ring). Held off by novelty-decay + small prizes + OLAS eviction + (eventually) knowledge-pricing; not eliminated.

## 6. SolverNets

- A **SolverNet is an off-chain manifest** (IPFS CID), launched by a launcher with a goal. There is no first-class on-chain SolverNet object.
- The launcher's **generator posts funded tasks** for the SolverNet (the existing launched-record-driven generator model — see `spec/2026-05-05-solvernet-creation-and-launch.md`).
- **Operators join by manifest CID** (`joinedSolverNets[<manifestCid>]`), shared across the single staking contract. The indexer attributes requests/deliveries to a SolverNet by the CID carried in the request blob.
- **Per-SolverNet staking contracts are a deferred lever** — only when a SolverNet nears the 100-slot cap or genuinely needs a different reward rate / liveness bar. Not v0.

## 7. On-chain architecture — deliberately tiny

**Keep (OLAS-native, zero Jinn-custom):**
- **Mech Marketplace** — delivery transport + per-delivery fee + delivery counter. Matching is **first-delivery-wins** (no off-chain lock manager needed).
- **OLAS service / mech / Safe** infrastructure + the **stOLAS `ExternalStakingDistributor`** (bond-lending + curating-agent split).
- **One OLAS staking contract** (the existing proxy) with one activity checker. Solving *and* evaluating both count toward one liveness target — no need to split solver / evaluator into separate contracts until their reward rates need independent tuning (a deferred lever).
- **veOLAS nomination** path (Jinn directs its veOLAS to this one nominee to fund the emissions stream).

**Keep (the only Jinn-custom code — small):**
- **One activity checker** (`TaskActivityCheckerV3`, `DeliveryActivityChecker` lineage): counts completed-loop activity toward OLAS staking liveness, exposing `getMultisigNonces` / `isRatioPass` / `eligibleActivityWeight` for the OLAS staking checkpoint. Optional cheap quality (novelty-decay on solutions, consensus-outlier decay on verdicts) is stubbed at v0 and re-addable in place.
- **One thin recorder** (`TaskCoordinator` + `JinnRouterV3`, trimmed): anchors each `(task, solution, verdict)` tuple on-chain (knowledge + legibility), enforces self-eval prevention (evaluator ≠ solver per task, behind a network-keyed toggle — see §7.1), and **sequences solver credit** (solve → *pending* → first verdict → credit). It gates no payout; its job is loop-completion sequencing + knowledge integrity, not money. The launcher's per-task delivery-fee escrow is retained on the router (it funds the demand stream; it is not a quality escrow).

**Delete (the token's gravity + the bespoke coordinator overhead):**
- `JINN.sol`, `JinnDistributor`, `JinnGovernor` / ve-JINN, Treasury emissions, and the entire L2→L1 cross-chain claim stack (`TaskClaimEmitter`, messengers, bridge processors).
- The heavy policy apparatus inside `TaskCoordinator` + `JinnRouterV3` — claim windows, lease TTLs, attempt finalization, quorum / pass-threshold gating, the per-operator claim caps — collapsed so the recorder does loop-completion sequencing only.

### 7.1 Self-evaluation toggle

Self-eval prevention (a solver cannot evaluate its own solution) is enforced by the recorder via a `TaskPolicy.allowSolverSelfEvaluation` flag, **default false (blocked)** — the design-aligned, mainnet-safe posture. A testnet SolverNet / harness may set it `true` so a single operator can close the loop solo for dogfooding and CI. The reward unit and loop are identical either way; only the distinct-evaluator requirement relaxes on testnet.

## 8. Off-chain

- **Indexer** — discovery + SolverNet attribution (reads the manifest CID from request blobs). Read-side only — *not* a write-side lock manager, which is more Neutral than a Control-API.
- **Harness + generators** — as today.
- **Claim coordination** — none needed: the marketplace's first-delivery-wins *is* the claim resolution.

## 9. Knowledge

**Recorded now, priced later.** Each verified `(task, solution, verdict)` tuple is anchored on-chain by the recorder and published/addressable — so the *future* knowledge-economics has a clean, legible object to price. The economics are deferred; the substrate is produced from day one. This is the eventual home of the quality / get-better incentive — Learning Maximised expressed on top of the substrate rather than baked into consensus.

## 10. Network

Two-tier: **testnet** (Base Sepolia) = dev / CI, with faucet'd or mock OLAS for plumbing; **Base mainnet** = the *only* real economy (where OLAS emissions, veOLAS, the staking proxy, and the stOLAS pool actually exist).

## 11. Economic reality (honest)

At **OLAS ≈ $0.028** (2026-06-29): one staking slot ≈ **1,233 OLAS/mo (~$35)**; the curating agent keeps ≈85% ≈ **~$29/mo/slot**; the 100-slot program caps at ~123k OLAS/mo (~$3,500/mo total network). This is **supplemental income, not a wage** — rescued for *breadth* by zero operator capital (the capital ROI is effectively infinite; the cost is compute + gas). **Depth** must come from the **launcher-funded** stream. The protocol is sound *iff* launchers actually fund tasks; without funded demand, operators earn OLAS for busywork and (with on-chain anti-farming stubbed at v0) little stops it.

## 12. Honest residuals / what this does NOT guarantee

- **Independence / Sybil** — the chain proves distinct addresses, not distinct parties.
- **Correctness** — nothing on-chain proves a result is right; this rests on honest evaluators.
- **Collusion ring on the subsidy stream** — see §5 residual.
- **Evaluator quality** ("who evaluates the evaluators") — mitigated by self-eval prevention + (optional) quorum + consensus-outlier; a colluding majority is the irreducible trust assumption.
- **Legibility downgrade vs the prior token design** — you can prove "a loop completed," not "this was verified correct and rewarded accordingly." Disclose in any external framing.
- **Dependencies Jinn does not control** — OLAS emission policy; the stOLAS distributor config (the curating-agent split, the permissionless staking guard) and depositor capital; veOLAS upkeep (a missed lock-extension silently zeroes the emissions stream).

## 13. Implementation status (proven on testnet)

The pivot is not only specified but implemented and proven on Base Sepolia (uncommitted, on `next`, as of 2026-06-30):

- **JINN-token economy deleted** (Track 1): `JINN.sol`, `JinnDistributor`, ve-JINN / governor, Treasury emissions, and the L2→L1 cross-chain claim stack removed; client reward surface flipped from JINN to OLAS.
- **Contracts trimmed + re-deployed** (Track 2): `TaskActivityCheckerV3` stubbed to a flat completed-loop credit with **all storage slots preserved** (`eligibleActivityWeight` stays at slot 16 — the OLAS checkpoint slot — so the checker upgraded **in place** with no operator re-stake); `TaskCoordinator` / `JinnRouterV3` policy apparatus removed while preserving the request↔task↔attempt↔verdict linkage, the `recordVerdict` return tuple, and the launcher delivery-fee escrow. Deployed live on Base Sepolia (coordinator `0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98`, router `0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247`, checker impl `0x3f061273348264b2a1Ae584eCC614185748832a8` on proxy `0x0e1B5f264F4FAdcFAA950fb00c58d9A39C040f70`).
- **Verdict-gated reward proven end-to-end** (Track 3): a live mock-market smoke ran the full loop on the trimmed stack — solve → verdict (requestId `0xd90bf4e7…`) → OLAS staking checkpoint credit → stOLAS `distributor.claim` (`reward_claimed` tx `0x787f1a143d49b482e3752500f86b3319f54799de6a00e33db13a90a11e5ad5b5`, ≈0.011 OLAS-as-JINN pre-split, operator curating-agent share). The operator's `eligibleActivityWeight` (read by the OLAS checkpoint via `getMultisigNonces`) is the loop-completion credit; **no JINN was minted anywhere**.

**What this does not yet prove:** testnet only; a single operator played both roles via the `allowSolverSelfEvaluation` testnet toggle; the market was a mock fixture; and the substrate used JINN-as-OLAS as the OLAS stand-in on Base Sepolia (canonical OLAS, emissions, and veOLAS are mainnet-only realities). Mainnet still runs the legacy marketplace-native model.

## 14. Open questions / roadmap

1. **Evaluator-quality controls** (quorum + consensus-outlier) — optional at v0, likely needed once volume rises. Cheap; lives in the checker / recorder.
2. **Challenge mechanism (Phase B.2)** — deliberately *avoided* at v0 because the gate is "any verdict," not "pass." If a Pass-gate is ever introduced, this becomes required.
3. **Knowledge-pricing design** — the future economics that turns the corpus into the get-better incentive. A separate design.
4. **Migration of live mainnet operators** — from the current shape to the consolidated (staking + recorder) shape.
5. **veOLAS sizing & custody** — who holds and extends the lock that funds the emissions nominee. veOLAS economics here are doc-sourced and **not** re-verified on Ethereum L1; verify before committing the funding plan.
6. **Testnet OLAS** — faucet vs mock, since emissions are a mainnet-only reality.

## Appendix — on-chain grounding (Base mainnet, chain 8453, verified 2026-06-29)

- **OLAS token:** `0x54330d28ca3357F294334BDC454a032e7f353416` — live price ≈ **$0.0284**.
- **Mech Marketplace:** proxy `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` → impl `MechMarketplace` v1.1.0 `0x155547857680A6D51bebC5603397488988DEb1c8`. **15% protocol fee** (`fee=1500`); response timeout 60–300 s; content-blind pay-on-delivery; first-delivery-wins.
- **Staking proxy:** `0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54` — `maxNumServices=100`, `minStakingDeposit=5000 OLAS`, `rewardsPerSecond=475646879756468` (≈1,233 OLAS/slot/mo), `availableRewards ≈ 108,898 OLAS`, 2/100 slots used.
- **Activity checker proxy:** `0x477C41Cccc8bd08027e40CEF80c25918C595a24d`.
- **stOLAS `ExternalStakingDistributor`:** proxy `0x40abf47B926181148000DbCC7c8DE76A3a61a66f` → impl `0xDAE0B11e5bF81216283cB95d30039fA3D650eFE3`. Config word `549772593280000` decodes to **curating-agent 85% / protocol 10% / collector 5%, staking guard `0x0` (permissionless)**. ~890k OLAS liquid in the distributor (~89 stakes of headroom). `stake()` lends `minStakingDeposit × 2 = 10,000 OLAS` and records the caller as curating agent.
- **veOLAS / emissions (doc-sourced, NOT re-verified on L1):** VoteWeighting `0x95418b46d5566D3d1ea62C12Aea91227E566c5c1` (Ethereum); Dispenser `0xeED0000fE94d7cfeF4Dc0CA86a223f0F603A61B8`. The Jinn proxy is a registered nominee.
- **Precedent:** the legacy `DeliveryActivityChecker` read marketplace `mapDeliveryCounts` directly to feed OLAS staking liveness — the marketplace-native model ran in production.
- **Confidence flags:** the mainnet `JinnRouter` `0xfFa7118A3D820cd4E820010837D65FAfF463181B` is unverified on Blockscout; the trimmed `TaskCoordinator` / `JinnRouterV3` / `TaskActivityCheckerV3` stack is **testnet (Base Sepolia)**, not mainnet.
