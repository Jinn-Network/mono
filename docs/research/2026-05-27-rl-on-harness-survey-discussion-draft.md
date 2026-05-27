# RL applied to the harness — what we have, what 16 papers suggest, what we're going to try

**Date:** 2026-05-27
**Author:** Jinn contributor (spike under [#692](https://github.com/Jinn-Network/mono/issues/692))
**Status:** Discussion-post draft — public version of [DR-2026-05-27](../../log/decisions/2026-05-27-rl-on-harness-survey.md). Call for feedback.

---

## TL;DR

Jinn is an open agentic knowledge economy. Each operator runs a daemon
that learns by mutating its own harness — prompts, skills, tools,
retrieval — over a frozen foundation model. The bet is that updating
the harness is enough to produce measurable improvement at production
scale, without ever touching model weights.

This note shares 16 cutting-edge techniques for non-weight
self-improvement of LLM-agent systems, maps each onto Jinn's existing
substrate, proposes a six-level ladder of increasing RL sophistication,
and proposes the smallest concrete first step. We're posting it for
public comment before the implementation design.

## Context

The daemon's learning loop runs in seven phases: Orient → Strategize →
Plan → Execute → Debrief → **Improve → Memory consolidation**. The last
two mutate a per-agent state directory (`implStateDir`, git-backed) via
a seven-tier action surface: skill edits, hook edits, tool-config
edits, new skills, new tools, operator-access requests, harness install
patches.

In production today, the only working learning case
(`claude-code-learner/prediction_v1`) has accumulated nine Improve
commits across runs on a single operator. All nine are in the
lowest-risk tier — markdown notes. No skill edits, no new tools, no
hook changes despite the surface allowing them. The substrate is wide;
the agent's occupancy of it is shallow.

This combination is the question the note addresses: what's the right
way to push the loop from "writes notes" to "actually learns" — and
what does the broader literature on non-weight self-improvement
suggest about the order of moves?

## The RL components, mapped to Jinn

A useful frame for what follows: every RL system has six components.
Naming where each lives in Jinn — and which one is missing — makes the
rest of the note legible at a glance.

1. **Policy** — what produces actions. *In Jinn:* the harness (prompts,
   skills, tools, retrieval). Foundation-model weights are frozen by
   design wager.
2. **Environment** — what the policy acts on. *In Jinn:* SolverNet
   tasks.
3. **Reward** — what scores actions. *In Jinn:*
   `verdictEnvelopeMeta.actualPassed` / `actualScore` from the
   evaluator, with JINN minted downstream.
4. **Trajectory** — the action/observation sequence inside one run.
   *In Jinn:* `TrajectoryCollector` publishes structured spans per run,
   sha256-referenced from the Solution envelope. Evaluator-side spans
   are rich; solver-side spans are sparse today
   (`state_transition` only).
5. **Credit assignment** — how reward attributes back to specific
   actions in the policy. *In Jinn:* this is the gap. The Consolidator
   today reverts on a qualitative trend signal; nothing reads
   quantitative per-codeDigest reward to decide what to revert.
6. **Policy update** — how the policy changes given a credit signal.
   *In Jinn:* the Improve phase's Promoter writes git commits to
   `implStateDir`; the Memory-consolidation phase's Consolidator
   reverts or prunes.

Today 1, 2, 3, 6 all exist. 4 exists but is sparse on the solver path.
5 runs on a qualitative signal, not quantitative reward. **The ladder
later in this note is the progression of #5 — closing the
credit-assignment gap with successively richer mechanisms, each
addressing a known weakness of the one before it.**

## Substrate

Jinn's learning substrate has two layers and a feedback channel
between them that isn't yet being used.

**Retrieval.** The daemon exposes `search_records → inspect_record →
acquire_artifact` via MCP, backed by a Ponder indexer over donation
envelopes. An agent can pull past artifacts — own and from other
operators, same mechanism — into context during a solve.

**Parameters.** The Improve and Memory phases mutate `implStateDir`,
git-backed, each commit recoverable by sha. A `mode: 'train' |
'frozen'` flag at the harness interface gates whether mutations are
permitted; in frozen mode the daemon hash-fences the state directory.

**Verdict signal joined to harness state.** Every run computes
`codeDigest = hash(implStateDir)` at the freeze-fence, writes it into
the Solution envelope's executor field, publishes it on-chain via the
v2 ExecutionPayload, and the indexer materialises it into
`attemptEnvelopeMeta.codeDigest`. That table joins to
`verdictEnvelopeMeta.actualPassed` / `actualScore` via the request
ID — so "for this harness state, what was the verdict?" is one
SQL/GraphQL query against the indexer, both per-operator and across
the network. The same query already runs in the explorer SPA for
frozen-mode SolverNet views (proof that the data is wired end-to-end).
The train-mode version is the same SQL minus the mode filter;
train-mode `codeDigest`s mutate per Task and so have smaller
per-codeDigest sample counts than frozen, but the Consolidator can
apply confidence-threshold and minimum-sample discipline that a
leaderboard UI can't.

**Structured trajectories per run.** A `TrajectoryCollector` produces
hash-chained, secret-scrubbed, content-addressable spans; the envelope
carries a sha256-referenced `trajectory` field served via the
operator's HTTP endpoint. Evaluator harnesses emit rich spans —
`venue_io` (external venue calls), `artifact.emit` (artifact creation),
`state_transition` (lifecycle). Solver harnesses today emit
`state_transition` markers only, without per-tool-call detail.

The closed feedback loop hasn't been wired up. The Consolidator — the
subagent that runs at the end of each run, prunes `implStateDir`,
reverts regressed mutations — currently uses Debrief's *qualitative*
trend signal to decide what to revert. The proposal in this note is to
tie revert to actual verdict-derived reward via the join above.

## What 16 papers suggest

The full per-technique briefs with arxiv citations are in the
[DR](../../log/decisions/2026-05-27-rl-on-harness-survey.md); the
headline is the mapping table.

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

"Implemented" = the mechanism is materially present in Jinn today.
"Partial" = the plumbing exists but a load-bearing half is missing.
"New work" = no current surface. "Control" = counterexample
(weight-update or no-loop), included for the comparison.

## A ladder, not a single move

The interventions divide naturally into six levels of increasing RL
sophistication and increasing operator cost. Each level addresses one
of the known weaknesses of the level below it.

| Level | What it adds | Operator cost | Required in Jinn |
|---|---|---|---|
| **0** (today) | Verbal-RL — Consolidator reverts on Debrief's qualitative trend | — | Already running |
| **1** | Per-codeDigest aggregate selection-on-reward — revert Improve commits whose codeDigest correlates with worse outcomes | Nothing extra (observational) | Index on `attemptEnvelopeMeta.codeDigest`; plugin-internal sample-window tracker + indexer query + revert decision; promoter-prompt nudge toward higher action-surface tiers |
| **2** | Controlled per-commit ablation — deliberately run K samples from sha_n vs sha_{n−1} | **K× per ablation** | Level 1 + a daemon CLI (`jinn ablate <sha> --samples K`) |
| **3a** | Retrieval-pattern GRPO — group-relative advantage on which donations each run acquired | K× per task | Level 1 + trajectory-diff over envelope `artifacts` lists |
| **3b** | Per-tool-call GRPO / GEPA — within-trajectory action attribution | K× + trajectory overhead | Richer solver-side spans, via MCP-server instrumentation or local-session capture wiring ([#671](https://github.com/Jinn-Network/mono/issues/671) + [#672](https://github.com/Jinn-Network/mono/issues/672)) |
| **4** | Process reward model — per-step credit within one trajectory | Sustained PRM inference | Level 3b + PRM training |
| **5** | Weight updates — full RL on the foundation model | Open-weight self-host | Foundation-model training infra; horizon |

**The through-line is hill climbing and its weaknesses.** Level 1 is
hill climbing on the harness: propose a small change, evaluate by pass
rate, accept if better, reject if worse. Greedy, single-trajectory,
local. Level 2 turns observational hill climbing into controlled
per-step experiments. Levels 3a / 3b introduce group baselines to
escape local optima. Level 4 supplies step-level credit. Level 5
moves from harness parameters to weight gradients. Reading the ladder
this way — *hill climbing plus successive fixes to its known
weaknesses* — makes the sequence canonical rather than ad hoc. GEPA
names its own contribution in exactly these terms: defeating "the
local-optima problem that plagues greedy prompt search."

## Why Level 1 first

Three reasons.

1. **Use what's already wired.** The verdict-to-codeDigest join is
   queryable today. Level 1 closes the loop with one small plugin
   extension and a Ponder index; no new infrastructure.
2. **Operate within the cost envelope.** Per-attempt cost in Jinn is
   real spend — the operator pays for inference and gas every time
   their daemon claims a task. Level 1 runs observationally over
   attempts the operator was going to make anyway; Levels 2+
   multiply that cost by K. A continuous loop belongs at Level 1;
   higher levels are deliberate, periodic, per-SolverNet economic
   decisions.
3. **Build the substrate every higher level needs.** Period-tracking
   + indexer query + statistical revert-decision is the sample-window
   pattern every higher level reuses. Filing Level 1 also files the
   foundation Levels 2 / 3a / 3b build on.

Level 1 will plateau on some SolverNets — that's the known
characteristic of hill climbing, not a bug. Plateau under Level 1 is
the signal to either run a Level 2 ablation (disambiguate a genuine
local optimum from a noisy denominator) or jump to Level 3 (escape via
group baselines).

There's also a federated Level 1 within reach. The indexer join works
across *all* operators, not just the local one. "Which codeDigests
across the network perform best on this SolverNet?" is queryable
today — operators could converge on dominant codeDigests by
observation alone. One path to cross-operator amplification that
requires no new infrastructure.

The concrete first sprint lands as four sub-issues of
[**#689**](https://github.com/Jinn-Network/mono/issues/689), the
design pass for harness-as-policy learning, which sits under
[**#601**](https://github.com/Jinn-Network/mono/issues/601) — the
EPIC for demonstrating solver learning. The four pieces:

- The Ponder index that makes the per-codeDigest aggregation query fast.
- The Consolidator extension that closes the feedback loop on
  aggregate reward (the actual hill-climbing step).
- The promoter-prompt nudge toward higher action-surface tiers.
- A measurement-infrastructure spike so we can tell whether Level 1
  actually improved the agent.

The full dependency map — including adjacent prerequisites that sit
under #601 directly — is in [the consolidated comment on
#689](https://github.com/Jinn-Network/mono/issues/689#issuecomment-4555858041).

## What this doesn't yet prove

- **The ladder ordering is reasoned, not measured.** None of these
  techniques have been benchmarked against each other on Jinn's task
  stream. Level 1's deployment is the first datapoint that will
  sharpen the ordering.
- **Cost isn't priced in.** Per-step inference cost varies by 1–3
  orders of magnitude across the surveyed techniques. The ladder
  names the K× per-task multiplier at Levels 2+ but doesn't produce
  a full cost-leverage Pareto.
- **Multi-operator dynamics are open.** Every cited paper studies
  single-agent learning. Jinn's marketplace introduces questions no
  prior art directly addresses — when does an operator publish
  vs. hoard a skill discovery? how does selection-on-reward compose
  with cross-operator donation density?
- **The survey is a thick slice, not exhaustive.** Areas not covered:
  process reward models, search-based reasoning (LATS),
  production-harness comparisons (OpenHands), recent agent-debate or
  multi-agent self-play. A refresh every ~6 months is appropriate.

## What we're asking

If you've shipped non-weight self-improvement in production, or work
in the literature on any of the 16 techniques above, we'd value your
read on:

1. **A paper or system we missed?** Particularly from 2025 or later —
   that's the part of the literature we're least confident is fully
   covered.
2. **Does the ladder match your priors?** The case for Level 1 first
   rests on the empirical-occupancy observation plus the
   observational-only per-attempt cost. Anyone gone straight to
   GRPO-shape on harness actions and regretted skipping the
   per-codeDigest aggregate step? Or seen agents that happily use the
   higher action surface but produce noise — and if so, what gate
   worked?
3. **Selection-on-reward design at Level 1.** Tying revert to actual
   verdict-derived reward is the proposed change. What window size,
   what statistical discipline? Voyager-style held-out validation is
   the current intuition, but per-codeDigest sample sizes will be
   small in early operation.
4. **2025+ findings on multi-agent / federated harness learning?**
   The cited papers are all single-agent, yet a federated Level 1 is
   queryable in Jinn today.

Comment on the Discussion, file an issue at
[Jinn-Network/mono](https://github.com/Jinn-Network/mono), or reach
out on the public channels named in [GROWTH.md](../../GROWTH.md).

The full DR with per-technique briefs, complete mapping table, gating
matrix, and caveats:
[`log/decisions/2026-05-27-rl-on-harness-survey.md`](../../log/decisions/2026-05-27-rl-on-harness-survey.md).
