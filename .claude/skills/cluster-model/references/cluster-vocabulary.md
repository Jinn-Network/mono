# Cluster vocabulary — operational search terms by cluster

Companion to the `cluster-model` skill. Calibration-only — the canonical cluster definitions live in [`GROWTH.md`](../../../../GROWTH.md) §3 (current target) and §4 (GTM phases). This file holds the search vocabulary the skill uses to sample fresh evidence per cluster, and gets refined over time as cluster vocabulary shifts.

## Current target cluster — AI builders (GROWTH §3)

Eval-harness builders, agent-observability tooling builders, RL-environment authors, shadow-eval practitioners, public-benchmark contributors.

**Working vocabulary (use):**
- *agent eval harness*
- *agent observability*
- *open harness*
- *eval signal*
- *long-horizon agent*
- *shadow eval*
- *RL environment*
- *environments hub*
- *public benchmark agent*
- *benchmark harness*
- *agent training corpus*

**Project / handle anchors (replies, mentions):**
- `to:autonolas <topic>`
- replies under `@a16zcrypto` agent threads
- replies under cluster-shaping voices identified in growth-log §1

**Anti-patterns (refer to `discover-twitter-recruits/references/search-strategy.md` §1):** generic *agent economy*, *agentic future*, *value capture* phrasings catch shillers; thesis-language verbatim catches landing-page copy; audience-name vocabulary without §7 post-filter catches marketing-quest accounts.

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
