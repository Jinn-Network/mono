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

### §1.3 Data join is already live (verdict ↔ codeDigest)

This is one of the load-bearing facts the first draft of this DR
under-specified. The chain from harness state to verdict reward is
wired end-to-end and queryable through the indexer today:

1. **`codeDigest` = content hash of `implStateDir`.** The freeze-fence
   ([`client/src/daemon/freeze-fence.ts:55`](../../client/src/daemon/freeze-fence.ts:55))
   computes `hashImplStateDir(ctx.implStateDir)` on every run via the
   deterministic, sorted, content-only hasher at
   [`client/src/harnesses/freeze.ts:51`](../../client/src/harnesses/freeze.ts:51).
2. **`codeDigest` is written to the Solution envelope.** The engine
   stores the freeze-fence digest per request
   ([`engine.ts:1268`](../../client/src/harnesses/engine/engine.ts:1268))
   and writes it into the envelope's `executor.codeDigest` field
   ([`engine.ts:1624`](../../client/src/harnesses/engine/engine.ts:1624)).
3. **`codeDigest` is published on-chain via the v2 payload.** When the
   harness identity is available the engine emits a v2
   `ExecutionPayload` carrying the 32-byte codeDigest, mode flag, and
   implName
   ([`engine.ts:1802`](../../client/src/harnesses/engine/engine.ts:1802),
   [`identity.ts:268`](../../client/src/erc8004/identity.ts:268)).
4. **The indexer materialises codeDigest into a queryable table.** The
   Ponder enrichment pass fetches the IPFS envelope body and projects
   the executor block into
   [`attemptEnvelopeMeta`](../../packages/indexer/ponder.schema.ts) —
   columns `codeDigest`, `implName`, `mode`, `pluginsJson`
   ([`handlers.ts:586`](../../packages/indexer/src/handlers.ts)).
5. **The verdict's real outcome is also indexed.** A sibling enrichment
   writes `verdictEnvelopeMeta` carrying `actualPassed` and
   `actualScore`
   ([`handlers.ts:709`](../../packages/indexer/src/handlers.ts)) —
   the source of truth that bypasses the on-chain default-to-Pass bug.

Conceptually, per-codeDigest selection-on-reward is one query against
the indexer:

```sql
SELECT
  aem.implName,
  aem.codeDigest,
  aem.mode,
  COUNT(*)                                                AS attempts,
  AVG(CASE WHEN vem.actualPassed THEN 1.0 ELSE 0.0 END)   AS pass_rate,
  AVG(CAST(NULLIF(vem.actualScore,'') AS DECIMAL))        AS avg_score
FROM attempt_envelope_meta aem
JOIN attempt              a   ON aem.requestId = a.requestId AND aem.chainId = a.chainId
JOIN verdict              v   ON v.taskId = a.taskId AND v.attemptIndex = a.attemptIndex
JOIN verdict_envelope_meta vem ON vem.requestId = v.requestId
WHERE a.operator = $operatorSafe
GROUP BY aem.implName, aem.codeDigest, aem.mode;
```

The explorer SPA already runs essentially this query for frozen-mode
SolverNet views ([`explorer/src/lib/api.ts:154`](../../packages/indexer/explorer/src/lib/api.ts)
documents the frozen-pass-rate-by-codeDigest aggregation). Adapting it
to train mode is removing one WHERE clause.

