# Cluster vocabulary — operational search terms by cluster

Companion to the `cluster-model` skill. Calibration-only — the canonical cluster definitions live in [`GROWTH.md`](../../../../GROWTH.md) §3 (current target) and §4 (GTM phases). This file holds the search vocabulary the skill uses to sample fresh evidence per cluster, and gets refined over time as cluster vocabulary shifts.

## Current target cluster — open-source coding agent contributors (GROWTH §3)

People who maintain or actively contribute to open-source coding agents (Aider, OpenHands, SWE-agent, Continue, Cline, Sweep, Agentless, gpt-engineer, smol-ai, Open Interpreter, Codename Goose, Devon AI, Roo Code), shipping their harness publicly, plus SWE-bench / swe-rebench leaderboard contributor pool.

**Working vocabulary (use — validated 2026-05-07 PM through `discover-twitter-recruits`):**
- *swe-rebench* (the pinned vertical — surfaces exactly the maintainer + builder pool)
- *swe-bench harness* (harness-gap framing; surfaces builders measuring scaffolding deltas)
- *coding agent harness* (broadest in-cluster query; surfaces solo OSS maintainers)
- *OpenHands*, *SWE-agent* (project-anchor queries; combine with `-filter:replies`)
- *aider coding agent* (project-anchor; produces tool-comparison and adjacent-builder noise; profile-check strict)
- *agent execution harness* (specific OSS package and the verification framing)
- *swe-bench verified lift* (operational language used by builders reporting honest deltas)

**Project / handle anchors (replies, mentions):**
- replies / mentions of `@PrimeIntellect`, `@nebiusai` — swe-rebench v2 maintainer orbit
- mentions of `OpenHands`, `swe-rebench`, `mini-swe-agent` in conversation rather than promo
- conversation around the SWE-bench / swe-rebench / Terminal-Bench leaderboard updates

**Anti-patterns specific to this cluster:**
- *patch contract OR "agent_main"* (too cross-domain — DeFi smart-contract talk + sports contracts dominate)
- *"AI agent"* alone (catches enterprise / no-code / generic agents — not coding-specific)
- *swe-rebench* paired with `min_faves:N` (catches Bittensor SN120 `$TAO`-pumpers running coding-agent-themed RL — Sprint #1 retired that cluster, freeze rather than re-engage)

**Maintainer-vs-operator distinction (sub-rule, lesson logged 2026-05-07 PM):** for the swe-rebench v2 vertical, the *maintainer* pool (Nebius / Prime Intellect builders, Princeton SWE-bench team) is **adjacent**, not in-cluster. They are upstream of the SolverNet, not downstream operators. Engagement shape with them is methodology dialogue + amplification, never operator-recruit. The OSS coding-agent contributor cluster proper is solo or small-team builders shipping their own harnesses (`@alexpinkone` / CodeBot AI, `@luciusluxfire` / agent-execution-harness, `@kylemathews` / new harness in progress, `@feng_huawe30089` / 1500-LOC tiny code agent, etc.).

**Generic anti-patterns (refer to `discover-twitter-recruits/references/search-strategy.md` §1):** generic *agent economy*, *agentic future*, *value capture* phrasings catch shillers; thesis-language verbatim catches landing-page copy; audience-name vocabulary without §7 post-filter catches marketing-quest accounts.

## Phase 2 (provisional) — domain professionals (GROWTH §4)

Bankers, consultants, lawyers, other white-collar professionals whose work is being benchmarked. Sampling is light — the cluster is benchmark-coupled and the SolverNet of focus has not been pinned. Vocabulary will firm up once §7 names the specific benchmark.

**Provisional vocabulary:**
- *AI replacing investment banking*
- *AI replacing consulting*
- *AI in legal work*
- *agent benchmark + (banking / consulting / law)*

Handle the brand-risk gate explicitly: discard candidates whose feed is dominated by displacement-anxiety register; recruit candidates with agency-framed posts (skin-in-the-game on whether AI can do the job).

## Phase 3 — crypto-native (GROWTH §4, deprioritised)

DeFi / mech-design fluent participants. The cluster does not lead — it follows visible adoption. Sampling is deprioritised until §7 metrics show Phase 1 traction.

**Vocabulary (when sampling):**
- *vault curation*
- *DeFi risk parameters*
- *AMM design*
- *liquidation cascade*
- *stablecoin oracle design*
- *perp mechanism*

Sprint #1 retired this cluster as primary on 2026-05-06; see `growth-log` §7 postmortem for the reasons (sub-segment tribalism, fine-grained differentiation problem from inside crypto vocabulary).

## Refinement loop

When a sampling run consistently returns noise after the §7 post-filter, the vocabulary is stale. Update this file (operational change, not canonical) and note the change in `growth-log` §1 under the next `Sampled this run:` block. Larger vocabulary shifts that indicate the *cluster itself* has shifted should be raised to `growth-refine` for a possible §3 bridge-model amendment.
