# Skills Factory MVP — Measured Skills on Public Registries

- **Version:** 0.1
- **Date:** 2026-07-30
- **Author:** Ritsu (design session, Claude Fable 5)
- **Shape:** `design` — output is this document; implementation planned separately
- **Status:** approved in session; pending written review
- **Parent design:** [`docs/superpowers/specs/2026-07-16-jinn-skill-factory-design.md`](2026-07-16-jinn-skill-factory-design.md)
  (v1.0, on `claude/jinn-skill-factory-design-1eaf45`) — remains the reference architecture for the
  protocol-native factory. This MVP reorders the roadmap (demand surface first, protocol later); it
  does not supersede the v1.0 destination.
- **Sibling:** [`docs/superpowers/specs/2026-07-22-solvernet-benchmarking-primitive-design.md`](2026-07-22-solvernet-benchmarking-primitive-design.md)
  (same branch) — untouched; the MVP rig is deliberately *not* that primitive.
- **Origin:** 2026-07-30 discussion (Ritsu × Oak). Oak's chain: open-source maintainers want
  judgment and accountability Jinn doesn't provide → find the surface where agents *autonomously*
  discover capability, with a tight feedback loop and no outreach → skill registries → fork and
  improve skills — a niche at first — with benchmarking as the differentiator. Users get better
  skills; the corpus grows.

---

## 1. Product definition

### 1.1 What the product is

**The improved skills are the product.** Agents and users install skills; that is the unit of
consumption on every registry surface. Everything else is a supporting role:

- **Benchmark receipts are the trust layer**, not the product. Among ~57k plausible skills on the
  registries, ours are the ones that say: *forked from X, measured against X on N real tasks,
  here's the delta, here's the reproduction.* No other publisher makes this claim today.
- **The factory is internal machinery** — how we make them. Invisible to the consumer in v1.
- **The corpus is the compounding byproduct** — every benchmark run and improvement attempt
  produces evidence that makes the next skill cheaper to improve. Post-MVP, this is where the
  protocol ("place to learn") reconnects.

One sentence: **Jinn publishes measurably better versions of the skills agents already search
for; the receipts prove it, and the evidence accumulates.**

### 1.2 What the MVP ships

1. **Receipts for the incumbents** — benchmark reports for ~5 of the most-installed
   coding-workflow skills, each measured against a no-skill baseline on real SWE tasks.
2. **One fork outcome** — a fork of the empirically best target, run through an optimization
   loop, measured against the original on a held-out slate; published as an installable skill if
   it wins, published as an honest finding if it doesn't.

### 1.3 Demand surface (researched 2026-07-30)

Primary: **skills.sh** (Vercel, launched 2026-01-20) — the npm-style Agent Skills registry.
Decisive properties:

- **Permissionless, zero-gate publishing.** A public GitHub repo following the Agent Skills spec
  is the whole submission flow; the repo appears on the leaderboard automatically via anonymous
  install telemetry from `npx skills add <owner>/<repo>`.
- **Public install counts** (all-time, trending 24h, 8-week activity) — the MVP's demand signal
  is measured for us, for free.
- **Agent-mediated discovery is plumbed in, throughput unverified**: Vercel's `find-skills`
  skill (2.7M installs) instructs agents to search the registry mid-task and install with user
  consent — the permissionless agent-facing surface the origin thread hypothesized. Caveat
  (2026-07-30): installs of `find-skills` are not evidence of its use; no public metric
  distinguishes agent-driven installs from human ones, and the count is likely inflated by
  first-party promotion. Autonomous discovery is therefore a hypothesis the MVP observes
  (install persistence after the announcement spike), not a premise it rests on.
- **Cross-agent**: the CLI installs into Claude Code, Cursor, Windsurf, Copilot, Codex, Goose.
- **Quality signals are thin** (an "official" badge, a security-audit filter). Nobody does
  efficacy evidence.

Secondary registries (SkillsMP, claude-plugins.dev, mcpservers.org, claudemarketplaces.com)
auto-index public GitHub; publishing for skills.sh covers them as a byproduct. We build no
registry of our own; jinn.network gets at most a link.

### 1.4 Niche

**General coding-workflow skills, measured on real SWE tasks.** Rationale:

1. **Demand is proven, not guessed.** Leaderboard top (2026-07-30): `frontend-design`
   (anthropics, 722k installs), `grill-me` (mattpocock, 705k), `vercel-react-best-practices`
   (592k), `improve-codebase-architecture` (577k), `tdd` (556k). We fork the top of the
   leaderboard, not a corner of it.
