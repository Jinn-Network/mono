# Jinn as the Open Verifiable Substrate for Agentic Training Data

> **Status (2026-06-30): superseded by DR-2026-06-30 (tokenless, OLAS-native).** Jinn drops the native token and the sovereign chain; OLAS is the economic layer. For the current direction read `spec/2026-06-30-tokenless-olas-native.md` and `log/decisions/2026-06-30-tokenless-olas-native-pivot.md`.

**Version:** 0.1 (draft)
**Date:** 2026-04-21
**Author:** Ritsu Kai
**Status:** Strategic thesis for internal discussion — one option for packaging Jinn into something valuable, not a decided direction

## TL;DR

Jinn's restoration loop produces exactly the data shape the post-training frontier is starving for: real, multi-turn, tool-using agent trajectories with outcome-verified rewards and cryptographic provenance. The proposal is to treat **that data** — not a model, not a prediction market — as the packaged output of Jinn, sold as an open, verifiable alternative to the in-house data pipelines of frontier labs. The competitive battle isn't with OpenAI; it's with Scale AI, Mercor, Surge, and the absence of any verifiable alternative for everyone outside the top five labs. Fine-tuned models become a downstream v2 product, not the starting point.

## The framing

We've built a protocol that coordinates agents to restore intents. Phase 0 is live on Base. Phase 1a is deployed on testnet. The execution loop works. The open question for GTM is: **what is the product?** — the packaged output that consumers actually pay for.

Three framings are on the table:

1. **Prediction markets** on restoration strategies — surface the best approach via a market
2. **Per-intent fine-tuned models** — Jinn data funnels into specialist models, exposed via API
3. **Knowledge as structured data** — the (intent, attempt, evaluation) tuples are themselves the product

This document argues for (3) as the primary product and (2) as a downstream option. It makes the case for why, what we'd need to change in Jinn to make it work, and where the argument is weakest.

## Thesis

**Jinn is the decentralized, verifiable data substrate for agentic AI training.**

The claim has three parts:

1. Agentic training data — real multi-turn trajectories with outcome-verified rewards — is the scarcest and most valuable data in post-training right now
2. Jinn produces this data natively as a byproduct of its execution loop
3. Jinn's data carries structural properties (cryptographic provenance, economic staking, multi-party evaluation, on-chain outcome grounding) that no centralized lab pipeline can replicate

If the thesis holds, the value accrual story is:

> Protocol executes agent loops → data accumulates on-chain with provenance → data is licensed to labs, vertical AI companies, and researchers → revenue flows back to participants via the JINN token economy.

## Why now — the post-training shift

The ground moved in 2024–2025. Four trends matter:

**From human preference labels to verifiable rewards.** DeepSeek-R1's *Nature* paper (Sept 2025) demonstrated that pure RL with verifiable rewards (RLVR) produces emergent reasoning without any human-labeled traces. The reward is binary correctness + format compliance. GRPO samples multiple outputs per prompt, compares within the group, no separate critic needed. This is the dominant agentic training paradigm going forward. **Jinn's evaluator verdict is structurally a verifiable reward.**

**Process reward models (PRMs) are the next frontier.** Step-level supervision beats outcome-only for complex reasoning. The bottleneck is labeling steps at scale — it's expensive, and active-learning (pick the most contested steps) is the current best approach (ActPRM, ThinkPRM, R-PRM, 2025). **Jinn's challenge mechanism naturally surfaces contested steps; the labels are a protocol byproduct.**

**Data contamination is now existential.** Every public benchmark is contaminated. Labs can't prove their evals weren't in training. Regulatory pressure (EU AI Act, kicking in 2026–2027) and scientific rigor both demand provenance. **Jinn's on-chain timestamps give every trajectory "provably predates model X" as a native property** — unreplicable by a centralized pipeline.

**Agentic trajectory data is genuinely scarce.** Kimi-Researcher, AgentRL, ProRL — all struggle with the same bottleneck. Synthesizing is the fallback because real multi-turn, tool-using, outcome-grounded data is rare. **Jinn produces real data as its core loop.**

## Why Jinn is structurally positioned

Seven properties, ordered roughly by defensibility:

1. **Contamination-proof by construction.** Block-anchored timestamps. No other dataset has this. Premium regulatory property.
2. **Cryptographic provenance.** Every record signed and staked. Auditable chain of custody. EU AI Act compliance story.
3. **Economic quality signals at generation time.** Restorers and evaluators stake OLAS/JINN. Sybils priced out; quality is bonded. Inverts the Scale AI labor economics.
4. **Multi-party evaluation consensus.** Inter-rater reliability is computable. Evaluators are independent from generators. A centralized lab cannot be its own third-party auditor.
5. **Outcome-grounded for on-chain intents.** For DeFi, prediction markets, trading, the chain *is* ground truth. No LLM-as-judge bias.
6. **Challenge mechanism as active-learning flywheel.** Contested evaluations = hard examples = the highest-value data for PRMs and reasoning models.
7. **Live stream, not snapshot.** Continuous data. Frozen datasets decay; Jinn's stream stays current.

