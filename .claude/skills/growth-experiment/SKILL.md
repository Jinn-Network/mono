---
name: growth-experiment
description: Drive one cycle of Jinn's growth experiment loop — PLAN an attempt with a written prediction, LOG the result against the Mayfield rungs, EVOLVE the loadout (revert / keep / wait) when there is enough evidence. Triggers on "plan the next growth attempt", "growth experiment", "log this post", "log the result", "should I revert the loadout", "growth plan", "growth log", "growth evolve", "what's the next growth experiment". Reads growth/.local/growth-loadout.md and growth/.local/growth-experiment-log.md; creates them on first PLAN call if absent. Implements GROWTH.md; sole sanctioned writer of new log entries.
---

# growth-experiment

Implements the cycle in [`GROWTH.md`](../../../GROWTH.md). See §1 for the model and Mayfield rungs, §2 for the eight knobs, §4 for the non-negotiables. This skill is their enforcement and the only sanctioned writer of new log entries.

## When to invoke

See frontmatter triggers. Also invoke proactively if the user is about to ship a growth artefact without having defined a prediction.

## Inputs

- `growth/.local/growth-loadout.md` — current loadout.
- `growth/.local/growth-experiment-log.md` — append-only log.

Both are operator-private (gitignored). Create them on first PLAN call if absent; never overwrite a populated loadout without the user's explicit confirmation.

## Mode 1 — PLAN

1. Ask the user which **rung** to move (default to lowest-volume), which single **knob** is varying (one of: pitch, audience, channel, format, proof, ask, cadence, voice, amplifiers), and **what would count as a hit**. Reject vague predictions ("good engagement") — push back for a concrete number, comparison, or binary. Refuse co-varied attempts unless the user explicitly overrides, logging the override in the entry.
2. Append a pending entry to the log: date, loadout version, rung, knob, audience slice, prediction. Leave actuals and verdict blank; mark status `pending`.

## Mode 2 — LOG

1. Read the most recent pending entry (or ask the user which attempt). Collect actuals across the target rung and any meaningful adjacent rungs — record by rung, not as a single number.
2. Compute the verdict:
   - `better` — actuals meet or exceed prediction AND outperform prior same-rung entries.
   - `worse` — actuals miss prediction AND underperform prior same-rung entries.
   - `inconclusive` — any other combination. **Always inconclusive if no written prediction**, regardless of how the result looks.
3. Mark status `logged`. Add ≤2 sentences on what the result implies for the loadout — without acting.

## Mode 3 — EVOLVE

1. Read recent entries filtered to the **same rung-knob pair** as the most recent logged attempt. Require **N ≥ 2** before acting; if fewer, refuse and tell the user what additional data unblocks.
2. With ≥2 attempts: consistently `worse` → propose revert (show current and prior knob values from the changelog, confirm before bumping). Consistently `better` → propose keep + ratify in changelog. Mixed or `inconclusive` → recommend wait, naming the specific attempts that would resolve.
3. When evolving, write the changelog entry on the loadout: date, version bump, knob changed, evidence cited (log entry dates), one-sentence rationale.

## Enforcement

Enforces [`GROWTH.md`](../../../GROWTH.md) §4. Skill-specific specifics:

- PLAN rejects vague predictions and refuses co-varied attempts (override flag required).
- LOG marks any no-prediction entry `inconclusive` regardless of result shape.
- EVOLVE refuses to act under N<2 or with co-varied attempts unreplicated.
- Entries record audience slice so a verdict on slice A does not propagate to slice B.

## Schemas

### `growth/.local/growth-loadout.md`

```markdown
# Growth loadout — current

**Version**: v0.1
**Date**: YYYY-MM-DD

## The eight knobs

**Pitch** — [framing]
**Audience** — [cluster or slice]
**Channel** — [X, conference, essay, DM, demo]
**Format** — [thread, long post, video, talk, README]
**Proof** — [what is on display]
**Ask / CTA** — [what the reader is invited to do]
**Cadence** — [posting frequency, sequencing]
**Voice** — [register; see BRAND.md]
**Amplifiers** — [who else is RT'ing]

## Targeting

**Rung being moved**: [Read / Favorite / ... / Lead]
**Hypothesis being tested**: [one sentence]

## Changelog

- v0.1 (YYYY-MM-DD): initial loadout.
```

### `growth/.local/growth-experiment-log.md`

```markdown
# Growth experiment log

Append-only. Newest first.

## Entry template

- **Date**: YYYY-MM-DD
- **Loadout version**: vX.Y
- **Attempt**: [link or artefact]
- **Audience slice**: [specific slice]
- **Rung targeted**: Read / Favorite / ... / Lead
- **Knob varied**: pitch / audience / channel / format / proof / ask / cadence / voice / amplifiers
- **Prediction**: [written before shipping]
- **Actual** (LOG mode):
  - Read: N
  - (etc — rungs that apply)
- **Verdict**: better / worse / inconclusive
- **Notes**: [implications, no actions]
- **Status**: pending / logged

## Entries

[append above this line, newest first]
```

## What this skill does not do

- Invoke other skills.
- Pull metrics automatically — actuals are user-supplied.
- Pool across deployers — current Scope knob is local-only.
- Draft content (the archive has skills that did; revive them via the loadout, not by reintroducing the skill).
- Modify [`GROWTH.md`](../../../GROWTH.md). Canon changes go through the canonical-doc PR flow.