2. **It is the one niche our machinery can already measure.** The shipped eval stack
   (swe-rebench slates, Docker eval-runner, paired statistics) measures exactly one thing:
   does an agent resolve real coding tasks better with X than without? A workflow skill's claim
   *is* that claim.
3. **The incumbents are vibes-based** — well-written opinion documents with zero evidence.
   Maximum contrast against precisely the most-installed skills.

### 1.5 Jinn fit (MVP posture: pure off-protocol)

Nothing of Jinn sits on the critical path: no marketplace, no corpus reads/writes, no anchoring.
The Jinn tie is branding and provenance narrative. Post-MVP upgrades, in the v1.0 design's
territory: corpus evidence feeding the improvement loop (place to learn), marketplace waves as
the scaled measurement instrument (place to do work), anchored receipts.

### 1.6 Success test

MVP done-when: the repo is public with ≥4 incumbent receipts and 1 fork outcome; the fork (or
best skill) is installable via `npx skills add`; every receipt is reproducible from the repo
alone. Demand *validation* (install telemetry, `find-skills` discovery) is the post-MVP
observation phase — the MVP's job is to exist and be honest.

---

## 2. The rig (the only real engineering)

One local benchmark harness reused by both waves — Block 1 of the v1.0 design stripped of every
protocol dependency. It composes four shipped components; the net-new surface is one
orchestration script and a receipt renderer.

| Piece | Source (shipped) | Role |
|---|---|---|
| Slate screening | `client/src/eval/screen.ts` layering | admit gradeable instances |
| Arm-isolated runs | pilot rig arm isolation (harness-layer measurement stack) | per-attempt agent home; skill mounted per arm; no cross-arm residue |
| Grading | `swe-rebench-v2-evaluator/eval-runner.ts` | Docker, resolved semantics, unscorable ≠ fail |
| Statistics | `client/src/eval/{paired,wilson}.ts`, `measurement.ts` | paired per-task outcomes, deltas, exact McNemar, Wilson intervals |

Design points:

- **Slate:** ~30 swe-rebench-v2 instances, screened gradeable, split **once, up front** into a
  *feedback slate* (wave-2 iteration) and a *holdout slate* (published receipts only; touched
  exactly once per final measurement). Membership pinned and committed to the repo.
- **Arms:** baseline (no skill) + each skill under test. One agent run per task × arm.
- **Profile:** one pinned solve profile — claude-code CLI, one pinned model, pinned skill bytes
  (upstream commit sha recorded). Every receipt states the claim scope: *this profile, this
  slate*. No portability claims.
- **Statistics posture:** feedback-tier honesty, not promotion-grade power. Receipts report N,
  resolve rates, paired delta, CI, and the caveat in plain words. No claim of significance the
  interval doesn't support.
- **Scale:** wave 1 ≈ 30 tasks × 6 arms ≈ 180 runs. Runs on the big-disk host (≥100 GB free;
  disk-floor guard per the standing eval-disk lesson), never a laptop. In-house inference,
  per-wave budget caps.

---

## 3. Wave 1 — benchmark the incumbents

1. Pin each target skill at a specific upstream commit; record sha and license.
   **License gate:** only skills whose license permits redistribution/modification are fork
   candidates; measure-only for the rest.
2. Run baseline + ~5 skills across the full slate.
3. Publish one receipt per skill: resolve rate vs baseline, paired delta, CI, per-task table,
   archived trajectories. README carries the summary table.

Wave 1 **cannot fail to produce a result**: helps / does nothing / hurts are all publishable,
attention-worthy findings nobody has published. It is the launch content, the credibility base
of the receipt brand, and the empirical selector of the wave-2 target (demonstrated headroom or
demonstrated failure, not guesswork).

Framing: neutral measurement, not an attack on authors. Some skills may genuinely win; every
result ships with its limits stated.

## 4. Wave 2 — fork and improve (the optimization loop)

The rig is the fitness function; wave 2 wraps a **GEPA-lite inner loop** around it — canonical
GEPA's natural regime (local, fast, own inference), exactly as the v1.0 design's v0.9 revision
concluded. The marketplace outer loop is post-MVP.

1. **Diagnose from traces.** Reflection over the wave-1 failing trajectories of the target
   skill: never triggered? guidance too vague to act on? actively harmful on a task class? (The
   2026-07-10 pilot null identified the dominant failure modes: content and discoverability.)
2. **Generate K candidate variants** — full revised SKILL.md files, not patches: sharper trigger
   description, failure-specific guidance, deletion of misfiring advice.
3. **Select on the feedback slate** (minibatch screening first where useful); keep the winner.
4. **Iterate** 2–3 rounds within a fixed run budget.
5. **One shot at the holdout** vs the original. That number is the receipt. Publish the fork
   only if it wins; publish the finding either way.