These are not "labs haven't done it yet" — several are properties labs *structurally cannot* provide from an internal pipeline.

## What we'd sell

Two products, sequenced:

**v1 — Verified dataset.** Content-addressed snapshots published on a cadence, with the live firehose available to enterprise tier. Licensed in tiers (free sample, paid full, enterprise direct-query access). Gated via x402 (already in the stack). Restorers and evaluators earn a cut via data royalty — this is the alignment mechanism that makes contributors choose Jinn over other protocols.

**v2 — Fine-tuned specialist models.** Once v0 dataset quality is validated, produce specialist models per intent domain (`jinn-restore-defi-v1`, `jinn-restore-prediction-v1`, etc.). Hosted API, or model weights released with an inference partner. Cheap to train (see cost section), so this is incremental, not an ambitious bet.

Prediction markets on restoration strategies are **not** in the primary thesis. Assuming the Tier 2 evaluator upgrades land (multi-evaluator consensus + scalar reward signal), the "which restoration is best" ranking problem is solved inside the existing evaluator path, without the capital requirements and resolution complexity a market layer would add. Park — contingent on those upgrades.

## Why this isn't a losing battle with labs

The most reasonable objection: *"This is just what OpenAI / Anthropic / Google already do internally."*

Two-part response:

**1. We concede territory we cannot take.**
- Pure volume. Frontier labs have ~300M weekly actives; we will never match that.
- Generalist SFT/preference data. Scale AI / Mercor / Surge already compete here.
- Quality per-trace for their own use case. Internal loops beat external pipes when both parties share an objective.
- Synthetic data volume via distillation from frontier models.

