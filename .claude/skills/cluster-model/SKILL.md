---
name: cluster-model
description: Use to refine thought-models of the AI / crypto / AI×crypto clusters Jinn recruits from, identify gaps to the canonical THESIS frame, and output bridge angles for both broadcast posts and per-individual replies. Triggers on "what does the X cluster think", "build a cluster model", "find bridges to cluster Y", "where does our thinking diverge from the AI cluster", "update the cluster snapshot", "what bridges have we got", "refresh the market model". Reads canonical docs (THESIS, BRAND, GROWTH); writes cluster snapshots and bridge angles to growth/.local/growth-log.md sections 1 and 2. Composes upstream of discover-twitter-recruits (refines vocabulary) and x-post-builder bridge-post mode (consumes angles produced here).
---

# Cluster model

Refine per-cluster thought-models with verbatim evidence. Identify gaps to Jinn's canonical frame. Propose bridge angles for broadcast and per-individual outreach.

## Read first
- [`GROWTH.md`](../../../GROWTH.md) — the recruiting bet and what we will not chase.
- [`THESIS.md`](../../../THESIS.md) — the canonical structural argument.
- [`BRAND.md`](../../../BRAND.md) — voice and headless-brand posture.
- [`growth/.local/growth-log.md`](../../../growth/.local/growth-log.md) §1 — current cluster snapshot.
- [`references/bridge-shapes.md`](references/bridge-shapes.md) — canonical sub-patterns by cluster.

This skill operationalises the recruitment loop articulated 2026-05-01: *continuously refine a model of how the market is thinking about decentralised agentic AI; look for opportunities to bridge clusters and individuals over to our way of thinking; out of that, source individual recruits, and speak to parts of the existing audience in a way that will resonate*. Do not redefine GROWTH-level claims here.

## What this skill does

One mode: **refresh**. Pulls fresh evidence per cluster, compares against last snapshot, identifies deltas, proposes bridge angles. Writes the result back to the growth log.

Three target clusters (canonical, do not invent new ones without a proposal):
- **AI** — AI-capability builders. Coordination treated as research/cryptography problem, not protocol-economic.
- **Crypto** — DeFi / mechanism-design fluent. Treats AI as productivity tool, not participant class.
- **AI × crypto** — agent-economy operators. Already shipping at one specific layer (identity / payment / execution / eval); often miss the outer-loop-with-stake.

## Mental model in one paragraph

The map is more valuable than the candidate list. Cluster thought-models are precipitates of recurring frames in cluster-shaping voices' public posts. The gap to Jinn is what those voices haven't said yet — the next move in their argument that lands in our frame. Bridge angles are the questions or claims that move them across that gap without naming Jinn. The pattern, observed across 5 successful first-touches by 2026-05-01: methodology question that engages a specific gap they've already named, asking them to extend their thinking one step further toward the Jinn frame, without naming Jinn.

## When to run

- Weekly, as part of the routine cycle that feeds `growth-day`.
- Ad-hoc when a cluster shifts (a16z drops a manifesto, OpenAI ships agent platform, major operator rebalances).
- Before drafting a `bridge-post` (consumed by `x-post-builder` bridge-post mode).

## Procedure

Apply in order. **Always sample, always append.** The point is to build a *dynamic* model that accumulates evidence across runs from a *moving* sample of voices — not to track the same fixed set of accounts and measure their drift. A fixed-set tracker measures who you already know; a sampling tracker measures the cluster.

### Step 1 — Read the current snapshot

Read `growth/.local/growth-log.md` §1. Note the last-refresh date per cluster and the handles already cited as evidence (so you can skip them this run — diversity matters more than re-quoting the same voices).

### Step 2 — Sample fresh voices per cluster via search

For each cluster, run 2–3 `bird search` queries using cluster-specific vocabulary, aggregate the candidate handles, apply the §7 post-filter from `discover-twitter-recruits/references/search-strategy.md` (no `$TICKER` rate ≥40%, no hashtag-stack ≥30%, no 🚨-prefix ≥30%, no marketing-register density ≥25%), then sample 5–7 *diverse* handles per cluster. Diversity rules:

- Prefer handles not in the existing §1 evidence list (rotate the sample).
- Prefer mid-sized accounts (~1k–50k followers); skip mega-accounts unless they are the substantive surface for that vocabulary right now.
- Skip handles already in growth-log §3 active threads (those are tracked by `growth-watcher`, not the cluster model).

Suggested vocabulary per cluster (refine over time as the cluster shifts; keep the search-strategy.md anti-patterns in mind):

