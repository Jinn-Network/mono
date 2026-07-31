# Skills Factory MVP — Measured Skills on Public Registries

- **Version:** 0.2
- **Date:** 2026-07-31
- **Author:** Ritsu (design session, Claude Fable 5)
- **Shape:** `design` — output is this document; implementation planned separately
- **Status:** v0.2 amendment approved in session (Ritsu + Oak, 2026-07-31); pending written review
- **Revision note (v0.2, 2026-07-31):** **author-first distribution; Jinn is neutral evaluation
  infrastructure, not a skill publisher.** Two findings invalidate wave 1 as designed. First, the
  benchmark wave 1 planned to run largely already exists, at a scale we could not match: **SWE-Skills-Bench**
  (arXiv 2603.15401) measured 49 public SWE skills over ~565 paired task instances (with/without) and
  found 39/49 (80%) show zero pass-rate improvement, average +1.2%, 7 skills gain meaningfully (up to
  +30%), 3 degrade (up to -10%), and token overhead ranges -78% to +451% uncorrelated with
  correctness — cited from the paper text; the paper's own public artifact link 404s as of
  2026-07-31, so its data is not independently re-derivable, only cited. **SkillsBench** (arXiv
  2602.12670, June 2026) supplies the contrast that makes this pivot worth doing rather than
  abandoning: 87 tasks across 8 domains and 18 model-harness configs, where curated, domain-matched
  skills lift pass rate 33.9% to 50.5% (+16.6pp), focused skills (≤3 modules) beat large bundles, and
  smaller models with skills match larger models without. Generic registry skills mostly do not
  help; curated, domain-matched skills do — that contrast, not a replica of either paper, is the
  finding this document is now built to exploit. v0.1's five-skill generic wave 1 would have been a
  smaller, weaker version of SWE-Skills-Bench's null, and three of its five targets
  (`vercel-react-best-practices`, `frontend-design`, `improve-codebase-architecture`) sit in a
  frontend/React domain our Python-heavy SWE task-authoring cannot measure — the exact mismatch v0.1
  §8 risk 5 named as hypothetical, now confirmed rather than avoided.

  Second, a strategy pivot (Ritsu + Oak, 2026-07-31): distribute through **skill authors**, who
  already control the discovery pages their skills live on, rather than through a Jinn-owned fork
  repository competing for registry attention. Jinn positions as **neutral evaluation
  infrastructure** — evaluation (a public, verifiable capability report) is strictly separated from
  optimization (a private diagnosis and suggested edits, delivered to the author only). The funnel:
  **free evaluation → private report + fix annex to the author → author revises → re-evaluation on
  fresh tasks → an earned badge the author embeds in their own README.** This replaces the
  wave-1/wave-2 (benchmark-then-fork) shape everywhere in this document — §1 restates the product as
  the capability report, not the skill; §2 is new (measurement method); §3/§4 (v0.1) are replaced by
  the per-skill pilot flow (§3, this version); §4 (this version) replaces the fork-repo publishing
  surface with a reports registry; §5 (growth) is rewritten around the author funnel; §7 (risks) is
  updated; §8 (this version) records an explicitly deferred consent/publication policy question.
  Sections are renumbered below to match; every internal cross-reference in this document points at
  v0.2 numbering unless prefixed `v0.1 §…`.

  **Model profile.** All pilot measurement pins **Claude Haiku 4.5**, not Sonnet, as the sole solve
  model, for four reasons: (a) SkillsBench found skills lift smaller models most; (b) a lower
  baseline gives more headroom, which means more discordant pairs per task and more statistical
  power at fixed N; (c) it matches what skills are economically for — cheap models doing more with
  guidance, not expensive models doing marginally better; (d) cost. Receipts stay scoped to this
  pinned profile; re-evaluating a winning skill on Sonnet is a later tier, not part of the pilot.
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
  skills; the corpus grows. (v0.2 note: the fork-and-improve half of this chain is superseded by the
  revision note above; the registry-discovery half survives into §5.)

