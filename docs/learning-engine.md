# The learning engine

A plain-English presentation of **policy iteration** (Sutton & Barto, Chapter 4) applied to **non-weight policies** — what the LLM-agent literature calls the **harness**, **scaffold**, or **loadout** (Voyager, Reflexion, GEPA, Darwin Gödel Machine).

Each concept below is anchored in its canonical machine-learning / reinforcement-learning / experimentation name. Our project's plain-English alias is bracketed on first use. Use this doc to (a) map a new domain onto the framework, or (b) diagnose where the binding constraint of an existing learning loop sits.

Production applications already live elsewhere:

- **SWE-side harness learning** — [`docs/superpowers/specs/2026-08-03-policy-optimization-product-design.md`](superpowers/specs/2026-08-03-policy-optimization-product-design.md) (with its substrate, [`2026-08-03-policy-identity-and-outcomes-design.md`](superpowers/specs/2026-08-03-policy-identity-and-outcomes-design.md)) is the current design authority; [`spec/2026-05-28-harness-as-policy-learning-architecture.md`](../spec/2026-05-28-harness-as-policy-learning-architecture.md) remains the source of the L0–L5 ladder (its underlying DRs are ratified; the consolidating spec itself is `proposed`, and its roadmap sections are superseded per the product design §15.3), the seven-tier promoter action surface, and the held-out exam.
- **Growth** — [`GROWTH.md`](../GROWTH.md) applies the framework to recruiting and distribution.

## Generalized Policy Iteration in two operations

Every policy-iteration algorithm decomposes into two operations that alternate (Sutton & Barto §4.6):

- **Policy evaluation** [we have called this "the instrument"] — given a policy, estimate how good it is from observed outcomes.
- **Policy improvement** [we have called this "the search rule"] — given the evaluation, propose a better policy.

Almost every RL method, every A/B testing framework, every Bayesian-optimization loop, and every evolutionary algorithm is some form of these two operations alternating. Cranking one without the other usually wastes budget. Cranking both without considering the pitfalls (below) burns budget faster than it learns.

## Policy [the "loadout"]

The thing being iterated. In RL, the policy π is the function mapping states to actions. In the LLM-agent literature, the policy is the **harness** — prompts, skills, tool configs, retrieval — because the foundation model's weights are frozen and only the surrounding scaffold changes. In experimentation, the policy is the **treatment** or **arm**. In growth, the policy is what we have called the **loadout** — pitch, audience, channel, format, proof, ask, cadence, voice, amplifiers.

Whatever the domain, the policy is the mutable bundle the learning loop is trying to make better.

## Policy evaluation [the "instrument"] — the part that judges how good a policy is

You ran a policy. A verdict came back. The evaluator's job is to look at that verdict (and all the verdicts before it) and tell you whether this policy is actually any good. Four hyperparameters shape how trustworthy its answer is.

### Statistical power [the "sensitivity" knob]

In frequentist statistics, **statistical power** is the probability that an estimator detects a real effect of a given size. Plain English: how well it can tell signal from noise. One verdict isn't enough; you got lucky or unlucky. Low power: one verdict and you commit. High power: many verdicts under controlled conditions, then a statistical test. High power costs more samples per decision — what RL calls **sample efficiency**.

### Evaluation population [the "scope" knob]

The set of runs the estimator is allowed to count. In experimentation this is the **sample frame**; in federated RL it is the **federation scope**. Plain English: whose runs feed the judgment. Just yours, or every deployer running the same policy? Wider scope = more data, faster answers — but only valid if everyone agrees on what counts as "the same policy" (see *policy identity* below).

### Credit-assignment granularity [the "resolution" knob]

**Credit assignment** is canonical RL vocabulary (Minsky 1961, Sutton 1988): given an outcome, which actions or components deserve credit for it? Granularity ranges from coarse (the whole policy gets credit) → medium (per-component, e.g. per-skill) → fine (per-step within a trajectory). Higher granularity lets you fix what is actually broken instead of reverting whole edits — but only meaningful if power supports it (see pitfalls below).

### Baseline [the "baseline" knob]

`advantage = outcome − baseline` is canonical in policy-gradient methods (REINFORCE with baseline, Sutton & Barto §13.4). Plain English: what "better" is measured against. Versus yesterday's policy (lineage baseline), versus no action (null baseline), versus what peers are running (group baseline — GRPO and group-relative methods formalize this). Each comparison answers a different question.

## Policy improvement [the "search rule"] — the part that picks what to try next

The evaluator tells you how things went. The improvement step decides what policy to try next. Four hyperparameters shape it.

### Step size / trust region [the "step size" knob]

