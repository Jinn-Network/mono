---
name: jinn-adjacent-frame
description: Substrate-and-evaluator analysis of the jinn-adjacent cluster (Bittensor, Numerai, Allora, OLAS). Two-beat frame for teach posts and outreach — capture-asymmetric substrate + free-oracle-vs-judgment-evaluator. Source for Sprint #1 teach posts, bridge angles, and cluster-recognition replies.
type: reference
status: archival calibration — Sprint #1 retired 2026-05-06; see GROWTH §6.2
last_refreshed: 2026-05-05
---

# Jinn-adjacent cluster — frame

Companion to `cluster-model` skill. Captures the structural argument for why Jinn looks different from existing protocols in the same orbit, in cluster-recognisable vocabulary. Read when proposing teach posts or bridge angles aimed at Bittensor / Numerai / Allora / OLAS operators.

## What this cluster is

Operators and builders on protocols that already implement *staked solver / evaluator economics*:

- **Bittensor** — subnet owners, miners, validators, dTAO holders. Yuma consensus, validator weights, dereg risk, alpha pools.
- **Numerai** — tournament modellers, Signals submitters, NMR stakers. Meta-model, MMC, True Contribution, NumerBay.
- **Allora** — workers, reputers, forecasters, topic owners. CZAR loss function, Forge ranking, synthesis layer.
- **OLAS** — Pearl operators, Mech operators, service stakers. ServiceRegistry, PoAA, Mech Marketplace.

Distinct from the broader **AI × crypto cluster** (which is mostly identity / payment / execution / eval layers — ERC-8004, x402, observability tools) — those are infrastructure-layer accounts; the jinn-adjacent cluster is the *coordination-protocol-layer*.

Distinct from the **AI cluster** (which treats coordination as a research / cryptography problem, not an economic-protocol problem).

Distinct from the **Crypto cluster** (which treats AI as a productivity tool, not a participant class).

## The two beats — plain English

### Beat 1 — capture-asymmetric substrate

> In all three of these projects, the people doing the work don't end up owning what the work produces. Numerai modellers train models that get folded into a hedge fund's alpha. Allora workers ran nodes for months to bootstrap a network that VCs and the foundation now own. Bittensor miners and validators do real work, but a lot of subnets are basically private companies using TAO emissions as a marketing budget. The data, the models, the predictions — they all flow into something privately owned at the top.
>
> Jinn is trying to do something different. The thing the network produces — the record of what was done, what worked, what didn't, who did it — is meant to be a public resource. Anyone can read it. Anyone can build on it. The way the network captures value isn't by owning that record; it's by being the live market where new work gets staked, evaluated, and added to the record.

### Beat 2 — free oracle vs judgment evaluator

> There's a reason those projects can keep ownership of what their workers produce: the work they coordinate has an easy answer-key. Numerai modellers predict stock returns, and the market tells you 20 days later whether they were right. Bittensor's coding subnet runs your patch through a test suite — the tests pass or they don't. Allora workers predict BTC/USD 24 hours out, and the price tells you. In each case, the "did this work?" question gets answered for free by something outside the network — the market, the test suite, the price feed.
>
> Most agentic work doesn't have an answer-key like that. *Did the agent actually do what the user asked? Is this contract correct, not just compiling? Is this restoration job actually fixed?* Nobody outside the network can tell you. So somebody inside the network has to do real judgment — and if they have power over rewards without skin in the game, they become the weak point. That's why Jinn treats the evaluator as a first-class role with their own stake. It's not an extra mechanism; it's the only way the protocol works when the answer isn't free.

## Per-protocol breakdown