Not in the MVP loop: corpus evidence as diagnosis material (post-MVP), GEPA's system-aware merge
across lineages (K variants, pick one, done).

Upstream goodwill: offer the winning diff back to the original author as a PR. Merged or
declined, the receipt remains ours.

## 5. Publishing surface

One public GitHub repo, working name `Jinn-Network/skills`:

```
skills/<name>/SKILL.md        Agent Skills spec layout — `npx skills add Jinn-Network/skills` works
receipts/<name>.md            per-skill receipt: claim, numbers, CI, scope caveats
receipts/data/                pinned slate, run manifests, raw per-task results
rig/                          the orchestration script — open, so receipts are reproducible, not claimed
README.md                     the receipts summary table (leaderboard vs. reality)
```

Fork skill READMEs lead with: *forked from X@sha (attribution), measured against X on N held-out
real tasks, resolve rate A% → B% [CI], reproduction in /receipts.*

Announcement: one thread (Oak's channels) pointing at the receipts table. No submission flows
anywhere; registries index the repo on their own.

### 5.1 Skill packaging — the standard, unmodified; receipts by pointer

Verified against the [Agent Skills specification](https://agentskills.io/specification) and the
[skills CLI](https://github.com/vercel-labs/skills) on 2026-07-30.

The spec permits exactly six frontmatter keys — `name` and `description` (required), plus
`license`, `compatibility`, `metadata`, `allowed-tools`. Unknown top-level keys fail validation.
`metadata` is the sanctioned extension point and is a **flat map of string keys to string
values** (no nested objects). The CLI requires no manifest file; it scans conventional paths for
`SKILL.md` and has no version concept of its own.

**The receipt does not go in the frontmatter or the body.** `name` and `description` load into
the agent's context at startup for *every installed skill in every session* (~100 tokens each),
and `description` is the string the model matches a request against to decide whether to
trigger. Benchmark claims there would tax every user on every session and dilute the matching
surface, degrading trigger accuracy. The body loads whole on trigger, so receipt prose there is
pure runtime cost that does not help the agent do the task.

Frontmatter therefore carries **pointers**, and the receipt lives in the repo:

```yaml
---
name: <skill-name>
description: <pure trigger text — what it does and when to use it, nothing else>
license: <upstream license>
metadata:
  jinn.receipt: https://github.com/Jinn-Network/skills/blob/main/receipts/<name>.md
  jinn.receipt-sha256: "<hash of the receipt file>"
  jinn.measured-on: "<date>"
  jinn.forked-from: "<owner/repo@commit>"
  version: "<n>"
---
```

Keys are namespaced per the spec's collision guidance. This makes the claim machine-readable
without inventing a registry or breaking any client. Human-facing display stays in the README
(what registry pages surface) and `receipts/`.

Two consequences, both binding:

1. **The `description` is an optimization target, not ad space.** "Never triggered" is one of the
   three failure modes the improvement loop reads out of transcripts (§4), and its fix *is*
   editing the description. Keeping it clean protects the lever. When a fork changes the
   description, the receipt must record that as part of what was measured.
2. **The standard has no verification, and no artifact may imply otherwise.** Anyone can write a
   `metadata` key asserting a benchmark; a frontmatter field is an assertion, not evidence. All
   credibility rests on the receipt being re-runnable — pinned slate, raw per-task results, and
   the rig in the same repo. Copy must present the field as a pointer, never as proof. Closing
   that gap with independently anchored evidence is post-MVP (§7, v1.0 territory).

## 6. Growth — the discovery trust barrier

**The constraint** (raised by Oak, 2026-07-30): the registry is permissionless, but the *finding
tools* are not neutral. Vercel's `find-skills` instructs the agent to filter candidates by

- **install count** — prefer >1,000; treat <100 cautiously;
- **publisher reputation** — prefer Vercel, Anthropic, Microsoft;
- **repository stars** — treat <~100 skeptically.

A new publisher fails all three on day one. Autonomous discovery does not bootstrap us; it
rewards incumbency.

**The reframe that makes it tractable:** those criteria are *prompt text in an open-source
SKILL.md*, interpreted by the user's own agent, which then presents options for a human to
approve. They are not enforced code and there is no gate to pass — it is a persuasion surface,
and the reader is an LLM that can weigh evidence against a prior. Four layers follow, cheapest
first.

**L1 — Human-first bootstrap, with the thresholds as explicit targets.** The criteria name their
own numbers, and they are one-good-launch numbers. Wave 1's incumbent table is the asset that
clears them: a measurement nobody has published, about tools with hundreds of thousands of
installs. Graduation condition, written into the plan: *announcement → ≥100 stars and ≥1,000
installs → we exit the "treat skeptically" band and become recommendable under their own
heuristics.* The human audience is the mechanism that unlocks the agent channel, not a
consolation.

**L2 — Upstream the criterion itself.** Open a PR to `vercel-labs/skills` proposing a fourth
quality criterion: *reproducible evidence of effect — does the skill link a benchmark receipt
(pinned task list, raw per-task results, rerun script)?* Docs-sized change, good for the
ecosystem independent of us (their own guidance already worries about skill quality and
security), and aligned with Vercel's interest in the registry not becoming a lemon market. If it
lands, every agent running `find-skills` starts asking for receipts, and we are the only
publisher holding them. If it is declined, the PR is still visible positioning. This is the
honest form of "inject ourselves into the metadata": improve the finder rather than game it.

**L3 — Write the frontmatter and README for the inspecting agent.** `find-skills` tells the agent
to open the repository and present details before recommending. That agent sees `jinn.receipt`,
`jinn.receipt-sha256`, `jinn.forked-from` (§5.1) and a README whose first line is the measured
claim. A low install count is a *caution* in their heuristics, not a veto — and "zero installs,
but carries a reproducible benchmark against the 556k-install skill it forked" is exactly the
evidence that lets a reasoning agent justify overriding an install-count prior to its human.

**L4 — Distribution through upstream's trust.** The upstream PR of a winning diff (§4) doubles as
the growth channel: if the original author merges, the improvement reaches their install base and
the trust barrier becomes the distribution path. The receipt is what makes that merge case
arguable, and the PR is visible to the repo's watchers either way. Our fork ships regardless;
acceptance is upside, never a dependency.

**Deferred (post-MVP): our own evidence-ranked finder.** A finder that ranks by receipt rather
than install count is the natural endgame of the receipts business, and wave 1 makes it useful on
day one because it can rank skills we measured but do not own. It has the same cold-start problem
one level up — someone must install the finder — so it follows L1, never precedes it.

**Ruled out: gaming the trust metrics.** No install farming, no star exchanges, no sockpuppet
publishers. It is the exact behavior the product exists to displace, the telemetry belongs to
Vercel, and for a company whose only asset is trustworthy measurement, being caught is terminal.

## 7. Explicitly cut (v1.0 territory, unchanged destination)

No marketplace, no on-chain anchoring, no corpus reads/writes, no Hub, no powered
promotion-grade statistics, no multi-profile portability claims, no non-coding niches, no
continuous re-benchmarking, no skill pricing, no security-audit program. The MVP changes the
*order* (demand surface first), not the destination; the v1.0 design remains the scaling
reference.

## 8. Risks

1. **All-null wave 1** — still the launch content, arguably the best version of it; wave 2
   retargets to "first skill with any measured effect."
2. **Optimization finds nothing** — publish the negative honestly (the pilot null says this is
   live); the receipts business survives, the fork business waits.
3. **Small-N variance** — N≈30 gives coarse CIs; receipts show them and never overclaim. If all
   wave-1 deltas sit inside noise, we say so.
4. **Optics of forking big names** — attribution, upstream PRs, neutral tone; the receipt is the
   defense.
5. **Benchmark–niche mismatch** — `react-best-practices` / `frontend-design` may be unmeasurable
   on a Python-heavy SWE slate; screening decides, and "not measurable on this slate" is stated
   rather than faked.
6. **Compute/disk** — big-disk host, disk-floor guard, per-wave budget caps.
7. **Discovery cold start** — the finder's own heuristics filter out new publishers (§6). The
   MVP's demand path is therefore human-first by design; if the L1 thresholds are not cleared
   after launch, agent-channel discovery stays closed and the receipts must carry the product on
   human distribution alone.

## 9. Registry landscape sources (2026-07-30)

- skills.sh — leaderboard, install telemetry, `find-skills`: https://www.skills.sh/docs,
  https://github.com/vercel-labs/skills
- Vercel KB — Agent Skills creation/installation:
  https://vercel.com/kb/guide/agent-skills-creating-installing-and-sharing-reusable-agent-context
- Agent Skills specification (frontmatter keys, `metadata` shape, progressive disclosure):
  https://agentskills.io/specification; Anthropic overview:
  https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- Secondary indexes: https://skillsmp.com/, https://claude-plugins.dev/skills,
  https://mcpservers.org/agent-skills, https://claudemarketplaces.com/
- Adjacent academic activity (niche being circled, unoccupied): arXiv 2605.11418 (skill-registry
  supply-chain attacks), arXiv 2606.07412 (trace-derived agent skills).