---

## 1. Product definition

### 1.1 What the product is

**The capability report is the product.** Not the skill — the skill stays the author's, unforked,
unmodified, living wherever it already lives (their repo, their registry listing). What Jinn
produces and stands behind is the report:

- **Public evaluation** — a per-skill capability report: the domain-matched task set used (§2.2),
  the trigger rate (did the skill actually load on these tasks, §2.5), paired resolve-rate deltas
  against a no-skill baseline with their confidence intervals, cost/token overhead, a per-task
  outcome table, the raw run data, and a rerun script. Anyone can reproduce it or dispute the task
  selection.
- **Private annex** — delivered to the author only, never published: failing-transcript diagnosis
  (did the skill never trigger, trigger but give guidance too vague to act on, or trigger and
  actively mislead the agent) and suggested edits. This is the optimization half of the work, and it
  stays private deliberately — the report proves the number, the annex is how the author moves it.
- **The badge/embed is the distribution artifact**, not a side effect. It repoints the existing
  `jinn.*` frontmatter metadata block (§4.1) at the public report instead of at a fork receipt: the
  same six-key-limited mechanism, the same non-normative-pointer discipline, a different referent. An
  author who embeds it is putting Jinn's evaluation in front of their own install base — that is the
  whole distribution model.
- **Demand signals**: author embed rate (did they put the badge in their README) and re-evaluation
  requests (did they come back after revising) are what tell us the funnel is working — not registry
  rank, not install count of anything Jinn owns, because Jinn owns no skill.

**Jinn is not a skill publisher and does not fork.** v0.1's wave 2 fork-and-improve loop, its
fork-candidate selection, and every place this document previously described publishing an
installable skill under a Jinn-owned repo describe the dropped model; §3 replaces them with the
per-skill pilot flow, and §4 replaces the fork-repo publishing surface with a reports registry.

One sentence: **Jinn measures the skills authors already publish and hands each author a private
path to a better number; the public report is the receipt, the badge is how it travels.**

### 1.2 What the pilot ships

For each pilot-cohort skill (§1.4): one public capability report and one private annex, delivered
through the full flow in §3. No fork, no installable skill of Jinn's own — measurement and
diagnosis only, plus the offer of one re-evaluation cycle if the author revises.

### 1.3 Where the report meets the ecosystem

The skill itself already lives on a public registry — primarily **skills.sh** (Vercel, launched
2026-01-20), the npm-style Agent Skills registry: permissionless GitHub-repo publishing, public
install telemetry (all-time, trending 24h, 8-week activity), cross-agent installs (Claude Code,
Cursor, Windsurf, Copilot, Codex, Goose), and an agent-mediated discovery skill (`find-skills`, 2.7M
installs) that instructs an inspecting agent to filter candidates by install count, publisher
reputation, and star count before presenting options for a human to approve. Secondary indexes
(SkillsMP, claude-plugins.dev, mcpservers.org, claudemarketplaces.com) mirror it automatically.
Quality signals there are otherwise thin (an "official" badge, a security-audit filter); nobody
measures effect.

**Jinn publishes nothing on any of these.** We have no listing, no install count, no leaderboard
entry to accumulate — the report lives in our own repo (§4) and the badge lives in the author's own
frontmatter and README, wherever those already are. §5 covers how this reframes the discovery-trust
problem v0.1 had to climb as a new publisher: under this model we do not climb it, because we never
appear as a competing listing in the first place.

### 1.4 Pilot cohort

`tdd` and `grill-me` (mattpocock, MIT-licensed, already pinned at their upstream commit shas per the
runbook) anchor the pilot: both are real, leaderboard-ranked coding-workflow skills (556k and 705k
installs respectively as of 2026-07-30), both fall inside the domain our task-authoring machinery
can measure (real repo, real bug, real test suite), and both are exactly the kind of well-written
opinion document SWE-Skills-Bench found mostly does nothing — the maximum-contrast case for what a
domain-matched, per-skill measurement can add.

