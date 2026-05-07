---
name: growth-refine
description: Use to close the growth daily loop's Refine function — analyse accumulated evidence (sprint postmortems, cluster snapshots, calibration logs, warm-contacts state, twitter-strategy outputs) and propose diff-shaped amendments to GROWTH.md, skill files, or the loop itself when canon drifts from observed reality. Triggers on "refine growth", "growth refine", "propose growth amendments", "what should we change about GROWTH.md", "review growth strategy", "growth retro", "is GROWTH.md stale", "growth canon check", "should we update the bridge model", "should we change the target cluster". Composes downstream of `cluster-model`, `twitter-strategy`, and sprint postmortems; produces proposals only, never edits canonical files. Cadence — ad-hoc, suggested every sprint postmortem, surfaced as Tier B by `growth-day` when last refine >30 days.
---

# Growth refine

The Refine function from GROWTH §5. Analyses the accumulated evidence in the growth system and proposes amendments to the canonical doc, the skills, or the loop itself when reality has drifted from canon. It produces *proposals*. It does not edit canonical files.

## Read first

- [`GROWTH.md`](../../../GROWTH.md) — the canon being checked for drift. Especially §3 (target recruit + bridge model), §4 (GTM sequence), §6 (will-not-chase), §7 (metrics), §8 (channel canon), §9 (sprint discipline).
- [`THESIS.md`](../../../THESIS.md) — the structural argument GROWTH derives from. A refine proposal that contradicts THESIS without reasoning needs to make the contradiction explicit.
- [`BRAND.md`](../../../BRAND.md) — voice canon. Refine proposals that touch pitch language are accountable to BRAND §1.
- [`growth/.local/growth-log.md`](../../../growth/.local/growth-log.md) — full operational state. §1 cluster history (Frame / Evidence / Gap), §3 active threads, §6 active sprint + daily progress, §7 postmortem archive.
- [`growth/.local/jinn-warm-contacts.csv`](../../../growth/.local/jinn-warm-contacts.csv) — funnel state per individual.
- [`.claude/skills/x-algorithm-grader/references/calibration-log.md`](../x-algorithm-grader/references/calibration-log.md) — post-results vs predicted reach. Drift here may imply §8 channel-canon drift.
- [`.claude/skills/discover-twitter-recruits/references/discovery-log.md`](../discover-twitter-recruits/references/discovery-log.md) — recruit-attempt outcomes. Drift here may imply §3 target-cluster drift.
- [`growth/.local/twitter-strategy-last-run.md`](../../../growth/.local/twitter-strategy-last-run.md) and any retained twitter-strategy outputs in chat history — account-level drift signal.

## What this skill does

One mode: **propose**. Reads the evidence, computes drift candidates, writes a structured proposal document inline in chat. Each candidate is a diff-shaped amendment with a rationale grounded in dated evidence.

The skill does not write to canonical files. The output is a proposal; Oak applies via PRs (with a spec proposal for canonical changes per [`spec/2026-04-28-canonical-docs.md`](../../../spec/2026-04-28-canonical-docs.md)).

## When to run

- **After a sprint postmortem.** The postmortem in `growth-log` §7 is the natural prompt: it names what worked and what didn't, and refine consumes that into amendment proposals.
- **Ad-hoc** when Oak suspects drift — bridge model feels stale, channel canon mis-calibrated, GTM phase trigger met or missed, will-not-chase rules aren't biting.
- **Surfaced as Tier B by `growth-day`** when last refine >30 days. The cadence is light by design; refine is forcing-function infrastructure, not a daily routine.

## Procedure

Apply in order. Stop early if no drift candidates surface — *no drift* is a valid output.

### Step 1 — Read state and date the run

Capture today's UTC date and read the files listed in *Read first*. Note the last refine run if recorded; this run's output supersedes it.

### Step 2 — Compute drift candidates per canon section

Walk each canonical section that this skill is allowed to propose against. For each, ask: *does today's evidence support, contradict, or extend this section?* Cite dated evidence for any candidate.

#### §3 Target recruit