Canonical optimization vocabulary; in trust-region methods like **TRPO** (Schulman 2015) and **PPO** (Schulman 2017) the step size is explicitly bounded. Plain English: how big each tweak is. A one-line edit to a skill file ↔ rewriting a whole tool. Small tweaks are low-risk but slow to traverse the policy space. Big tweaks cover ground fast but can overshoot useful regions.

### Exploration strategy / acquisition function [the "direction" knob]

The rule that decides where in policy space to sample next. In RL: ε-greedy, softmax, UCB, Thompson sampling. In Bayesian optimization: the **acquisition function** (expected improvement, upper confidence bound). In evolutionary algorithms: the **variation operator** (mutation, crossover). Plain English: how it decides which way to tweak. Random (uninformed but unbiased), guided (use the trace), or imitative (copy what worked elsewhere — what RL calls **imitation learning** or **behavior cloning**).

### Population size [the "parallelism" knob]

Canonical evolutionary-strategies vocabulary, formalized for deep RL in **population-based training** (Jaderberg et al. 2017). Plain English: how many policies you have alive at once. One: a single lineage; gets stuck at local optima. Many: variants compete on the same tasks, winners propagate; escapes local optima but spends budget on dead branches.

### Acceptance criterion / stopping rule [the "commit policy" knob]

In Metropolis-Hastings, the **acceptance criterion** decides whether a proposed candidate replaces the current one. In **sequential analysis** (Wald 1947), the **stopping rule** decides when enough evidence has accumulated to act. Plain English: how patient you are before locking a change in. Greedy: accept on the first sign of improvement. Validated: wait for statistical significance.

## Three foundational pitfalls [the "couplings"]

Hyperparameters interact. Three pitfalls are well-known in the statistics and experimentation literature.

### Multiple comparisons [credit-assignment granularity needs power]

Sometimes called the **multiple-testing problem** or **garden-of-forking-paths analysis** (Gelman & Loken 2013). If you crank credit-assignment granularity (per-skill, per-step) without proportionally increasing statistical power, you will confidently attribute outcomes to noise. The Bonferroni correction and FDR control are the standard fixes.

### Treatment fidelity / SUTVA [scope needs policy identity]

In Rubin's causal-inference framework, the **Stable Unit Treatment Value Assumption** (SUTVA) requires that the treatment given to each unit be well-defined and consistent. Plain English: pooling evidence across deployers requires that "the same policy" mean the same thing everywhere. Without a stable, content-addressed policy identity, scope collapses to local-only.

### Regression to the mean [population size needs evaluator sharpness]

A population of variants the evaluator can't reliably rank will appear to differentiate during evaluation but converge toward the mean on replication — classical **regression to the mean** (Galton 1886). Cranking population size without sharpening the evaluator wastes compute on noise-driven selection.

## Policy identity [the "chassis"]

A stable, content-addressed identifier for a policy is what makes valid **off-policy evaluation** possible (Precup, Sutton, Singh 2000) — it lets you attribute a verdict to the specific policy that produced it, across operators, across time, across re-runs. On the SWE side this is `codeDigest = hash(implStateDir)` (see the SWE spec §3.1). On the growth side it is the loadout version in `growth/.local/growth-loadout.md`.

Policy identity is not a hyperparameter; it is the bearing several hyperparameters turn on. Without it:

- Evaluation population collapses to local-only (you can't agree across deployers on which policy was run).
- Credit assignment can't accumulate across runs (no key for attribution).
- Population size degenerates (variants can't be told apart in the verdict table).

## Sample budget [the "budget"]

The shared resource — compute, time, coordination cost, attention — that both policy evaluation and policy improvement compete for. In RL this is the **sample budget** or **compute budget**; in experimentation, the **traffic budget** or **test budget**. The design question is never the maximum, it is the allocation.

## How to apply this

Given any system that iterates a policy:

1. **Name the policy.** What is the mutable bundle?
2. **Name the verdict.** What comes back from each attempt?
3. **Locate the policy identity.** Is there a stable, content-addressed identifier? If not, build that first.
4. **Read each hyperparameter's current setting.** Be honest. Most default to "low" without conscious effort.
5. **Check the pitfalls.** Is the loop cranking one half of a coupling without the other?
6. **Identify the binding constraint.** Which hyperparameter, turned, buys the biggest improvement in learning per unit of budget?
7. **Turn it.** Be specific. Name the exact next setting.

The mistake everyone makes is cranking policy improvement (try more things, try faster) without sharpening policy evaluation. Every attempt without a sharper evaluator teaches almost nothing.

## The mental shortcut

**Resolution before reach. Baseline before broadcast. Pool before pivot.**

Sharpen the evaluator before you crank the search rule.

## The `learning-engine` skill

[`.claude/skills/learning-engine/`](../.claude/skills/learning-engine/) takes a user-described system and walks it through this framework in order, returning a structured plain-English diagnosis with a single recommended next move. The skill leads with canonical names; project aliases are bracketed.