A third pilot target is chosen at execution time from **SWE-Skills-Bench's own harmful/null list**:
deliberately re-measuring a skill the coarse cross-skill study already scored as zero-effect or
actively harmful, on a narrower, better-matched task set, is the sharpest test of whether this
method finds something theirs missed. A null on a null still tells that skill's author something
usable (the annex can say "confirmed, not measured wrong"); a positive would be the pilot's headline
finding.

This replaces v0.1 §3's five-skill generic wave 1 (`tdd`, `grill-me`, `improve-codebase-architecture`,
`vercel-react-best-practices`, `frontend-design`). The three dropped targets are frontend/React-domain
skills our Python-heavy SWE task-authoring cannot yet measure without building a parallel domain;
running them anyway would repeat the domain-mismatch risk v0.1 §8 risk 5 named as hypothetical and
this pivot's revision note now treats as confirmed.

### 1.5 Jinn fit (pilot posture: off-protocol, on-positioning)

Nothing of Jinn's protocol sits on the pilot's critical path — no marketplace, no corpus
reads/writes, no anchoring. But unlike v0.1, where the Jinn tie was branding and provenance
narrative riding on top of a fork-publishing business, the positioning itself is now the product:
Jinn's claim to skill authors and their users is that it is the neutral third party measuring
effect, with nothing to sell them and no competing skill of its own. That posture only holds if it
stays true — no fork, no owned listing, no stake in which skill wins. Externally, this sits inside
the same frame as every other Jinn artifact per CLAUDE.md §External Communication: Jinn is an open
agentic knowledge economy, and a capability report is the smallest complete unit of that economy —
work (the paired runs) gets done, the evidence of it (the report and its data) stays open, and the
next attempt (a revision, a re-evaluation) starts from it. Post-pilot upgrades remain in the v1.0
design's territory: corpus evidence feeding the private annex (place to learn), a marketplace-scaled
version of the pilot flow (place to do work), independently anchored reports.

### 1.6 Success test

Pilot done-when: at least one pilot-cohort skill has a public capability report (gradeability-gated,
discrimination-screened, trigger rate reported) and a private annex delivered to its author; the
report is reproducible from the repo alone; the reports-registry badge/embed snippet renders and is
offered to the author. Whether the author embeds it, and whether they come back for
re-evaluation, is the post-pilot observation phase (§5) — the pilot's job is to produce one honest,
deliverable report end to end, not to prove the funnel converts on the first try.

---

## 2. Measurement method

### 2.1 The rig

One local benchmark harness, reused across every pilot skill and both task-set paths below. It
composes four shipped components (Block 1 of the v1.0 design, stripped of every protocol
dependency) — this table is machinery, unchanged by the pivot:

| Piece | Source (shipped) | Role |
|---|---|---|
| Slate/task-set screening | `client/src/eval/screen.ts` layering | admit gradeable instances |
| Arm-isolated runs | pilot rig arm isolation (harness-layer measurement stack) | per-attempt agent home; skill mounted per arm; no cross-arm residue |
| Grading | `swe-rebench-v2-evaluator/eval-runner.ts` (generic slate) / a per-skill verifier grade path (authored task sets) | Docker, resolved semantics, unscorable ≠ fail |
| Statistics | `client/src/eval/{paired,wilson}.ts`, `measurement.ts` | paired per-task outcomes, deltas, exact McNemar, Wilson intervals |

Two task-set paths feed the same rig:

- **Authored, per-skill task sets** — the default path for a pilot skill (§2.2), built to match the
  skill's actual domain rather than drawn from a generic pool.