The first draft of this DR mis-stated that this join required
[#671](https://github.com/Jinn-Network/mono/issues/671) +
[#672](https://github.com/Jinn-Network/mono/issues/672) (the
TranscriptWatcher + CodexSessionParser unblock). Those are gates for
**trajectory-level credit assignment** (Level 3b in §4); aggregate
per-codeDigest selection-on-reward operates on data the indexer already
exposes. The actual structural ask on Level 1 is (a) add a Ponder index
on `attemptEnvelopeMeta.codeDigest` for fast lookup, (b) extend the
learner plugin's Memory-consolidation phase to query the join and
decide reverts on statistical confidence.
[#669](https://github.com/Jinn-Network/mono/issues/669)'s launcher
counter under-count degrades denominator reliability but does not
block the work.

### §1.4 Trajectory capture: structure exists, solver-side density is sparse

The same correction applies to trajectory data. Jinn already publishes
structured, hash-chained, content-addressable trajectories with every
Solution envelope:

- The `TrajectoryCollector`
  ([`client/src/trajectory/collector.ts:53`](../../client/src/trajectory/collector.ts:53))
  produces spans with `traceId`, `spanId`, `parentSpanId`, `name`,
  `kind`, hash-chained via `jinn.prevSpanHash`, secret-scrubbed,
  conformance-checked.
- The envelope's `trajectory` field is a content-addressed reference
  ([`client/src/types/envelope.ts:172`](../../client/src/types/envelope.ts:172))
  carrying `{ sha256, access: { endpoint, priceUsdc } }` — fetchable
  via the operator's HTTP endpoint.
- Three `jinn.span.kind` values are emitted in practice:
  `jinn.state_transition` (lifecycle), `jinn.venue_io` (external venue
  interactions), `jinn.artifact.emit` (artifact creation).

The **nuance** is who emits which kinds:

| Path | Trajectory richness |
|---|---|
| Evaluator harnesses (prediction-v0, prediction-apy-v0, portfolio-v0) | **Rich** — venue_io + state_transition + artifact.emit |
| Solver session orchestrators (claude-mcp-shared, hyperliquid) | **Sparse** — state_transition markers only |
| MCP server tool calls (`search_records`, `inspect_record`, `acquire_artifact`) | **Not instrumented** — fired without addSpan |
| Codex / claude-code session contents | **Rich locally** in `~/.codex/sessions/`; **not yet joined** to envelope trajectory |

So an evaluator's envelope today is genuinely "trajectory + verdict";
a solver's envelope is "sparse trajectory + verdict." For Levels 1–3a
in §4 below this is sufficient (the relevant signals are codeDigest and
the envelope's `artifacts` acquired-list). For Level 3b (per-tool-call
GRPO / GEPA) the gap is bridgeable two ways: instrument the MCP
server's tool handlers to call `addSpan` on each invocation (lives
entirely inside Jinn's controlled path) **OR** unblock
[#671](https://github.com/Jinn-Network/mono/issues/671) +
[#672](https://github.com/Jinn-Network/mono/issues/672) so local
session JSONLs flow into `capture_spans` and content-address into the
envelope.

### §1.5 Empirical occupancy

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

Jinn already has: **the substrate** (git-backed `implStateDir`,
revert-by-sha, mode-gated freezing, allowed write paths,
operator-access requests), **the verbal-RL inner loop** (Reflexion-shaped
Debrief → Memory), **the verdict-to-harness-state join** (§1.3 —
`attemptEnvelopeMeta.codeDigest` ↔ `verdictEnvelopeMeta.actualPassed`,
queryable today), and **structured trajectory publication** (§1.4 —
`TrajectoryCollector` + envelope `trajectory` ref). What Jinn does not
yet have are **(a) a closed feedback loop that uses the live join** —
nothing yet reads per-codeDigest aggregate reward to decide reverts;
**(b) richer solver-side trajectory spans** — today only state_transition
markers, no per-tool-call detail; **(c) any retrieval policy more
sophisticated than name-similarity** over the corpus; and **(d) any
mechanism that biases the promoter toward higher-tier action surface
(skills / tools) rather than markdown-in-notes**. (a) and (d) are
plugin-level edits — the §4 ladder starts there. (b) is bridgeable via
MCP-server instrumentation or by the capture_spans unblock. (c) becomes
a real lever once (a) supplies reward attribution for retrieval ranking.

## §4 — The ladder, level by level

The first draft of this DR proposed three candidate sequences (A / B / C)
under a leverage-and-effort schema. The corrections in §1.3 and §1.4 made
that framing misleading: a substantial portion of the "wiring" the
original Sequence A and B treated as new work is already in place. The
clean reframing is a six-level ladder of increasing RL sophistication,
with explicit per-level cost-to-operator and required work.

Each level names: what it adds, what it costs the operator, what work it
needs in Jinn beyond what already exists today.

### §4.1 Level 0 — "RL-shaped" memory (today)

What runs today. The Memory-consolidation phase reverts `implStateDir`
mutations on the Debrief Analyst's qualitative trend signal. Verbal-RL /
Reflexion-shaped. Not statistical RL.

**Cost:** nothing extra. **Status:** in production.

### §4.2 Level 1 — Per-codeDigest aggregate selection-on-reward

What it adds: the first **quantitative** reward signal into the
learning loop. The Memory-consolidation phase (Consolidator or a sibling
subagent dispatched from it) tracks per-codeDigest sample windows,
queries the indexer join from §1.3 for aggregate pass rate, and reverts
Improve commits whose presence is statistically associated with worse
outcomes.

**Cost to the operator:** nothing extra. Operates observationally over
attempts the operator submits anyway.

**Required work in Jinn:**

1. Ponder index on `attemptEnvelopeMeta.codeDigest`. Small migration.
2. Learner-plugin extension — per-codeDigest sample-window tracker,
   indexer query, statistical revert-decision logic. Lives inside the
   Consolidator's prompt or in a new sibling subagent dispatched from
   phase 7. Reusable substrate for higher levels (every level needs
   "sample window before update").
3. Promoter-prompt nudge toward higher action-surface tiers (the
   originally-A1 move). Independent; can ship in parallel.

**Prior art:** ReST-EM (§2.7, verifier-filter step), Voyager (§2.1,
skill validation), GEPA (§2.15, Pareto-front discipline). The
selection-on-reward step generalises: every higher level uses the same
sample-window pattern.

### §4.3 Level 2 — Controlled per-commit ablation

What it adds: isolation of a single Improve commit's contribution by
deliberately running K samples from sha_n vs sha_{n−1} rather than
relying on observational comparison alone.

**Cost to the operator:** **K× more inference per ablation.** Acceptable
for periodic / operator-initiated ablations of specific commits; not a
continuous loop.

**Required work:** Level 1 + a daemon-side scheduling capability
("re-run N samples from this implStateDir sha"), invokable from a CLI
(`jinn ablate <commit-sha> --samples K`).

### §4.4 Level 3a — Retrieval-pattern GRPO

What it adds: group-relative policy attribution at the
**retrieval-pattern** level. For K trajectories from the same starting
codeDigest, compute advantage = score − group_mean and attribute the
delta to differences in which donated artifacts each run acquired. The
envelope's `artifacts` list already contains the acquired CIDs.

**Cost:** K× inference per task you optimize on (same shape as Level 2
and 3b).

**Required work:** Level 1 substrate + a trajectory-diff routine over
envelope `artifacts` lists. No new instrumentation.

**Prior art:** contextual bandits, ExpeL (§2.10, cross-task insight
extraction), Generative Agents (§2.9, recency × importance × relevance
scoring).

### §4.5 Level 3b — Per-tool-call GRPO / GEPA

What it adds: group-relative attribution at the **per-tool-call**
level — which `search_records` queries fired, which decisions the LLM
made between tool calls. Choice of advantage-arithmetic (GRPO-style) or
reflective natural-language critique (GEPA-style).

**Cost:** K× inference + ongoing trajectory-storage / query overhead.

**Required work:** richer solver-side trajectory spans (per §1.4 the
sparse-on-solver picture today). Two complementary paths:

- **Instrument the MCP server's tool handlers** (`search_records`,
  `inspect_record`, `acquire_artifact`) to emit `addSpan` calls. Lives
  entirely inside Jinn's controlled path. Wins for agents that use the
  Jinn MCP server.
- **Unblock [#671](https://github.com/Jinn-Network/mono/issues/671) +
  [#672](https://github.com/Jinn-Network/mono/issues/672)** so local
  codex / claude-code session JSONLs flow into `capture_spans` and then
  fold into the envelope trajectory. Wins for agents that drive the
  model CLI as a subprocess.

The two paths complement: MCP-server instrumentation gives the
Jinn-controlled half; capture_spans gives the LLM-reasoning half.

The GRPO-vs-GEPA prompt-shape choice is a days-long A/B once the
substrate is in place, not a big design fork.

**Prior art:** GEPA (§2.15, 35× fewer rollouts than GRPO with reflective
critique), Promptbreeder (§2.3), classical GRPO.

### §4.6 Level 4 — Process reward model

What it adds: per-step credit assignment within a single trajectory.
Train a small scorer (LLM-as-judge or learned PRM) that predicts step
quality from local context, then use it as a within-trajectory reward.

**Cost:** sustained inference for the PRM, plus substantial trajectory
volume to calibrate.

**Required work:** Level 3b + PRM training pipeline. Research direction;
not a near-term sprint.

**Prior art:** process reward models (Lightman et al., 2023,
arXiv:2305.20050 — surveyed in §7 caveat 1).

### §4.7 Level 5 — Weight updates (horizon)

Out of scope while Jinn uses API providers. Recorded as the horizon for
the day Jinn self-hosts open-weight models. Prior art for that day:
SWE-RL (§2.6), ReST-EM (§2.7), Constitutional AI (§2.8).

### §4.8 Two economic constraints specific to Jinn

1. **Per-attempt cost is real JINN spend.** Levels 0/1 are
   observational over attempts the operator already pays for; Levels
   2+ multiply per-task cost by K. The continuous loop should stay at
   Level 1; higher levels are deliberate / periodic / per-SolverNet
   economic decisions.
2. **The marketplace is a cross-operator reward aggregator we don't
   yet use.** The indexer join from §1.3 works across *all* operators,
   not just the local one. A federated Level 1 — "which codeDigests
   across the network perform best on this SolverNet?" — is queryable
   today. Operators could converge on dominant codeDigests by
   observation alone. This is one path to Phase 5 / federation in
   [#689](https://github.com/Jinn-Network/mono/issues/689)'s roadmap
   that requires no new infrastructure.

### §4.9 Honorable mentions (orthogonal to the ladder)

These are surveyed and parked because they don't sit cleanly on the
levels above but should be visible to [#689](https://github.com/Jinn-Network/mono/issues/689)'s
design pass.

- **Voyager-style skill validation gate** (effort: M). New skills
  emitted by the promoter must pass a held-out validation before
  promotion. Prerequisite for any aggressive new-skill cadence —
  becomes load-bearing once Level 1 has shifted occupancy off the
  notes-only baseline. Cite: Voyager (§2.1).
- **Constitutional self-critique pass** (effort: S). Add a self-critique
  step in the Improve phase grounded in `PRINCIPLES.md` — analogous to
  the SL half of Constitutional AI. Cheapest path to PRINCIPLES.md
  adherence inside the loop. Cite: Constitutional AI (§2.8).
- **Cross-operator donations carry skill edits, not just past solutions**
  (effort: L). Envelope plumbing exists; what's missing is the
  promoter-side semantics for consuming a donated skill (vs. a donated
  past patch). Phase 5 in
  [#689](https://github.com/Jinn-Network/mono/issues/689)'s roadmap.
  Cite: Voyager (§2.1), Darwin Gödel Machine (§2.16) for the
  archive-not-overwrite discipline.

## §5 — Recommendation for the next concrete step

**File Level 1 as three small issues; defer Level 2+ to the design pass
in [#689](https://github.com/Jinn-Network/mono/issues/689).**

1. **`chore(indexer)`** — add `codeDigest` index on
   `attemptEnvelopeMeta`. ≤1 hour. Independent.
2. **`feat(learner)`** — extend the Memory-consolidation phase (Consolidator
   or sibling subagent inside the learner plugin) with: per-codeDigest
   sample-window tracking, indexer query for aggregate `actualPassed` /
   `actualScore`, statistical revert-decision logic. ~1 sprint.
   Independent of [#671](https://github.com/Jinn-Network/mono/issues/671)
   / [#672](https://github.com/Jinn-Network/mono/issues/672).
3. **`feat(learner)`** — promoter-prompt nudge toward higher
   action-surface tiers. ~1 day. Independent.

Why three issues rather than one bundled PR: each is small enough that
the AI-PR-review-parity rule (handbook §AI workflow rules, rule 4) is
cheap to honour. The promoter nudge can ship and start collecting
empirical data while the selection-on-reward extension is in review.

**Level 2** (controlled per-commit ablation) lands as a follow-up CLI
(`jinn ablate <sha> --samples K`) once Level 1's observational signal is
demonstrably useful.

**Level 3a** (retrieval-pattern GRPO) follows once Level 2's K-sample
regime has been shown economically acceptable for at least one
SolverNet — the K× per-task cost is a real operator decision and needs
empirical grounding.

**Level 3b** (per-tool-call GRPO / GEPA) lands behind either the
MCP-server span-instrumentation issue or
[#671](https://github.com/Jinn-Network/mono/issues/671) /
[#672](https://github.com/Jinn-Network/mono/issues/672), whichever
substrate appears first.

The deliberate choice is **not** to file the entire ladder at once.
Level 1 is the experimental input the design pass needs in order to
decide whether the higher-level work is worth its K× cost; without that
signal, the order of Level 2 vs Level 3a is intuition.

## §6 — Gating on filed prerequisites (corrected)

| Level / step | Gated on | Why |
|---|---|---|
| L1 — Ponder index | nothing | Schema-additive migration on `attemptEnvelopeMeta.codeDigest` |
| L1 — Consolidator extension | nothing structural; [#669](https://github.com/Jinn-Network/mono/issues/669) degrades denominator reliability but doesn't block | Indexer join is live (§1.3); plugin already has indexer access via MCP |
| L1 — Promoter-prompt nudge | nothing | Pure prompt edit |
| L2 — Controlled ablation CLI | L1 having shown observational signal works | No reason to pay K× cost ablating if observational signal at L1 is sufficient |
| L3a — Retrieval-pattern GRPO | L1 substrate (sample-window tracking) | Envelope `artifacts` list already exists; trajectory-diff is a small extension |
| L3b — Per-tool-call GRPO / GEPA | richer solver-side spans, via either MCP-server instrumentation **or** [#671](https://github.com/Jinn-Network/mono/issues/671) + [#672](https://github.com/Jinn-Network/mono/issues/672) | Solver spans today are state_transition-only (§1.4) |
| L4 — Process reward model | L3b + sustained trajectory volume | Step-level signal needs step-level data |
| L5 — Weight updates | open-weight self-host | Foundation-model training infra |
| HM — Voyager skill validation | L1 having shown new-skill promotions occur | Validation only matters once new-skill cadence exists |
| HM — Constitutional critique | nothing | Pure prompt edit |
| HM — donation of skill edits | [#666](https://github.com/Jinn-Network/mono/issues/666) | Hermes operators are currently silently disabled from cross-operator donation consumption |

**[#669](https://github.com/Jinn-Network/mono/issues/669) and
[#670](https://github.com/Jinn-Network/mono/issues/670)** (launcher
counter under-count, launcher cap overshoot) are filed-but-not-blocking
across the whole ladder: they degrade denominator reliability for any
pass-rate measurement, but every level can ship with degraded signal
and tighten as those fixes land.

**The original DR's gating table was substantially wrong on
[#671](https://github.com/Jinn-Network/mono/issues/671) and
[#672](https://github.com/Jinn-Network/mono/issues/672).** Those issues
gate Level 3b's per-tool-call path; the original table claimed they
gate Level 1's aggregate selection-on-reward, which would have
mis-prioritised the design pass in
[#689](https://github.com/Jinn-Network/mono/issues/689) toward "wait
for trajectory capture" rather than "ship Level 1 now." Corrected here
per the substrate findings in §1.3 / §1.4.

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
   task stream. The ladder ordering in §4 is reasoned, not measured.
   Level 1's deployment is the first datapoint that will sharpen it.
3. **Cost analysis.** Each technique's per-step inference cost differs
   by 1–3 orders of magnitude (Self-Refine: 3 LLM calls per instance;
   GEPA: k × population × N trajectories; Promptbreeder: similar). The
   ladder names the K× per-task multiplier at Levels 2+ but doesn't
   produce a cost-leverage Pareto; an honest one would shape the
   per-SolverNet decision on which level to operate at.
4. **Multi-operator dynamics.** Every cited technique studies single-agent
   learning. Jinn's marketplace introduces unsolved questions (when does
   an operator publish vs. hoard a skill discovery? how does
   selection-on-reward compose with cross-operator donation density?)
   that no prior art directly addresses. These belong in
   [#689](https://github.com/Jinn-Network/mono/issues/689)'s scoping of
   Phase 5 (cross-operator federation), not in this survey.
5. **Window-pressure feasibility of higher-tier mutations.** Per
   DR-2026-05-26 caveat 3: whether adding aggressive Improve-tier
   mutations fits within the task window is unverified. Level 1's
   instrumentation should surface this if it appears.
6. **Substantial in-place revision.** The first publication of this DR
   (committed earlier on this branch) under-specified what was already
   built and over-stated the gating on
   [#671](https://github.com/Jinn-Network/mono/issues/671) /
   [#672](https://github.com/Jinn-Network/mono/issues/672). The
   corrections in §1.3, §1.4, §3.1, §4, §5, and §6 were prompted by a
   dialogue with the Captain after the first publish; key facts
   discovered: `codeDigest` is the `implStateDir` content-hash and is
   indexer-queryable today (§1.3); `TrajectoryCollector` already
   publishes structured spans (§1.4); selection-on-reward at the
   per-codeDigest aggregate level is not gated on `capture_spans`
   (§4.2). The earlier version remains in git history on this branch
   as a record of the investigation arc. Future reviewers: trust the
   corrected version; treat the gating-on-#671/#672 framing in the
   earlier draft as archaeology.

## Status

Ratified as the spike finding for
[#692](https://github.com/Jinn-Network/mono/issues/692). Revision 2 —
restructured around the six-level ladder (§4) after substrate
clarifications (§1.3, §1.4) discovered post-first-publish; see §7
caveat 6 for the investigation arc.

Companion artifact: the Discussion-post draft at
[`docs/research/2026-05-27-rl-on-harness-survey-discussion-draft.md`](../../docs/research/2026-05-27-rl-on-harness-survey-discussion-draft.md)
is the public version of this survey for posting under
`Jinn-Network/mono` Discussions. The Captain publishes it; this DR lands
first to provide the canonical reference the Discussion links to.
