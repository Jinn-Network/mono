# Launch Gating Criteria — Discussion Proposal

> **Status (2026-06-30): superseded by DR-2026-06-30 (tokenless, OLAS-native).** Jinn drops the native token and the sovereign chain; OLAS is the economic layer. For the current direction read `spec/2026-06-30-tokenless-olas-native.md` and `log/decisions/2026-06-30-tokenless-olas-native-pivot.md`.

- **Version:** 0.1 (discussion draft)
- **Date:** 2026-05-14
- **Author:** Oak
- **Status:** Open for community review. First ask: *Is this the right set of questions, and is anything missing?*

## Purpose

Define the criteria that gate Jinn's testnet → mainnet transition.

The concrete action at the end of this discussion is updates to the canonical docs (`SPEC.md`, `THESIS.md`, `BRAND.md`, `GROWTH.md`, `GLOSSARY.md`) — or new canonical docs where needed — such that every question raised below has a documented, community-accepted answer before we ship mainnet.

The launch decision is then mechanical: *every question below has an answer in canon → we are ready.*

## Why launch quality matters

Launch is not a milestone. It is a **coordination event** that creates common knowledge about what Jinn is and who it serves. Common knowledge, once formed, is irreversible — and very expensive to repair if it forms wrong.

If the launch event encodes (or appears to encode) extractive structure, founder capture, technical fragility, or principle-violation, that signal is durable and de-legitimising. The retroactive narrative of every failed fair launch in crypto is the same: *the structure was visible from day one, and the people running it knew.*

We are gating mainnet on launch quality. Therefore we must define what *quality* means concretely enough that we can tell when we have it.

## Principles, re-established

These principles were established prior to the canonical docs, and I will create a separate PR to land them in canon. They should govern every gate below.

**Meta-principle: Legitimacy** (Buterin sense — the coordination equilibrium maintained by higher-order expectations that other participants will continue to cooperate). Every gate below exists to build or defend legitimacy.

Legitimacy is purchased by stacking multiple sources. Single-source legitimacy is fragile. Jinn's principal sources, in priority order:

