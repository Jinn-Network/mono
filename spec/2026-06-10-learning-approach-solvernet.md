---
version: 0.1
date: 2026-06-10
author: opus + oaksprout
status: superseded
superseded-by: 'docs/superpowers/specs/2026-08-03-policy-optimization-product-design.md §15.1 (2026-08-03): same product intent in dissolved SolverNet vocabulary; bundle-as-policy, novelty-vs-quality split, and auto-A/B harvested into the campaign design'
parent-milestone: '[#2 — solvers improving on swe-rebench v2](https://github.com/Jinn-Network/mono/milestone/2)'
parent-epic: '[#601 — EPIC: Demonstrate solver learning](https://github.com/Jinn-Network/mono/issues/601)'
work-shape: design
---

# A SolverNet whose product is *learning approaches*

A meta-SolverNet whose task is **"create a runnable learning approach for the swe-rebench-v2 SolverNet that is materially different from every approach already in the registry."** The protocol does not judge whether a submitted approach is *good*. It gates only that the approach is *real* (it runs, it does something) and *novel* (its behaviour differs from existing entries). Quality is decided downstream — by swe-rebench-v2 operators who fetch entries from the registry and observe whether they move the metric.

This is the bitter-lesson-shaped move: the protocol holds no opinion about what a good learning approach looks like. The market does.

## 0. The priors this doc stands on

| Prior | What it ratifies | Role here |
|---|---|---|
| [`spec/2026-05-28-harness-as-policy-learning-architecture.md`](2026-05-28-harness-as-policy-learning-architecture.md) | The harness is the policy. The action surface is wide; usage is shallow. The L0–L5 ladder is one possible path up. | **The problem statement.** The current learning approach (L1 hill climbing via promoter/consolidator) is one shape. There are others. We don't know which one wins. |
| [DR-2026-05-06-c](../log/decisions/2026-05-06-frozen-state-contract.md) | Frozen-state contract: a held-out eval runs against a frozen `implStateDir`, not a live-mutating one. | **How a downstream operator measures whether a registry entry helped.** |
| [DR-2026-05-28](../log/decisions/2026-05-28-rl-eval-measurement.md) | The held-out exam is the measurement floor. Replayable slate, frozen checkpoint, before-vs-after, confidence interval. | **What "moves the metric" means downstream.** |
| SPEC.md | Value is the bonded economy; corpus is a public good. | **The framing constraint.** This SolverNet must not enclose the registry — it is a public good, content-addressed, discoverable via ERC-8004. |

## 1. The wager

**The current learning approach is one shape of an RL approach.** The shipped promoter/consolidator loop (L1 hill climbing) is a hand-designed point in a large policy space. So is "use a stronger teacher model and let weaker models retrieve the trajectories" (corpus-seeding). So is "rewrite the action surface to force tier-2+ writes" (mutation policy). So is "swap the harness entirely and run codex+GPT-5 with no learner plugin at all" (a null hypothesis the team has not tested).

We do not know which shape wins. Hand-picking the next shape to try is the [bitter-lesson]-violating move: human cleverness about which structure of learning will work is the kind of thing the field reliably under-bets compute against.

**The protocol move.** Make *generating new learning-approach shapes* its own SolverNet, and let the swe-rebench-v2 SolverNet itself pay the bill for finding out which of them works.

## 2. Why a SolverNet (not a script)

A meta-search script run on internal compute would do the *narrow* version of this — programmatically generate prompt variations, eval each on a held-out slate, keep winners. That is one shape, and it is well-explored prior art ([GEPA], [Voyager]). The SolverNet framing is justified iff it does something structurally different. Three things, in order of load-bearingness:

- **It crowd-sources the *shape*, not just the parameters.** A script can search variations of a known structure. A SolverNet attracts proposers who bring **structurally distinct learning approaches** — distillation-from-teacher, retrieval-policy swaps, harness/model substitutions, things no in-house search would propose. The reward surface is *what shape to try at all*, not *which point within a known shape*.
- **The incentive surface is the search heuristic.** Asking "what novel learning approach would actually be valuable for swe-rebench-v2 operators to use" is a different question than "what variation maximises our chosen metric on our chosen slate." The first is the question the bitter lesson actually asks. Bonding makes it Legible.
- **Distributed compute.** A network of operators evaluating submissions is more compute than the team has on-tap.

