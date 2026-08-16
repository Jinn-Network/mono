# E1 — Comparison Frame and Citation Map

**Version:** 0.7 (E3 closure-preparation amendment)
**Date:** 2026-08-13
**Author:** E1 method-stream agent
**Program:** `docs/superpowers/plans/2026-08-11-demo-report-1-skill-ab-program.md` (Stage 2, packet E1)
**Status:** **Frame approved by the operator (Ritsu).** Nothing is locked — the lock happens at the sealed Run record, after E2's power numbers and E3's pre-lock dispositions close. The publication framing is resolved (§2.8); network publication remains outside this program.

---

## 0. What this document is for

Demo Report #1 is the product's first sealed benchmark report bundle. Its motivation section has to be real: there must be a live public argument the report speaks into, and the report has to close a gap that is actually open. Part 1 establishes both with verified sources. Part 2 records the approved comparison design, and keeps the rejected alternatives on the page so the choice stays auditable. This program stops at the independently recomputed publication handoff; it does not claim the report is published.

Two things this document does not do. It does not design engineering (that is R1–R5 and P1–P5). It does not choose statistics (that is C3/R4 — every number in the report comes from a named `BENCHMARKING_METHOD_REGISTRY` method, and this document proposes no estimator).

### 0.1 Operator decisions (approved)

| Question | Decision |
|---|---|
| **Frame** | **Mechanism vs mechanism** — same agent, same instruction-body bytes, delivery varied. The Skill wrapper retains its required upstream frontmatter; only the instruction body is byte-identical. The higher-pull public-skill on/off alternative is declined for this report and stays available as a second report (§2.6). |
| **Arm count** | **Three arms.** Arm C is the manipulation check (§2.2). The two-arm fallback is not taken. |
| **Content source** | **`anthropics/skills`** (the four source-available document skills excluded; the selected folder requires its own compatible license). The SWE-Skills-Bench C1 path is formally withdrawn for Demo-1 (§2.3). |
| **Public pre-registration (E4)** | **Committed**, conditional on the P5 e2e gate being green (§2.10). |
| **Flat-file mechanism (2026-08-13)** | **Native root `CLAUDE.md`.** P2 stopped after proving Claude Code does not load `AGENTS.md`; the operator chose the runtime-native file rather than an import shim or prompt injection. The motivating public debate is retained, but the measured and reported comparison is Skill minus CLAUDE.md. |
| **Report framing (2026-08-13)** | **Name the Vercel comparison and Hacker News objection directly and respectfully.** Attribute only source-supported facts, describe Demo-1 as a controlled follow-up rather than a correction or takedown, and require the independent arithmetic/source fact-check in E3 J7. |
| **Content source (2026-08-16) — supersedes the row above** | **SkillsBench v1.1**, per [DR-2026-08-16](../../../../log/decisions/2026-08-16-demo1-skillsbench-source-amendment.md). See §2.3.1. |

No comparison-frame operator question remains open. Arm C is the true no-file control and therefore has an intentionally unverifiable loadout axis. P2 owns verification of the resolved product-side placement and exclusion path. Publication topology, author-source identity, report origin, discovery, mirrors, Explorer ingestion, key custody, and errata policy remain decisions for the separate publication program.

---

# Part 1 — Citation map of the live public argument

## 1.1 The argument in one paragraph

Coding agents can be given repository- or task-specific instructions through an always-on context file or through a progressively disclosed skill. The motivating public argument names `AGENTS.md`; the bound runtime is Claude Code, whose native always-on project file is root `CLAUDE.md` and which explicitly does not load `AGENTS.md`. A skill (`SKILL.md`) exposes its metadata at startup and loads the body only when the model routes to it. Practitioners disagree, publicly and with numbers, about which delivery shape performs better — and the loudest published comparison changed content and mechanism together.

## 1.2 The two mechanisms — primary sources

