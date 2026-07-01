---
id: DR-2026-06-30
title: Jinn goes tokenless and OLAS-native — drop the JINN token and the sovereign chain; operators earn OLAS for completed-loop work
date: 2026-06-30
verb: Decide
status: ratified
authors: opus (drafted), Ritsu (steer); ratified on a CODEOWNER's sign-off on the conscious trade — 2026-07-01
spec: spec/2026-06-30-tokenless-olas-native.md
amends: "spec/2026-06-05-independent-blockchain-launch.md (sovereign Cosmos chain — set aside); spec/2026-05-24-phase-2-chain-architecture.md (DAO-on-Ethereum / multi-chain ZK distribution — set aside); spec/2026-06-08-substrate-spike-cosmos-evm.md (substrate choice — moot); spec/2026-06-10-genesis-condition.md (token-on-sovereign-chain genesis gates — moot); DR-2026-06-04 (OLAS staking as non-load-bearing substrate — consciously reversed); spec/2026-04-06-phase-1a-design.md + docs/superpowers/plans/2026-04-06-phase-1a-tokenomics.md (fair-launch JINN tokenomics — dropped); SPEC.md §Tokenomics + GROWTH.md §economic framing (JINN-token mechanics — to be rewritten via Discussion + CODEOWNERS)"
relates-to: spec/2026-06-30-tokenless-olas-native.md (the design); .local/protocol/2026-06-29-tokenless-olas-native.md (private design brief + detailed contributor-risk analysis); .local/protocol/DESIGN-PROPOSAL.md (the superseded converged sovereign-token design); DR-2026-04-30 (knowledge-market substrate framing — preserved); GitHub Discussions [#59](https://github.com/Jinn-Network/mono/discussions/59) (substrate vision) + [#57](https://github.com/Jinn-Network/mono/discussions/57) (paired GTM)
---

> **Ratified 2026-07-01 on a CODEOWNER's sign-off.** A CODEOWNER has agreed the conscious trade (rent vs own legitimacy); per this DR's own framing the public DR is the ratification artifact, and the decision was implemented and proven on testnet before ratification (see Consequences → Implementation status). The canonical-doc rewrites it implies (SPEC.md §Economics, GLOSSARY.md, README, CLAUDE.md — GROWTH.md needed none) are drafted in the accompanying PR (#1297 → `next`) and take CODEOWNERS review there; GitHub Discussion #1299 anchors the public record per `spec/2026-04-28-canonical-docs.md`.

## Context

For most of 2026 the forward roadmap converged on a **native token on a sovereign chain**. The lineage:

- **Phase 1a** (`spec/2026-04-06-phase-1a-design.md`, `docs/superpowers/plans/2026-04-06-phase-1a-tokenomics.md`) shipped a fair-launch JINN token + DAO + distribution contracts on Sepolia / Base Sepolia.
- **Phase 2 chain architecture** (`spec/2026-05-24-phase-2-chain-architecture.md`) placed the DAO permanently on Ethereum with multi-chain, ZK-requiring distribution.
- That was then re-opened toward **sovereignty**: an independent JINN chain (`spec/2026-06-05-independent-blockchain-launch.md`), a substrate spike that settled on Cosmos EVM (`spec/2026-06-08-substrate-spike-cosmos-evm.md`), and genesis-condition gates (`spec/2026-06-10-genesis-condition.md`).
- The fullest expression is the private converged design (`.local/protocol/DESIGN-PROPOSAL.md`, v0.39) — the product of 45+ adversarial design runs plus a parallel design convergence by another contributor. Its standing observer constraints included **contributor safety** (minimise builders' legal / regulatory / financial / physical exposure) and **year-1000 viability**.

Reading the converged design's own residual list surfaces an undeniable pattern: **nearly every hardest-won residual is token-induced legal and operational exposure**, and a large fraction of the design's complexity exists to *temporarily* neutralise risks the token itself creates (cold-start mechanisms that clear those risks "by absence" only at launch). The detailed contributor-risk analysis is held in the private brief (`.local/protocol/2026-06-29-tokenless-olas-native.md` §0) and is deliberately not restated in this public DR.

Meanwhile the execution substrate has, since Phase 0, been **OLAS** (Base): the Mech Marketplace, OLAS service / mech / Safe infra, an OLAS staking proxy + activity checker, veOLAS nomination, and the stOLAS `ExternalStakingDistributor` that already provides **zero-capital onboarding** (the bond is lent; the operator is recorded as curating agent and keeps ≈85% of staking rewards). DR-2026-06-04 had taken the opposite stance — that OLAS staking was non-load-bearing Phase-0 substrate to deprecate. This DR reverses that.

## Decision

**Jinn does not launch its own token, and does not run its own chain. OLAS is the permanent economic layer; Jinn runs natively on OLAS (Base). Operators earn OLAS for verified, completed-loop work.**

1. **No JINN token.** OLAS is the unit of both stake and reward. The JINN ERC-20, `JinnDistributor`, `JinnGovernor` / ve-JINN, Treasury emissions, and the L2→L1 cross-chain claim stack are deleted.
2. **No sovereign chain.** Jinn inherits OLAS's economic and security base on Base rather than bootstrapping its own chain. The Cosmos-EVM / genesis line of work is set aside.
3. **Reward is for completed-loop activity, gated on a verdict, not on passing.** A solver's OLAS staking-activity counter increments once their solution has *any* verdict (a **loop-completion gate**); an evaluator's increments on delivering a verdict. Pass/Fail is recorded (knowledge + reputation) but does not gate OLAS — so a wrong or malicious Fail can never deny a solver their earnings, and no challenge mechanism is required at v0. Two reward streams: OLAS **staking emissions** (the bootstrap subsidy) and **launcher funding** (the per-task marketplace delivery fee the launcher escrows — the real, demand-funded economy).
4. **The bespoke on-chain surface collapses to two small contracts** — **one activity checker** + **one thin recorder** — with everything else OLAS-native and unmodified. The recorder anchors each `(task, solution, verdict)` tuple (knowledge + legibility), enforces self-eval prevention, and sequences solver credit (solve → pending → first verdict → credit); it gates no payout. The launcher delivery-fee escrow is retained on the router as the funded-stream mechanism (it is not a quality escrow).

**The conscious trade (the crux to ratify).** Running on OLAS means *renting* legitimacy from the OLAS ecosystem rather than *owning* it via sovereignty. This reverses the prior sovereign-legitimacy position. We accept it deliberately: contributor-safety + shipping-now + radical simplicity over self-rooted legitimacy — *given* that the legitimacy prize was reachable only through a token/chain that carries significant legal and regulatory risk to contributors. This trade is what a CODEOWNER must sign off on for the DR to ratify.

The full design is `spec/2026-06-30-tokenless-olas-native.md`.

## Consequences

**Deleted (the token's gravity + bespoke-coordination overhead):** `JINN.sol`, `JinnDistributor`, ve-JINN / governor, Treasury emissions, the entire L2→L1 cross-chain claim stack (`TaskClaimEmitter`, messengers, bridge processors); and the heavy policy apparatus inside `TaskCoordinator` / `JinnRouterV3` (claim windows, lease TTLs, attempt finalization, quorum / pass-threshold gating, per-operator claim caps).

**Kept:** the loop discipline (distinct parties; a single address rewarding its own task is a faucet, not coordination); evaluation, kept *for knowledge and legibility*, not for pay-gating; the corpus / learning thesis (expressed atop the substrate via future knowledge-pricing); on-chain legibility (verdicts/records anchored on-chain); the launcher delivery-fee escrow; and **contributor safety achieved structurally by absence** rather than engineered around.

**The reward surface flips JINN → OLAS** across the client (dashboard "earned" figure, status build, claim loop): the stOLAS `RewardClaimLoop` becomes the sole reward path; the JINN-claim loop is removed.

**Economic reality (honest).** At OLAS ≈ $0.028, one staking slot ≈ ~$35/mo (curating agent keeps ≈85% ≈ ~$29/mo/slot); the 100-slot program caps at ~$3,500/mo total network. This is **supplemental income, not a wage** — rescued for breadth by zero operator capital; **depth must come from the launcher-funded stream.** The protocol is sound *iff* launchers actually fund tasks; with on-chain anti-farming stubbed at v0, undirected subsidy can be farmed.

**Residuals (disclose — see spec §12):** Sybil / independence (chain proves distinct addresses, not distinct parties); correctness (nothing on-chain proves a result right; rests on honest evaluators); a two-operator solver↔evaluator collusion ring on the subsidy stream (self-eval prevention stops single-operator double-dipping, not a ring); evaluator quality (irreducible colluding-majority trust assumption); a **legibility downgrade** vs the token design (you can prove "a loop completed," not "this was verified correct and rewarded accordingly"); and **dependence on OLAS** (emission policy, the stOLAS distributor config + depositor capital, veOLAS upkeep — a missed lock-extension silently zeroes the emissions stream).

**Implementation status — already proven on Base Sepolia (uncommitted, on `next`, 2026-06-30).** This DR documents a decision that has been executed and validated end-to-end:
- *JINN-token economy deleted* (Track 1); client reward surface flipped to OLAS.
- *Contracts trimmed + re-deployed* (Track 2): the checker stubbed to a flat completed-loop credit with **all storage slots preserved** (`eligibleActivityWeight` at slot 16 — the OLAS checkpoint slot — upgraded **in place**, no operator re-stake); coordinator / router policy apparatus removed with the request↔task↔attempt↔verdict linkage, the `recordVerdict` tuple, and the delivery-fee escrow preserved. Live: coordinator `0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98`, router `0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247`, checker impl `0x3f061273348264b2a1Ae584eCC614185748832a8` on proxy `0x0e1B5f264F4FAdcFAA950fb00c58d9A39C040f70`.
- *Verdict-gated reward proven* (Track 3): a live mock-market smoke ran solve → verdict (requestId `0xd90bf4e7…`) → OLAS staking checkpoint credit → stOLAS `distributor.claim` (`reward_claimed` tx `0x787f1a143d49b482e3752500f86b3319f54799de6a00e33db13a90a11e5ad5b5`, ≈0.011 OLAS-as-JINN pre-split, operator curating-agent share). **No JINN minted anywhere.** What it does not yet prove: testnet only; single operator both roles via the `allowSolverSelfEvaluation` testnet toggle; mock market; JINN-as-OLAS substrate (canonical OLAS / emissions / veOLAS are mainnet-only). Mainnet still runs the legacy marketplace-native model.

## Alternatives considered (rejected)

1. **Keep the converged sovereign-token design (`DESIGN-PROPOSAL.md` v0.39).** It is excellent and its *reasoning* is preserved here — but its hardest residual stack is token-induced contributor exposure, and no amount of cold-start mechanism removes that permanently; it only defers it. Rejected because the simplest durable answer to the design's *own* hardest problem is to remove the token.
2. **Native token, but no sovereign chain (token on Base/L2).** Rejected: the token is the gravity source — issuer surface, distribution apparatus, and the money-movement pipeline persist regardless of which chain it lives on.
3. **Sovereign chain, but no token.** Rejected: a chain with no native economic base inherits a cold-start security deficit with nothing to pay validators/security, and provides no operator reward unit — strictly worse than renting OLAS's live base.
4. **Status quo: Phase-A-on-OLAS but keep JINN for governance/incentives.** Rejected: still carries the issuer surface and the dual-economy complexity (JINN incentives layered over OLAS execution) for no benefit the OLAS rail doesn't already provide (staking emissions + zero-capital onboarding + nomination governance).

## Why this shape

The tokenless-OLAS move clears the converged design's hardest residuals **the way that design cleared them only at cold-start — by absence — but permanently, and without the machinery.** No token → no issuer → no distribution apparatus → no securities surface. No sovereign chain → no cold-start security deficit (you inherit OLAS's). Contributor safety, the converged design's hardest-won goal, becomes structural rather than engineered. And it leverages a **live** economic layer (OLAS emissions, staking, veOLAS, stOLAS zero-capital onboarding) instead of re-deriving an equivalent — shrinking the bespoke on-chain surface from seven contract families to **two**. The knowledge-market substrate framing (DR-2026-04-30) is preserved intact: the loop and the corpus stand; only the reward unit and the coordination layer change.

## Reversal inventory & supersession actions

Recorded here as the **reversals** artifact. The in-place edits below are **applied at ratification**, not now — spec and canonical-doc changes route through Discussion + CODEOWNERS (`spec/2026-04-28-canonical-docs.md`). Until then the superseded docs stand unmodified and this DR is the single record of intent.

**A. Specs to mark superseded** — prepend the repo's standard supersession blockquote at the top of each:

> **Status (2026-06-30): superseded by DR-2026-06-30 (tokenless, OLAS-native).** Jinn drops the native token and the sovereign chain; OLAS is the economic layer. For the current direction read `spec/2026-06-30-tokenless-olas-native.md` and `log/decisions/2026-06-30-tokenless-olas-native-pivot.md`.

| Doc | Why superseded |
|---|---|
| `spec/2026-06-05-independent-blockchain-launch.md` | Sovereign Cosmos chain + native JINN from genesis — set aside (native-on-OLAS instead of own chain). |
| `spec/2026-05-24-phase-2-chain-architecture.md` | DAO-on-Ethereum / multi-chain / ZK distribution — set aside (no DAO token, no own distribution). |
| `spec/2026-06-08-substrate-spike-cosmos-evm.md` | Substrate choice for a sovereign chain — moot (no sovereign chain). |
| `spec/2026-06-10-genesis-condition.md` | Genesis gates for a token-on-sovereign-chain launch — moot; if any readiness reasoning is reusable for an OLAS-native genesis, re-home it rather than retain. |

**B. DR consciously reversed** — `log/decisions/2026-06-04-olas-staking-strategy.md` (DR-2026-06-04). It declared OLAS staking non-load-bearing substrate to deprecate. **Reversed:** OLAS staking becomes *the* operator reward rail. Add to that DR's frontmatter a `superseded-by: DR-2026-06-30` note (and a one-line body header) at ratification.

**C. Phase 1a tokenomics — dropped.** `spec/2026-04-06-phase-1a-design.md` and `docs/superpowers/plans/2026-04-06-phase-1a-tokenomics.md` already carry a 2026-05-01 "superseded for forward planning" blockquote (subsumed by Phase A). Extend that note to record that the JINN-token tokenomics itself is now dropped by DR-2026-06-30 (not merely re-roadmapped).

**D. Canonical docs to rewrite (Discussion + CODEOWNERS required — do not edit unilaterally):**
- `SPEC.md` §Tokenomics (lines ~7–54): the five JINN functions (veJINN direction, publication-via-slot, execution/evaluation bonds, priority service) and emissions-gating contradict a tokenless protocol. Rewrite to the OLAS-native model: OLAS stake + liveness, the loop-completion gate, the two reward streams, the curating-agent split.
- `GROWTH.md` §economic framing (lines ~19–47): replace veJINN/gauge/JINN-emissions language with OLAS-native equivalents.
- `GLOSSARY.md`: retire or re-scope JINN-token terms (veJINN, JinnDistributor) if present; add OLAS-native terms.
- `PRINCIPLES.md`, `THESIS.md`: no load-bearing token mechanics found; confirm no incidental token claims need adjusting.

**E. Preserved (no reversal):** DR-2026-04-30 (knowledge-market substrate framing); `spec/2026-04-30-phase-a-umbrella.md` (operational, token-orthogonal); `spec/2026-05-05-solvernet-creation-and-launch.md` (SolverNet model, reused verbatim).

## Open questions to ratify

1. **A CODEOWNER's formal sign-off on the conscious trade** (rent vs own legitimacy) — *gating*. **Resolved (2026-07-01):** signed off; DR ratified on that basis.
2. **veOLAS sizing & custody** — who holds and extends the lock funding the emissions nominee. veOLAS economics here are doc-sourced and **not** re-verified on Ethereum L1 — verify before committing the funding plan.
3. **Evaluator-quality-control timing** — quorum + consensus-outlier are optional at v0 (the gate is "any verdict") but likely needed as volume rises; decide the trigger.
4. **Mainnet migration** — sequence for moving live mainnet operators from the legacy marketplace-native model to the consolidated (staking + recorder) shape.
5. **Testnet OLAS** — faucet vs mock, since emissions are a mainnet-only reality (the testnet smoke used JINN-as-OLAS).
6. **Canonical-doc rewrite routing** — open the Discussion that gates the SPEC.md / GROWTH.md rewrites (item D).

## Status / next steps

`ratified` (2026-07-01, CODEOWNER sign-off). Implemented and proven on testnet (Tracks 1–3) and committed on branch `tokenless-olas-native` (draft PR #1297 → `next`). The §Reversal supersession blockquotes are applied and the canonical-doc rewrites (SPEC.md §Economics, GLOSSARY.md, README, CLAUDE.md) are drafted in that PR. Remaining before merge: (1) post the anchoring GitHub Discussion; (2) CODEOWNERS approval on the canonical-doc changes in the PR; (3) resolve the §Open questions that gate **mainnet** (notably re-verify veOLAS on L1, the evaluator-quality trigger, and the mainnet-migration sequence) — these do not block the testnet-scoped merge but must close before mainnet.
