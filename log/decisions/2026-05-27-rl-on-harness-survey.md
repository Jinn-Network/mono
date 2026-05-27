---
id: DR-2026-05-27
title: RL-applied-to-harness survey — Jinn substrate inventory, prior art landscape, candidate interventions
date: 2026-05-27
verb: Survey
status: ratified
authors: opus (spike on hungry-jones-32a040 worktree)
spike: issue [#692](https://github.com/Jinn-Network/mono/issues/692)
relates-to: [#601](https://github.com/Jinn-Network/mono/issues/601) (parent EPIC), [#689](https://github.com/Jinn-Network/mono/issues/689) (design issue this survey feeds), DR-2026-05-26 (predecessor spike on [#677](https://github.com/Jinn-Network/mono/pull/677)), [#669](https://github.com/Jinn-Network/mono/issues/669) / [#671](https://github.com/Jinn-Network/mono/issues/671) / [#672](https://github.com/Jinn-Network/mono/issues/672) (prerequisite observability fixes)
---

## Context

Jinn frames itself as a knowledge-market substrate (DR-2026-04-30). Each
operator runs a daemon whose `learn` skill drives a seven-phase loop —
Orient → Strategize → Plan → Execute → Debrief → Improve → Memory
consolidation — across a SolverNet's task stream. **Phases 6 (Improve) and 7
(Memory consolidation) mutate `implStateDir`, a per-agent git-backed state
directory.** The Improve subagent's prompt
([`promoter-prompt.md`](../../client/plugins/learner/skills/learn/promoter-prompt.md))
exposes a seven-tier action surface, in increasing risk order: skill edits,
hook edits, tool-config edits, new skills / hooks / configs, new tool source,
operator-access requests, and (policy-gated) harness install patches.

DR-2026-05-26 (PR [#677](https://github.com/Jinn-Network/mono/pull/677))
established two things empirically:

1. The substrate works on prediction.v1 — `claude-code-learner/prediction_v1`
   accumulated nine Improve/consolidate commits across runs on a single
   operator. swe-rebench-v2 is mechanically blocked because its plugin's
   `plan` skill terminates the agent's loop after `submit_typed_payload`;
   [#673](https://github.com/Jinn-Network/mono/issues/673) implements the
   fix.
2. **Every one of those nine commits is in the lowest-risk tier — markdown
   in `plans/`, `runs/`, `strategies/`.** No skill edits, no hook changes,
   no new tools. The action surface is far broader than the agent is
   exercising.

This survey grounds the question of what to do about that gap. It is the
research input for issue
[#689](https://github.com/Jinn-Network/mono/issues/689)'s design pass
(harness-as-policy learning architecture). It does **not** propose
implementation; it proposes ranked candidate interventions for the design
to choose between.

The framing the survey runs with: **the harness IS the policy**
([#689](https://github.com/Jinn-Network/mono/issues/689) phrasing). Jinn
does not update the LLM's weights. It updates the prompts, skills, tool
libraries, hooks, retrieval policies, and memory that surround a frozen
foundation model. The relevant prior art is the body of work on non-weight
self-improvement for LLM-agent systems, not classical RL on model weights.

## Decision

Ratify this survey as the literature ground for issue #689's design.
File the recommended next step (§5 below) as a `design` issue when #689
opens.

The DR's structure mirrors the issue's acceptance criteria:

- §1 — inventory of Jinn's current harness-parameter substrate (acceptance
  criterion a)
- §2 — survey of 16 cutting-edge techniques with citations (criterion b,
  floor is 10)
- §3 — mapping of each technique against Jinn (criterion c)
- §4 — three candidate intervention sequences ranked by leverage with
  effort estimates (criterion d, floor is 3)
- §5 — recommendation for the next concrete step (criterion e)
- §6 — gating against filed prerequisites
- §7 — what this survey did not check

## §1 — Jinn's current harness-parameter substrate (inventory)

### §1.1 The two-layer taxonomy

Per [#689](https://github.com/Jinn-Network/mono/issues/689), there are
**two** RL-tractable layers in Jinn today, not three:

1. **Retrieval (RAG).** Agent pulls past artifacts into context via
   `search_records → inspect_record → acquire_artifact`. Same mechanism for
   `local:served:` (own past work) and `network:envelope:` (other operators'
   donations). Cross-operator vs self is a data-density question, not a
   separate mechanism. Implementation:
   [`client/src/mcp/server.ts`](../../client/src/mcp/server.ts).
2. **Parameters (harness mutations).** The Improve phase's seven-tier
   action surface (above) plus the Memory-consolidation phase's revert /
   prune semantics. Implementation:
   [`promoter-prompt.md`](../../client/plugins/learner/skills/learn/promoter-prompt.md)
   and
   [`consolidator-prompt.md`](../../client/plugins/learner/skills/learn/consolidator-prompt.md).

A third theoretical layer — LLM weight updates — is out of reach until Jinn
self-hosts an open-weight model. The survey treats it as a control / horizon,
not as a current Jinn surface.

### §1.2 Substrate-shape facts

- **`implStateDir` is git-backed.** Session-start hook
  ([`client/plugins/learner/hooks/session-start`](../../client/plugins/learner/hooks/session-start))
  initialises the repo with `claude-code-learner` author identity. Promoter
  emits one commit per accepted mutation; Consolidator emits one
  consolidation commit per run.
- **Revert is by sha.** Each `promotion_record` carries
  `implStateDirShaAfter`; the Consolidator reverts a promotion by
  `git revert <sha>`. The plumbing for selection-on-reward is in place; the
  trigger ("which sha to revert") today comes from Debrief's trend signal,
  not from an explicit reward attribution.
- **`mode: 'train' | 'frozen'`** is contractually enforced at the Harness
  interface (DR-2026-05-06-c). In `frozen` mode the daemon hash-fences
  `implStateDir` and rejects envelopes whose hash changed. Frozen-mode is
  the externally-comparable benchmark surface;
  train-mode is the substrate-progress surface. **All learning happens in
  train mode.**
- **Allowed write paths are `implStateDir/**`,
  `workingDir/.improve/**`, `workingDir/.operator-requests/**`.** Anywhere
  else is forbidden; the promoter's prompt enforces this and the harness
  harvester respects it.
- **Operator-access requests are first-class.** When the Improve agent
  wants something only the operator can grant (a new API key, an external
  service binding, a permission scope), it writes a
  `workingDir/.operator-requests/<name>.json` artifact. Memory
  consolidation migrates these into `implStateDir/operator-requests/`
  across runs so the operator has a durable history. This is one path by
  which the marketplace of agent ↔ operator preferences can compose.

### §1.3 Empirical occupancy

Per DR-2026-05-26 §F5: the only working learning case today is
`claude-code-learner/prediction_v1` with **nine commits across runs**, all
in the lowest-risk tier (markdown in `plans/`, `runs/`, `strategies/`).
Three of the four other implStateDir trees observed have zero commits
beyond `init implStateDir`. The substrate is wide; usage is shallow.

The design wager in [#689](https://github.com/Jinn-Network/mono/issues/689)
— that **the harness is the policy** — predicts that the residual
performance plateau (60–70% resolved rate across harnesses, per
DR-2026-05-26 §Context) is in significant part a harness-mutation gap, not
a model-capability gap. This survey supplies the prior art for closing it.

## §2 — Prior art landscape (16 techniques)

Each entry is one paragraph. Citations are arxiv URLs.

### §2.1 Voyager

Wang, Xie, Jiang, Mandlekar, Xiao, Zhu, Fan, Anandkumar. *Voyager: An
Open-Ended Embodied Agent with Large Language Models*. arXiv:2305.16291,
May 2023 (NVIDIA / Caltech).
[arxiv.org/abs/2305.16291](https://arxiv.org/abs/2305.16291).

GPT-4-driven lifelong-learning agent in Minecraft. An automatic curriculum
proposes goals; an iterative prompting loop writes JavaScript skills that
are executed, debugged via environment feedback plus self-verification,
then promoted into a vector-indexed skill library keyed by docstring.
Future tasks retrieve relevant skills as context, compounding capability
with zero weight updates. Headline number: 3.3× more unique items, 2.3×
longer distances, key tech-tree milestones up to 15.3× faster than prior
SOTA; transfers learned skills zero-shot to a fresh world.

### §2.2 Reflexion

Shinn, Cassano, Berman, Gopinath, Narasimhan, Yao. *Reflexion: Language
Agents with Verbal Reinforcement Learning*. arXiv:2303.11366, NeurIPS 2023.
[arxiv.org/abs/2303.11366](https://arxiv.org/abs/2303.11366).

After each trial, the agent receives a scalar / textual reward and a
separate self-reflection LLM writes a natural-language critique into an
episodic memory buffer prepended to the next attempt's prompt. No gradient
updates; the policy improves because future contexts contain explicit error
postmortems. Headline: 91% pass@1 on HumanEval (vs GPT-4's 80% baseline);
large gains on AlfWorld and HotpotQA.

### §2.3 Promptbreeder

Fernando, Banarse, Michalewski, Osindero, Rocktäschel. *Promptbreeder:
Self-Referential Self-Improvement Via Prompt Evolution*. arXiv:2309.16797,
Sept 2023 (DeepMind).
[arxiv.org/abs/2309.16797](https://arxiv.org/abs/2309.16797).

Evolutionary algorithm where an LLM mutates a population of task-prompts.
Crucially, **the mutation-prompts themselves also evolve** — the system
improves how it improves. Fitness = task accuracy on a held-out training
set; selection by binary tournament. Headline: beats Chain-of-Thought and
Plan-and-Solve on GSM8K and BBH; produces interpretable, domain-specific
prompts.

### §2.4 DSPy

Khattab, Singhvi, Maheshwari, Zhang, Santhanam, et al. *DSPy: Compiling
Declarative Language Model Calls into Self-Improving Pipelines*.
arXiv:2310.03714, Oct 2023 (Stanford).
[arxiv.org/abs/2310.03714](https://arxiv.org/abs/2310.03714).

Programs are written as typed module graphs (`Signature` + `Module`); a
compiler (`BootstrapFewShot`, `MIPROv2`) bootstraps demonstrations and
optimises per-module instructions against a user-supplied metric.
Optimization is gradient-free over discrete prompt + few-shot space.
Headline: 5–46% absolute gains over expert-written prompts on multi-hop
QA and math; lets a 13B Llama2 match larger models when compiled.

### §2.5 OPRO

Yang, Wang, Lu, Liu, Le, Zhou, Chen. *Large Language Models as Optimizers*.
arXiv:2309.03409, Sept 2023 (DeepMind).
[arxiv.org/abs/2309.03409](https://arxiv.org/abs/2309.03409).

Treats the LLM as a black-box optimizer: each step's prompt contains a
trajectory of `(candidate, score)` pairs, and the LLM proposes new
candidates. Applied to prompt search, linear regression, TSP. The
meta-prompt is the optimizer state. Headline: +8% on GSM8K and up to +50%
on BBH vs human-engineered prompts.

### §2.6 SWE-RL

Wei, Duchenne, Copet, Carbonneaux, Zhang, Fried, Synnaeve, Singh, Wang.
*SWE-RL: Advancing LLM Reasoning via Reinforcement Learning on Open
Software Evolution*. arXiv:2502.18449, Feb 2025 (Meta), NeurIPS 2025.
[arxiv.org/abs/2502.18449](https://arxiv.org/abs/2502.18449).

RL with a lightweight rule-based reward (sequence-similarity between
predicted patch and ground-truth diff from GitHub PRs). Trains on a massive
corpus of open-source software evolution data. **This updates weights** —
included as the weight-update counterexample. Headline:
Llama3-SWE-RL-70B reaches 41.0% on SWE-bench Verified — best among
medium-sized open-weight models at the time. The rule-based-reward
methodology (similarity to ground-truth) is reusable as an evaluator signal
even without weight updates.

### §2.7 ReST-EM

Singh et al. *Beyond Human Data: Scaling Self-Training for Problem-Solving
with Language Models*. arXiv:2312.06585, Dec 2023 (DeepMind).
[arxiv.org/abs/2312.06585](https://arxiv.org/abs/2312.06585).

Reward-weighted EM. E-step: sample candidate solutions; filter by binary
verifier (e.g., test-passing). M-step: SFT the base model on filtered
samples. Repeat. **Updates weights**, but the signal-generation half
(verifier-filtered self-trajectories) is the part that ports to Jinn.
Headline: on MATH and APPS with PaLM-2, ReST-EM substantially exceeds SFT
on human data and scales favorably with model size.

### §2.8 Constitutional AI / RLAIF

Bai et al. *Constitutional AI: Harmlessness from AI Feedback*.
arXiv:2212.08073, Dec 2022 (Anthropic).
[arxiv.org/abs/2212.08073](https://arxiv.org/abs/2212.08073).

Two phases. SL phase: model critiques and revises its own outputs against
a written constitution. RL phase: trains a preference model on
AI-generated A/B labels and uses it as the RL reward. **Updates weights**,
but the constitution + self-critique loop is a non-weight pattern Jinn
can borrow wholesale. Headline: matches or exceeds RLHF on harmlessness
while being more helpful.

### §2.9 Generative Agents

Park, O'Brien, Cai, Morris, Liang, Bernstein. *Generative Agents:
Interactive Simulacra of Human Behavior*. arXiv:2304.03442, April 2023
(Stanford / Google), UIST 2023.
[arxiv.org/abs/2304.03442](https://arxiv.org/abs/2304.03442).

Architecture with (a) a raw memory stream of observations, (b) periodic
reflection passes that synthesize higher-level insights from the stream,
and (c) retrieval scored by recency × importance × relevance to plan
behavior. No reward signal beyond believability ratings; learning is
purely structural. Headline: ablations show observation, planning, and
reflection each contribute critically to human-rated believability;
emergent coordination.

### §2.10 ExpeL

Zhao, Huang, Xu, Lin, Liu, Huang. *ExpeL: LLM Agents Are Experiential
Learners*. arXiv:2308.10144, Aug 2023, AAAI 2024.
[arxiv.org/abs/2308.10144](https://arxiv.org/abs/2308.10144).

Two-stage system. (1) Experience Gathering: agent runs Reflexion-style
attempts on a training set, storing success / failure trajectories.
(2) Insight Extraction: a separate LLM mines the cross-task corpus and
distils natural-language insights (rules of thumb). Insights plus retrieved
trajectories condition test-time behavior. Headline: outperforms
Reflexion and ReAct on HotpotQA, ALFWorld, WebShop, and FEVER without
parameter updates; insights transfer across task families.

### §2.11 Self-Refine

Madaan et al. *Self-Refine: Iterative Refinement with Self-Feedback*.
arXiv:2303.17651, March 2023, NeurIPS 2023.
[arxiv.org/abs/2303.17651](https://arxiv.org/abs/2303.17651).

One LLM plays three roles — generator, critic, refiner — in a tight loop
on a single problem instance. No training, no reward model, no memory
across instances; the policy update is the in-context revision. Headline:
~20% mean improvement across seven tasks (dialog, code optimization, math
reasoning, sentiment reversal) on GPT-3.5/4.

### §2.12 SWE-agent (ACI)

Yang, Jimenez, Wettig, Lieret, Yao, Narasimhan, Press. *SWE-agent:
Agent-Computer Interfaces Enable Automated Software Engineering*.
arXiv:2405.15793, May 2024 (Princeton), NeurIPS 2024.
[arxiv.org/abs/2405.15793](https://arxiv.org/abs/2405.15793).

Argues the *interface* (what tools the agent sees, what feedback they
return) is a first-class lever distinct from the model. Custom file-viewer,
editor, and search tools designed for LM consumption (small windows,
structured errors). No learning loop in the original paper — but it is the
first systematic claim that **the harness is the policy**, by ablating ACI
surface alone. Headline: 12.5% pass@1 on SWE-bench (Devin-class at the
time) and 87.7% on HumanEvalFix, dominantly from interface-design wins
rather than model changes.

### §2.13 MemGPT (Letta)

Packer, Wooders, Lin, Fang, Patil, Stoica, Gonzalez. *MemGPT: Towards LLMs
as Operating Systems*. arXiv:2310.08560, Oct 2023 (UC Berkeley).
[arxiv.org/abs/2310.08560](https://arxiv.org/abs/2310.08560).

OS-inspired memory management: an OS-kernel prompt teaches the LLM to page
data between a small in-context working set, a recall buffer, and an
external archival store via function calls. The agent self-manages what to
evict and what to retrieve. Headline: on multi-document QA and long
conversational consistency, MemGPT outperforms fixed-context baselines;
demonstrates conversation length effectively unbounded.

### §2.14 TextGrad

Yuksekgonul, Bianchi, Boen, Liu, Huang, Guestrin, Zou. *TextGrad:
Automatic "Differentiation" via Text*. arXiv:2406.07496, June 2024
(Stanford).
[arxiv.org/abs/2406.07496](https://arxiv.org/abs/2406.07496).

Generalizes backprop to compound LLM systems: each variable (prompt, code,
molecule SMILES) receives a textual gradient — an LLM-written critique of
how to change it to improve the downstream loss. Gradients propagate
through arbitrary functions (LLM calls, simulators, solvers). Headline:
GPT-4o on GPQA 51%→55%; ~20% relative gain on LeetCode-Hard;
demonstrated on radiotherapy-plan and drug-molecule design.

### §2.15 GEPA

Agrawal, Tan, Singhvi, Khattab, et al. *GEPA: Reflective Prompt Evolution
Can Outperform Reinforcement Learning*. arXiv:2507.19457, July 2025
(UC Berkeley / Stanford / Databricks / MIT).
[arxiv.org/abs/2507.19457](https://arxiv.org/abs/2507.19457).

Genetic-Pareto prompt optimizer. Samples full trajectories (reasoning +
tool calls + outputs), reflects on them in natural language to diagnose
failures, proposes prompt mutations, and **maintains a Pareto front per
problem instance** rather than a single global best — defeating the
local-optima problem that plagues greedy prompt search. Headline: beats
GRPO (RL with verifiable rewards) by an average of 10% and up to 20%,
with up to 35× fewer rollouts; beats MIPROv2 by 10%+.

### §2.16 Darwin Gödel Machine

Zhang, Hu, Lu, Lange, Clune. *Darwin Gödel Machine: Open-Ended Evolution
of Self-Improving Agents*. arXiv:2505.22954, May 2025.
[arxiv.org/abs/2505.22954](https://arxiv.org/abs/2505.22954).

A coding agent that rewrites its own codebase. Maintains an archive of
agent versions (rather than overwriting a single best). Each step samples
an archived agent, asks a foundation model to mutate it into an
"interesting" new version, and evaluates on coding benchmarks. Open-ended
evolution over the harness, no weight updates. Headline: SWE-bench
20.0% → 50.0%; Polyglot 14.2% → 30.7%, all via harness self-edits with
frozen foundation model.

## §3 — Mapping against Jinn

The column **Status** uses:

- **Implemented** — the technique's mechanism is materially present in
  Jinn today.
- **Partial** — the mechanism's plumbing exists but a load-bearing
  half is missing.
- **New work** — no current Jinn surface; would require new code.
- **Control** — included as a counterexample (weight-update or no-loop);
  not directly portable.

| # | Technique | What it updates | Status in Jinn | Closest Jinn surface |
|---|---|---|---|---|
| 1 | Voyager | Skill library + curriculum | **Partial** | Promoter `new-skill` tier exists; vector-indexed retrieval over `implStateDir/skills/` does not |
| 2 | Reflexion | Episodic memory (verbal) | **Implemented** | Debrief → Memory; `implStateDir/transcripts/<runId>/` |
| 3 | Promptbreeder | Prompts + meta-prompts | **New work** | Would require a promoter-prompt population, not a single canonical prompt |
| 4 | DSPy | Per-module prompts + few-shots | **Partial** | Promoter is one module; no compiler abstraction across modules |
| 5 | OPRO | Prompt (instruction string) | **New work** | Would require `(prompt, JINN-earned)` trajectory feed to the meta-prompt |
| 6 | SWE-RL | **Weights** | **Control** | Rule-based reward (patch-similarity) is reusable as an evaluator signal |
| 7 | ReST-EM | **Weights** | **Partial** | Verifier-filter half is what evaluator gauntlet provides; M-step ports as skill-promotion not SFT |
| 8 | Constitutional AI | **Weights** + preference model | **Partial** | `PRINCIPLES.md` is the constitution; no self-critique → revision loop yet |
| 9 | Generative Agents | Memory stream + reflections + retrieval | **Partial** | Memory consolidation exists; recency × importance × relevance scoring does not |
| 10 | ExpeL | Insight rule-base + trajectory store + retrieval | **Partial** | Trajectory store exists; cross-task insight extraction does not |
| 11 | Self-Refine | Intra-episode output only | **Implemented** | Step-worker retry, replan logic in Execute phase |
| 12 | SWE-agent (ACI) | Tool library + tool I/O format (manual) | **Implemented** | `network-tools`, `submit_typed_payload`, MCP server tools |
| 13 | MemGPT | Hierarchical memory + eviction policy | **New work** | Consolidator prunes by mtime / size today; no agent-driven eviction |
| 14 | TextGrad | Any text parameter | **New work** | Most general framing; would require a textual-gradient pass over the harness graph |
| 15 | GEPA | Prompt Pareto front + reflective mutation | **New work** | Strongest 2025+ evidence for the central wager; no Pareto-per-SolverNet today |
| 16 | Darwin Gödel Machine | Agent codebase (whole harness) | **Partial** | `implStateDir` is the substrate; no archive-not-overwrite discipline; no inter-version sampling |

### §3.1 Where the gap is, in one paragraph

The pieces Jinn already has are **the substrate** (git-backed
`implStateDir`, revert-by-sha, mode-gated freezing, allowed write paths,
operator-access requests) and **the verbal-RL inner loop** (Reflexion-shaped
Debrief → Memory). The pieces Jinn does not yet have are **(a) any
attribution from a downstream reward signal back to a specific Improve
commit** (selection-on-reward); **(b) any retrieval policy more
sophisticated than name-similarity** over the corpus; and **(c) any
mechanism that biases the promoter toward higher-tier action surface
(skills / tools) rather than markdown-in-notes**. Most of the
high-leverage interventions in §4 close exactly these three gaps with
small, composable additions to existing prompts and indexer code.

## §4 — Candidate intervention sequences (ranked by leverage)

Each intervention names:

- **What** — concrete change.
- **Effort** — rough scale (`S` = ≤1 sprint, `M` = 1–2 sprints,
  `L` = 2+ sprints).
- **Leverage** — qualitative (`High` shifts the central
  empirical-occupancy gap; `Medium` improves an existing surface;
  `Low` is exploratory).
- **Gated on** — which filed prerequisites block it (see §6).
- **Prior art** — which techniques in §2 inform it.

### §4.1 Sequence A — promoter-prompt nudge + selection-on-reward (highest leverage / lowest effort)

**Step A1 — promoter-prompt nudge** (Effort: S; Leverage: High; Gated on:
nothing). Add a single paragraph to
[`promoter-prompt.md`](../../client/plugins/learner/skills/learn/promoter-prompt.md)
biasing the Improve agent toward higher-tier mutations (skill edits, new
tools) over note-writing, with a worked example of a skill-edit promotion.
A/B against the current prompt for one operator over N runs. **Why High
leverage:** the empirical-occupancy gap (9 of 9 commits in the lowest tier)
is the load-bearing diagnostic for the whole substrate-vs-usage
mismatch — a one-paragraph nudge that shifts the distribution upward
turns ~all of the un-exercised surface into a measurable experiment.
Prior art: Voyager (§2.1), Darwin Gödel Machine (§2.16).

**Step A2 — selection-on-reward in Memory consolidation** (Effort: M;
Leverage: High; Gated on: [#671](https://github.com/Jinn-Network/mono/issues/671),
[#672](https://github.com/Jinn-Network/mono/issues/672) for reward
attribution). Wire the Consolidator to read a recent-N-run reward signal
(per-`implStateDirShaAfter`) and `git revert` Improve commits whose
presence did not lift pass rate. Today Consolidator only reverts on
Debrief's "regressed" trend signal — that's coarse; tie it to the actual
JINN-earned / verdict-passed counter. **Why High leverage:** the
revert-by-sha plumbing already exists; this turns the existing substrate
from "wide but un-pressured" into the closed loop the design wager
requires. Prior art: ReST-EM (§2.7, verifier-filter step), Voyager (§2.1,
skill validation), GEPA (§2.15, Pareto-front discipline).

**Sequence A combined effort:** S + M = roughly one sprint of focused
work once #671/#672 land. **Combined leverage:** closes both the
"agent under-uses the surface" gap and the "no reward attribution" gap in
one ordered pair.

### §4.2 Sequence B — reward-shaped retrieval (medium leverage / medium effort)

**Step B1 — reward-attribution indexer schema** (Effort: M; Leverage:
Medium; Gated on:
[#671](https://github.com/Jinn-Network/mono/issues/671),
[#672](https://github.com/Jinn-Network/mono/issues/672)). Indexer-side
back-join from `verdict.score` to every span in the trajectory that
produced it, so each `acquire_artifact` call inherits a downstream PASS /
FAIL marker. Required by everything in §4.1 step A2 and §4.2 step B2.
Prerequisite, not a deliverable.

**Step B2 — reward-shaped retrieval ranking** (Effort: M; Leverage:
Medium; Gated on: B1). Replace name-similarity ranking in
`handleSearchRecords` ([`client/src/mcp/server.ts`](../../client/src/mcp/server.ts))
with empirical-reward ranking — corpus entries weighted by their
downstream PASS correlation across the operator's history (and, where
cross-operator data exists, across the network). **Why Medium leverage:**
the cross-operator corpus is sparse today (DR-2026-05-26 §F3: two active
publishers), so the immediate gain is largely intra-operator. Becomes
High leverage if / when donation density grows. Prior art: contextual
bandits, ExpeL (§2.10, insight-conditioned retrieval), Generative Agents
(§2.9, recency × importance × relevance scoring).

**Sequence B combined effort:** M + M = roughly two sprints once #671/#672
land. **Combined leverage:** improves the retrieval half of the two-layer
taxonomy; downstream-bound on donation density.

### §4.3 Sequence C — Pareto-per-SolverNet promoter evolution (medium leverage / high effort)

**Step C1 — promoter-prompt population** (Effort: M; Leverage: Low alone,
High in combination with C2; Gated on: A1 having shown the agent is
willing to use higher-tier surface at all). Maintain k=4 promoter prompts
per SolverNet, sampled per run; track per-prompt downstream reward; evolve
via reflective mutation each N runs. Prior art: Promptbreeder (§2.3),
GEPA (§2.15).

**Step C2 — Pareto-front-per-SolverNet bookkeeping** (Effort: M; Leverage:
Medium; Gated on: C1, B1). Per the GEPA result, maintain a Pareto front
per SolverNet rather than a single best promoter — defeats local optima
when the SolverNet's task distribution is multi-modal. **Why this is
ranked below A and B:** higher effort, and the headline (35× sample
efficiency vs RL) is from a 2025 paper on synthetic benchmarks; production
behaviour at Jinn's scale is uncertain. Right thing if A + B have already
demonstrated the central wager and we need to push further.

**Sequence C combined effort:** M + M = roughly two sprints. **Combined
leverage:** the largest single 2025+ prior-art finding; right next step
*after* the simpler sequences have de-risked the design wager.

### §4.4 Honorable mentions (below the top three)

These are surveyed and parked, not ranked, because they don't fit the
≥3-sequence cutoff but should be visible to the design pass.

- **Voyager-style skill validation gate** (Effort: M; Leverage: Medium).
  New skills emitted by the promoter must pass a held-out validation
  before promotion. Prerequisite for any aggressive new-skill cadence.
  Cite: Voyager (§2.1).
- **Constitutional self-critique pass** (Effort: S; Leverage: Low–Medium).
  Add a self-critique step in the Improve phase grounded in `PRINCIPLES.md`
  — analogous to the SL half of Constitutional AI. Cheapest path to
  Legibility / Neutral / Permissionless adherence inside the loop. Cite:
  Constitutional AI (§2.8).
- **Cross-operator donations carry skill edits, not just past solutions**
  (Effort: L; Leverage: High *if* density grows). The substrate already
  has the envelope plumbing; what's missing is the promoter-side semantics
  for consuming a donated skill (vs. a donated past patch). Phase 5 in
  [#689](https://github.com/Jinn-Network/mono/issues/689)'s roadmap. Cite:
  Voyager (§2.1), Darwin Gödel Machine (§2.16) for the
  archive-not-overwrite discipline.

## §5 — Recommendation for the next concrete step

**File Sequence A (A1 + A2) as one or two `design` issues under
[#689](https://github.com/Jinn-Network/mono/issues/689).** Specifically:

1. **One `feat` issue:** "promoter-prompt nudge toward higher action-surface
   tiers + A/B measurement protocol." Acceptance: a single-paragraph edit
   to `promoter-prompt.md` plus a measurement plan (using
   [#683](https://github.com/Jinn-Network/mono/issues/683)'s tracker if it
   lands first; degraded measurement otherwise) lands; runs are observable
   for ≥4 weeks. Effort: S. Independent of #671 / #672 / #669.
2. **One `design` issue:** "selection-on-reward in Memory consolidation."
   Acceptance: the design pass produces a spec for how the Consolidator
   reads per-sha downstream reward signal and reverts non-improving Improve
   commits. Effort: M. Implementation gated on #671 / #672. Filing the
   design issue *now* (not after #671 / #672 land) parallelises the work.

Sequence B (reward-shaped retrieval) and Sequence C (Pareto-per-SolverNet)
follow once A has demonstrated the central wager. Each of B and C can be
filed as a separate `design` issue with a single recommended near-term
issue inside it; they are sequential to A, not parallel, because the
empirical signal from A determines whether to push further on retrieval
ranking (Sequence B) or on promoter-population evolution (Sequence C)
first.

The deliberate choice is **not** to file the entire ladder at once.
Sequence A is the experimental input the design needs in order to choose
between B and C; without A's signal, the choice of B-then-C vs C-then-B is
intuition.

## §6 — Gating on filed prerequisites

| Step | Gated on | Why |
|---|---|---|
| A1 — promoter-prompt nudge | nothing | Pure prompt edit; A/B can run on existing infrastructure |
| A2 — selection-on-reward | [#671](https://github.com/Jinn-Network/mono/issues/671), [#672](https://github.com/Jinn-Network/mono/issues/672) | Needs trajectory-to-reward attribution from TranscriptWatcher + CodexSessionParser |
| B1 — reward-attribution schema | [#671](https://github.com/Jinn-Network/mono/issues/671), [#672](https://github.com/Jinn-Network/mono/issues/672) | Same as A2; this is the indexer-side half |
| B2 — reward-shaped retrieval | B1 | Needs the attribution from B1 to rank by |
| C1 — promoter population | A1 having shifted occupancy | Need empirical evidence the agent will use higher-tier surface before evolving a population over it |
| C2 — Pareto-per-SolverNet | C1, B1 | Same |
| HM — Voyager skill validation | A1 having shown new-skill promotions occur | Validation only matters once new-skill cadence exists |
| HM — Constitutional critique | nothing | Pure prompt edit |
| HM — donation of skill edits | [#666](https://github.com/Jinn-Network/mono/issues/666) | Hermes operators are currently silently disabled from cross-operator donation consumption |

**[#669](https://github.com/Jinn-Network/mono/issues/669) and
[#670](https://github.com/Jinn-Network/mono/issues/670)** (launcher
counter under-count, launcher cap overshoot) are not direct prerequisites
for any §4 sequence, but they degrade the denominator of every learning
measurement. Filed-but-not-blocking: a survey result expressed as
"pass rate improved by +X%" is unreliable until those land, regardless of
which intervention sequence runs.

## §7 — What this survey did not check

Per BRAND.md, naming the gap is more Legible than papering over it.

1. **2025–2026 papers beyond the 16.** The survey is a thick slice, not
   exhaustive. A few areas not covered that could matter: process reward
   models (Lightman et al., 2023, arXiv:2305.20050) for step-level
   credit assignment; LATS (Zhou et al., 2023) for search-based reasoning
   with self-improvement; OpenHands / OpenDevin for the production-harness
   comparison; recent agent-debate or multi-agent self-play literature.
   Refresh recommended every ~6 months as the field is moving fast.
2. **Quantitative head-to-head on Jinn substrate.** None of the §2
   techniques have been benchmarked against each other on Jinn's actual
   task stream. The leverage rankings in §4 are reasoned, not measured.
   Sequence A's A/B is the first datapoint that will sharpen them.
3. **Cost analysis.** Each technique's per-step inference cost differs by
   1–3 orders of magnitude (Self-Refine: 3 LLM calls per instance; GEPA:
   k × population × N trajectories; Promptbreeder: similar). The rankings
   in §4 don't price this in; an honest cost-leverage Pareto would shift
   §4.3 (Sequence C) lower.
4. **Multi-operator dynamics.** Every cited technique studies single-agent
   learning. Jinn's marketplace introduces unsolved questions (when does
   an operator publish vs. hoard a skill discovery? how does
   selection-on-reward compose with cross-operator donation density?)
   that no prior art directly addresses. These belong in
   [#689](https://github.com/Jinn-Network/mono/issues/689)'s scoping of
   Phase 5 (cross-operator federation), not in this survey.
5. **Window-pressure feasibility of higher-tier mutations.** Per
   DR-2026-05-26 caveat 3: whether adding aggressive Improve-tier
   mutations fits within the task window is unverified. Sequence A's
   instrumentation should surface this if it appears.

## Status

Ratified as the spike finding for
[#692](https://github.com/Jinn-Network/mono/issues/692).

Companion artifact: the Discussion-post draft at
[`docs/research/2026-05-27-rl-on-harness-survey-discussion-draft.md`](../../docs/research/2026-05-27-rl-on-harness-survey-discussion-draft.md)
is the public version of this survey for posting under
`Jinn-Network/mono` Discussions. The Captain publishes it; this DR lands
first to provide the canonical reference the Discussion links to.