1. **Fairness / neutrality / minimum viable extraction.** Bought through credible neutrality — signals that are cheap-if-genuine and expensive-to-fake. Disclosure is not commitment.
2. **Learning maximisation (the Bitter Lesson).** Discovery beats encoded cleverness. We defer to the loop rather than to our own taste. This is process-source legitimacy applied to the protocol's own evolution.
3. **Governance minimisation.** Governance itself is a vector of capture; every governance surface is a potential extraction point. We minimise the on-chain governance footprint, push decisions to mechanism where possible, and rely on ve-JINN gauge voting (rather than discretionary admin) for the directions where governance is unavoidable. This cuts across performance (is our decision-making structurally better than competitors'?), participation (a simple governance model lowers the cost of meaningful participation), and process (governance architecture is itself part of process legitimacy).

Auxiliary sources we should also engineer for:

- **Performance** — raw, observable results from the loop.
- **Participation** — early operators have both skin and voice.
- **Process** — the way we make decisions (including the launch decision itself) is legitimate.

Brute force and pure continuity are not available to us, and we do not want them.

Every gate below should trace back to one of these sources. If a candidate gate does not, it should be dropped or the principle stack should be revisited.

## Question set

Grouped by meta-theme: **Community**, **Economics**, **Tech**.

Economics is treated as a peer meta-theme rather than a sub-theme of either Community or Tech — token distribution and substrate choice mediate the relationship between the two and warrant first-class treatment.

---

### Community

#### Group composition

- **C1.** What constitutes a sufficient group size prior to launch? (And: sufficient *for what* — to defend the protocol? To run the loop? To carry the narrative?)
- **C2.** What viewpoints and interests must be represented in the early group? Candidates: operators, protocol researchers, traders, peer-protocol builders, end-task creators, regulators-as-stakeholders, adversarial reviewers. Which are essential, which are nice-to-have?
- **C3.** Do we have enough credibility in the early group? (Legitimacy-by-association — who confers prestige onto Jinn, and is that prestige freely conferred or transactional?)
- **C4.** Do we have the right mix of skills to ship and operate the protocol? (Capability is partially mitigated by AI, not fully.)
- **C5.** How is group diversity maintained over time, not just at launch? (Diversity at t=0 that collapses by t+90d is theatre.)

#### Founders and concentration

- **C6.** What structural advantages does the early group hold that need to be mitigated? The obvious one: Oak and Ritsu hold OLAS, and the protocol relies on OLAS for PoAA. What others exist that we have not named?
- **C7.** What credible pre-commitments on founder extraction are required *before* launch? Extraction has two surfaces and both need to be addressed:
  - *Internal* — selling JINN, using early ve-JINN voting power to direct emissions toward addresses we benefit from, exercising any admin / multisig authority in a self-interested direction.
  - *External* — using Jinn protocol activity to move OLAS price while we hold OLAS, selling OLAS on Jinn-favourable news, front-running Jinn-affecting decisions in OLAS markets, or steering Jinn architecture toward designs that incidentally benefit our OLAS holdings.
  
  Disclosure is cheap. Vesting cliffs, multisig-renounce clauses, on-chain bonds with social cost of reversal, public position freezes — what is cheap-if-genuine and expensive-to-fake on each surface?
- **C8.** Individual fungibility — how replaceable are early-group members generally, and Oak and Ritsu specifically? How do we *credibly demonstrate* replaceability rather than just claim it? (Fungibility of the early community is a structural property; fungibility of named founders is a sharper test of it.)
- **C9.** Founder *accountability* (distinct from fungibility) — how does the community sanction or remove Oak or Ritsu (or any disproportionately-empowered early member) mid-flight if they go off-spec? Fungibility is removal capacity; accountability is the trigger.
- **C10.** Can canonical docs survive founder absence for three months? What hardening do they need to be load-bearing rather than scaffolding?

#### The launch event itself

- **C11.** What does "launch" actually mean? Contract deployment, token transferability, first emission, first wish fulfilled, first independent operator earning — these are different moments. Which is the Schelling moment we point at? The choice matters because common knowledge forms around one event, not a fuzzy window.
- **C12.** Who decides the gates are met? What is the legitimate process to call "we are ready"? (If Oak or Ritsu unilaterally decide, the launch is process-illegitimate regardless of the technical state.)
- **C13.** What is the canonical public narrative of the launch — the thing that has to be true, legible, and become common knowledge? (Bitcoin: "Chancellor on brink of second bailout." Ethereum: Foundation + premine framing. Jinn: ?)
- **C14.** What is the abort / failure path? If we ship and it goes wrong, how do we step back without burning the legitimacy reserve? Without a stated failure mode, launch becomes implicitly irrevocable, which is brittle.

#### Process meta

- **C15.** How do the principles themselves get updated post-launch? Without an explicit meta-process, principles erode silently under operational pressure.
- **C16.** Has there been adversarial public review of the design? (Economists trying to break tokenomics; security researchers attacking distribution; hostile operators stress-testing the loop in public.)

#### Governance architecture

Governance is itself a capture surface, so launch quality includes a separate audit of the on-chain governance structure — not just whether it works, but whether it is as small as possible.

- **C17.** Is the on-chain governance surface at launch minimal? What discretionary powers exist (admin keys, upgrade paths, parameter setters, emergency pauses) and can each be justified against governance-minimisation? Anything that cannot should be removed before launch, not after.
- **C18.** Is ve-JINN gauge voting the *only* directional governance mechanism at launch, or are there parallel discretionary channels that compete with it? (Parallel channels dilute the legitimacy ve-JINN is supposed to provide.)
- **C19.** What is the legitimate process for changing the governance architecture itself? Meta-governance is the deepest capture surface and the easiest to leave undefined.

#### Immune architecture

Detecting and excluding illegitimate participants is a community question first — *who counts as illegitimate, and who decides* — with protocol mechanisms downstream of those decisions.

- **C20.** Post-launch, how does the network detect and exclude illegitimate participants? The two failure modes:
  - *Autoimmune* — legitimate operators are falsely expelled, burning trust.
  - *Cancer* — extractive actors evade detection and capture rewards.
  
  Phase A.1's evidence-schema work supplies the substrate. The community questions on top of it: who proposes exclusion, who confirms it, what evidentiary standard is required, and what is the appeal path? Is the answer sufficient *as a launch property*, or only as a post-launch trajectory? If only the latter, what is the interim mitigation?

---

### Economics

#### Distribution

- **E1.** What does ideal token distribution look like at launch? At t+30d? At t+90d? (Targets, not just floors and ceilings.)
- **E2.** What concentration thresholds are unacceptable — top-N wallet share, Gini, operator-capture ratios, founder-cluster share? Are these *measured* (transparent dashboards) or *enforced* (mechanism-level limits)?
- **E3.** Bittensor specifically: how was TAO actually distributed? The mainstream lesson is "be fair." The sharper question is *at what point did any insider advantage become common knowledge, and what did that do to the narrative?* What is our analogue, and how do we pre-empt it?
- **E4.** What do we learn from other fair launches — Bitcoin's slow grind, Yearn's micro-supply, Curve's voting wars, Olympus's reflexivity collapse, LBP-based launches, ICO-era fair launches? What worked, what failed, and why?

#### Emissions and liquidity

- **E5.** Is "JINN is emitted for useful work, the market handles the rest" the right liquidity stance? It is principled and consistent with neutrality. The risk is that initial conditions of distribution shape reflexive expectations regardless of stance.
- **E6.** Distribution shape in the first 90 days of emissions — does this deserve to be a gate (a mechanism property we tune) rather than a market problem (an outcome we observe)?
- **E7.** Does Jinn need any pre-launch market-making, locked liquidity, treasury-side LP, or LBP-style mechanism — or does any of that compromise neutrality? Is *no* liquidity provisioning itself a credible-neutrality signal?

#### Economic substrate and underlying-protocol neutrality

Every protocol we depend on is a legitimacy input. Their neutrality properties become ours, and their capture surfaces become ours. This is broader than chain selection.

- **E8.** We are pragmatically bound by the EVM. Is Ethereum — and the L2 we land on — *sufficiently* credibly neutral to serve as Jinn's economic substrate? Substrate neutrality is a legitimacy input we usually take for granted, but it is an input. What are the realistic alternatives, and what do we lose / gain by considering them?
- **E9.** Multi-chain at launch (Base + Arbitrum per the roadmap) — does this strengthen neutrality (no single chain captures Jinn) or fragment it (each chain carries different legitimacy properties and different censorship risk)?
- **E10.** How does our selection of underlying protocols (OLAS for PoAA, Mech Marketplace for execution, ERC-8004 for discovery, x402 for payment-gated access) affect Jinn's legitimacy? Each carries its own neutrality profile, capture exposure, and governance trajectory, and we inherit all of them. Which dependencies are load-bearing for legitimacy (such that their compromise compromises Jinn) versus replaceable, and what is our public position on the trade-off for each?

---

### Tech

#### Security

- **T1.** What security posture is required for the DAO + distributor setup? Proposed: minimal and robust as possible. What does "minimal" mean concretely — which contracts are in scope at launch, which are deferred to later phases?
- **T2.** What audits, formal verification, or public review must be complete? What is the standard? (Industry-standard may not be Jinn-standard; if neutrality is load-bearing, the bar is higher than for a closed product.)
- **T3.** Bug bounty live before launch? At what size, and against which scope?

#### Performance

- **T4.** What level of SolverNet performance must be demonstrated on testnet? Concrete KPIs — throughput, restoration success rate, evaluation agreement rate, time-to-delivery, cost-per-task, claim-rate-to-completion?
- **T5.** How long must KPIs hold on testnet before mainnet ships? (Stability of performance over time, not just peak performance in a window.)

#### Stability

- **T6.** How much stability do we need in the first client? Define along: uptime, crash-recovery, idempotency of bootstrap, upgrade safety, data-loss resistance.
- **T7.** How many independent operators must successfully run the client end-to-end (bootstrap → earning, unaided) on testnet before mainnet? This is both a tech gate (the client works) and a community gate (operator diversity exists).

#### On-chain readiness

- **T8.** How much testing of the on-chain setup do we need? Fork tests, fuzz, invariant tests, mainnet-shadow runs, minimum public testnet duration?
- **T9.** What on-chain dependencies (OLAS, Mech Marketplace, ERC-8004, x402) need formal compatibility statements, version pinning, or fallback plans? An external break post-launch should degrade Jinn, not brick it. (The legitimacy-side framing of these same dependencies is in E10; this is the operational-resilience side.)

---

## First ask of the community

**Is this the right set of questions? What is missing?**

Once the question set is agreed, the next round drafts proposed answers. Each accepted answer becomes a candidate amendment to one of the canonical docs, or seeds a new canonical doc where the surface is not covered.

The launch decision is then: *every question above has a documented, community-accepted answer in canonical docs.* No private gate. No founder discretion.
