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
self-improvement. This is the public version of the survey, with a
proposed six-level ladder of increasing RL sophistication. We're posting
it for feedback because the design pass that follows
([#689](https://github.com/Jinn-Network/mono/issues/689)) will choose
where on the ladder to land first.

## What Jinn has today

Two layers, both more built than we first thought.

**Retrieval (RAG):** the daemon's MCP server exposes `search_records →
inspect_record → acquire_artifact` against a Ponder indexer over
donation envelopes (own and cross-operator, same mechanism).

**Parameters:** the seven-tier action surface (skill edits / hook edits
/ tool-config edits / new skills / new tools / operator-access requests
/ harness install patches), with `implStateDir` git-backed, each Improve
commit recoverable by sha, Consolidator revert already plumbed. The
`mode: 'train' | 'frozen'` field is contractually enforced at the
Harness interface; frozen-mode hash-fences `implStateDir`.

**The verdict-to-harness-state join is already live.** The freeze-fence
computes `codeDigest = hashImplStateDir(implStateDir)` on every run.
That codeDigest is written into the Solution envelope's
`executor.codeDigest`, published on-chain via the v2 payload, and
materialised by the indexer into `attemptEnvelopeMeta.codeDigest` —
joinable to `verdictEnvelopeMeta.actualPassed` / `actualScore`. The
explorer SPA already runs essentially this query for frozen-mode
SolverNet views. Per-codeDigest selection-on-reward is one
GraphQL/SQL query against the indexer today.

**Structured trajectories are also already published.** The
`TrajectoryCollector` produces hash-chained, secret-scrubbed,
content-addressable spans; the envelope carries a sha256-referenced
`trajectory` field served via the operator's HTTP endpoint. Evaluator
trajectories are rich (`venue_io`, `artifact.emit`, `state_transition`);
solver trajectories today are sparse (`state_transition` markers only).

What we don't have: (a) any consumer that closes the feedback loop
using the live join — nothing reads per-codeDigest aggregate reward to
decide reverts; (b) richer solver-side trajectory spans (the MCP
server's tool handlers aren't instrumented to call `addSpan`, and the
local codex / claude-code session JSONLs aren't joined into the
envelope trajectory — that's what
[#671](https://github.com/Jinn-Network/mono/issues/671) +
[#672](https://github.com/Jinn-Network/mono/issues/672) unblock);
(c) any retrieval policy more sophisticated than name-similarity over
the corpus; (d) any mechanism that biases the promoter toward
higher-tier action surface over notes.

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

## The ladder

Each level adds an RL capability; each costs the operator a different
amount of inference; each requires different work in Jinn beyond what
exists today.

| Level | What it adds | Operator cost | Required in Jinn |
|---|---|---|---|
| **0** (today) | Verbal-RL — Consolidator reverts on Debrief's qualitative trend | — | Already running |
| **1** | Per-codeDigest aggregate selection-on-reward — revert Improve commits whose codeDigest correlates with worse `actualPassed` | Nothing extra (observational) | Ponder index on `attemptEnvelopeMeta.codeDigest`; plugin-internal sample-window tracker + indexer query + revert decision; promoter-prompt nudge toward higher tiers |
| **2** | Controlled per-commit ablation — deliberately run K samples from sha_n vs sha_{n−1} | **K× per ablation** | Level 1 + daemon CLI (`jinn ablate <sha> --samples K`) |
| **3a** | Retrieval-pattern GRPO — group-relative advantage on which donations each run acquired | K× per task optimized | Level 1 + trajectory-diff over envelope `artifacts` lists. No new instrumentation |
| **3b** | Per-tool-call GRPO / GEPA — within-trajectory action attribution | K× + trajectory overhead | Richer solver-side spans, via MCP-server instrumentation **or** [#671](https://github.com/Jinn-Network/mono/issues/671) + [#672](https://github.com/Jinn-Network/mono/issues/672) |
| **4** | Process reward model — per-step credit within one trajectory | Sustained PRM inference | Level 3b + PRM training |
| **5** | Weight updates — full RL on the foundation model | Open-weight self-host | Foundation-model training infra; horizon |

The early ladder (Levels 0 → 1 → 2 → 3a) is achievable without
[#671](https://github.com/Jinn-Network/mono/issues/671) /
[#672](https://github.com/Jinn-Network/mono/issues/672). Those gates
are real but only for **3b and above**, where per-tool-call spans
matter.

## Why Level 1 first

Three reasons.

1. **The empirical-occupancy gap is the load-bearing diagnostic.** Nine
   commits in the lowest tier (DR-2026-05-26) tells us we don't yet
   know whether the substrate's higher tiers pay off — because they're
   untouched. A promoter-prompt nudge that shifts the distribution
   upward turns the un-exercised surface into a measurable experiment.
2. **Level 1 is the first level that uses quantitative reward signal**,
   and it does so observationally over attempts the operator already
   pays for. Per-attempt cost in Jinn is real JINN spend — the K×
   inference cost of Levels 2+ is a real operator decision that
   benefits from prior empirical grounding.
3. **The sample-window pattern at Level 1 is the substrate for every
   higher level.** Period-tracking + indexer query + statistical
   decision lives in the learner plugin; every level above reuses it.
   Filing Level 1 is also filing the foundation Levels 2 / 3a / 3b
   build on.

We'd file Level 1 as three small issues: (1) `chore(indexer)` for the
codeDigest index (~1 hour); (2) `feat(learner)` for the
sample-window + indexer-query + revert-decision extension to the
Consolidator (~1 sprint); (3) `feat(learner)` for the promoter-prompt
nudge (~1 day). Independent of #671 / #672.

There's a federated Level 1 within reach as well: the indexer join
works across *all* operators, not just the local one. "Which
codeDigests across the network perform best on this SolverNet?" is
already queryable, and an operator could converge on the dominant
codeDigest by observation alone. That's one path to Phase 5 federation
in #689 that needs no new infrastructure.

## What this does not yet prove

Per [`PRINCIPLES.md`](../../PRINCIPLES.md) Legibility, naming the gap is
more honest than papering over it.

- **The leverage rankings are reasoned, not measured.** None of the
  surveyed techniques have been benchmarked against each other on Jinn's
  task stream. Level 1's deployment is the first datapoint that will
  sharpen them.
- **Cost is not priced in.** Per-step inference cost differs by 1–3 orders
  of magnitude across these techniques. An honest cost-leverage Pareto
  would change the order; this survey doesn't run that pass. (The
  ladder's Levels 2+ at K× per-task cost is named, but the per-SolverNet
  K-choice is itself an open economic question.)
- **Multi-operator dynamics are unstudied.** Every cited paper studies
  single-agent learning. Jinn's marketplace introduces unsolved questions
  (publish vs. hoard? cross-operator donation density × selection-on-reward
  composition?) that no prior art addresses. Phase 5 in #689's roadmap
  scopes this; it's not in scope here.
- **The survey is a thick slice, not exhaustive.** Refresh recommended
  every ~6 months. Areas not covered: process reward models, search-based
  reasoning (LATS), production-harness comparisons (OpenHands), recent
  agent-debate or multi-agent self-play work.
- **First draft under-specified what was already built.** The DR's
  first publish claimed Level 1 was gated on
  [#671](https://github.com/Jinn-Network/mono/issues/671) /
  [#672](https://github.com/Jinn-Network/mono/issues/672) and that
  reward attribution required new wiring. Both wrong: the
  verdict-to-codeDigest join is live in the indexer, structured
  trajectories are already published with every Solution envelope, and
  the gating only kicks in at Level 3b (per-tool-call attribution).
  Corrected in the DR's §1.3 / §1.4 and the ladder above.

## What we're asking

If you've shipped non-weight self-improvement in production — or if you're
in the literature on any of the 16 techniques above — we'd value your
read on:

1. **Did we miss a paper or system that belongs in §2?** Particularly
   anything 2025+; that's the part of the literature we're least certain
   we have full coverage of.
2. **Does the ladder match your priors?** The case for Level 1 first is
   built on the empirical-occupancy gap plus the observational-only
   per-attempt cost. Have you seen the opposite — agents who happily
   use the higher action surface but produce noise? If so, what gate
   worked? Anyone gone straight to GRPO-shape on harness actions and
   regretted skipping the per-codeDigest aggregate step?
3. **Selection-on-reward design at Level 1.** The Consolidator already
   reverts by sha on Debrief's trend signal; tying revert to actual
   reward correlation is the proposed change. What window size, what
   statistical discipline? (We're thinking held-out validation,
   Voyager-style — but the per-codeDigest sample sizes will be small
   in early operation.)
4. **Are there 2025+ findings on multi-agent / federated harness
   learning we should be reading before #689's design pass?** This is
   the part we're weakest on; the cited papers are all single-agent,
   yet a federated Level 1 — operators converging on dominant
   codeDigests by observation — is queryable today.

Comment here, file an issue at
[`Jinn-Network/mono`](https://github.com/Jinn-Network/mono), or reach out
on the public channels in [`GROWTH.md`](../../GROWTH.md).

The DR with full per-technique briefs, the mapping table, the gating
matrix, and the §7 caveats is at
[`log/decisions/2026-05-27-rl-on-harness-survey.md`](../../log/decisions/2026-05-27-rl-on-harness-survey.md).