If proposer count is zero at v0, the SolverNet framing was wrong and this should be relegated to a script. The smallest meaningful test of the SolverNet hypothesis is "do non-team proposers submit approaches at all." See §6.

## 3. Structure

### 3.1 The task

> **Create a learning approach for the swe-rebench-v2 SolverNet that is materially different from every approach already in the registry.**

The task is open per round; multiple solvers can claim and submit independently. Each accepted submission raises the novelty bar for the next.

### 3.2 The solution — the *bundle*

A submission is a directory. The protocol takes no position on its internal contents; it is opaque to the protocol and runnable by a receiving operator. The directory contains:

```
bundle/
  manifest.yaml         # required: declares the intervention shape
  plugin/               # optional: a Jinn plugin (or a diff against client/plugins/learner)
  probe-outputs.json    # required: solver's outputs from running the bundle on the public probe set
```

**`manifest.yaml`** declares the full operator-config slice the bundle wants applied. It captures all three layers above the plugin (the user's "iterate over a single config" intuition):

```yaml
intervention_kind: harness-mutation | corpus-seed | teacher-distill | retrieval-policy | hybrid | other
harness: claude-code | codex | <external>     # which CLI runtime
model: claude-haiku-4-5-20251001 | claude-opus-4-8 | gpt-5 | ...
plugins:                                       # the plugin set
  - jinn/learner@<ref>
  - <bundle-local-plugin-name>                 # references plugin/ subdirectory
train_arm_tasks: 50                            # how many production tasks before frozen eval
declared_compute_ceiling_usd: 25.00            # solver's declared upper bound per eval round
description_freeform: |
  ...one paragraph of plain prose describing what the approach does and why...
```

The bundle is **fully described by manifest + content-addressed contents**; nothing the protocol does requires understanding the intervention. The receiving operator applies the bundle by writing the manifest fields into `joinedSolverNets[swe-rebench-v2].{harness,model,plugins}` and (re)starting their train-arm window.

**Why this shape encapsulates harness + model.** The existing plugin shape on a Jinn node does NOT encapsulate harness or model choice — those sit one layer above the plugin in operator config ([client/src/config.ts:473-494](../client/src/config.ts:473)). If the submission were plugin-only, the SolverNet could not search over the layer where some of the most interesting interventions live (teacher distillation requires model choice; harness substitution requires harness choice). The bundle is the smallest unit that captures the whole policy.

### 3.3 The evaluator's verdict — *behavioural novelty*

The evaluator answers **two** questions, mechanically:

1. **Is the bundle real?** The evaluator runs the bundle on the public probe set (§3.4) end-to-end. The harness must boot, the plugins must load, the run must produce parseable outputs. If not — reject.
2. **Is the bundle novel?** The evaluator records the bundle's outputs on the probe set — its [behavioural signature]. It computes a distance between this signature and the nearest existing registry entry's signature. If distance > novelty threshold — accept. Otherwise — reject.

**Why behavioural, not syntactic.** "Different code" can be gamed in seconds by renaming variables. "Different manifest category" can be gamed by lying about the manifest. "Different outputs on the same tasks" requires actually producing different outputs — the gaming cost approaches the honest cost. This is the standard [Novelty Search] / [Quality-Diversity] framing in the literature: novelty is measured in *output space*, not *code space*.

**The signature.** For v0 the signature is a tuple of (PASS / FAIL per probe task, patch SHA-256 per probe task). Distance is Hamming-on-PASS-vector plus Jaccard-on-patch-content. Concrete, robust, replaceable. The distance metric is a parameter the spec leaves under-specified deliberately — it will be tuned against the first ~10 submissions.

**Why the evaluator's run is authoritative.** The solver submits their own `probe-outputs.json` as proof-of-attempt. The evaluator does not trust it — it re-runs the bundle and uses *its own* outputs as the signature. The submitted file exists for cross-checking (large delta between solver's and evaluator's outputs is a flag) and for the public record. LLM stochasticity is real; one run is enough to characterise novelty distance.

### 3.4 The probe set

A small, fixed, public set of swe-rebench-v2 tasks. v0 = **5 tasks, hand-picked from swe-rebench-v2 to span common difficulty/domain bands.** Public so solvers can develop against it. Fixed so signature comparisons are commensurable across rounds.

The probe set being public is **not** the held-out slate. The held-out slate lives in the swe-rebench-v2 SolverNet for downstream measurement (§4). The probe set is purely a behavioural-distance instrument.

### 3.5 The registry

[ERC-8004]. Each accepted submission registers a content-addressed pointer to the bundle (IPFS CID) plus the evaluator's signature and acceptance verdict. Discovery is the standard's job; this SolverNet does not build its own registry UI.

### 3.6 Reward

Standard per-delivery emission as defined by the SolverNet's emission rules at launch. No royalty model in v0 — the question "should the author of a popular registry entry earn from downstream usage" is real and important but is a §8 open question, not a v0 dependency.

## 4. Downstream usage — how swe-rebench-v2 operators consume the registry

A swe-rebench-v2 operator opts in by adding registry entries to their `joinedSolverNets[swe-rebench-v2-key]` config. In v0 this is **manual pull**: the operator picks an entry, writes the bundle's manifest fields into their config, and restarts the daemon. The operator's next train-arm window runs with the new policy. The held-out eval ([DR-2026-05-28]; [`jinn eval`](../client/src/cli/commands/eval.ts) when #818 lands) measures whether it moved the metric.

Out of scope for v0: automatic A/B sampling of the registry by swe-rebench-v2 operators. That is the bitter-lesson-shaped *downstream* search, and it deserves its own design pass once the registry has enough entries to be worth sampling.

## 5. Anti-overfit posture

The previous draft of this design had to engineer cheat-prevention machinery (commit-reveal slates, blind eval) because the SolverNet evaluator was scoring *quality*. Under the current shape — the evaluator scores only *novelty* — the anti-overfit problem **dissolves at this layer**.

- **The protocol does not pay for moving the metric.** It pays for being novel. There is nothing to overfit to.
- **The metric measurement lives downstream**, in the swe-rebench-v2 SolverNet's existing held-out eval. That eval's anti-overfit posture is the harness-as-policy doc's §4 measurement floor — not this SolverNet's problem to re-solve.
- **Probe-set overfitting is bounded by design.** The verdict is binary (above or below the novelty threshold), not graded — so there is no incentive to maximise probe-set distance beyond clearing the bar. A bundle that overfits the 5-task probe set to fake behavioural novelty (rather than producing genuinely distinct behaviour) is still a bundle the downstream swe-rebench-v2 SolverNet will reveal as useless. The cost of fake novelty falls on the proposer; the protocol is not paying for it.

The one anti-overfit problem this SolverNet inherits is **probe-set staleness**: if 100 entries are in the registry, all matched against the same 5 probe tasks, the probe set may saturate. Out of scope for v0; flagged in §8.

## 6. v0 — the smallest end-to-end slice

The closed loop that proves the design works:

1. The learning-approach SolverNet exists. SolverType `learning-approach-v0` defined per [`docs/runbooks/add-solver-type.md`](../docs/runbooks/add-solver-type.md) and [`spec/2026-04-30-plug-in-surface.md`](2026-04-30-plug-in-surface.md).
2. One operator runs the evaluator role. The evaluator can take a bundle, run its declared harness+model+plugins against the 5-task probe set on the swe-rebench-v2 SolverType, capture outputs, compute novelty distance, accept or reject.
3. The team manually proposes the **first two bundles**:
   - **Bundle A — baseline.** Today's production config: claude-code harness, Haiku, learner plugin. Seeds the registry. Trivially "novel" because the registry is empty.
   - **Bundle B — model substitution.** Same harness and same plugin set as Bundle A, model swapped from Haiku to Opus. The simplest possible second entry — chosen because model substitution alone is expected to produce non-zero behavioural distance on the probe set, and because it tests the part of the bundle shape the existing plugin-only surface cannot express.
4. The evaluator accepts both. The registry has two entries.
5. **A swe-rebench-v2 operator runs both bundles, separately, over a train-arm window each, and runs `jinn eval` against the held-out slate after each.** Reports delta-pass-rate ± CI per bundle vs the baseline checkpoint. The deltas may be positive, zero, or negative — that is not the success criterion at this milestone. The success criterion is **the closed loop produced a measurement**.
6. **The SolverNet test:** an additional non-team proposer submits at least one bundle, in the first 14 days after the v0 SolverNet's open task is posted. If zero, the SolverNet framing failed empirically at proposer-attraction; this becomes an internal meta-search script.

**Milestone-2 contribution.** v0 does not, by itself, demonstrably move swe-rebench-v2's metric. It builds the substrate that moves it: a registry that can grow, a mechanism that pays for *exploration*, and a downstream consumption path that converts exploration into measurement. Movement of the metric is delivered by the **first bundle** the swe-rebench-v2 SolverNet's downstream eval reveals as net-positive over baseline — whether that is bundle A, B, or one of the proposer-supplied bundles after them.

## 7. What this does NOT do

Naming gaps is more Legible than papering over them ([BRAND.md](../BRAND.md)).

- **It does not measure quality of learning approaches.** It measures *novelty*. Quality is a downstream property of the swe-rebench-v2 SolverNet's eval. This SolverNet would over-claim if it advertised registry entries as "good approaches" — they are *candidate* approaches.
- **It does not pay royalties.** A popular registry entry does not earn its author anything beyond the one-time emission at submission. Building back-attribution is real and deferred.
- **It does not gate spam at v0.** Network-level bonding is the long-term answer ([SPEC.md] §value is the bonded economy). v0 ships before that, so the registry will plausibly accumulate trivial entries. Discovery via ERC-8004 means downstream operators can ignore them; junk-as-pollution is bounded.
- **It does not search the model layer or compute envelope.** The manifest declares model and compute ceiling, but does not constrain or measure them. A bundle that wins by spending 100× more compute will win at the eval and lose at the cost-per-solved-task metric the swe-rebench-v2 SolverNet already exposes. That trade-off is for the downstream consumer.
- **It does not modify the swe-rebench-v2 SolverNet.** v0 is purely additive: a new SolverType, a new task type, a new evaluator role, a new registry. swe-rebench-v2 operators opt in to consumption; if zero opt in, this SolverNet is inert and easily turned off.

## 8. Open questions

- **Probe-set staleness.** At what registry size does the 5-task probe set saturate and stop discriminating? Concrete answer needs the first ~20 entries. Probe-set rotation cadence is the obvious lever.
- **Distance metric tuning.** v0's Hamming-on-PASS + Jaccard-on-patch is a placeholder. The first ~10 submissions are the tuning corpus; spec a revision after.
- **Verifying the solver actually ran their submission.** v0 trusts `probe-outputs.json` only as a flag, not as evidence — the evaluator re-runs. If re-run cost is prohibitive at scale, an attestation-of-run scheme (signed receipts from a known harness adapter, or stake-and-challenge) becomes load-bearing.
- **Should the evaluator role be plural?** v0 assumes one evaluator. Pluralising introduces evaluator-collusion and divergence-on-acceptance risks, but improves Legibility. Belongs in a B.2 evaluator-economics pass, not here.
- **Royalty / back-attribution to bundle authors.** Out of scope for v0; not out of scope long-term. The shape (downstream operator's emission splits a share to the registry entry's author) is sketchable; the on-chain plumbing is non-trivial.
- **Automatic A/B sampling by downstream operators.** The bitter-lesson-shaped move at the consumption layer. Deferred until the registry has enough entries to sample.
- **Does the bundle shape encapsulate corpus contributions?** A teacher-distillation bundle's *real* payload is the trajectories it deposits into the cross-operator corpus. The current bundle shape lets the bundle's plugin do that at run-time. Whether the registry entry itself should also store a content-addressed pointer to the seed corpus is a v1 question.

## 9. Companion artefacts

This spec is one half of a pair. The implementation plan — scoping the v0 closed loop to the smallest set of tickets that ship it — lives at [`docs/superpowers/plans/2026-06-10-learning-approach-solvernet.md`](../docs/superpowers/plans/2026-06-10-learning-approach-solvernet.md) (to be written next via the `superpowers:writing-plans` skill).

A GitHub Discussion is warranted — this is a sibling design to Milestone #2 / [EPIC #601](https://github.com/Jinn-Network/mono/issues/601) and the wager is non-trivial. Sibling Discussion to be filed against the umbrella once the spec lands.

## 10. Status

Proposed. Brainstormed 2026-06-09 / -10 between opus + oaksprout, anchored on [`spec/2026-05-28-harness-as-policy-learning-architecture.md`](2026-05-28-harness-as-policy-learning-architecture.md) §1 (the harness-is-the-policy framing) and SPEC.md (value is the bonded economy, corpus is a public good). Next gates: review by oaksprout → writing-plans pass → Discussion → Issue creation under Milestone #2.
