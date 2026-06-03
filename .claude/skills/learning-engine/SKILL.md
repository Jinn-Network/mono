---
name: learning-engine
description: Map any system that iterates a loadout (growth experiment, SWE harness, business process, hiring pipeline, personal habit, feedback loop) onto the learning-engine model and return a structured plain-English diagnosis — what the loadout is, what the verdict is, whether the chassis is present, where each of the eight knobs is currently set, which couplings are honored or violated, what the binding constraint is, and the one most leveraged next move. Triggers on "map this onto the engine", "diagnose this loop", "where's the bottleneck", "analyze this with the learning engine", "engine map", "loadout analysis", "what's the binding constraint here", "is this learning", "what should I improve". Reads docs/learning-engine.md. Does not modify files; output is a written diagnosis.
---

# learning-engine

Takes any system that iterates a loadout and maps it onto the model in [`docs/learning-engine.md`](../../../docs/learning-engine.md). Output is a structured plain-English diagnosis ending in one binding-constraint identification and one specific leverage move.

## When to invoke

When the user describes a system, process, or feedback loop and wants to know where the bottleneck is, what to improve, or how to think about it.

Also invoke proactively when the user is about to crank one half of an iteration loop (e.g. "let's try more things", "let's post more often", "let's add a new feature") without having sharpened the other half (the measurement).

Valid inputs:

- A growth attempt described against the GROWTH.md eight knobs.
- A SWE harness change or learning-roadmap move (defer to [`spec/2026-05-28-harness-as-policy-learning-architecture.md`](../../../spec/2026-05-28-harness-as-policy-learning-architecture.md) for the canonical SWE-side ladder).
- A business process — hiring pipeline (loadout = sourcing channel + screener + rubric), product feature iteration (loadout = spec + experiment + metric), sales motion (loadout = ICP + outreach script + qualifier).
- A personal practice — a routine, a study habit, a workout split.
- Any feedback loop the user describes informally.

## How to map

If the user has not stated their input, ask once: "Describe the system you want to diagnose — what gets changed, what comes back as feedback, and how you currently decide what to change next."

Then walk the system through the model in this fixed order. Be concrete. Quote the user's own terms where possible. Mention the canonical applications (GROWTH.md, the SWE-side spec) only when they help anchor an explanation.

### 1. The loadout

Name the mutable bundle and its components. If the user calls it the playbook, the config, the strategy, the routine, or the recipe — use their word but make the mapping explicit.

### 2. The verdict

Name what comes back from each attempt:

- Single number or multi-dimensional?
- Slow or fast to render?
- Self-reported or independently measured?
- Are there leading indicators that arrive sooner than the headline?

### 3. The chassis

Ask: is there a stable identity for the loadout — a version, a hash, a content-addressed fingerprint? If not, name what would close the gap. The chassis is the first thing to build if missing — most of the instrument's knobs depend on it.

### 4. The eight knobs

Walk each knob and name its current setting in one line. Use the language of the reference doc.

**Instrument:**

- Sensitivity — N per decision? Controls? Statistical discipline?
- Scope — local or pooled? Pooled across whom?
- Resolution — coarse (whole loadout) / medium (per component) / fine (per step within an attempt)?
- Baseline — vs past self / vs null / vs peers / vs theoretical max?

**Search rule:**

- Step size — small tweak or big move?
- Direction — random / trace-guided / imitative?
- Parallelism — one lineage or population?
- Commit policy — greedy or validated?

### 5. Couplings

For each of the three, name whether the system honors it or violates it:

- Resolution being cranked without Sensitivity? (Will produce confident attribution of noise.)
- Scope being cranked without Identity? (Will produce incoherent pooling.)
- Parallelism being cranked without instrument sharpness? (Will produce unrankable variants.)

### 6. The binding constraint

Of the eight knobs, which one — turned — buys the biggest improvement in learning per unit of budget? The default answer is usually on the instrument side; the universal failure mode is firing more attempts without measuring them better. Resist that default only when the user's instrument is already sharp.

### 7. One leverage move

Be specific. Not "improve the instrument" — name the exact knob and the exact next setting. Not "try more things" — name what to try and why. Cap at one move per invocation.

## Output format

Return a structured plain-English diagnosis using these section headers:

```
## The loadout
[the mutable bundle, components]

## The verdict
[what comes back, how, how fast]

## The chassis
[stable identity present? what would close the gap if not]

## The knobs

**Instrument:**
- Sensitivity: [setting, one line]
- Scope: [setting, one line]
- Resolution: [setting, one line]
- Baseline: [setting, one line]

**Search rule:**
- Step size: [setting, one line]
- Direction: [setting, one line]
- Parallelism: [setting, one line]
- Commit policy: [setting, one line]

## Couplings
[honored or violated, one line each]

## Binding constraint
[the one knob]

## Highest-leverage next move
[the specific action, one paragraph]
```

Cap the whole output at ~600 words. The point is leverage, not exhaustiveness.

## What this skill does not do

- Iterate the loop for the user. Diagnosis only.
- Invoke other skills.
- Modify any files.
- Propose a multi-step plan. One leverage move per invocation.
- Output vague generalities. Every line names a specific knob or setting.