Drift signals:
- **Bridge model staleness.** `growth-log` §1's Frame for the current target cluster has shifted (new dated `Sampled this run:` blocks add a frame the GROWTH §3 bridge does not name).
- **Pitch underperformance.** `x-algorithm-grader/calibration-log.md` shows Teach posts on the canonical pitch under-reaching their predicted distribution by >30% over a 30-day window.
- **Conversion shape mismatch.** `discover-twitter-recruits/discovery-log.md` outcomes show first-touch replies failing the canonical bridge sub-pattern (the methodology question shape) at >50% rate over the last 5+ attempts.

Proposal shape: rewrite of §3 bridge model's Frame they hold / Frame Jinn offers / The bridge fields with dated evidence justifying each change.

#### §4 GTM sequence

Drift signals:
- **Phase 1 transition trigger met.** Headline metric in §7 indicates ≥10 testnet operators or one visible benchmark engagement (whichever §4 names as the trigger). Propose: declare Phase 2 as next-up; rewrite §3 to name the new target cluster (with the §3 archival of current target into `growth-log` §1).
- **Phase 1 transition trigger stale.** §7 metrics have not moved in >60 days while Phase 1 is current. Propose: review whether the trigger is the right shape, or whether sprint inputs are mis-aligned with the trigger.
- **Phase 2 brand-risk gate at risk.** Evidence (e.g. fear-bait drift in twitter-strategy outputs) shows the gate would trigger if Phase 2 began today. Propose: tighten the gate or hold Phase 2 longer.

Proposal shape: edits to phase definitions or transition triggers, with dated evidence.

#### §5 The daily loop

Drift signals:
- **A function lacks skill coverage.** A new operational need has emerged (e.g. evaluator recruitment as a distinct funnel stage) that no existing skill handles.
- **A skill's behaviour has drifted from its named function.** E.g. `x-post-builder` is doing engagement work instead of teach work.

Proposal shape: skill-creation proposal, skill-rename, or function redefinition.

#### §6 What we will not chase

Drift signals:
- **Tactical deferral honoured for >60 days with the same conditions** — promote to permanent rule (§6.1).
- **Tactical deferral conditions changed** — un-defer (move out of §6.2 entirely).
- **A new pattern is being repeatedly avoided in practice without canonical recognition** — propose adding to §6.1.
- **A permanent rule is being violated by the team's own posts** — propose either tightening enforcement or relaxing the rule based on whether the violations represent learning or drift.

Proposal shape: list-edit with dated evidence per item.

#### §7 Metrics

Drift signals:
- **Headline metric ceiling hit** (operator gate met). Propose: §2 bottleneck is no longer the bottleneck; what is?
- **Supporting metric is no longer load-bearing.** Two consecutive 30-day windows with no movement that correlates with strategy decisions. Propose: replace or retire.
- **A new metric has become load-bearing in practice** but is not in §7. Propose: promote.

#### §8 Channel canon

Drift signals:
- **Calibration-log shows a direction-claim violated by sustained evidence.** E.g. constructive-tone overlay no longer detectable; cluster-fit dominance no longer dominating. Threshold: >30 days of evidence pointing the other way.
- **A new direction-claim is being relied on operationally** without canonical recognition. Promote.

Proposal shape: §8 line-edit with calibration-log citations.

#### §9 Sprint discipline

Drift signals:
- **Sprint postmortems repeatedly flag the same shape gap** — a missing field, an unparseable trigger, a decision-rule shape that does not actually decide. Propose: §9 field-edit.
- **Sprints are routinely declared without all required fields.** Propose: tighter §9 enforcement or a simpler shape that gets honoured.

#### Skill-internal calibration

Drift signals not at canon level — calibration-log entries that imply skill-side updates (cluster-vocabulary additions, bridge-shapes catalogue extensions, audience-profile defining-traits refinements).

Proposal shape: per-skill edit list, with file paths and line numbers where possible.

#### The loop itself

A meta-drift candidate: the loop's *structure* has gaps that no individual section captures. Examples: no mechanism for ratcheting Phase 1 → Phase 2 cleanly; no skill covering off-platform contact paths; sprint cadence too long / too short for the cluster's reply-decay window. These propose against §5 or against the skill set.

### Step 3 — Rank candidates by leverage

