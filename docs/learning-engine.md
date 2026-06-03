# The learning engine

A reusable mental model for any system that iterates a **loadout** — a mutable bundle the system reads at runtime — toward better outcomes, without retraining the underlying model. Two subsystems, eight knobs, three couplings, one chassis primitive, one shared budget.

This doc is the meta-model. The two production applications live elsewhere:

- **SWE-side harness learning** — [`spec/2026-05-28-harness-as-policy-learning-architecture.md`](../spec/2026-05-28-harness-as-policy-learning-architecture.md) is the canonical roadmap (ratified L0–L5 ladder, seven-tier action surface, held-out exam, federation plan).
- **Growth** — [`GROWTH.md`](../GROWTH.md) applies the engine to recruiting and distribution (loadout = pitch / audience / channel / format / proof / ask / cadence / voice / amplifiers; verdict = Mayfield rung position).

Use this doc to (a) map a new domain onto the engine, or (b) diagnose where the binding constraint of an existing iteration loop sits. The interesting question is never "where on the ladder are we" — it is "given a fixed budget, which knob is the binding constraint right now."

## Two subsystems

The whole engine is a function: `loadout history → next loadout`. It decomposes into two parts.

**The instrument.** Judges how good a loadout is. Takes verdicts in, returns a comparison.

**The search rule.** Decides what loadout to try next. Takes the instrument's history in, returns a candidate.

Cranking either subsystem without the other usually wastes budget. Cranking both at the same time without considering couplings (below) burns budget faster than it learns.

## The instrument — the part that judges how good a loadout is

You ran a loadout. A verdict came back. The instrument's job is to look at that verdict (and all the verdicts before it) and tell you whether this loadout is actually any good. Four things shape how trustworthy its answer is.

- **Sensitivity — how well it can tell signal from noise.** One verdict isn't enough; you got lucky or unlucky. Sensitivity is *how much you bother to control for that*. Low sensitivity: one verdict and you commit. High sensitivity: ten verdicts on the same task with everything else held constant, then a statistical test. High sensitivity costs more runs per decision.

- **Scope — whose runs the instrument is allowed to count.** Maybe only your own operator's runs feed the judgment. Or maybe every operator on the network running the same loadout contributes to one shared tally. Wider scope = more data, faster answers — but it only works if everyone agrees on what "the same loadout" means. That's why the chassis exists.

- **Resolution — how specifically the instrument names what's good.** Coarse: "this loadout is better than the last one." Medium: "the skill changes helped, the new tool didn't." Fine: "the skill helped on step 4 of the trajectory, hurt on step 7." Higher resolution lets you fix what's actually broken instead of reverting whole edits.

- **Baseline — what "better" is measured against.** Better than yesterday's loadout? Better than no edit at all? Better than what other operators are running on the same tasks? Each comparison answers a different question, and the answer is only meaningful if you've named the comparison.

## The search rule — the part that picks what to try next

The instrument tells you how things went. The search rule decides what to do about it. Four things shape how good it is at finding better loadouts.

- **Step size — how big each tweak is.** A one-line edit to a skill file? A whole tool rewritten? Small tweaks are low-risk but slow to traverse the space of possible loadouts. Big tweaks cover ground fast but can overshoot useful regions you'd never revisit.

- **Direction — how it decides which way to tweak.** Random: just try something. Guided: look at the trace, see where the agent struggled, and target the tweak there. Imitative: copy a loadout that worked for another operator. Random is dumb but unbiased. Guided is informed but can chase artifacts. Imitative is fastest when the network has good examples.

- **Parallelism — how many loadouts you have alive at once.** One: a single line of evolution. Many: a population of variants competing on the same tasks, with winners propagating. One is cheap and gets stuck at local plateaus. Many escapes plateaus but spends compute on dead branches.

- **Commit policy — how patient you are before locking a change in.** Greedy: as soon as the trend points up, accept it. Validated: wait for enough samples to be statistically confident before accepting. Greedy is fast and noisy. Validated is slow and stable.

## Three couplings

Knobs are not independent. Three couplings matter most:

- **Resolution needs Sensitivity.** High resolution without sensitivity attributes noise with confidence.
- **Scope needs Identity.** Pooling evidence across deployers requires that "the same loadout" mean the same thing everywhere.
- **Parallelism amplifies the Instrument.** A population of variants is wasted if the instrument can't rank them.

## The chassis: content-addressed loadout identity

Beneath the knobs is one primitive that has to exist before several knobs will turn at all: a stable identity for the loadout.

- On the SWE side, this is `codeDigest = hash(implStateDir)`. See the canonical spec §3.1.
- On the growth side, this is the loadout version in `growth/.local/growth-loadout.md`, manually advanced because cross-deployer pooling is not yet in scope.

Without identity:

- Scope collapses to local-only (you can't agree with another deployer on which loadout was run).
- Resolution can't accumulate across runs (no key to attribute outcomes to).
- Parallelism degenerates (you can't tell variants apart in the verdict table).

Identity is not a knob; it is the bearing that several knobs turn on.

## The budget

One shared resource — compute, time, coordination cost, attention — that both subsystems compete for. Spend it on instrument sharpness or on search breadth. The design question is the allocation, not the maximum.

## How to use this model

Given any system that iterates a loadout:

1. **Name the loadout.** What is the mutable bundle? (Prompts, skills, tools, retrieval. Or pitch, audience, channel, format, ask. Or hyperparameters. Or process steps. Or a daily routine.)
2. **Name the verdict.** What comes back from each attempt? Single number, distribution, multi-dimensional outcome?
3. **Locate the chassis.** Is there a stable identity for the loadout? If not, that's the first thing to build.
4. **Read each knob's current setting.** Be honest. Most knobs default to "low" without conscious effort.
5. **Check the couplings.** Is the system cranking one half of a couple without the other?
6. **Identify the binding constraint.** Which knob, turned, would buy the biggest improvement in learning per unit of budget?
7. **Turn that knob.** Be specific. Not "improve the instrument" — name the exact next setting.

The mistake everyone makes is cranking the search rule (try more things, try faster) without sharpening the instrument. Every attempt without a sharper instrument teaches almost nothing.

## The mental shortcut

**Resolution before reach. Baseline before broadcast. Pool before pivot.**

Sharpen the instrument before you crank the search rule.

## The `learning-engine` skill

[`.claude/skills/learning-engine/`](../.claude/skills/learning-engine/) takes a user-described system and walks it through this model in order, returning a structured plain-English diagnosis with a single recommended next move.
