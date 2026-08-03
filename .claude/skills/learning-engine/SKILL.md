---
name: learning-engine
description: Map any system that iterates a policy (a growth experiment, a SWE harness, a business process, a hiring pipeline, a personal habit, any feedback loop) onto the canonical policy-iteration framework — policy evaluation + policy improvement, eight hyperparameters, three foundational pitfalls (multiple comparisons, treatment fidelity, regression to the mean), one chassis primitive (policy identity), one shared sample budget. Returns a structured plain-English diagnosis ending in one binding-constraint identification and one specific leverage move. Triggers on "map this onto the engine", "diagnose this loop", "where's the bottleneck", "analyze this with the learning engine", "engine map", "policy analysis", "loadout analysis", "what's the binding constraint here", "is this learning", "what should I improve". Reads docs/learning-engine.md. Does not modify files; output is a written diagnosis.
---

# learning-engine

Takes any system that iterates a **policy** — a mutable bundle the system reads at runtime — and maps it onto the policy-iteration framework documented in [`docs/learning-engine.md`](../../../docs/learning-engine.md). Output is a structured plain-English diagnosis ending in one binding-constraint identification and one specific leverage move.

The skill leads with canonical machine-learning / reinforcement-learning / statistics names and brackets the project's plain-English aliases on first use, so a reader from the ML community sees the formal terms first.

## When to invoke

When the user describes a system, process, or feedback loop and wants to know where the bottleneck is, what to improve, or how to think about it.

Also invoke proactively when the user is about to crank one half of a learning loop (e.g. "let's try more things", "let's post more often", "let's add a new feature") without having sharpened the other half (the measurement).

Valid inputs:

- A growth attempt described against GROWTH.md's eight hyperparameters.
- A SWE harness change or learning-roadmap move (defer to [`docs/superpowers/specs/2026-08-03-policy-optimization-product-design.md`](../../../docs/superpowers/specs/2026-08-03-policy-optimization-product-design.md) as the current SWE-side design authority; [`spec/2026-05-28-harness-as-policy-learning-architecture.md`](../../../spec/2026-05-28-harness-as-policy-learning-architecture.md) for the L0–L5 ladder it composes).
- A business process — hiring pipeline (policy = sourcing channel + screener + rubric), product feature iteration (policy = spec + experiment + metric), sales motion (policy = ICP + outreach script + qualifier).
- A personal practice — a routine, a study habit, a workout split.
- Any feedback loop the user describes informally.

## How to map

If the user has not stated their input, ask once: "Describe the system you want to diagnose — what gets changed (the policy), what comes back as feedback (the verdict), and how you currently decide what to change next."

Then walk the system through the framework in this fixed order. Be concrete. Quote the user's own terms where possible. Use canonical names as headers; bracket the project's plain-English aliases (loadout, instrument, sensitivity, etc.) on first use.

### 1. The policy [the "loadout"]

Name the mutable bundle and its components. If the user calls it the playbook, the config, the strategy, the routine, or the recipe — use their word but make the mapping explicit. In RL terms this is the policy π; in LLM-agent terms it is the harness; in experimentation it is the treatment.

### 2. The verdict

Name what comes back from each attempt:

- Single number or multi-dimensional?
- Slow or fast to render?
- Self-reported or independently measured?
- Are there leading indicators that arrive sooner than the headline outcome?

### 3. Policy identity [the "chassis"]

Ask: is there a stable, content-addressed identifier for the policy — a version, a hash, a fingerprint? Off-policy evaluation depends on it. If absent, name what would close the gap; this is the first thing to build because most evaluation hyperparameters depend on it.

### 4. The eight hyperparameters [the "knobs"]

Walk each in one line.

**Policy evaluation [the "instrument"]:**

- **Statistical power** [sensitivity] — N per decision? Controls? Statistical discipline?
- **Evaluation population** [scope] — local or pooled? Pooled across whom?
- **Credit-assignment granularity** [resolution] — coarse (whole policy) / medium (per component) / fine (per step within an attempt)?
- **Baseline** — versus past self (lineage) / null / peers (group) / theoretical max?

**Policy improvement [the "search rule"]:**

- **Step size / trust region** — small tweak or big move?
- **Exploration strategy / acquisition function** [direction] — random / trace-guided / imitative?
- **Population size** [parallelism] — one lineage or many concurrent variants?
- **Acceptance criterion / stopping rule** [commit policy] — greedy or validated?

### 5. Foundational pitfalls [the "couplings"]

For each of the three, name whether the system is exposed:

- **Multiple comparisons** — credit-assignment granularity cranked without statistical power? (Will confidently attribute outcomes to noise; Bonferroni / FDR is the standard fix.)
- **Treatment fidelity / SUTVA** — evaluation population pooled across deployers without policy identity? (Pooling is incoherent.)
- **Regression to the mean** — population size cranked without evaluator sharpness? (Variants ranked on noise; converge to mean on replication.)

### 6. The binding constraint

Of the eight hyperparameters, which one — turned — buys the biggest improvement in learning per unit of budget? The default answer is usually on the policy-evaluation side; the universal failure mode is firing more attempts without measuring them better. Resist that default only when the evaluator is already sharp.

### 7. One leverage move

Be specific. Not "improve the evaluator" — name the exact hyperparameter and the exact next setting. Not "try more things" — name what to try and why. Cap at one move per invocation.

## Output format

Return a structured plain-English diagnosis. Lead with the canonical name; bracket the project alias on first use.

```
## The policy [the "loadout"]
[the mutable bundle, components]

## The verdict
[what comes back, how, how fast]

## Policy identity [the "chassis"]
[stable content-addressed identifier present? what would close the gap if not]

## Hyperparameters [the "knobs"]

**Policy evaluation [the "instrument"]:**
- Statistical power [sensitivity]: [setting, one line]
- Evaluation population [scope]: [setting, one line]
- Credit-assignment granularity [resolution]: [setting, one line]
- Baseline: [setting, one line]

**Policy improvement [the "search rule"]:**
- Step size / trust region: [setting, one line]
- Exploration strategy [direction]: [setting, one line]
- Population size [parallelism]: [setting, one line]
- Acceptance criterion [commit policy]: [setting, one line]

## Foundational pitfalls [the "couplings"]
[Multiple comparisons / Treatment fidelity / Regression to the mean — honored or exposed, one line each]

## Binding constraint
[the one hyperparameter]

## Highest-leverage next move
[the specific action, one paragraph]
```

Cap the whole output at ~600 words. The point is leverage, not exhaustiveness.

## What this skill does not do

- Iterate the loop for the user. Diagnosis only.
- Invoke other skills.
- Modify any files.
- Propose a multi-step plan. One leverage move per invocation.
- Output vague generalities. Every line names a specific hyperparameter or setting.