Order proposals by expected impact:
1. Canonical drift (§3, §4, §6, §7, §8, §9) — highest leverage, requires spec proposal.
2. Skill behavioural drift (§5 function coverage) — medium leverage, may require new skill or skill rewrite.
3. Skill-internal calibration — lowest leverage, fastest to apply.

Stop including candidates when their justification thins out. *No drift in §X* is a valid line in the proposal — it tells Oak which sections were checked and held.

### Step 4 — Write the proposal

Output structure (inline in chat):

```
GROWTH REFINE — proposal dated YYYY-MM-DD

EVIDENCE WINDOW
  [start_date] → [end_date]
  Read: GROWTH.md (rev <git-sha-or-marker>), growth-log §<sections>,
        warm-contacts CSV (last_modified), calibration-log, discovery-log,
        twitter-strategy outputs.

CANONICAL DRIFT CANDIDATES

  §<section>.<subsection>
    Current canon:
      <verbatim or short paraphrase>
    Proposed amendment:
      <diff-shaped: before → after, or net-new content>
    Rationale:
      <one paragraph; cite dated evidence>
    Spec-proposal needed: yes / no
    Suggested spec path: spec/YYYY-MM-DD-<topic>.md

  [repeat per candidate]

SKILL BEHAVIOURAL DRIFT

  <skill-path>
    Current behaviour: <what>
    Proposed change: <what>
    Rationale: <why, with evidence>

SKILL-INTERNAL CALIBRATION

  <file-path>:<line-numbers>
    Proposed edit: <what>
    Rationale: <why>

NO DRIFT (sections checked and held)
  - §<section>: <one-line note>
  - …

NEXT STEPS
  - <which proposals Oak should action first, in what order>
  - <which require spec proposals before implementation>
  - <which can be applied directly>

WRITTEN TO: chat only (this skill does not edit canonical files).
```

### Step 5 — Honesty rules

- **No drift is the default.** Do not invent candidates to fill the proposal. A short, honest "no drift in §X / §Y / §Z" beats five thin candidates.
- **Cite dates.** Every candidate names the dated evidence that justifies it. Undated assertions are downgraded.
- **Mark spec-proposal-required.** Canonical-doc changes per `spec/2026-04-28-canonical-docs.md` need a linked spec; this skill names the spec path it suggests.
- **Do not rank canonical changes against trivial calibration changes.** Different leverage classes; different application paths. Keep them in separate output sections.

## Voice constraints

- British English. No emoji. Plain prose. Diff-shaped where structure earns its keep.
- Builder-to-builder vocabulary. Strip marketing register.
- One short paragraph of rationale per candidate; longer is suspicious.
- Refusal beats padding — if no drift, say so.

## What this skill does not do

- Edit canonical files (`GROWTH.md`, `THESIS.md`, `BRAND.md`, `SPEC.md`, `GLOSSARY.md`). Output is proposal; Oak applies via PRs.
- Write spec proposals. It *names* a spec-proposal path; Oak writes it.
- Run growth-day's daily loop. Refine is meta to the loop.
- Generate or score posts. (`x-post-builder`, `x-algorithm-grader`.)
- Score recruits or run discovery. (`discover-twitter-recruits`.)
- Sample cluster evidence. (`cluster-model`.)

## Composition

- **Inputs:** GROWTH.md, growth-log full file, warm-contacts CSV, calibration-log, discovery-log, twitter-strategy retained outputs.
- **Outputs:** chat proposal document.
- **Consumes:** all other growth-side skills' outputs (cluster-model, growth-watcher, twitter-strategy, discover-twitter-recruits, x-post-builder, x-algorithm-grader).
- **Triggered by:** Oak ad-hoc, every sprint postmortem, `growth-day` Tier B surface when last refine >30 days.

## Why this skill exists

The growth system accumulates evidence across multiple log files and skill calibration trails. Without a forcing function, that evidence either drifts canon silently (skill-side restatements that contradict GROWTH.md) or stays uncomputed (canon goes stale because nobody synthesised the evidence into a proposed change). Refine is the function that forces synthesis. Its existence is what makes the canon-derives-from-evidence loop close; without it the loop is open and either canon ossifies or skill files quietly fork.
