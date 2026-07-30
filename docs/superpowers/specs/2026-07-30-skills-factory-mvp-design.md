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
- **Autonomous discovery exists**: Vercel's `find-skills` skill (2.7M installs) lets agents
  search the registry and install mid-task — exactly the permissionless agent-facing surface the
  origin thread hypothesized.
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

## 6. Explicitly cut (v1.0 territory, unchanged destination)

No marketplace, no on-chain anchoring, no corpus reads/writes, no Hub, no powered
promotion-grade statistics, no multi-profile portability claims, no non-coding niches, no
continuous re-benchmarking, no skill pricing, no security-audit program. The MVP changes the
*order* (demand surface first), not the destination; the v1.0 design remains the scaling
reference.

## 7. Risks

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

## 8. Registry landscape sources (2026-07-30)

- skills.sh — leaderboard, install telemetry, `find-skills`: https://www.skills.sh/docs,
  https://github.com/vercel-labs/skills
- Vercel KB — Agent Skills creation/installation:
  https://vercel.com/kb/guide/agent-skills-creating-installing-and-sharing-reusable-agent-context
- Secondary indexes: https://skillsmp.com/, https://claude-plugins.dev/skills,
  https://mcpservers.org/agent-skills, https://claudemarketplaces.com/
- Adjacent academic activity (niche being circled, unoccupied): arXiv 2605.11418 (skill-registry
  supply-chain attacks), arXiv 2606.07412 (trace-derived agent skills).