Three things to keep separate for each protocol: substrate (what the participants produce), mechanism (the rules), capture (where the value accrues). Plus the evaluator architecture (who decides what's good, and how).

### Numerai

- **Substrate:** *Privately owned.* The meta-model — the actual aggregated alpha — is constructed inside Numerai and trades inside Numerai Master Fund. Modellers see their own predictions, MMC, and TC scores; they do not get the meta-model.
- **Mechanism:** Set by Numerai (Council of Elders advises, but Numerai decides scoring, payouts, dataset versions, what gets folded into the meta-model).
- **Capture:** Numerai Inc. (the fund). ~$600M AUM, JPMorgan $500M capacity, Series C at $500M valuation. Modellers earn NMR for individual contribution; the fund's revenue accrues to Numerai equity-holders, not modellers proportionally.
- **Evaluator architecture:** *The market is the evaluator.* 20-day forward stock returns resolve every prediction deterministically. Numerai doesn't need a stake-priced evaluator role because the market is a free, ground-truth oracle.
- **Hypothesis correction (per 2026-05-05 research):** "Stocks-locked" is outdated — Numerai Crypto, Numerai Risk, Singularity, and Predictive LLM are shipped or shipping. The correct claim is **markets-locked**: every product terminates in a tradeable forecast feeding a fund.

### Bittensor

- **Substrate:** *Neutral at the protocol level, privately captured per subnet.* Anyone can register a subnet permissionlessly. The Yuma consensus and 21M cap are real. But subnets — the units where actual work compounds — are mostly team-owned product ventures using Bittensor's economic primitives for distribution and growth.
- **Mechanism:** Yuma consensus + dTAO emissions + governance via Const + recent BIT-0011 "Conviction" addition. The Covenant / Sam Dare / Jacob Steeves incident (2026-04-09) demonstrated that subnet owners can operate with founder discretion and exit with significant personal benefit.
- **Capture:** Mostly subnet teams. Operators (miners, validators) earn TAO emissions, but the canonical work that compounds (e.g. Templar's training output, Ridges' SWE agent infrastructure, Chutes' inference network) accrues to subnet-team equity.
- **Evaluator architecture:** *Validators per subnet, with task-specific deterministic graders.* SN62 Ridges runs patches through a Harbor sandbox with a test suite. SN44 Score uses ground-truth physical-AI labels. SN6 Numinous uses Brier on resolved events. Each subnet defines its own scoring; the protocol assumes each scoring problem reduces to a deterministic comparison.
- **Hypothesis correction (per 2026-05-05 research):** *Bittensor is not LLM-shaped-with-agents-tacked-on.* The 2026 subnet topology is heterogeneous: Templar (72B distributed training), Ridges (SWE agents), Chutes (serverless inference at $100M+ scale), Synth (probabilistic forecasting), Celium (GPU markets), Masa (social agents), NeuralAI (3D), BitMind (deepfake detection). The honest critique is **validator-scoring-locked** — works wherever "good" is commoditisable digital output (training loss, inference latency, code patches that pass tests). Breaks where "is this actually good" requires subjective evaluation, end-state assessment, or multi-stakeholder judgment.

### Allora

- **Substrate:** *Foundation-controlled.* Topic owners are permissionless in principle; the canonical synthesis layer (forecast-weighted inference) and most active topics are protocol/team-driven. Workers' inferences flow into a synthesis they don't control or own.
- **Mechanism:** Set by Allora protocol (CZAR loss function, classification rollout, Forge ranking, mainnet eligibility checker).
- **Capture:** Allora Foundation / VC investors. The post-mainnet ALLO allocation (Forge testnet got allocated; general workers didn't) made this visible publicly.
- **Evaluator architecture:** *Reputers grade workers; price feeds resolve workers' inferences.* All three layers (workers, reputers, forecasters) carry stake. The synthesis function itself sits inside the protocol and is unbonded. Topics today are overwhelmingly financial regression feeds where the resolution oracle is a price.
- **Hypothesis correction (per 2026-05-05 research):** "Forecasting-locked" is fair, with the soft caveat that topics are nominally permissionless regression-shaped tasks. The frame **regression-shaped forecasting** is more precise — works wherever the answer is a number you can score with Brier or MSE.
- **Worker grievance context:** Post-mainnet (2025-11-09 mainnet launch), the eligibility checker showed 0 ALLO for many workers who'd run pre-launch nodes for months. The team explanation was design-intent (Forge testnet allocation; general workers separate). The "$ALLO scam" pile-on on X is shill-ring-shaped; the underlying grievance is real (post-genesis emissions decay coinciding with a 50% listing-day drop on heavy airdrop selling). **Do not cite the grievance using "scam" framing** — that triggers cluster rejection. The cluster-recognition wedge for Allora workers specifically is *"you ran the network. The substrate you built is now their asset."*

### OLAS

- **Substrate:** *Mostly neutral.* OLAS positions itself as a substrate-for-agent-economies; Pearl operators, Mech operators, ServiceRegistry users all interact with neutral protocol primitives.
- **Mechanism:** PoAA (Proof of Agent Activity), staking via ServiceRegistry, veOLAS governance, MechMarketplace coordination.
- **Capture:** More distributed than the others. Treasury / Dispenser / Tokenomics distribute emissions; veOLAS governance is real. Valory team has founder influence but less single-point capture than Numerai or Allora.
- **Evaluator architecture:** *Activity checkers per service.* Each staking program has its own activity checker that determines reward eligibility. JinnRouter on Base today is exactly such a checker — Jinn is operationally a customer of the OLAS substrate.
- **Note:** OLAS is the protocol Jinn already runs on. Recruitment from this audience is structurally different — they're already adjacent to Jinn rather than needing conversion. Bridge angles should treat OLAS operators as *peers operating alongside Jinn*, not *targets to convert*.

## Bridge angles for outreach

The canonical cross-cluster shape (per `bridge-shapes.md`): *methodology question that engages a specific gap the candidate has already named, asking them to extend their thinking one step further toward the Jinn frame, without naming Jinn.*

### Per-individual methodology questions

For each protocol's operators, the bridge is the question that surfaces the frame's gap from inside their daily experience:

- **Numerai modeller:** *The market is your free oracle. What does the protocol look like when there isn't one — when "did this prediction come true" can't be answered by waiting 20 days?* Engages: TC, MMC, meta-model construction, third-party-evaluator-with-stake design.

- **Bittensor SN62 Ridges operator:** *The test suite is your free oracle. What does the protocol look like for software work where there's no test suite — where "is this contract semantically correct, not just passing tests" is the actual question?* Engages: validator-scoring discipline, the limit of deterministic graders, patch-quality vs end-state-correctness.

- **Bittensor SN6 Numinous operator:** *Brier on resolved events is your free oracle. What does the protocol look like for forecasting where the resolution itself is contested or interpretive?* Engages: WTA-on-Brier, the limit of objective resolution.

- **Allora worker:** *The price feed is your free oracle. You ran the network and the substrate you built is now their asset. What does the protocol look like when the substrate itself is the public good and the bonded market on top is what compounds?* Engages: post-mainnet grievance + public-good frame.

- **OLAS Pearl / Mech operator:** *You're already operating on a substrate. What's the operator-side win when the canonical attestations on top of that substrate become a public record nobody owns?* Engages: peer-to-peer framing, since OLAS operators are structurally aligned with Jinn.

### Broadcast claim (teach-shaped)

The two beats above, layered: capture-asymmetric substrate (headline) + free-oracle-vs-judgment-evaluator (proof). See bridge-shapes.md sub-pattern 7.

## What NOT to say

- **"Bittensor is a private network."** Wrong at the protocol level (Yuma + permissionless subnet registration + 21M cap are genuinely decentralised primitives). The cluster will tear this apart. Use *"many active subnets are private ventures using TAO economics"* instead — narrower, defensible, survives operator scrutiny.

- **"Allora is forecasting; Numerai is stocks; Bittensor is LLMs."** Research (2026-05-05) disproves all three. Numerai is markets-locked, not stocks-locked (Crypto / Risk / Singularity / Predictive LLM all shipped). Bittensor is *not* LLM-shaped — subnet topology is heterogeneous. Allora is closest to "forecasting-locked" but topics are nominally permissionless regression-shaped tasks. Use **regression-shaped forecasting** / **markets-locked** / **validator-scoring-locked** instead — these survive operator interrogation.

- **Worker "$ALLO scam" framing.** The grievance is real but the shill-ring vocabulary triggers rejection. Frame the wedge as *"you ran the network; the substrate you built is now their asset"* — same observation, doesn't fall into the rejection class.

- **"Numerai is just a hedge fund extracting from data scientists."** Modellers know this and accepted it; the deal is good for top modellers (NMR earnings + Master tier). The wedge isn't outrage — it's *what would change if the substrate were public and the bonded market on top is what compounds?*

- **"Jinn has better mechanism design than these protocols."** Avoid mechanism comparisons — invites rebuttal-by-protocol-detail. The frame difference is *what's the protocol building toward*, not *who has cleaner Yuma weights*.

## Vocabulary the cluster uses

For search-strategy and reply-cascade vocabulary discipline:

- **Numerai:** stake, NMR, MMC, TC, true contribution, meta-model, Signals, tournament, NumerBay, Master tier, payout schedule.
- **Bittensor:** subnet, miner, validator, Yuma, weights, dTAO, alpha, emission, dereg, slash, immunity, registration, Conviction (BIT-0011), Templar, Ridges, Chutes, Synth, Numinous, Score, Targon, BitMind, Const.
- **Allora:** worker, reputer, forecaster, topic, Forge, ranking, synthesis, regression head, classification head, CZAR, eligibility checker, Topic 1, BTC/USD 24h, directional accuracy.
- **OLAS:** Pearl, Mech, agent, service, ServiceRegistry, PoAA, Trader Quickstart, Predict, MechMarketplace, veOLAS, Polystrat (deprecated frame), nominee, activity checker.

## Sources

- Research file: `growth/.local/research-jinn-adjacent-2026-05-05.md` (technical scope + GTM positioning + generality assessment per protocol).
- GitHub Discussion #69 comment 16806259 (substrate-as-public-good thinking; @oaksprout + GPT5.5; @ritsuKai2000 stake-shape refinement).
- Frozen warm-contacts AI-cluster context: `growth/.local/jinn-warm-contacts.csv` rows tagged `frozen` (askdrvoyage, Vtrivedy10, Obsrver_Prtcl, TreebeardAI, pkyanam) — reasoning logged at 2026-05-05.
- THESIS.md, SPEC.md, GLOSSARY.md (canonical Jinn substrate).

## How to use this file

- **`cluster-model`:** read when revisiting the jinn-adjacent surface in growth-log §1 or a future sprint. Treat it as calibration material unless GROWTH §3 / §4 makes the cluster current again.
- **`x-post-builder`:** consume Beat 1 + Beat 2 framing when drafting teach posts targeted at jinn-adjacent operators. Per-individual bridge angles for reply-cascade methodology questions.
- **`discover-twitter-recruits`:** vocabulary section informs `search-strategy.md` queries; *what NOT to say* informs §3 audience-profile exclusions.
- **`growth-day`:** surface during sprint-active periods where §6 cluster is jinn-adjacent. Pull bridge angles for daily top-3 actions.

## How to update this file

- When the active sprint cluster definition changes, refresh the *what this cluster is* section.
- When a per-protocol fact becomes stale (e.g. Numerai ships a new product, Bittensor governance shifts), update the per-protocol breakdown + dated note.
- When a new cluster-recognition wedge is empirically validated, append to bridge angles.
- When a *what NOT to say* item is empirically falsified across two or more attempts, downgrade it.
- Keep `last_refreshed:` in frontmatter current.
