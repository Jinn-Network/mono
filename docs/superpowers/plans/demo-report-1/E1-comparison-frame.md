# E1 — Comparison Frame and Citation Map

**Version:** 0.2 (draft for operator decision; folds in C1's pinning recon)
**Date:** 2026-08-11
**Author:** E1 method-stream agent
**Program:** `docs/superpowers/plans/2026-08-11-demo-report-1-skill-ab-program.md` (Stage 2, packet E1)
**Status:** Draft. Part 2 is a recommendation, not a decision. The operator (Ritsu) chooses the frame; nothing here is locked.

---

## 0. What this document is for

Demo Report #1 is the product's first published benchmark. Its motivation section has to be real: there must be a live public argument the report speaks into, and the report has to close a gap that is actually open. Part 1 establishes both with verified sources. Part 2 proposes the comparison design that closes the gap at the lowest blast radius, and records the alternative honestly.

Two things this document does not do. It does not design engineering (that is R1–R5 and P1–P5). It does not choose statistics (that is C3/R4 — every number in the report comes from a named `BENCHMARKING_METHOD_REGISTRY` method, and this document proposes no estimator).

---

# Part 1 — Citation map of the live public argument

## 1.1 The argument in one paragraph

Coding agents can be given repository- or task-specific instructions two ways. A **context file** (`AGENTS.md`) is loaded into the agent's context unconditionally and in full, every turn. A **skill** (`SKILL.md`) is loaded through *progressive disclosure*: only its name and description sit in context at startup, and the body enters context only if the agent decides the description matches the task. Both mechanisms are open standards with broad vendor adoption. Practitioners disagree, publicly and with numbers, about which one actually produces better agent performance — and the loudest published comparison changed the content and the mechanism at the same time, which is the exact objection its own top Hacker News comment raised.

## 1.2 The two mechanisms — primary sources

| Source | What it establishes |
|---|---|
| [agents.md](https://agents.md/) | The AGENTS.md format homepage. "A simple, open format for guiding coding agents." Reports use by over 60k open-source projects; states the standard is stewarded by the Agentic AI Foundation under the Linux Foundation; lists 20+ compatible tools including OpenAI Codex, GitHub Copilot, Gemini CLI, Cursor, VS Code, Devin, Zed, Aider, Warp, JetBrains Junie. |
| [github.com/agentsmd/agents.md](https://github.com/agentsmd/agents.md) | The AGENTS.md specification repository. **License: MIT.** Hosts the spec text. (The Linux Foundation stewardship statement appears on the site, not on the repo landing page.) |
| [agentskills.io](https://agentskills.io/home) | The Agent Skills open specification. A skill is a folder with a required `SKILL.md` (YAML metadata plus instructions) and optional `scripts/`, `references/`, `assets/`. States the format "was originally developed by Anthropic, released as an open standard." Documents the three-stage progressive disclosure model: Discovery (name + description at startup), Activation (full `SKILL.md` read when the task matches), Execution. Client showcase lists 40+ adopting products including Claude Code, ChatGPT/Codex, Gemini CLI, GitHub Copilot, VS Code, Cursor, Amp, Goose, OpenHands, Factory, JetBrains Junie, Roo Code, Kiro, Tabnine. |
| [github.com/agentskills/agentskills](https://github.com/agentskills/agentskills) | The Agent Skills spec repository. **License: Apache-2.0 for code, CC-BY-4.0 for documentation.** |
| [Agent Skills — Claude Platform Docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) | The canonical vendor documentation for the mechanism under test. Specifies the three loading levels precisely: **Level 1 metadata always loaded at startup (~100 tokens per skill, name + description in the system prompt)**; **Level 2 `SKILL.md` body loaded only when the skill is triggered** (under 5k tokens); Level 3 bundled resources loaded only when read. States the `description` "is what Claude matches your request against when determining whether to trigger the Skill." |
| [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) — Anthropic engineering, 16 Oct 2025 | The design rationale for progressive disclosure and composability; the origin post for the mechanism. |
| [github.com/anthropics/skills](https://github.com/anthropics/skills) | Anthropic's public skills repository. **License: Apache-2.0 for most skills**; the four document skills (`docx`, `pdf`, `pptx`, `xlsx`) are **source-available, not open source**. Ships `./spec/` and `./template/`. Relevant to Part 2 content selection. |

The mechanism difference that matters for this A/B is one sentence, and it is documented, not inferred: **AGENTS.md content is present unconditionally; skill body content is present only if the model routes to it.**

## 1.3 The live claim that started the current fight

| Source | What it says |
|---|---|
| [AGENTS.md outperforms skills in our agent evals](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals) — Jude Gao, Vercel, 27 Jan 2026 | Four configurations on Next.js 16 API tasks held out of training data. Pass rates: **baseline 53%, skill with default behavior 53%, skill with explicit invocation instructions 79%, AGENTS.md docs index 100%**. Reports the skill **was never invoked in 56% of default-behavior cases**; explicit trigger instructions raised invocation above 95%. Also reports that trigger *wording* changed outcomes materially. **The post does not state that the AGENTS.md arm and the skill arm contained identical source material** — the AGENTS.md arm is described as a compressed 8KB docs index. |
| [Hacker News discussion](https://news.ycombinator.com/item?id=46809708) — 524 points, 196 comments | The two dominant themes: (1) skills require an invocation decision the agent can get wrong, whereas AGENTS.md is always present; (2) **the comparison may be flawed because the arms are different configurations — a comprehensive compressed index versus a brief description — leaving it unclear whether the difference comes from the mechanism or from implementation quality.** |
| [Agent-Optimized Docs vs Skills: What Actually Improves Coding Agent Performance](https://rmax.ai/notes/docs-vs-skills-agent-context-delivery/) — Max, 12 May 2026 | Practitioner analysis arguing passive context wins because it "removes the activation step." Notes Vercel's 8KB index matched the 40KB version, which points at compression as a factor independent of delivery. Does not resolve the content-versus-mechanism confound. |
| [Claude Skills are awesome, maybe a bigger deal than MCP](https://simonwillison.net/2025/Oct/16/claude-skills/) — Simon Willison, 16 Oct 2025 | The most-cited practitioner endorsement of the skill mechanism, on simplicity and token efficiency grounds — the position the Vercel result is read as contradicting. |

## 1.4 Published empirical work — all of it is on/off, none of it is packaging-versus-packaging

| Source | Design | Finding |
|---|---|---|
| [Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?](https://arxiv.org/abs/2602.11988) — Gloaguen, Mündler, Müller, Raychev, Vechev; 12 Feb 2026 (rev. 23 Jun 2026) | Context file present vs absent, on SWE-bench tasks with LLM-generated context files and on novel issues in repos with developer-committed context files. | Context files **did not generally improve success rates** and **increased inference cost by over 20%**; held across models and agents. Repository overviews specifically were unhelpful. |
| [On the Impact of AGENTS.md Files on the Efficiency of AI Coding Agents](https://arxiv.org/abs/2601.20404) — Lulla, Mohsenimofidi, Galster, Zhang, Baltes, Treude; 28 Jan 2026 (v2 30 Mar 2026) | AGENTS.md present vs absent; 10 repositories, 124 pull requests; efficiency metrics. | **Lower median runtime (Δ 28.64%)** and **reduced output tokens (Δ 16.58%)** with comparable completion behavior. |
| [SWE-Skills-Bench: Do Agent Skills Actually Help in Real-World Software Engineering?](https://arxiv.org/abs/2603.15401) — Han, Zhang, Song, Fang, Chen, Sun, Hu; 16 Mar 2026 | 49 public SWE skills, ~565 task instances across six subdomains, paired with-skill vs no-skill, execution-based verification. | **39 of 49 skills yield zero pass-rate improvement; average gain +1.2%.** Token overhead ranges to **+451%** with unchanged pass rates. Seven skills give meaningful gains (to +30%); three degrade performance (to −10%). |
| [Do Agent Skills Actually Help? A Controlled Experiment](https://tessl.io/blog/do-agent-skills-actually-help-a-controlled-experiment/) — Rotem Tamir, Tessl, 18 Feb 2026 | Three arms × 30 trials on a Go/GORM migration bug: vanilla Claude Code, official Atlas skill, custom project skill. | **53% / 73% / 80%.** Skill vs *nothing*, not skill vs equivalent flat instructions. |
| [When Skills Don't Help: A Negative Result on Procedural Knowledge for Tool-Grounded Agents in Offensive Cybersecurity](https://arxiv.org/abs/2605.20023) — Chacko, Hugglestone, Islam, Liu; 19 May 2026 (v2 24 May) | Four documentation richness conditions (591–36,001 tokens) on a CTF agent. | Margin between no-skill and richest-skill was **8.9 pp, p = 0.71**. Proposes "environment-feedback bandwidth" as the explanation. |
| [Harness Engineering for Agentic AI Coding Tools: An Exploratory Study](https://arxiv.org/abs/2602.14690) — Galster, Mohsenimofidi, Lulla, Abubakar, Treude, Baltes; 16 Feb 2026 (v5 30 Jun 2026) | Adoption study across 2,853 GitHub repositories; eight configuration mechanisms. | **Context files dominate** and are often the sole mechanism, with **AGENTS.md emerging as the interoperable standard**; **few repositories adopt Skills**, and adopted skills mostly carry static instructions rather than executable scripts. |
| [From Anatomy to Smells: An Empirical Study of SKILL.md in Agent Skills](https://arxiv.org/abs/2607.01456) — Hong, Imani, Ahmed; 1 Jul 2026 | 238 real-world skills; taxonomy of 13 higher-level and 44 lower-level components; "skill smells" from a 29-source multivocal review. | **Over 99% of SKILL.md files contain at least one skill smell**, and smells rarely disappear as skills evolve. |

Note the shape of the literature. Every controlled study varies **whether instruction content is present**. None varies **how the same content is delivered**. The two AGENTS.md papers disagree with each other on whether context files help at all, and the skill studies range from +27pp (Tessl, one task) to +1.2% average (SWE-Skills-Bench, 565 instances). The adoption paper shows the mechanism practitioners actually use is the one with the weakest published support.

## 1.5 The nearest neighbors — the two papers closest to our design

These matter most, because if either already ran our experiment, the demo report's novelty claim is false and must be withdrawn.

| Source | How close it gets | Why it is not the same experiment |
|---|---|---|
| [SkillJuror: Measuring How Agent Skill Organization Changes Runtime Behavior](https://arxiv.org/abs/2606.11543) — Chen, Guo, Huang, Lu, Lin, Zhou, Zhang; 10 Jun 2026 | The closest published work. Explicitly separates "what a Skill says from how it is organized," compares **Progressive Disclosure against a normalized flat baseline while holding task knowledge fixed**, 82 SkillsBench tasks, 410 matched trials. Reports distinct resources touched per trajectory rising 1.18 → 3.85 and **+4.1% verifier-passing trials**. | The contrast appears to be *within* the skill mechanism — a hierarchical `SKILL.md` versus a flattened one, both routed through skill activation — rather than skill-mechanism versus always-on context-file mechanism. **VERIFICATION GAP:** the abstract is confirmed, but the mechanical definition of "normalized flat baseline" could not be extracted from the PDF at verification time. **E3 must resolve this before lock.** If SkillJuror's flat baseline is in fact an always-on context file, our novelty claim collapses and the report must be reframed as a replication. |
| [Skill Availability and Presentation Granularity in Large-Language-Model Agents: A Controlled SkillsBench Study](https://arxiv.org/abs/2605.31408) — Xu, Wu; 29 May 2026 | Holds knowledge constant and varies presentation: six skill conditions, 30-task subset, two models, five trials per cell, 1,800 rows. Reports **skill availability worth 18.0–36.0 pp** over no skill, while **presentation-granularity contrasts are small and uncertain** (low- vs high-abstraction: +0.7 pp and −6.7 pp, both 95% bootstrap CIs crossing zero). | Varies *abstraction level and worked examples* within skill documents. Every arm is a skill; the delivery mechanism never changes. |

## 1.6 The gap this report closes

**No published study holds the instruction bytes constant and varies only the delivery mechanism between a progressive-disclosure skill and an always-on `AGENTS.md`.**

Stated precisely, and with each clause backed above:

1. The mechanism difference is real and documented (Claude Platform docs, §1.2): conditional model-routed load versus unconditional load.
2. The most-read comparison of the two changed content and mechanism together and did not state content equivalence (Vercel, §1.3).
3. That confound is the single most-upvoted objection to it (Hacker News, §1.3).
4. All controlled academic work varies presence, not packaging (§1.4).
5. The two studies that do hold content fixed vary organization *within* the skill mechanism, not the mechanism itself (§1.5) — subject to the SkillJuror verification item.
6. Practitioners are choosing between these mechanisms today at scale, and the mechanism they overwhelmingly choose is the one with the most contradictory evidence (§1.4, Harness Engineering).

The honest framing of the motivation is therefore not "nobody has studied this." It is: **this question has been argued publicly with numbers on both sides, and every published number confounds what the instructions say with how they are delivered. We hold the bytes fixed and vary only the delivery.**

## 1.7 Verification log

Every URL above was fetched and confirmed to resolve and to say what is attributed to it, on 2026-08-11. One URL surfaced in search **failed** verification and is therefore **not cited** as a source:

- `https://github.com/GeniusHTX/SWE-Skills-Bench` — HTTP 404 at verification time. The SWE-Skills-Bench *paper* (arXiv 2603.15401) verified live; its artifact repository did not. This blocks the paper's 49-skill set from being a content candidate until availability and license are confirmed (§2.3).

Sources seen in search results but **not fetched, and therefore not cited**: HANDBOOK.md (arXiv 2607.25398), MalSkillBench (2606.07131), Skill-to-LoRA (2606.16769), SkillGenBench (2605.18693), SKT (2608.02287), and assorted secondary commentary. E3 may add them after its own verification.

---

# Part 2 — Comparison-design draft (for operator approval)

## 2.1 Recommended frame: mechanism versus mechanism

**Same agent. Same model. Same effort. Same tasks. Same instruction bytes. Only the delivery mechanism differs.**

| Arm | Delivery | What the agent sees |
|---|---|---|
| **A — skill** | `SKILL.md` in the skills directory, loaded through the standard progressive-disclosure path | Name + description always in context; body enters context only on model-initiated activation |
| **B — flat** | `AGENTS.md` at repository root | Body always in context, in full, every turn |
| **C — neither** | No instruction file, but an **explicit empty loadout** is pinned — a digest over a zero-byte file — so the arm is pinned rather than unpinned (§2.4) | Nothing |

The measured quantity is the effect of the *delivery mechanism*, with content held byte-identical. This is exactly the contrast the public argument needs and exactly the one no published work supplies.

## 2.2 Arms: recommend three, not two

**Recommendation: 3 arms.** Arm C is not optional insurance; it is the load-bearing control.

Without C, an A-versus-B null is uninterpretable. "No difference between packagings" is equally consistent with *packaging does not matter* and with *this particular content does nothing, so of course its packaging does not matter*. The literature makes the second reading the **more likely prior**, not a remote one: SWE-Skills-Bench found 39 of 49 skills produced zero improvement, and the ETH Zurich AGENTS.md study found context files did not generally help. Publishing an A-versus-B null without a manipulation check would be publishing an uninterpretable number, and a hostile reader would say so immediately.

**Cost.** Cells scale as `arms × tasks × replicates`. Three arms is 1.5× the cells of two — with a 30-task slate at 5 replicates, 450 container-graded cells instead of 300. That is real compute on the highest-variance seam in the program (P3, container grading). The operator should price this against the alternative, which is a report whose headline cannot be defended.

**Proposed contrast structure, to be pre-registered before lock:**

- **Primary contrast: A vs B**, paired by task. This is the report's headline. E2 powers this one and declares its MDE.
- **Secondary contrast (manipulation check): (A ∪ B) vs C.** Establishes that the content has any detectable effect at all.
- **Pre-declared decision rule:** if the manipulation check fails — the content shows no detectable effect over C — then the A-vs-B result is reported as *uninformative about the mechanism, because the content had no detectable effect to deliver*. This rule is declared before the run, not chosen after seeing results. It is the difference between an honest null and a denominator game.

**If the operator declines the third arm on cost:** the fallback is 2 arms plus a *pre-run* content-efficacy screen on a small disposable preview slate (disclosed as a rehearsal per §7.2), used only to decide whether the content qualifies for the official run. This is weaker — the screen is not part of the sealed run and cannot appear as a result — but it preserves interpretability at lower official-cell cost. Recorded as the fallback, not the recommendation.

## 2.3 Instruction content: candidates, with license verification

Requirements the content must satisfy:

1. **Public and licensed** for this use.
2. **Non-trivial** — capable of changing task outcomes, or the manipulation check fails by construction.
3. **Faithfully expressible in both packagings** without either arm being obviously handicapped by our authoring.
4. **No task-answer leakage** — the content must not contain hints specific to the slate's held-out issues.
5. **Authored upstream, with an upstream description** — see §2.4, this is the decisive constraint.

| Candidate | License status | Assessment |
|---|---|---|
| **C2 (recommended default) — a skill from [github.com/anthropics/skills](https://github.com/anthropics/skills)** | **Apache-2.0 for most skills, verified.** The four document skills (`docx`, `pdf`, `pptx`, `xlsx`) are source-available and **must be excluded**. | License verified live. Authored as a skill by the mechanism's originator, which removes the strongest objection to a negative result for arm A ("you wrote a bad skill"). Ships an upstream `description`, satisfying §2.4. Constraint: the chosen skill's domain must plausibly bear on a SWE-shaped slate; the creative and enterprise categories do not, so the viable set is narrow and must be named before lock. |
| **C1 (preferred upgrade, blocked) — a skill from the 49-skill SWE-Skills-Bench set** | **Unverified. Artifact repository returned 404 (§1.7).** | Strongest option on the merits: third-party authored, domain-matched, and already measured on/off in published work — so the "does this content do anything" prior is partly known, and we could deliberately select from the seven skills the paper reports as producing meaningful gains, which are the only ones where a mechanism contrast is measurable at all. **Blocked until availability and license verify.** Do not adopt on the strength of the paper alone. |
| **C3 (not recommended) — content derived from the target repositories' own public docs** | Per-repository OSS licenses; heterogeneous. | Highest ecological validity — this is what real AGENTS.md files contain — but the worst risk profile. Leakage risk is highest (a repo's own docs may touch the very issue under test), licensing is per-repo rather than uniform, and if we generate or summarize the content ourselves we inherit exactly the confound the ETH Zurich study identified with LLM-generated context files, while losing "public and licensed." |

**Recommendation: C2 as the default, with C1 as a documented upgrade if and only if its availability and license verify independently.** Whichever is chosen, the specific artifact, its upstream URL, its commit or version, its license, and its sha256 go into the Benchmark record before lock.

## 2.4 Content identity: how it is guaranteed and how a reader audits it

This is the mechanic the whole frame rests on. If a reader cannot verify content identity, the report is just another Vercel-shaped comparison with a confound.

**Construction — one source, two packagings:**

1. **One frozen source document.** `source.md` holds the instruction body verbatim from the upstream artifact. Its sha256 is recorded in the Benchmark record before lock.
2. **A committed, deterministic transform** produces both arm materializations:
   - **Arm A:** `SKILL.md` = the upstream YAML frontmatter block (`name`, `description`) followed by `source.md` bytes verbatim.
   - **Arm B:** `AGENTS.md` = `source.md` bytes verbatim. No frontmatter — the AGENTS.md format has no frontmatter requirement.
3. **The delta between arms is therefore exactly:** the YAML frontmatter block, the file name and path, and the loading mechanism they select. Nothing else.

**Audit path published in the report:** `sha256(source.md)`, `sha256(SKILL.md)`, `sha256(AGENTS.md)`, the frontmatter block reproduced verbatim, the transform, and the upstream artifact URL and version. A reader reconstructs both arms from the source and checks the three digests. The claim "identical content" becomes checkable rather than asserted.

**Pinning — symmetric enforcement across all three arms (resolved by C1's engineering recon).**

The draft of this document flagged an open risk: that arm A's skill could pin `enforced` while arm B's plain `AGENTS.md` could only be *attested*, leaving the two arms with different pinning strength. **C1's recon closes it, and the answer is better than the risk-mitigated case.**

- **Arms A and B pin on the same axis, with the same verification.** Arm B's flat `AGENTS.md` fits the `jinn.skill.v1` loadout kind's single-file shape exactly, so both arms materialize through the identical digest-verified path — `materializeLoadout` at `packages/task-execution/backend-local/workspace/src/materialize.ts:112-124`, which for the `jinn.skill.v1` branch writes a single file at the pin's `name` via `materializeAt`, and `materializeAt` refuses on a sha256 mismatch (`ContentCorruptionError`, same file line 37). Both arms therefore reach `enforced` / `match` on one loadout axis, differing only in digest. The pin shape itself is `{kind, name, digest}` — `packages/task-execution/backend-local/workspace/src/loadout.ts` (`LOADOUT_KINDS`, `canonicalLoadoutPin`).
- **Two product-side mechanics make it work**, both on existing precedent and requiring no platform change: placement into the work directory rather than the sealed input directory, and a venue launcher wrapper that drops the `--plugin-dir` argument for the flat-file arm so arm B is not silently handed the skill-loading path.
- **Arm C pins an explicit empty loadout** — a digest over a zero-byte file — rather than running unpinned. An unpinned arm locks fine, but publishes `unverifiable` on the loadout axis in the report's honesty block. Pinning empty instead makes **all three arms reach `match` on the loadout axis, with `unverifiableAxisCounts.loadout` = 0**. That is a strictly stronger claim surface for the same run, and it is why arm C's row in §2.1 says "explicit empty loadout" rather than "no pin."

**Rejected alternative, recorded:** running the comparison with disclosed asymmetric pinning — arm A enforced, arm B attested, arm C unpinned — and naming the asymmetry in the limitations. This was the fallback while the seam was open. It is now rejected on the merits: symmetric enforcement is achievable with existing precedent, so accepting a disclosed wart would be choosing a weaker report for no saving.

Verification note: the path C1 reported omitted the `backend-local` segment; the file is at `packages/task-execution/backend-local/workspace/src/materialize.ts`, and the cited line range and digest-refusal behavior were confirmed there directly.

**The residual asymmetry that cannot be removed — and must be stated, not hidden.**

The frontmatter is not nothing. Arm A's `description` is a routing prompt: it is the text the agent reads to decide whether to load the body, and it has no counterpart in arm B, where the body is simply always present. So "byte-identical content" is true of the *instruction body* and false of the *total delivered text*. Arm A delivers frontmatter-always plus body-sometimes; arm B delivers body-always.

That **is** the mechanism, so it is not a flaw — but the report must say it in exactly those terms, or a hostile reader will correctly call it a content difference.

**This creates the single largest threat to validity in the design.** Vercel's own result showed trigger wording swinging pass rates from 53% to 79%. Description wording is therefore a live researcher degree of freedom: a weak description makes arm A lose for a reason that is not the mechanism. Two mitigations, and the first is why §2.3 rules out C3:

- **Use the upstream artifact's own `description` verbatim.** Zero researcher freedom. This requires the content candidate to be an existing public skill with an existing description — which is precisely why C2 and C1 beat C3.
- **Freeze it before lock and publish it verbatim.** No tuning after any cell has run, official or preview.

The report's claim is then bounded honestly: *we measure the skill mechanism as delivered by its upstream-authored description, not the skill mechanism at its best.*

## 2.5 Held constant across arms

Agent (claude-code launcher), model, **effort (held constant, disclosed as attested-not-graded per the program's global constraints)**, harness version, task slate, container grader, retry and exclusion policy, replicate count. Enforced pins wherever the local venue can enforce; per-axis pinning status published in the report's disclosures rather than assumed (design §7.1, §7.3).

**The loadout axis is the one the A/B varies, and per C1's recon it reaches `match` on all three arms** — arm A's skill digest, arm B's `AGENTS.md` digest, arm C's zero-byte digest — so the report can publish `unverifiableAxisCounts.loadout` = 0 (§2.4). Every other axis above is held rather than varied.

Exclusion and infra-failure retry rules are proposed by R5 **before anyone sees per-task results** and are part of the lock.

## 2.6 Blast-radius rationale: why this frame embarrasses no one

- **No third party's artifact is on trial.** The same bytes appear in both arms. A negative result for arm A is a result about progressive-disclosure *delivery*, not about anyone's writing. This is the structural reason the frame is safe, and it holds even if the content is an Anthropic-authored skill.
- **The result cannot be read as vendor-versus-vendor.** Both arms run on the same vendor's agent. There is no "X beats Y" headline available to a careless reader, because there is no X and Y.
- **Both mechanisms have institutional backing.** AGENTS.md is stewarded under the Linux Foundation; Agent Skills originated at Anthropic and is now an open standard with 40+ adopting products. Neither is an underdog being punched down at.
- **The genre is already established as a contribution, not an attack.** Vercel published a directionally negative result about skills and it was received as research. We are refining the comparison, not contradicting a person.

**The higher-pull alternative, recorded honestly: a widely-used public skill on/off.**

- **Pull:** materially higher. "Does [famous skill] actually work" is a headline; "does packaging matter" is a methods result.
- **Blast:** an identifiable third party's artifact receives a public pass-rate number. A negative result is a public negative review of a named party's work, published by an unknown benchmark vendor on a **self-run venue that by construction proves nothing against its own owner** (design §7.1). That combination invites "who are you to grade this" rather than "is the method sound" — which is the wrong first argument to have about a first report.
- **It is also already done, better.** SWE-Skills-Bench measured on/off across 49 public skills and ~565 instances. We would be second, with less data, on a weaker venue.
- **Recommendation: do not open with it.** It is a good *second* report once the venue has an external track record, and the method transfers unchanged, so it stays cheap to run later.

**A third option the operator should see, because it is a presentation choice rather than a design choice.** The same design can be *framed* at publication as "the controlled version of the comparison Vercel ran" — naming the post and the Hacker News objection directly. Pull is high, because the top comment on a 524-point thread is literally our design rationale. Blast is moderate, because we would be naming a company. The design is identical either way, so this decision can be deferred to E5 and made at publication time rather than at lock.

## 2.7 What this frame does not claim (feeds the §8.1 must-not-imply discipline)

Every line below is a limitation the report carries, not a caveat to be trimmed for marketability (design §8.2).

- **Not** that skills are better or worse than AGENTS.md **in general**. One agent, one model, one content artifact, one task family, one slate.
- **Not** that skills do not work, or that AGENTS.md does not work. Content efficacy is arm C's contrast, and it is secondary.
- **Not** a judgment of any authored skill's quality. The bytes are identical across arms; nothing here evaluates the content's merit.
- **Not** a vendor comparison. Both arms are the same agent.
- **Not** the skill mechanism at its best. It is the mechanism as delivered by the upstream-authored description (§2.4).
- **Not** an official certification or a universal ranking (§8.1).
- **Not** owner-honesty-proven. The run is on a **self-run local venue**: its pre-registration is a discipline, not a proof against its own owner (§7.1). This appears in the product and in the report.
- **Not** a claim that every configured runtime property was independently enforced (§8.1). Effort is held constant and **attested, not graded**; per-axis pinning status — including any `attested` or `unverifiable` axis — is published, not hidden (§7.3).
- **Not** generalizable below the declared MDE. An underpowered null is reported as "we cannot detect effects smaller than X" and never quietly reframed as "no effect" (E2).
- **Not** rehearsal-free. Every preview is logged, counted, and disclosed in the limitations (§7.2).
- **Not** re-derivable at the Matrix integrity tier. SWE-shaped tasks mint no admission receipt today, so the Matrix integrity tier on those tasks is **`attested-only`, never `re-derivable`** (C1 recon). Engineering will **disclose this for demo 1, not fix it** — so the report states it as a limitation rather than implying a stronger integrity tier than the run has.
- **Not** a novelty claim that survives the SkillJuror verification item (§1.5). If E3 finds SkillJuror's flat baseline is an always-on context file, this report is a replication and says so.

## 2.8 Open questions only the operator can answer

Four remain. A fifth — whether a disclosed asymmetric-pinning run would be acceptable — is **withdrawn**: C1's recon showed symmetric enforcement is achievable for all three arms on existing precedent, so §2.4 now carries a recommendation rather than a question.

1. **Frame.** Approve mechanism-versus-mechanism as recommended, or take the higher-pull public-skill on/off alternative (§2.6)?
2. **Arm count.** Three arms at 1.5× cells, or two arms plus a disposable pre-run content screen (§2.2)? This is a compute-budget call against headline defensibility.
3. **Content artifact.** Accept C2 (Anthropic public skills, Apache-2.0, verified) as the default, and authorize C1 (SWE-Skills-Bench set) as an upgrade conditional on independent license and availability verification (§2.3)?
4. **Publication framing.** Name the Vercel post and the Hacker News objection in the report's motivation, or motivate the gap generically (§2.6)? Deferrable to E5.

## 2.9 Handoffs

- **To E2 (power):** primary contrast is A vs B paired by task; secondary is (A ∪ B) vs C. Size both. Declare the A-vs-B MDE before the official run and print it in the report.
- **To E3 (red team):** two verification items are already open. (a) Resolve SkillJuror's "normalized flat baseline" definition (§1.5) — the novelty claim depends on it. (b) Verify the SWE-Skills-Bench artifact availability and license if C1 is pursued (§1.7, §2.3). E3 additionally owns leakage in the chosen content and description-wording freedom (§2.4). The pinning asymmetry is **closed** (§2.4) and no longer an E3 item; the `attested-only` Matrix integrity tier on SWE-shaped tasks (§2.7) is a disclosure item, not a defect to attack.
- **To P2 (launcher arm wiring):** the acceptance criterion is now specific rather than open — all three arms pin `enforced` on one `jinn.skill.v1` loadout axis (arm A skill, arm B flat `AGENTS.md`, arm C zero-byte), with `unverifiableAxisCounts.loadout` = 0. The two product-side mechanics C1 identified — work-dir placement, and a venue launcher wrapper dropping `--plugin-dir` for the flat-file arm — are implementation items on existing precedent, no platform change (§2.4).
- **To R5:** the slate must be domain-compatible with the chosen content artifact, or the manipulation check fails by construction (§2.3).
- **To C3/R4:** no estimator is proposed here. Every number comes from a named registry method.
