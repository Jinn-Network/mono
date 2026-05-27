# RL applied to the harness: what's in Jinn today, what 16 papers suggest, what we'd try next

**Date:** 2026-05-27
**Author:** Jinn contributor (spike under [#692](https://github.com/Jinn-Network/mono/issues/692))
**Status:** Discussion-post draft — public version of [DR-2026-05-27](../../log/decisions/2026-05-27-rl-on-harness-survey.md). Call for feedback.

---

## Why we're asking

Jinn is an open agentic knowledge economy. Each operator runs a daemon
whose `learn` skill drives a seven-phase loop — Orient → Strategize → Plan
→ Execute → Debrief → Improve → Memory consolidation. The Improve and
Memory phases mutate a per-agent git-backed state directory across a
seven-tier action surface (skill edits, hook edits, tool-config edits,
new skills, new tools, operator-access requests, harness install
patches). The wager: **the harness is the policy.** We update prompts,
skills, tool libraries, and retrieval over a frozen foundation model
rather than the model weights.

A predecessor spike ([DR-2026-05-26](https://github.com/Jinn-Network/mono/pull/677))
found one thing that's working — `claude-code-learner/prediction_v1`
accumulated nine Improve commits across runs on a single operator — and
one thing that's not: **all nine commits are in the lowest-risk tier
(markdown notes).** No skill edits, no new tools, no hook changes despite
the surface allowing them.

So we went looking. The field has moved past Reflexion-style memory:
Voyager, Promptbreeder, DSPy, OPRO, SWE-RL, ReST^EM, Constitutional AI,
ExpeL, Self-Refine, SWE-agent, MemGPT, TextGrad, GEPA, Darwin Gödel
Machine, Generative Agents — fifteen-plus candidates for non-weight
self-improvement. This is the public version of the survey we wrote, and
the three intervention sequences we'd propose. We're posting it for
feedback because the design pass that follows
([#689](https://github.com/Jinn-Network/mono/issues/689)) will choose
between them.

## What Jinn has today (one paragraph)

Two layers. **Retrieval (RAG):** the daemon's MCP server exposes
`search_records → inspect_record → acquire_artifact` against a Ponder
indexer over donation envelopes (own and cross-operator, same mechanism).
**Parameters:** the seven-tier action surface above, with `implStateDir`
git-backed, each Improve commit recoverable by sha, Consolidator revert
already plumbed. `mode: 'train' | 'frozen'` is contractually enforced
at the Harness interface; frozen-mode hash-fences `implStateDir`.

What we don't have: (a) attribution from a downstream reward signal back
to a specific Improve commit; (b) any retrieval policy more sophisticated
than name-similarity over the corpus; (c) any mechanism that biases the
promoter toward higher-tier action surface over notes.

## The 16-technique table (abbreviated)

The full DR is at [`log/decisions/2026-05-27-rl-on-harness-survey.md`](../../log/decisions/2026-05-27-rl-on-harness-survey.md);
this table is the headline.

| # | Technique (year) | Updates | Status in Jinn |
|---|---|---|---|
| 1 | [Voyager](https://arxiv.org/abs/2305.16291) (2023) | Skill library + curriculum | **Partial** — promoter `new-skill` tier exists; vector-indexed retrieval doesn't |
| 2 | [Reflexion](https://arxiv.org/abs/2303.11366) (2023) | Episodic memory (verbal) | **Implemented** — Debrief → Memory |
| 3 | [Promptbreeder](https://arxiv.org/abs/2309.16797) (2023) | Prompts + meta-prompts | **New work** |
| 4 | [DSPy](https://arxiv.org/abs/2310.03714) (2023) | Per-module prompts + few-shots | **Partial** — promoter is one module; no compiler |
| 5 | [OPRO](https://arxiv.org/abs/2309.03409) (2023) | Prompt (instruction) | **New work** |
| 6 | [SWE-RL](https://arxiv.org/abs/2502.18449) (2025) | **Weights** | **Control** |
| 7 | [ReST-EM](https://arxiv.org/abs/2312.06585) (2023) | **Weights** | **Partial** — verifier-filter half ports |
| 8 | [Constitutional AI](https://arxiv.org/abs/2212.08073) (2022) | **Weights** + preference model | **Partial** — PRINCIPLES.md is the constitution |
| 9 | [Generative Agents](https://arxiv.org/abs/2304.03442) (2023) | Memory stream + reflections + retrieval | **Partial** |
| 10 | [ExpeL](https://arxiv.org/abs/2308.10144) (2023) | Insight rule-base + retrieval | **Partial** |
| 11 | [Self-Refine](https://arxiv.org/abs/2303.17651) (2023) | Intra-episode output | **Implemented** |
| 12 | [SWE-agent](https://arxiv.org/abs/2405.15793) (2024) | Tool library + I/O format (manual) | **Implemented** |
| 13 | [MemGPT](https://arxiv.org/abs/2310.08560) (2023) | Hierarchical memory + eviction | **New work** |
| 14 | [TextGrad](https://arxiv.org/abs/2406.07496) (2024) | Any text parameter | **New work** |
| 15 | [GEPA](https://arxiv.org/abs/2507.19457) (2025) | Prompt Pareto front + reflective mutation | **New work** |
| 16 | [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954) (2025) | Whole agent codebase | **Partial** — `implStateDir` is the substrate |

"Implemented" = mechanism is materially present today. "Partial" = plumbing
exists, a load-bearing half is missing. "New work" = no current surface.
"Control" = counterexample (weight-update or no-loop).

## Three ranked intervention sequences

**Sequence A — promoter-prompt nudge + selection-on-reward.** Highest
leverage, lowest effort.

- **A1:** add a paragraph to the promoter prompt biasing toward
  skill edits and new tools over notes; A/B against current prompt for one
  operator over N runs. Effort: ≤1 sprint. Gated on: nothing. Prior art:
  Voyager, Darwin Gödel Machine.
- **A2:** wire the Consolidator to read recent-N-run reward signal per
  Improve-commit sha and `git revert` non-improving commits. The
  revert-by-sha plumbing exists; what's missing is the reward attribution.
  Effort: 1–2 sprints. Gated on:
  [#671](https://github.com/Jinn-Network/mono/issues/671) (TranscriptWatcher
  startup) and [#672](https://github.com/Jinn-Network/mono/issues/672)
  (CodexSessionParser format drift). Prior art: ReST-EM, Voyager, GEPA.

**Sequence B — reward-shaped retrieval.** Medium leverage, medium effort.
Replace name-similarity ranking in `handleSearchRecords` with empirical
PASS-correlation weighting; requires the same reward-attribution
infrastructure as A2. Cross-operator amplification is downstream-bound on
donation density (today: 2 active publishers per DR-2026-05-26). Prior
art: contextual bandits, ExpeL, Generative Agents.

**Sequence C — Pareto-per-SolverNet promoter evolution.** Medium leverage,
high effort. Maintain k=4 promoter prompts per SolverNet; evolve via
reflective mutation; keep a Pareto front per SolverNet (the GEPA
contribution — defeats local optima). Right thing if A and B have
demonstrated the central wager and we want to push further. Prior art:
Promptbreeder, GEPA.

## Why Sequence A first

Two reasons.

1. **The empirical-occupancy gap is the load-bearing diagnostic.** Nine
   commits in the lowest tier is what tells us we don't yet know whether
   the substrate's higher tiers are valuable — because they're untouched.
   A one-paragraph nudge that shifts the distribution upward turns the
   un-exercised surface into a measurable experiment.
2. **A's two steps share infrastructure with B and C.** The reward
   attribution wired up in A2 is exactly what B's retrieval-ranking and
   C's per-prompt fitness both need. So A is also the cheapest path to
   the prerequisites for B and C.

We'd file A1 as a `feat` issue (no prerequisites) and A2 as a `design`
issue *now* (implementation gated on #671 / #672) so the design work
parallelises the unblock.

## What this does not yet prove

Per [`PRINCIPLES.md`](../../PRINCIPLES.md) Legibility, naming the gap is
more honest than papering over it.

- **The leverage rankings are reasoned, not measured.** None of the
  surveyed techniques have been benchmarked against each other on Jinn's
  task stream. Sequence A's A/B is the first datapoint that will sharpen
  them.
- **Cost is not priced in.** Per-step inference cost differs by 1–3 orders
  of magnitude across these techniques. An honest cost-leverage Pareto
  would change the order; this survey doesn't run that pass.
- **Multi-operator dynamics are unstudied.** Every cited paper studies
  single-agent learning. Jinn's marketplace introduces unsolved questions
  (publish vs. hoard? cross-operator donation density × selection-on-reward
  composition?) that no prior art addresses. Phase 5 in #689's roadmap
  scopes this; it's not in scope here.
- **The survey is a thick slice, not exhaustive.** Refresh recommended
  every ~6 months. Areas not covered: process reward models, search-based
  reasoning (LATS), production-harness comparisons (OpenHands), recent
  agent-debate or multi-agent self-play work.

## What we're asking

If you've shipped non-weight self-improvement in production — or if you're
in the literature on any of the 16 techniques above — we'd value your
read on:

1. **Did we miss a paper or system that belongs in §2?** Particularly
   anything 2025+; that's the part of the literature we're least certain
   we have full coverage of.
2. **Does Sequence A's ranking match your priors?** The case for "nudge
   the promoter prompt first" is built on the empirical-occupancy gap.
   Have you seen the opposite — agents who happily use the higher action
   surface but produce noise? If so, what gate worked?
3. **Selection-on-reward design.** The Consolidator already reverts by
   sha on Debrief's trend signal; tying revert to actual reward
   correlation is the proposed change. What window size, what statistical
   discipline (we're thinking of falling back to held-out validation,
   Voyager-style)?
4. **Are there 2025+ findings on multi-agent / federated harness learning
   we should be reading before #689's design pass?** This is the part
   we're weakest on; the cited papers are all single-agent.

Comment here, file an issue at
[`Jinn-Network/mono`](https://github.com/Jinn-Network/mono), or reach out
on the public channels in [`GROWTH.md`](../../GROWTH.md).

The DR with full per-technique briefs, the mapping table, the gating
matrix, and the §7 caveats is at
[`log/decisions/2026-05-27-rl-on-harness-survey.md`](../../log/decisions/2026-05-27-rl-on-harness-survey.md).