- **AI cluster:** *agent eval harness*, *decentralized AI*, *agent observability*, *alignment is a coordination problem*, *open harness*, *long-horizon agent*, *eval signal*.
- **Crypto cluster:** *vault curation*, *stablecoin oracle design*, *perp mechanism*, *DeFi risk parameters*, *AMM design*, *liquidation cascade*.
- **AI × crypto cluster:** *ERC-8004*, *x402*, *OLAS PoAA*, *agent registry*, *agent payment rail*, *outcome attestation*, *agent stake*.

Then for each sampled handle, run `bird user-tweets <handle> -n 12 --plain` and extract: recurring frames, named gaps, vocabulary they use, vocabulary they avoid, recent shifts in stance.

If a search returns mostly noise after the filter, refine the vocabulary for next run rather than over-relaxing the filter.

### Step 3 — Update cluster snapshot — append, don't replace

Each cluster's §1 entry has three sub-sections:

- **Frame (current):** one-paragraph synthesis of how the cluster is thinking *as of this refresh*. Replace the prior frame *only* if today's evidence shifts it; otherwise keep the prior frame and add a one-line dated note (`2026-MM-DD: no frame shift; N new evidence points added`).
- **Evidence (cumulative, dated):** append today's evidence under a new `Sampled this run: YYYY-MM-DD — N handles via "<vocab>" search; M passed §7 filter` sub-heading, then list verbatim quotes with handle, date, URL beneath. Do not delete prior `Sampled this run:` blocks — the historical record is the dynamic model. The literal `Sampled this run: YYYY-MM-DD` prefix lets `growth-day` Step 0 detect freshness with a simple grep.
- **Gap to Jinn (current + drift log):** the current synthesis of where the cluster sits relative to the THESIS frame, plus a dated change-log when the gap shifts (`2026-MM-DD: gap refined from X to Y because [evidence]`).

If a cluster genuinely produced no new evidence (e.g., search returned no usable handles after the filter), still write the `Sampled this run: YYYY-MM-DD` heading with `0 new evidence (filter rejected all)` underneath — that itself is data, and it keeps the freshness stamp current.

### Step 4 — Identify bridge angles

For each cluster, propose 1–3 bridge angles. Each angle has:
- **Form:** broadcast post OR per-individual methodology question.
- **Claim:** the contestable claim or question that makes the bridge.
- **Target:** which voices in the cluster the bridge is calibrated for.
- **Sub-pattern reference:** which of `references/bridge-shapes.md`'s sub-patterns this instance applies.

### Step 5 — Write the deltas to growth-log §2

Append a dated entry to growth-log §2 (Bridge experiments). Honesty rules: if a bridge angle didn't change since last run, mark it `(carry over from YYYY-MM-DD)`. If a bridge angle was tried and failed, log the failure with the lesson.

### Step 6 — Recommend handoff

If a bridge angle is broadcast-shaped, note: "→ pass to `x-post-builder` bridge-post mode."
If a bridge angle is per-individual, note: "→ candidate handles for next `discover-twitter-recruits` round."

## Output format

Output the delta inline in chat (cluster-by-cluster), then write the structured update to the growth log. Both forms must be honest about what changed and what didn't.

```
CLUSTER MODEL — refresh dated YYYY-MM-DD

AI
  Sampled this run: [N handles via "<vocab>" search; M passed §7 filter]
  Frame: [one-line summary of current frame; note "no shift since YYYY-MM-DD" if unchanged, else describe shift]
  New evidence appended: [up to 3 bullets with handle + verbatim quote + URL — these are net-new to §1]
  Gap to Jinn: [current synthesis; note refinement date if shifted]
  New bridge angles: [up to 3, with sub-pattern reference]

CRYPTO
  [same shape]

AI × CRYPTO
  [same shape]

WRITTEN TO: growth/.local/growth-log.md §1 (evidence appended), §2 (bridge angles)
HANDOFFS:
  - bridge-post candidates: [list]
  - next discovery target handles: [handles surfaced by sampling that look operator-shaped → feed discover-twitter-recruits]
```

## Voice constraints

- British English. No emoji. Plain prose.
- Builder-to-builder vocabulary. Strip marketing register.
- "Carry over from YYYY-MM-DD" is more useful than rewriting unchanged content.
- If a bridge angle has no evidence to back it, do not propose it.

## What this skill does not do

- Draft the broadcast post. (Hand off to `x-post-builder` bridge-post mode.)
- Profile-check candidates or run discovery. (Hand off to `discover-twitter-recruits`.)
- Score posts for reach. (That is `x-algorithm-grader`.)

## Composition

- **Inputs:** canonical docs, growth-log §1 prior snapshot, fresh `bird user-tweets` data.
- **Outputs:** updated growth-log §1, §2; bridge-angle handoffs.
- **Upstream of:** `discover-twitter-recruits` (cluster vocabulary feeds search), `x-post-builder` bridge-post mode (angles → drafts), `growth-day` (surfaces angles for today's actions).