| Source | What it establishes |
|---|---|
| [agents.md](https://agents.md/) | The AGENTS.md format homepage. "A simple, open format for guiding coding agents." Reports use by over 60k open-source projects; states the standard is stewarded by the Agentic AI Foundation under the Linux Foundation; lists 20+ compatible tools including OpenAI Codex, GitHub Copilot, Gemini CLI, Cursor, VS Code, Devin, Zed, Aider, Warp, JetBrains Junie. |
| [github.com/agentsmd/agents.md](https://github.com/agentsmd/agents.md) | The AGENTS.md specification repository. **License: MIT.** Hosts the spec text. (The Linux Foundation stewardship statement appears on the site, not on the repo landing page.) |
| [Claude Code memory](https://code.claude.com/docs/en/memory#agents-md) | The runtime-native rule that resolved P2: Claude Code reads `CLAUDE.md`, not `AGENTS.md`; its documented interoperability options are a `CLAUDE.md` import or symlink. Demo-1 declines either shim because it would add a third mechanism to arm B. |
| [agentskills.io](https://agentskills.io/home) | The Agent Skills open specification. A skill is a folder with a required `SKILL.md` (YAML metadata plus instructions) and optional `scripts/`, `references/`, `assets/`. States the format "was originally developed by Anthropic, released as an open standard." Documents the three-stage progressive disclosure model: Discovery (name + description at startup), Activation (full `SKILL.md` read when the task matches), Execution. Client showcase lists 40+ adopting products including Claude Code, ChatGPT/Codex, Gemini CLI, GitHub Copilot, VS Code, Cursor, Amp, Goose, OpenHands, Factory, JetBrains Junie, Roo Code, Kiro, Tabnine. |
| [github.com/agentskills/agentskills](https://github.com/agentskills/agentskills) | The Agent Skills spec repository. **License: Apache-2.0 for code, CC-BY-4.0 for documentation.** |
| [Agent Skills — Claude Platform Docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) | The canonical vendor documentation for the mechanism under test. Specifies the three loading levels precisely: **Level 1 metadata always loaded at startup (~100 tokens per skill, name + description in the system prompt)**; **Level 2 `SKILL.md` body loaded only when the skill is triggered** (under 5k tokens); Level 3 bundled resources loaded only when read. States the `description` "is what Claude matches your request against when determining whether to trigger the Skill." |
| [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) — Anthropic engineering, 16 Oct 2025 | The design rationale for progressive disclosure and composability; the origin post for the mechanism. |
| [github.com/anthropics/skills](https://github.com/anthropics/skills) | Anthropic's public skills repository. **License: Apache-2.0 for many skills**; the four document skills (`docx`, `pdf`, `pptx`, `xlsx`) are **source-available, not open source**. Ships `./spec/` and `./template/`. Relevant to Part 2 content selection. |

The mechanism difference that matters for this A/B is documented, not inferred: **root `CLAUDE.md` content is loaded into every Claude Code session; the skill body enters context only if the model routes to it.**

## 1.3 The live claim that started the current fight

| Source | What it says |
|---|---|
| [AGENTS.md outperforms skills in our agent evals](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals) — Jude Gao, Vercel, 27 Jan 2026 | Four configurations on Next.js 16 API tasks held out of training data. Pass rates: **baseline 53%, skill with default behavior 53%, skill with explicit invocation instructions 79%, AGENTS.md docs index 100%**. Reports the skill **was never invoked in 56% of default-behavior cases**; explicit trigger instructions raised invocation above 95%. Also reports that trigger *wording* changed outcomes materially. **The post does not state that the AGENTS.md arm and the skill arm contained identical source material** — the AGENTS.md arm is described as a compressed 8KB docs index. |
| [Hacker News discussion](https://news.ycombinator.com/item?id=46809708) — 524 points, 196 comments | The two dominant themes: (1) skills require an invocation decision the agent can get wrong, whereas AGENTS.md is always present; (2) **the comparison may be flawed because the arms are different configurations — a comprehensive compressed index versus a brief description — leaving it unclear whether the difference comes from the mechanism or from implementation quality.** |
| [Agent-Optimized Docs vs Skills: What Actually Improves Coding Agent Performance](https://rmax.ai/notes/docs-vs-skills-agent-context-delivery/) — Max, 12 May 2026 | Practitioner analysis arguing passive context wins because it removes an activation step. Notes Vercel's 8KB index matched the 40KB version, which points at compression as a factor independent of delivery. Does not resolve the content-versus-mechanism confound. |
| [Claude Skills are awesome, maybe a bigger deal than MCP](https://simonwillison.net/2025/Oct/16/claude-skills/) — Simon Willison, 16 Oct 2025 | The most-cited practitioner endorsement of the skill mechanism, on simplicity and token efficiency grounds — the position the Vercel result is read as contradicting. |

## 1.4 Published empirical work — presence-versus-absence, not packaging-versus-packaging

| Source | Design | Finding |
|---|---|---|
| [Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?](https://arxiv.org/abs/2602.11988) — Gloaguen, Mündler, Müller, Raychev, Vechev; 12 Feb 2026 (rev. 23 Jun 2026) | Context file present vs absent, on SWE-bench tasks with LLM-generated context files and on novel issues in repos with developer-committed context files. | Context files **did not generally improve success rates** and **increased inference cost by over 20%**; held across models and agents. Repository overviews specifically were unhelpful. |
| [On the Impact of AGENTS.md Files on the Efficiency of AI Coding Agents](https://arxiv.org/abs/2601.20404) — Lulla, Mohsenimofidi, Galster, Zhang, Baltes, Treude; 28 Jan 2026 (v2 30 Mar 2026) | AGENTS.md present vs absent; 10 repositories, 124 pull requests; efficiency metrics. | **Lower median runtime (Δ 28.64%)** and **reduced output tokens (Δ 16.58%)** with comparable completion behavior. |
| [SWE-Skills-Bench: Do Agent Skills Actually Help in Real-World Software Engineering?](https://arxiv.org/abs/2603.15401) — Han, Zhang, Song, Fang, Chen, Sun, Hu; 16 Mar 2026 | 49 public SWE skills, ~565 task instances across six subdomains, paired with-skill vs no-skill, execution-based verification. | **39 of 49 skills yield zero pass-rate improvement; average gain +1.2%.** Token overhead ranges to **+451%** with unchanged pass rates. Seven skills give meaningful gains (to +30%); three degrade performance (to −10%). |
| [Do Agent Skills Actually Help? A Controlled Experiment](https://tessl.io/blog/do-agent-skills-actually-help-a-controlled-experiment/) — Rotem Tamir, Tessl, 18 Feb 2026 | Three arms × 30 trials on a Go/GORM migration bug: vanilla Claude Code, official Atlas skill, custom project skill. | **53% / 73% / 80%.** Skill vs *nothing*, not skill vs equivalent flat instructions. |
| [When Skills Don't Help: A Negative Result on Procedural Knowledge for Tool-Grounded Agents in Offensive Cybersecurity](https://arxiv.org/abs/2605.20023) — Chacko, Hugglestone, Islam, Liu; 19 May 2026 (v2 24 May) | **A re-analysis, not a new experiment** — it re-analyzes a previously published 180-run controlled study of an MCP-grounded CTF agent under four documentation conditions (591–36,001 tokens), reframing those conditions as skill-ablation arms. | Margin between no-skill and richest-skill was **8.9 pp, p = 0.71**. Proposes "environment-feedback bandwidth" as the explanation. |
| [Harness Engineering for Agentic AI Coding Tools: An Exploratory Study](https://arxiv.org/abs/2602.14690) — Galster, Mohsenimofidi, Lulla, Abubakar, Treude, Baltes; 16 Feb 2026 (v5 30 Jun 2026) | Adoption study across 2,853 GitHub repositories; eight configuration mechanisms. | **Context files dominate** and are often the sole mechanism, with **AGENTS.md emerging as the interoperable standard**; **few repositories adopt Skills**, and adopted skills mostly carry static instructions rather than executable scripts. |
| [From Anatomy to Smells: An Empirical Study of SKILL.md in Agent Skills](https://arxiv.org/abs/2607.01456) — Hong, Imani, Ahmed; 1 Jul 2026 | 238 real-world skills; taxonomy of 13 higher-level and 44 lower-level components; "skill smells" from a 29-source multivocal review. | **Over 99% of SKILL.md files contain at least one skill smell**, and smells rarely disappear as skills evolve. |
| [Claw-SWE-Bench: A Benchmark for Evaluating OpenClaw-style Agent Harnesses on Coding Tasks](https://arxiv.org/abs/2606.12344) — Zheng, Han, Li, Xu, Tian, He et al.; 10 Jun 2026 | 350 issue-resolution instances, 8 languages, 43 repos; sweeps of model × harness under a fixed prompt, runtime budget, workspace contract, patch extraction, and evaluator. | **Harness choice alone moves Pass@1 by 27.4 pp at fixed model** (model choice moves it 29.4 pp). More starkly: the same GLM 5.1 backbone scores **19.1% with a minimal adapter and 73.4% with the full adapter**. Not about skills — cited as the magnitude context for why harness must be held byte-constant across arms (§2.5). |

Note the shape of the literature. Every controlled study varies **whether instruction content is present**. None varies **how the same content is delivered**. The two AGENTS.md papers **agree that context files do not move task success**, and disagree on **cost** — ETH Zurich reports inference cost up over 20%, while Lulla et al. report output tokens down 16.58% and runtime down 28.64%. The skill studies range from +27 pp (Tessl, one task) to +1.2% average (SWE-Skills-Bench, 565 instances). The adoption paper shows the mechanism practitioners actually use is the one with the weakest published support.

## 1.5 The nearest neighbors — the two papers closest to our design

These matter most, because if either already ran our experiment, the demo report's novelty claim is false and must be withdrawn.

| Source | How close it gets | Why it is not the same experiment |
|---|---|---|
| [SkillJuror: Measuring How Agent Skill Organization Changes Runtime Behavior](https://arxiv.org/abs/2606.11543) — Chen, Guo, Huang, Lu, Lin, Zhou, Zhang; 10 Jun 2026 | The closest published work. Explicitly separates "what a Skill says from how it is organized," compares **Progressive Disclosure against a normalized flat baseline while holding task knowledge fixed**, 82 SkillsBench tasks, 410 matched trials. Reports distinct resources touched per trajectory rising 1.18 → 3.85 and **+4.1% verifier-passing trials**. | The contrast appears to be *within* the skill mechanism — a hierarchical `SKILL.md` versus a flattened one, both routed through skill activation — rather than skill-mechanism versus always-on context-file mechanism. **VERIFICATION GAP:** the abstract is confirmed, but the mechanical definition of "normalized flat baseline" could not be extracted from the PDF at verification time. **E3 must resolve this before lock.** If SkillJuror's flat baseline is in fact an always-on context file, our novelty claim collapses and the report must be reframed as a replication. |
| [Skill Availability and Presentation Granularity in Large-Language-Model Agents: A Controlled SkillsBench Study](https://arxiv.org/abs/2605.31408) — Xu, Wu; 29 May 2026 | Holds knowledge constant and varies presentation: six skill conditions, 30-task subset, two models, five trials per cell, 1,800 rows. Reports **skill availability worth 18.0–36.0 pp across its two models** over no skill (26.7–36.0 pp for one, 18.0–26.0 pp for the other), while **presentation-granularity contrasts are small and uncertain** (low- vs high-abstraction: +0.7 pp and −6.7 pp, both 95% bootstrap CIs crossing zero). | Varies *abstraction level and worked examples* within skill documents. Every arm is a skill; the delivery mechanism never changes. |

## 1.6 The gap this report closes

**No verified published study holds the instruction-body bytes constant and varies only the delivery mechanism between a Claude Code progressive-disclosure skill and native always-on root `CLAUDE.md`.**

Stated precisely, and with each clause backed above:

1. The mechanism difference is real and documented (Claude Platform docs, §1.2): conditional model-routed load versus unconditional load.
2. The most-read comparison of the two changed content and mechanism together and did not state content equivalence (Vercel, §1.3).
3. That confound is a dominant objection in its Hacker News thread, raised independently by several commenters (§1.3).
4. All controlled academic work varies presence, not packaging (§1.4).
5. The two studies that do hold content fixed vary organization *within* the skill mechanism, not the mechanism itself (§1.5) — subject to the SkillJuror verification item.
6. Practitioners are choosing between these mechanisms today at scale, and the mechanism they overwhelmingly choose is the one with the most contradictory evidence (§1.4, Harness Engineering).

The honest framing of the motivation is therefore not "nobody has studied this." It is: **this question has been argued publicly with numbers on both sides, and every published number confounds what the instructions say with how they are delivered. We hold the instruction-body bytes fixed and vary delivery; the Skill's upstream routing frontmatter remains a measured mechanism difference.**

## 1.7 Verification log

Every URL above was fetched and confirmed to resolve and to say what is attributed to it, on 2026-08-11. One URL surfaced in search **failed** verification and is therefore **not cited** as a source:

- `https://github.com/GeniusHTX/SWE-Skills-Bench` — HTTP 404 at verification time. The SWE-Skills-Bench *paper* (arXiv 2603.15401) verified live; its artifact repository did not. This blocks the paper's 49-skill set from being a content candidate until availability and license are confirmed (§2.3).

Sources seen in search results but **not fetched, and therefore not cited**: HANDBOOK.md (arXiv 2607.25398), MalSkillBench (2606.07131), Skill-to-LoRA (2606.16769), SkillGenBench (2605.18693), SKT (2608.02287), and assorted secondary commentary. E3 may add them after its own verification.

---

# Part 2 — Approved comparison design

## 2.1 Approved frame: mechanism versus mechanism

**Same agent. Same model. Same effort. Same tasks. Same instruction-body bytes. Only the delivery mechanism differs.**

| Arm | Delivery | What the agent sees |
|---|---|---|
| **A — skill** | `SKILL.md` in the skills directory, loaded through the standard progressive-disclosure path | Name + description always in context; body enters context only on model-initiated activation |
| **B — flat** | `CLAUDE.md` at repository root, loaded by Claude Code's native project-memory discovery | Body always in context, in full, every turn |
| **C — neither** | True no-file control: no loadout and no experiment-created instruction path | Nothing; the loadout axis is truthfully `unverifiable` |

The measured quantity is the effect of the *delivery mechanism*, with the instruction body held byte-identical. The Skill's upstream frontmatter is additional delivered text and part of that mechanism. This is exactly the contrast the public argument needs and exactly the one no published work supplies.

## 2.2 Arms: three, approved

**Three arms.** Arm C is not optional insurance; it is the load-bearing control.

Without C, an A-versus-B null is uninterpretable. "No difference between packagings" is equally consistent with *packaging does not matter* and with *this particular content does nothing, so of course its packaging does not matter*. The literature makes the second reading the **more likely prior**, not a remote one: SWE-Skills-Bench found 39 of 49 skills produced zero improvement, and the ETH Zurich AGENTS.md study found context files did not generally help. Publishing an A-versus-B null without a manipulation check would be publishing an uninterpretable number, and a hostile reader would say so immediately.

**Cost, accepted.** Cells scale as `arms × tasks × replicates`. Three arms is 1.5× the cells of two — with a 30-task slate at 5 replicates, 450 container-graded cells instead of 300. That is real compute on the highest-variance seam in the program (P3, container grading). The operator has accepted it; the two-arm fallback (a pre-run content-efficacy screen on a disposable preview slate) is **not** taken and is recorded here only so the rejected option stays visible.

**Contrast structure, to be pre-registered before lock:**

- **Primary contrast: A vs B**, paired by task. This is the report's headline. E2 powers this one and declares its MDE.
- **Secondary contrast (manipulation check): (A ∪ B) vs C.** Establishes that the content has any detectable effect at all.
- **Pre-declared decision rule:** if the manipulation check fails — the content shows no detectable effect over C — then the A-vs-B result is reported as *uninformative about the mechanism, because the content had no detectable effect to deliver*. This rule is declared before the run, not chosen after seeing results. It is the difference between an honest null and a denominator game.

### 2.2.1 MDE anchoring: the null must be informative against the claims in circulation

E2 computes the numbers; this document fixes the **principle** they are computed against.

**The pre-declared minimum detectable effect is anchored to the effect sizes the live public debate actually claims.** The derivation, shown so the binding number is auditable rather than asserted:

- **The anchor is ~21 pp.** Vercel's skill-with-explicit-instructions arm scored 79% against its AGENTS.md arm at 100% — a 21 pp gap. This is the contrast **closest in shape to our A vs B**: both arms carry the instruction content and are expected to use it, and the difference is the delivery path. It is the number our design should be able to see.
- **The 47 pp gap is declined as an anchor.** Vercel's default-skill arm scored 53% against AGENTS.md at 100%, but 56% of those runs never invoked the skill at all, so that gap mostly measures non-invocation rather than delivery. Anchoring there would let the design pass by detecting only very large effects. It is recorded as a loose upper bound on what the debate claims, not as the target.
- **Corroboration, not derivation:** the Presentation Granularity study reports skill-availability effects of 18.0–36.0 pp across two models. That range brackets our anchor and is why ~21 pp reads as a reasonable middle of the claimed field rather than a cherry-pick — but the binding number comes from the Vercel contrast above, because that is the one shaped like ours.

**Binding statement: the design is powered to detect a ~21 pp A-vs-B difference.** E2 computes replicates and slate size against that figure and prints the achieved MDE in the report. If E2's variance estimates put ~21 pp out of reach at the accepted cell budget, that surfaces before lock as a design problem — solved by adding replicates or narrowing the slate — and if it cannot be solved, the achievable MDE is declared honestly instead of the anchor being quietly moved.

Why anchor there rather than at whatever the compute budget happens to buy: **a null is only worth publishing if it rules something out.** Powered at the anchored ~21 pp and finding nothing, the report can say — precisely, and in the debate's own units — *the mechanism does not produce effects of the size being claimed for it*. That is a real contribution. If the design were powered only to 5 pp, a null would say almost nothing, and if it were powered to 60 pp, a null would be vacuous against every claim on the table.

Two disciplines follow, both pre-registered:

- **The MDE is printed in the report**, and an underpowered null is stated as "we cannot detect effects smaller than X" — never quietly reframed as "no effect" (program E2 constraint).
- **The anchor is declared before the run and not moved afterward.** If E2's variance estimates show the accepted cell budget cannot reach the anchored MDE, that is surfaced as a design problem to solve before lock — by adding replicates or narrowing the slate — not resolved by lowering the bar after the fact.

## 2.3 Instruction content: candidates, with license verification

Requirements the content must satisfy:

1. **Public and licensed** for this use.
2. **Non-trivial** — capable of changing task outcomes, or the manipulation check fails by construction.
3. **Faithfully expressible in both packagings** without either arm being obviously handicapped by our authoring.
4. **No task-answer leakage** — the content must not contain hints specific to the slate's held-out issues.
5. **Authored upstream, with an upstream description** — see §2.4, this is the decisive constraint.

| Candidate | License status | Assessment |
|---|---|---|
| **C2 (approved) — a skill from [github.com/anthropics/skills](https://github.com/anthropics/skills)** | **Apache-2.0 for many skills, verified at the repository level.** The four document skills (`docx`, `pdf`, `pptx`, `xlsx`) are source-available and **must be excluded**. Because the repository is not uniformly licensed, **the chosen skill's license is confirmed from its own subfolder before lock** — repository-level verification is not sufficient. | License verified live. Authored as a skill by the mechanism's originator, which removes the strongest objection to a negative result for arm A ("you wrote a bad skill"). Ships an upstream `description`, satisfying §2.4. Constraint: the chosen skill's domain must plausibly bear on a SWE-shaped slate; the creative and enterprise categories do not, so the viable set is narrow and must be named before lock. |
| **C1 (withdrawn for Demo-1) — a skill from the 49-skill SWE-Skills-Bench set** | **Unverified. Artifact repository returned 404 (§1.7).** | Strong option on the merits, but unavailable for independent source-and-license verification. The operator fixed C2 as Demo-1's source; C1 is not a live upgrade or late switching path for this run. |
| **C3 (not recommended) — content derived from the target repositories' own public docs** | Per-repository OSS licenses; heterogeneous. | Highest ecological validity — this is what real AGENTS.md files contain — but the worst risk profile. Leakage risk is highest (a repo's own docs may touch the very issue under test), licensing is per-repo rather than uniform, and if we generate or summarize the content ourselves we inherit exactly the confound the ETH Zurich study identified with LLM-generated context files, while losing "public and licensed." |

**Approved: C2** — a skill from `anthropics/skills`, Apache-2.0, with the four source-available document skills excluded. **C1 is formally withdrawn for Demo-1.** Its artifact repository returned 404 at verification (§1.7), and the operator has fixed C2 as this report's source rather than retaining a late content-switching path. The specific C2 artifact, its upstream URL, its commit or version, its per-folder license, and its sha256 go into the Benchmark record before lock.

## 2.3.1 Source-method amendment (2026-08-16) — SkillsBench task-bundle units

**This section supersedes §2.3's "Approved: C2" for the active method.** §2.3 is preserved above
exactly as written, because it records the reasoning that produced the historical STOP and must
keep doing so. Ratified by
[DR-2026-08-16](../../../../log/decisions/2026-08-16-demo1-skillsbench-source-amendment.md).

**What changed and why.** §2.3's C2 path paired one `anthropics/skills` candidate with an unrelated
SWE-rebench slate, which forced a candidate-specific domain classifier to invent the relevance
hypothesis. That classifier is where the method stopped: `brand-guidelines` matched 0 of 197
authenticated tasks and `frontend-design` matched 3, against a 21-task/13-repository floor. The
replacement source ships the pairing instead of synthesising it — every SkillsBench task package
contains its own curated Skill bundle, environment, oracle, and verifier.

**The new source.** `benchflow-ai/skillsbench`, release `v1.1`, commit
`b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af`, 87 active task packages, runner line
`benchflow>=0.6.3,<0.7`, root license Apache-2.0. SkillsBench is a task corpus, not an eval
framework; BenchFlow is the runtime.

**The new experimental unit.** One exact upstream task package together with its complete curated
Skill bundle. Multi-Skill bundles are in scope and are the common case — 66 of the 87 active tasks
carry more than one Skill. There is therefore **no candidate ranking, no winning Skill, and no
domain classifier** on the active path.

**Effect on §2.4 (content identity).** The construction generalizes from one body to N. Arm A
receives the complete bundle with original folder boundaries, names, routing descriptions, and
frontmatter. Arm B receives the same authenticated bodies concatenated into a deterministic root
`CLAUDE.md` under the versioned, content-neutral transform `jinn.demo1.claude-md-flatten@1`,
ordered lexically by upstream skill folder path, with no native-discoverable `SKILL.md`. Arm C
receives no curated `SKILL.md` and no experiment-created instruction path. All three arms receive
byte-identical non-instruction resources and the same base environment; a unit whose relative-path
or resource semantics cannot be reproduced symmetrically is `unverifiable` and is rejected rather
than hand-repaired. §2.4's audit path is unchanged in kind: a reader still reconstructs each arm
from the authenticated source and checks digests, now per body rather than once.

**Effect on §2.5 (held constant) and E2.** Repository disjointness is replaced by transitive
independence clusters over four fixed edge classes (shared Skill content digest; shared underlying
project/dataset/input family; shared task-family template lineage; shared task-specific
oracle/verifier lineage). The pool floors are unchanged: 6/6 suitability, 10/5 rehearsal, 5/2
official feasibility, combined 21 units across 13 clusters, cluster-disjoint.

**Unchanged by this amendment.** The substantive claim, the three arms, the primary A-versus-B
contrast paired by unit, the manipulation contrast against arm C, the pre-declared rule that a
failed manipulation check makes A-versus-B uninformative about delivery mechanism, §2.2.1's ~21 pp
MDE anchor, the outcome firewall, and every must-not-imply line in §2.7. **Anthropic authorship
leaves the substantive claim** — §2.3's "removes the strongest objection to a negative result for
arm A" no longer applies, and §2.7's "Not a judgment of any authored skill's quality" now carries
that weight alone.

**Open, gated, now closed.** 86 of the 87 active tasks declare `environment.network_mode: public`;
exactly one declares `no-network`. Under §2.7's contamination discipline that is a live
contradiction with the 21-unit floor, and DR-2026-08-16 Decision 6 gated the ruling on a number
rather than a guess: the count of units surviving every static check except network, obtainable at
zero execution cost.

That count is now measured, and the broker itself has been built as policy and applied. Static
capacity is **1 unit / 1 cluster**; with a per-unit allowlist derived from each unit's own bytes it
is **6 units / 6 clusters**, and 5 / 5 after arm-materialization feasibility — against a required
21 / 13. **Decision 6 closes to option (a): an honest second STOP, and Demo-1 remains stopped.**

The reason is specific rather than general: 23 units provably require a host that could serve their
own oracle or expected output, and 57 more declare `public` while naming no host at all, which the
policy refuses to resolve by guessing. Whether a dynamically observed allowlist could admit those 57
is unresolved and would cost container execution.

## 2.4 Content identity: how it is guaranteed and how a reader audits it

This is the mechanic the whole frame rests on. If a reader cannot verify content identity, the report is just another Vercel-shaped comparison with a confound.

**Construction — one source, two packagings:**

1. **One frozen source document.** `source.md` holds the instruction body verbatim from the upstream artifact. Its sha256 is recorded in the Benchmark record before lock.
2. **A committed, deterministic transform** produces both arm materializations:
   - **Arm A:** `SKILL.md` = the upstream YAML frontmatter block (`name`, `description`) followed by `source.md` bytes verbatim.
   - **Arm B:** root `CLAUDE.md` = `source.md` bytes verbatim, with no frontmatter.
3. **The delta between arms is therefore exactly:** the skill frontmatter, file path, and native loading mechanism. Both verified artifacts are copied into loader-visible paths below the same repository root.

**Audit path published in the report:** `sha256(source.md)`, `sha256(SKILL.md)`, `sha256(CLAUDE.md)`, the frontmatter block reproduced verbatim, the transform, and the upstream artifact URL and version. A reader reconstructs both arms from the source and checks the three digests. The claim "identical instruction body" becomes checkable rather than asserted.

**Pinning and placement — resolved by the 2026-08-13 operator decision and P2 implementation.**

The platform's `jinn.skill.v1` materializer digest-verifies each single-file loadout under the sealed input root. The benchmark product then copies and re-hashes those verified bytes into one of two Claude-native locations:

- **Arm A:** `.jinn-demo1-skill-plugin/skills/demo1/SKILL.md` inside a valid plugin root supplied through `--plugin-dir`.
- **Arm B:** root `CLAUDE.md`, with the platform's single-file `--plugin-dir` argument removed so native project discovery is the only loading path.
- **Arm C:** neither path exists and no loadout is pinned; its loadout axis is not claimed verified.

**An instruction file inside the task's git working tree is a contamination risk, not a detail.** On a SWE-shaped slate the agent's `cwd` is the checked-out repository (`paths.work`), so any instruction file placed there is **inside the git working tree** — visible to `git status` and `git diff`, and therefore capable of leaking into patch extraction, which is how SWE-bench-shaped grading derives the submitted patch. Left unhandled, an arm could be penalized, or its patch invalidated, for a file the experiment itself placed there.

**The exclusion is symmetric and mechanical.** P2 removes both experiment paths before extraction in every A, B, and C cell and builds the patch with a private Git index carrying explicit exclusions for both paths. Acceptance requires A's and B's normalized patches to be byte-identical to the true no-file control for the same repository change.

**Arm C is fixed as true no-file.** It runs unpinned on the loadout axis and the report publishes that axis as `unverifiable`; no empty artifact is materialized merely to improve a disclosure count.

**Naming the departure.** The program's P2 gate requires pinning `enforced`, not attested, **for every axis the A/B varies or holds**. Arm C's `unverifiable` loadout is a deliberate, disclosed departure because baseline validity outranks a cosmetically stronger disclosure count.

This keeps the pinning claim subordinate to the baseline's validity, which is the correct ordering: arm C exists to make the A-vs-B result interpretable (§2.2), and a compromised baseline defeats that purpose no matter how clean its pin looks.

**Rejected alternative, recorded:** running an `AGENTS.md` arm through a generated `CLAUDE.md` import/symlink or prompt injection. That would add a third compatibility-shim mechanism instead of using Claude Code's native project-memory path, so the operator selected native root `CLAUDE.md` instead.

Verification note: the path C1 reported omitted the `backend-local` segment; the file is at `packages/task-execution/backend-local/workspace/src/materialize.ts`, and the cited line range and digest-refusal behavior were confirmed there directly.

**The residual asymmetry that cannot be removed — and must be stated, not hidden.**

The frontmatter is not nothing. Arm A's `description` is a routing prompt: it is the text the agent reads to decide whether to load the body, and it has no counterpart in arm B, where the body is simply always present. So "byte-identical content" is true of the *instruction body* and false of the *total delivered text*. Arm A delivers frontmatter-always plus body-sometimes; arm B delivers body-always.

That **is** the mechanism, so it is not a flaw — but the report must say it in exactly those terms, or a hostile reader will correctly call it a content difference.

**This creates the single largest threat to validity in the design.** Vercel's own result showed trigger wording swinging pass rates from 53% to 79%. Description wording is therefore a live researcher degree of freedom: a weak description makes arm A lose for a reason that is not the mechanism. Two mitigations, and the first is why §2.3 rules out C3:

- **Use the upstream artifact's own `description` verbatim.** Zero researcher freedom. This requires the content candidate to be an existing public skill with an existing description — which is precisely why C2 and C1 beat C3.
- **Freeze it before lock and publish it verbatim.** No tuning after any cell has run, official or preview.

The report's claim is then bounded honestly: *we measure the skill mechanism as delivered by its upstream-authored description, not the skill mechanism at its best.*

## 2.5 Held constant across arms

Agent (claude-code launcher), model, effort, harness version, task slate, container grader, retry and exclusion policy, replicate count. Enforced pins wherever the local venue can enforce; per-axis pinning status published in the report's disclosures rather than assumed (design §7.1, §7.3).

**Effort, stated exactly.** An earlier draft of this document called effort "attested-not-graded per the program's global constraints." That attribution was wrong — the program text says the opposite, that effort is an *enforced pinning key* (program R2 known-facts). The engineering reality, from C1's recon and confirmed at head, is narrower than either phrasing:

- The effort pin **is** declared and enforced at plan/admission time. `planning.ts` validates the pinned value against a closed inventory and throws on anything unsupported; the claude-code launcher declares the inventory as a capability and pushes `--effort <tier>` into argv.
- But effort is **not** checked by `verifyRunPinning` (`packages/task-execution/backend-local/assembly/src/pinning.ts`), which verifies harness, model, and loadout only — and it is **not a graded Matrix axis**: `PinningAxis` is `"harness" | "model" | "loadout" | "isolation"` (`packages/benchmarking/local/src/axes.ts`).

So the pin **gates dispatch** — a run cannot launch with an effort value outside the inventory, and the flag is passed to the harness — while the Matrix never grades the axis, and **"the model actually applied that reasoning depth" is attested only**. That is what the report says about effort: pinned and dispatch-gated, not independently verified.

**The loadout axis is the one the A/B varies.** Arms A and B target `enforced` / `match` on it — arm A's skill digest, arm B's `CLAUDE.md` digest — through the shared digest-verified materialization/copy path. True no-file C deliberately publishes `unverifiable` on that axis. Every other axis above is held rather than varied.

Because this section feeds the report's per-axis disclosures, the rule is: **the report publishes the pinning status the run actually achieved**, not the status this document targeted. If the placement leg does not land, the disclosure says so.

**Harness is held byte-constant across arms, and this is load-bearing rather than housekeeping.** Claw-SWE-Bench measured harness choice alone moving Pass@1 by 27.4 pp at fixed model, and adapter design alone moving it from 19.1% to 73.4% on the same backbone (§1.4). Those swings dwarf any plausible packaging effect, so any harness drift between arms would not merely add noise — it would dominate the result. Harness version pins `enforced`; drift between arms is a lock-invalidating condition, not a limitation to disclose after the fact.

Exclusion and infra-failure retry rules are proposed by R5 **before anyone sees per-task results** and are part of the lock.

## 2.6 Blast-radius rationale: why this frame embarrasses no one

- **No third party's artifact is on trial.** The same instruction-body bytes appear in both arms; the Skill wrapper additionally carries its required upstream frontmatter. A negative result for arm A is a result about progressive-disclosure *delivery*, not about anyone's writing. This is the structural reason the frame is safe, and it holds even if the content is an Anthropic-authored skill.
- **The result cannot be read as vendor-versus-vendor.** Both arms run on the same vendor's agent. There is no "X beats Y" headline available to a careless reader, because there is no X and Y.
- **Both mechanisms are native to the selected runtime.** `CLAUDE.md` and Agent Skills are documented Claude Code loading mechanisms. The broader AGENTS.md standard remains the public motivation, not the literal baseline executed here.
- **The genre is already established as a contribution, not an attack.** Vercel published a directionally negative result about skills and it was received as research. We are refining the comparison, not contradicting a person.

**The higher-pull alternative, recorded honestly: a widely-used public skill on/off.**

- **Pull:** materially higher. "Does [famous skill] actually work" is a headline; "does packaging matter" is a methods result.
- **Blast:** an identifiable third party's artifact receives a public pass-rate number. A negative result is a public negative review of a named party's work, published by an unknown benchmark vendor on a **self-run venue that by construction proves nothing against its own owner** (design §7.1). That combination invites "who are you to grade this" rather than "is the method sound" — which is the wrong first argument to have about a first report.
- **It is also already done, better.** SWE-Skills-Bench measured on/off across 49 public skills and ~565 instances. We would be second, with less data, on a weaker venue.
- **Decision: not taken for this report.** It is a good *second* report once the venue has an external track record, and the method transfers unchanged, so it stays cheap to run later.

**Resolved report framing (operator decision, 2026-08-13).** The report names the Vercel comparison and the Hacker News objection directly, respectfully, and only to the extent supported by their own text. Demo-1 is a controlled follow-up to a live public question, not a correction, certification, or takedown. Because naming a company raises the standard on our own arithmetic and attribution, E3 J7's independent recomputation and source fact-check are mandatory before the handoff packet can close.

## 2.7 What this frame does not claim (feeds the §8.1 must-not-imply discipline)

Every line below is a limitation the report carries, not a caveat to be trimmed for marketability (design §8.2).

- **Not** that skills are better or worse than AGENTS.md or context files **in general**. One agent, one model, one native `CLAUDE.md` mechanism, one content artifact, one task family, one slate.
- **Not** that skills or `CLAUDE.md` do not work. Content efficacy is arm C's contrast, and it is secondary.
- **Not** a judgment of any authored skill's quality. The instruction-body bytes are identical across arms; the Skill's upstream routing frontmatter differs by design, and nothing here evaluates the content's merit.
- **Not** a vendor comparison. Both arms are the same agent.
- **Not** the skill mechanism at its best. It is the mechanism as delivered by the upstream-authored description (§2.4).
- **Not** an official certification or a universal ranking (§8.1).
- **Not** owner-honesty-proven. The run is on a **self-run local venue**. The product and report both carry this exact sentence: **“Pre-registration here is a discipline enforced by this tool, not a proof against the run's own owner — nothing prevents the owner from having altered the record before publishing it.”**
- **Not** a claim that every configured runtime property was independently enforced (§8.1). Exact E3 C1 limitation sentence: **“Effort was configured and dispatch-gated at `high`, but it is not a graded Matrix axis and run-pinning verification does not independently establish the reasoning depth the model applied; that property is attested only.”** Per-axis pinning status — including any `attested` or `unverifiable` axis — is reported, not hidden (§7.3).
- **Not** generalizable below the declared MDE. An underpowered null is reported as "we cannot detect effects smaller than X" and never quietly reframed as "no effect" (E2).
- **Not** rehearsal-free. Every preview is logged, counted, and disclosed in the limitations (§7.2).
- **Not** re-derivable at the Matrix integrity tier. SWE-shaped tasks mint no admission receipt today, so the Matrix integrity tier on those tasks is **`attested-only`, never `re-derivable`** (C1 recon). Engineering will **disclose this for demo 1, not fix it** — so the report states it as a limitation rather than implying a stronger integrity tier than the run has.
- **Not** disinterested. **Conflict-of-interest statement, printed plainly in the limitations:** the contributors who designed and ran this benchmark operate the self-run venue it ran on, chose the slate and content artifact, built the estimator in the same program that emits the result, produced the grading environment, ran and graded both arms, and are using the report to demonstrate the benchmark product. The agent under test is made by the same vendor whose skill mechanism is one of the two arms. We hold no position that a particular arm should win; the sealed inputs, independently recomputed arithmetic, and content-identity construction (§2.4) are the checks a reader should rely on rather than that statement of intent. Attribution is role-only per the repo's external-communication rules; no named contributors.
- **Not** a multi-harness result. Exact E3 C2 limitation sentence: **“Every cell used one Claude Code harness configuration; generalization to other harnesses or configurations is unknown, and prior work's 27.4 percentage-point harness-choice swing is why this result is bounded to the exact configuration sealed here.”**
- **Not** silent about non-completions. **Per-arm timeout counts and per-arm retry counts are published**, not just aggregate pass rates. **Timeouts count as FAIL**, declared before the run — not dropped, not treated as missing data, not reclassified after seeing which arm they landed in.
- **Not** seed-shopped. The **bootstrap seed is bound at lock** and published with the report, so the interval is reproducible rather than one draw among many.
- **Not** a novelty claim that survives the SkillJuror verification item (§1.5). If E3 finds SkillJuror's flat baseline is an always-on context file, this report is a replication and says so.

## 2.8 Resolved report framing and deferred publication topology

Frame, arm count, source repository, native flat-file mechanism, and report framing are decided (§0.1). The exact C2 folder remains outcome-blind method work under the frozen selection rule, not an operator framing choice.

1. **Report framing — resolved.** Name the Vercel post and Hacker News objection directly and respectfully (§2.6). The independent recomputation and source fact-check in E3 J7 are mandatory.

2. **Publication topology — deferred.** Public report origin, author-source identity/name, signed Record Discovery source, archive mirror, Explorer ingestion/UI, key custody, errata policy, and the live `spec.jinn.network` dependency are intentionally unresolved in this program. The publication handoff names them without choosing or implementing them.

## 2.9 Handoffs

- **To E2 (power):** primary contrast is A vs B paired by task; secondary is (A ∪ B) vs true no-file C. Size both. **Anchor the MDE at ~21 pp per §2.2.1** — a motivating estimate, not a claim that CLAUDE.md reproduces Vercel's AGENTS.md mechanism — and print the achieved MDE in the report. Bind and publish the bootstrap seed at lock (§2.7).
- **To E3 (red team):** verify SkillJuror, content availability/license, native loader behavior, and zero patch contamination. Both `.jinn-demo1-skill-plugin/**` and root `CLAUDE.md` must be excluded in every arm, and A/B patches must be byte-identical to true no-file C for the same repository change.
- **To P2 (launcher arm wiring):** both A and B pin `enforced` on `jinn.skill.v1`; A loads a valid plugin, B uses native root `CLAUDE.md`, and C carries no loadout. Verify the copy hashes, exact runtime inventories, loader argv, symmetric exclusions, and harness-version equality.
- **To R5:** the slate must be domain-compatible with the chosen content artifact, or the manipulation check fails by construction (§2.3).
- **To C3/R4:** no estimator is proposed here. Every number comes from a named registry method. The registry method must support the recomputability commitment in §2.10.
- **To E5 (report and handoff):** the sealed claim package ships the one-command recomputation recipe (§2.10), the COI statement, the single-harness scope line, per-arm timeout and retry counts, and the bootstrap seed (§2.7). It does not claim network publication.

## 2.10 Pre-dispatch and handoff commitments

Two commitments make the report bundle more than an unsupported self-run number. Both are approved; neither is optional at the publication handoff boundary.

**Public pre-registration (E4) — committed, conditional on the P5 e2e gate being green.** Before the official run, we publish: the **locked method summary**, the **Run record digest**, and the **frozen grader program digest**. The grader digest matters as much as the method: pre-registering the method while leaving the grader mutable would leave the outcome definition adjustable after the fact, which is the loophole a careful reader checks for. Publishing all three before any official cell executes is what converts the local venue's structurally weak pre-registration (§7.1 — leg (a) structural and leg (c) append-order only, **no guarantee against the run owner**) into something a third party can actually hold us to. The conditionality is deliberate and is itself disclosed: we do not pre-register a run the pipeline cannot yet complete. If infrastructure trouble hits after pre-registration anyway, it is accounted for honestly in `runOutcome` rather than quietly re-run.

**Third-party recomputability — a headline deliverable, not a footnote.** Every number in the report must be recomputable from the sealed bundle using the handoff-supplied exact verifier and canary/package artifacts, by someone who does not trust us and does not run our product. The claim package ships the **one-command recipe**. This is the concrete form of the design's "evidence that outlives the product" posture (§8.2) and the honest answer to the venue limitation: we cannot prove owner-honesty by running the venue ourselves (§7.1), so instead we make every reported number independently checkable and say plainly that checkability — not our good faith — is what the reader should rely on.

Note what recomputability does and does not cover. It covers the path from the sealed bundle to the reported numbers. It does **not** make the run itself re-derivable — SWE-shaped tasks mint no admission receipt today, so the Matrix integrity tier stays `attested-only` (§2.7). Both statements appear together in the report; the strong one must not be allowed to imply the weak one.