- **The swe-rebench-v2 slate** — kept as the screening/holdout substrate for general coding-workflow
  skills (v0.1's original mechanism), unchanged as machinery, no longer the sole or default
  measurement surface.

### 2.2 Domain-matched task sets

Each authored task set follows **SWE-Skills-Bench's own construction shape**, because it is the one
part of that paper worth reusing even though its aggregate conclusion is what this pivot is testing:
a pinned repository and commit, a containerized environment, a four-part requirement document
(background, requirement, file-operations, acceptance criteria) that never names the skill under
test — an agent that reads "use test-driven development" in its task prompt is not measuring whether
`tdd` helps, it is measuring whether an instruction helps — and a deterministic verifier, validated
in both directions before it ever grades a real attempt (§2.3).

### 2.3 Zero-inference gradeability gate

Before any solve spend, every authored task's verifier runs twice against known inputs, at zero
inference cost: a reference patch (a known-good fix) must pass, and an empty patch must fail — and
fail as a graded failure, never as an error. This is the live-smoke lesson, generalized: a run burned
two paid solves against a zarr instance before `conftest_import_error` revealed the task could never
grade, full stop, regardless of what any skill did. A task set is not eligible for a paired run until
every task in it carries a passing both-directions gradeability receipt (status, timings, grade-log
digest); the run tooling refuses task sets without one, the same fail-loud posture as the existing
manifest guard. This gate is mandatory for every authored task and, separately, swept across the
generic slate too (empty-patch-only, zero inference) before slate freeze — the same lesson applied to
the substrate that predates it.

### 2.4 Discrimination gate

A task every configuration solves, or none solves, measures nothing — SWE-Skills-Bench's own
~565-instance pool includes this kind of task, unscreened, which is one reason 39 of 49 skills show
zero effect: some of that null is a real null, and some of it is an unpowered task mix. This design
adds a step the paper skipped: a baseline-only sweep (no skill, Haiku, one or more repeats) over
roughly twenty candidate tasks per skill, keeping the dozen or so the baseline fails outright or
passes only marginally — the tasks with headroom for a skill to change the outcome. The screening
receipts (per-task baseline outcomes) are written into the task-set file alongside the gradeability
receipts (§2.3), so the gate is auditable, not asserted. (The concept mirrors the baseline/differential
audit already used for environment screening in
`client/src/task-creator/environment/jinn-differential-policy.ts` §2.1 — the same idea, applied here
to skill headroom rather than environment validity.)

This is what makes this pivot's nulls interpretable where the source papers' aggregate null is not:
a null on a screened, headroom-proven task set is evidence the skill did not help; a null on an
unscreened pool could just mean the pool could not have shown help either way.

### 2.5 Trigger rate as a first-class receipt field

Every attempt's session transcript is parsed for skill-load evidence: an `assistant` event whose
`message.content` contains a `tool_use` block with `name: "Skill"` and `input.skill` matching the
mounted skill's name (case-insensitively), downgraded to not-triggered only if every paired
`tool_result` (matched by `tool_use_id`) comes back an error. The `skill_listing` attachment that
opens every session is deliberately **not** treated as a signal — it reflects the skill's
availability (mounted and discoverable), not its use, and it is present identically in both the
baseline and treatment arms wherever a skill happens to be listed there, so substring-matching it
would mark every treatment-arm attempt "triggered" regardless of whether the model ever invoked the
skill. This produces a per-attempt `triggered: true/false` and a per-arm trigger rate. This closes
the largest interpretation gap in a paired null: without it, "the skill made no difference" and "the
skill never loaded on these tasks" render identically. With it, a report distinguishes them
explicitly — a null result with low trigger rate is stated as *not exercised on this task set*, never
as *no effect* — and the private annex to the author starts from whichever one actually happened (a
discoverability fix for the former, a content fix for the latter).

### 2.6 Model profile

Every pilot measurement pins **Claude Haiku 4.5** as the sole solve model — see the v0.2 revision
note (header) for the full rationale (SkillsBench's smaller-model-lifts-most finding, headroom-driven
statistical power, cost, and the match to what skills are economically for). Receipts stay scoped to
this profile; a later tier may re-run a winning skill's task set against Sonnet, but that is not part
of the pilot.

### 2.7 Statistics posture

Feedback-tier honesty, not promotion-grade power. Reports state N, resolve rates, paired delta, an
exact McNemar-derived confidence interval, and the caveat in plain words — no claim of significance
the interval does not support. At roughly a dozen tasks per skill after the discrimination gate,
intervals are wide; the report says so.

---

## 3. Pilot flow (per skill)

### 3.1 The flow

1. Author a task set for the skill (repo, commit, four-part requirement doc, verifiers) —
   human-plus-agent work, roughly twenty candidates per skill.
2. Validate every verifier both directions (§2.3) — zero inference; refuse any task without a
   passing receipt.
3. Screen with the discrimination gate (§2.4) — down to roughly a dozen tasks with proven headroom.
4. Run the paired comparison on Haiku (§2.6): baseline (no skill) vs. with-skill, one arm each,
   across the screened task set.
5. Render the public capability report: task set, trigger rate, paired deltas with intervals, cost
   overhead, per-task table, raw data, rerun script (§4).
6. Write the private annex from the failing transcripts: never-triggered / vague-guidance /
   actively-harmful diagnosis, plus suggested edits — delivered to the author only, never published.
7. Offer re-evaluation: if the author revises the skill, measure the revision on a fresh,
   previously-unseen task set (or a held-back portion of the original ~20 candidates) — never on the
   tasks the diagnosis was derived from. This is the same information-boundary discipline v0.1's
   holdout ledger already enforced for forks, now keyed to `skill@sha` lineage instead of a
   candidate id: diagnosis tasks are burned for that lineage, fresh or held-back tasks serve the
   re-evaluation.
8. A revision that measurably improves earns the badge (§4); a revision that does not is reported
   honestly, and the offer to re-run again stands.

### 3.2 Pilot cohort

See §1.4.

### 3.3 Cost basis

Budget roughly $10–25 of Haiku inference per skill for the full paired run (baseline plus skill arm,
about a dozen screened tasks) — small enough to run several pilot-cohort skills without a wave-scale
budget line, and to re-run a revision without renegotiating cost. Docker/grading time, not
inference, is the pilot's actual bottleneck: §2.3's gates are zero-inference precisely so that cost
falls on compute time before any real spend happens, not on paid solves that later turn out to have
graded nothing.

### 3.4 Why generic wave 1 is dropped

v0.1's wave 1 — baseline plus five generic leaderboard skills across one shared ~30-task slate — is
dropped, not deferred, for the two reasons in the v0.2 revision note (header): the measurement
already exists at larger scale (SWE-Skills-Bench, 49 skills, ~565 instances, 80% null), and three of
the five original targets (`frontend-design`, `vercel-react-best-practices`,
`improve-codebase-architecture`) sit in a domain our Python-heavy SWE task-authoring cannot measure —
the exact mismatch v0.1 §8 risk 5 flagged as hypothetical and this pivot treats as decided. The
per-skill pilot flow above (§3.1) replaces it entirely; nothing in this document should be read as
wave 1 still pending.

---

## 4. Publishing surface

One public GitHub repo, working name `Jinn-Network/skills-eval` (renamed from v0.1's
`Jinn-Network/skills` — the old name implied a skill catalog; there is no catalog, only reports):

```
reports/<skill>@<sha>/report.md     public capability report: task set, trigger rate, deltas, CI, per-task table
reports/<skill>@<sha>/data/         pinned task set (or slate subset), run manifest, raw per-task results, transcripts
rig/                                the orchestration script — open, so reports are reproducible, not claimed
README.md                          reports index (skill, sha, date, headline delta) — generated, never hand-written
```

A new measured sha for a skill gets a new report directory; nothing is overwritten, so a report and
the skill version it measured stay permanently paired, and a stale badge (§4.1) is detectable by
comparing `jinn.receipt-sha256` against the current report's hash.

**No `skills/` directory, no forked skill code, ever.** The report is the only artifact Jinn
publishes.

### 4.1 Packaging — repointing the existing jinn.* metadata at the report

The Agent Skills frontmatter mechanism is unchanged from v0.1 §5.1: the spec permits exactly six
frontmatter keys (`name`, `description` required; `license`, `compatibility`, `metadata`,
`allowed-tools`), `metadata` is a flat map of string keys to string values, `name`/`description` load
into the agent's context every session, and `description` is the string the model matches a request
against. What changes is the referent: the `jinn.*` block built by `buildJinnReceiptMetadata`
(`client/src/skills-bench/frontmatter.ts`) now points at a public **report**, not a fork receipt:

```yaml
---
name: <skill-name>
description: <pure trigger text — what it does and when to use it, nothing else>
license: <upstream license>
metadata:
  jinn.receipt: https://github.com/Jinn-Network/skills-eval/blob/main/reports/<skill>@<sha>/report.md
  jinn.receipt-sha256: "<hash of the report file>"
  jinn.measured-on: "<date>"
  version: "<n>"
---
```

`jinn.forked-from` is dropped from the block — there is no fork, so there is nothing to attribute a
fork to. The author adds this block to their own skill's frontmatter and pastes an embed snippet
(generated alongside the report) into their own README; both are their edit to their own repo, not
Jinn's. The two binding consequences from v0.1 §5.1 still hold, unchanged:

1. **The `description` is an optimization target, not ad space.** "Never triggered" is one of the
   three failure modes the annex reads out of transcripts (§3.1 step 6), and its fix *is* editing the
   description. When a revision changes the description, the re-evaluation report must record that
   as part of what was measured.
2. **The standard has no verification, and no artifact may imply otherwise.** A `jinn.*` key is an
   assertion until the reader re-runs the rig — which is why the report and its data live in the open
   repo above, not just a claim in the metadata.

---

## 5. Growth — the author funnel

v0.1 §6 treated the registry's discovery heuristics (install count, publisher reputation, star count
— all live prompt text in Vercel's `find-skills` skill) as a trust barrier a new Jinn-owned listing
would have to climb, and built a four-layer plan (L1–L4) to climb it. Under the author-first model
that barrier mostly stops applying to Jinn, because Jinn never appears as a competing listing: the
badge lives inside the *author's own* skill entry, which already has whatever install count and
reputation it has. This rides the author's distribution instead of building a new one.

**The embed is the growth loop.** An author who embeds the badge in their README is putting a
third-party, reproducible number in front of every user who was already going to look at that skill.
This does not require any install-count threshold of Jinn's own to clear — the moment one author
embeds one badge, that badge reaches that author's full existing audience, day one. Growth compounds
by author count, not by Jinn's own registry rank.

**The `find-skills` trust barrier dissolves rather than being climbed.** `find-skills` instructs an
inspecting agent to weigh install count, publisher reputation, and stars, then present findings for
human approval — heuristics interpreted by an LLM against a human's judgment, not enforced code. A
badge embedded in an already-popular skill's own README does not need to overcome an install-count
prior; it *is* additional evidence attached to a listing that already clears every one of those
thresholds. v0.1's problem — a brand-new Jinn-owned fork failing all three heuristics on day one —
does not arise, because there is no Jinn-owned listing to fail them.

**The upstream evidence-criterion PR remains worthwhile, now secondary.** Opening a PR to
`vercel-labs/skills` proposing a fourth registry quality criterion — reproducible evidence of effect
(a linked report: pinned task list, raw per-task results, rerun script) — is still good for the
ecosystem independent of Jinn, and if it lands, every `find-skills` invocation starts asking for
exactly the artifact this pilot produces. It is no longer the load-bearing growth mechanism it was in
v0.1's L2 (there, it was one of only two viable channels for a listing with nothing else going for
it); here, individual author embeds already carry the funnel, and the PR is upside on top.