**2. We compete on properties labs structurally cannot provide.**
- External provenance (they can't prove their own independence)
- Contamination-free timestamps (retroactive provenance is impossible)
- Third-party verifier consensus (they can't audit themselves)
- Open access for non-frontier builders (their data is siloed by definition)
- Real-money outcome grounding (they can't run experimental agents with real capital)
- Specialist vertical depth (they train generalists; verticals are left to customers)

Our customer is **not** OpenAI. It is:

- **Non-frontier labs** (Mistral, DeepSeek, Qwen, Cohere, open-source) — need data, can't self-generate frontier volumes
- **Vertical AI companies** (trading firms, DeFi protocols, robotics, logistics, legal tech) — need specialist data generalist labs will never produce
- **Regulated enterprises** (finance, healthcare) — need provenance-verified data for compliance, not volume
- **Academic researchers** — need reproducible, uncontaminated benchmarks
- **Eventually** frontier labs themselves for niches they can't self-source

This is the Scale AI / Mercor / Surge market (~$14B in 2025 and growing) repositioned for agentic data with decentralized trust properties. Not a speculative new market — an existing one with a differentiated wedge.

Mental models that fit the shape:
- **Reuters** — wire service aggregating across newsrooms, exists alongside Bloomberg's and NYT's internal desks
- **Chainlink** — oracle aggregator, exists alongside any protocol's internal price feeds
- **Open-source software** — aggregate contributors beat single proprietary teams for certain workloads

Jinn is an aggregation + verification layer, not a competitor to any single lab.

## What we'd need to change in Jinn

Most of the pipeline is off-chain client + backend work. Protocol changes are where the alignment conversation matters. Tiered by cost/benefit:

**Tier 1 — essential:**

1. **Canonical trajectory schema**, enforced by the client. Every restoration attempt logs structured turns (observation, tool_call, response). Biggest data-quality lever. Mostly a client change.
2. **Multiple attempts per intent by design.** GRPO and DPO both need this. Requires protocol support for parallel claiming or tournament-style intents. Today: first-claimer wins → one trajectory per intent → poor training data shape.
3. **Evaluator step-level annotations** — optional but incentivized. Converts Jinn into a PRM data factory. Almost no one else has this at scale.
4. **Durable storage.** IPFS pin lapse = data loss. Need Filecoin/Arweave pinning or S3 mirror, ideally both.

**Tier 2 — high leverage:**

5. **Multi-evaluator consensus** per intent (2–3 evaluators, stake-weighted)
6. **Richer reward signal** — multi-dimensional scalar vector, not binary
7. **Intent taxonomy + difficulty tags** — metadata for dataset balancing and specialist training
8. **Challenge → hard-example pipeline** — formalize the data flow from contested cases

**Tier 3 — productization:**

9. **Rights licensing in ERC-8004 metadata** — per-trajectory license tag
10. **Redaction / selective disclosure** — encrypted fields, scheduled key release
11. **Schema versioning** — explicit, with migration rules
12. **Contamination anchoring** — batch dataset hashes on-chain on a cadence

Nothing in Tier 1 is technically hard. The question is prioritization against the existing Phase 1b roadmap.

## Cost is not the bottleneck

Fine-tuning is 1000–10,000× cheaper than pretraining. Relevant 2026 numbers:

| Workload | Cost |
|---|---|
| LoRA SFT of Llama 3 8B on 10k Jinn trajectories | ~$10 managed (Together), ~$5–15 self-hosted H100 |
| Full SFT of 70B open model on 10k examples | ~$20–50 managed, ~$200–400 self-hosted |
| DPO on 5k preference pairs | ~$15–80 |
| GRPO/RL run (100 steps, group rollouts) | $500–5,000 |
| Specialized reasoning model (DeepSeek-R1-style, niche domain) | $10k–$100k over a real program |

Translation: a weekend "does fine-tuning on Jinn data v0 beat base Qwen 7B on held-out Jinn intents" experiment is < $50. Validation is incidentally cheap. The binding constraints are data quality and pipeline maturity, not compute.

## Alternatives considered

For record:

- **Prediction markets on restoration strategies** — doesn't package knowledge for the consumer; ranking across restorations is subsumed by the Tier 2 evaluator upgrades.
- **Models-first (skip data, go straight to fine-tuned APIs)** — requires ML ops muscle we don't have and fronts infra cost before data validation; works as v2, not v1.
- **Generic data DAO** — Ocean, Vana, Sahara AI already occupy the "arbitrary data on-chain" category. Our differentiation is specifically **verified agentic execution traces**, not "data marketplace."
- **Compete on volume with labs** — losing battle. Don't.

## Open questions — deliberately deferred

These are the load-bearing decisions the thesis is *not* making. The thesis survives any reasonable answer, but each changes the GTM shape materially:

1. **Volume realism.** What's the trajectory/week rate at Phase 1b, realistically? If <100, this is a patient-capital 2-year story. If >1k, it's a 6-month product.
2. **First customer wedge.** Named starting beachhead — one open-weights lab pilot? One DeFi vertical partner? One academic group? Building supply with no named demand is risky.
3. **Pricing and licensing model.** Dataset tiers, x402 per-query, token-gated, revenue share with restorers — the permutations matter for token fit.
4. **JINN token value accrual.** How does dataset revenue flow to JINN holders — fee switch, buyback, distribution weight, other?
5. **Default training-data license at the protocol level.** CC-BY default? Protocol-controlled? Creator-controlled per intent?
6. **Build ask.** Who builds the pipeline, timeline, budget — not sized here.
7. **Relationship to Phase 1b priorities.** What, if anything, in Tier 1 protocol changes should displace existing Phase 1b work vs. layer on top?

## What this is asking for

Alignment on whether **"verifiable agentic training data as Jinn's primary packaged product"** is a direction worth investing in.

If yes, next steps:

1. Decide the open questions above (probably 2–3 working sessions)
2. Scope a v0 dataset pipeline — mostly off-chain, buildable from existing data
3. Run a weekend fine-tuning experiment to validate signal (<$50, no protocol changes)
4. Based on results, decide on Tier 1 protocol changes for Phase 1b

If no, the useful pushback articulates which part of the thesis breaks:

- **Market** — "labs will do this themselves"
- **Uniqueness** — "our structural properties aren't actually defensible"
- **Consumer** — "the buyer we're imagining doesn't exist yet"
- **Sequencing** — "right idea, wrong time"

Any of those rebuts point to a different product direction. A generic "I'm not sure" doesn't.

## References

Market context and cited research:

- [Post-Training in 2026: GRPO, DAPO, RLVR & Beyond — LLM Stats](https://llm-stats.com/blog/research/post-training-techniques-2026)
- [The State of Reinforcement Learning for LLM Reasoning — Sebastian Raschka](https://magazine.sebastianraschka.com/p/the-state-of-llm-reasoning-model-training)
- [DeepSeek-R1 — Nature (Sept 2025)](https://www.nature.com/articles/s41586-025-09422-z)
- [When Data is the Algorithm: DPO Dataset Curation Study (arXiv 2511.10985)](https://arxiv.org/html/2511.10985)
- [Less is More: Preference Data Selection (arXiv 2502.14560)](https://arxiv.org/html/2502.14560v3)
- [Let's Verify Step by Step (OpenAI)](https://arxiv.org/abs/2305.20050)
- [ActPRM: Active Learning for PRMs (arXiv 2504.10559)](https://arxiv.org/abs/2504.10559)
- [AntiLeak-Bench (ACL 2025)](https://aclanthology.org/2025.acl-long.901/)
- [Kimi-Researcher — Moonshot AI](https://moonshotai.github.io/Kimi-Researcher/)
- [AgentRL (arXiv 2510.04206)](https://arxiv.org/pdf/2510.04206)
- [Cryptographic Verifiability of End-to-End AI Pipelines (arXiv 2503.22573)](https://arxiv.org/html/2503.22573v1)
- [Bittensor Protocol: Critical Analysis (arXiv 2507.02951)](https://arxiv.org/html/2507.02951v1)

Pricing references (2026):

- [Fireworks Pricing](https://fireworks.ai/pricing)
- [LLM Fine-Tuning Pricing 2026 — Price Per Token](https://pricepertoken.com/fine-tuning)
- [H100 Rental Prices Compared — IntuitionLabs](https://intuitionlabs.ai/articles/h100-rental-prices-cloud-comparison)

Related internal specs:

- `spec/2026-04-06-phase-1a-design.md`
- `docs/superpowers/plans/2026-04-06-phase-1a-tokenomics.md`