**Re-evaluation requests are the second demand signal.** An author who comes back after revising
their skill, asking to be re-measured, is a stronger signal than an install count Jinn does not own:
it means the private annex was actionable and the author found the first report worth acting on
rather than ignoring. Both signals — embed rate and re-eval requests — are read together; the
pilot's job (§1.6) is to produce at least one clean report end to end so both signals become
observable at all.

**Deferred, post-pilot: an evidence-ranked finder.** A finder that ranks by report rather than
install count remains the natural endgame (v0.1 §6's deferred item, unchanged) — useful on day one
because it can rank skills Jinn measured but does not own, and it carries the same cold-start problem
the author funnel now solves at the individual-skill level, so it still follows this funnel rather
than preceding it.

**Ruled out, unchanged from v0.1:** no install farming, no star exchanges, no sockpuppet
publishers — the exact behavior the product exists to displace, and for something whose only asset
is trustworthy measurement, being caught gaming it is terminal.

---

## 6. Explicitly cut (v1.0 territory, unchanged destination; v0.2 additions below the rule)

No marketplace, no on-chain anchoring, no corpus reads/writes, no Hub, no powered promotion-grade
statistics, no multi-profile portability claims, no non-coding niches beyond the pilot cohort, no
continuous re-benchmarking, no skill pricing, no security-audit program. The v0.2 pivot changes the
*distribution model* (author-first, not fork-first), not this destination; the v1.0 design remains
the scaling reference.

**New for v0.2:**

- **No Jinn-owned skill fork, ever.** The fork wedge v0.1 §4 (wave 2) and §5 (publishing surface)
  described (optimize, then publish an installable skill under a Jinn-owned repo) is dropped
  entirely, not deferred.
- **No LLM-assisted annex authoring in the pilot.** The private annex is manual-first: a template
  plus a transcript-filter script listing failing-attempt session files for a human to read and
  diagnose, no automated diagnosis tooling.
- **No default publish-without-consent.** See §8's open policy question — not resolved by this
  amendment.

---

## 7. Risks

1. **Null-vs-not-applicable is resolved, not just named.** v0.1 risk 1 ("all-null wave 1... still
   the launch content") assumed we would have to argue a null was useful without a way to tell it
   apart from an unexercised skill. §2.5's trigger rate and §2.4's discrimination gate close that gap
   structurally: a report states "not exercised" when trigger rate is low, and only reports "no
   effect" against tasks proven to have headroom. This does not guarantee a positive result — most
   pilot skills may still come back null — but every null the pilot produces is now interpretable,
   not just publishable.
2. **80% of skills show zero effect in the published base rate, and the pilot inherits that prior.**
   SWE-Skills-Bench measured 39/49 skills (80%) as zero pass-rate improvement; there is no reason to
   expect the pilot cohort beats that rate by construction. Most first reports will likely be
   negative for the author. This is not a failure of the pilot — it is the funnel (§1.1, §5): a
   negative report is exactly the input the private annex and the revise/re-evaluate loop are built
   to act on, and a pipeline that could only produce good news would not be measuring anything
   (carried forward from v0.1 risk 2's framing).
3. **Author non-response.** Nothing compels an author to read the annex, revise the skill, or embed
   the badge — the report is a permissionless artifact handed to someone with no obligation to act
   on it. Mitigation: reports remain useful on their own regardless of author action (the public half
   is independently reproducible and citable even unembedded); whether to publish findings the author
   never acts on is part of the open policy question (§8), not resolved here.
4. **Verifier quality is the silent killer.** A weak or wrong verifier can pass a task that does not
   actually test the claimed behavior, or fail one that does — and unlike a solve-path bug, a bad
   verifier produces a plausible-looking, wrong number rather than a loud error. Mitigation: §2.3's
   both-direction gradeability gate (reference patch must pass, empty patch must fail, as a graded
   failure, never an error) is mandatory before any task enters a paired run — the direct answer to
   the zarr smoke lesson, the one documented case where this exact failure mode cost paid solves
   before being caught.
5. **Small-N variance.** Roughly a dozen tasks per skill after the discrimination gate gives coarse
   confidence intervals; reports show them and never overclaim (carried forward from v0.1 risk 3).
6. **Compute/disk.** Big-disk host, disk-floor guard, per-skill budget caps (carried forward from
   v0.1 risk 6; cost basis restated at §3.3's ~$10–25/skill).
7. **A revision finds nothing.** A revision that does not beat the original on the re-evaluation task
   set is reported honestly, the same posture as v0.1 risk 2 — the difference is that now it is the
   author's own revision being measured, not a Jinn-run optimization loop, so the annex's job is to
   make a null revision informative to them too (which of the three failure modes recurred).

Dropped from v0.1's risk list because they no longer apply under the author-first model: "optics of
forking big names" (there is no fork), "benchmark–niche mismatch" (confirmed rather than
hypothetical, and folded into §3.4's reasoning for dropping generic wave 1), "discovery cold start"
(§5 — the author-first model does not depend on a Jinn-owned listing clearing registry heuristics).

---

## 8. Open policy question (deferred to Ritsu/Oak)

Consent and publication policy for capability reports is **not resolved by this amendment**. Two
shapes were discussed and neither is adopted:

- **Publish-without-consent** — measure and publish a public report for any skill on a public
  registry, whether or not the author asked for it or responds, since the skill itself is already
  public and the task set, repo pin, and verifiers are Jinn's own construction.
- **Private-first window** — an SSL-Labs-style model: deliver the report privately first, hold it for
  a fixed window (giving the author time to revise before anything is public), and publish only after
  the window closes or the author opts in early.

The recommendation on the table is **private-first**, on the reasoning that it matches the annex's
own manual-first, non-adversarial posture and gives the funnel (§1.1) its best chance of landing as
help rather than an ambush — but this is a recommendation, not a decision. The decision is explicitly
deferred to Ritsu and Oak, and nothing in §1–§7 should be read as resolving it; §6 records "no
default publish-without-consent" as the placeholder position until this is decided.

---

## 9. Registry landscape and measurement sources

**Core measurement citations (v0.2):**

- SWE-Skills-Bench, arXiv 2603.15401 — 49 public SWE skills, ~565 paired task instances, with/without
  paired; 39/49 (80%) zero pass-rate improvement, average +1.2%, 7 skills meaningful gains (up to
  +30%), 3 degrade (up to -10%), token overhead -78% to +451% uncorrelated with correctness. The
  paper's own public artifact link 404s as of 2026-07-31; cited from the paper text, artifact
  unavailable.
- SkillsBench, arXiv 2602.12670 (June 2026) — 87 tasks, 8 domains, 18 model-harness configs; curated,
  domain-matched skills lift pass rate 33.9% to 50.5% (+16.6pp); focused skills (≤3 modules) beat
  large bundles; smaller models with skills match larger models without.

These two are why v0.2 exists: the contrast between them (generic registry skills mostly null vs.
curated domain-matched skills helping) is the finding the pilot is built to exploit, not replicate.

**Registry landscape (2026-07-30, unchanged from v0.1):**

- skills.sh — leaderboard, install telemetry, `find-skills`: https://www.skills.sh/docs,
  https://github.com/vercel-labs/skills
- Vercel KB — Agent Skills creation/installation:
  https://vercel.com/kb/guide/agent-skills-creating-installing-and-sharing-reusable-agent-context
- Agent Skills specification (frontmatter keys, `metadata` shape, progressive disclosure):
  https://agentskills.io/specification; Anthropic overview:
  https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- Secondary indexes: https://skillsmp.com/, https://claude-plugins.dev/skills,
  https://mcpservers.org/agent-skills, https://claudemarketplaces.com/
- Adjacent academic activity (a different niche — skill trust/provenance, not effect measurement):
  arXiv 2605.11418 (skill-registry supply-chain attacks), arXiv 2606.07412 (trace-derived agent
  skills).
