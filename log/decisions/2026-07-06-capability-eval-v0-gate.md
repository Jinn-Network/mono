---
id: DR-2026-07-06
title: Capability-eval v0 gate — corpus-connected harness PASSES iff quality non-inferior (δ=5pp) AND cost strictly lower (both-solve set), as an intersection-union test at α=0.05, on a new power-sized contested-band held-out slate; reuse the DR-2026-06-02-b stat/slate machinery, do not rebuild
date: 2026-07-06
verb: Design
status: draft
authors: Ritsu (design session — own the v0 capability gate for the harness network)
relates-to: >
  spec/2026-07-06-capability-eval-v0.md (the methodology this DR ratifies the gate for),
  spec/2026-07-02-jinn-harness-network.md §8 (the v1b capability gate — the binding bet),
  DR-2026-06-02-b (held-out efficacy — the paired-McNemar + slate + power lineage reused here),
  DR-2026-05-28 (#766 — the held-out exam primitive),
  issue #817 (held-out slate primitive), #818 (eval orchestrator), #986 (baseline-failure screen),
  PR #987 (paired.ts — the exact McNemar reused; its R>1 path is this spec's gate primary)
---

## Summary

The Jinn harness-network bet reduces to one number: a corpus-connected harness must beat a stock
harness at **equal quality, lower total cost** on the coding distribution
(`spec/2026-07-02-jinn-harness-network.md` §8). This DR records the operational **gate** for that
number and the load-bearing methodology choices, so the follow-on rig (`feat`) is built against a
ratified target. Full methodology: `spec/2026-07-06-capability-eval-v0.md`.

## Decisions

1. **The gate (met/not-met-able).** On a frozen contested-band coding slate, arm A = stock
   jinn-agent, arm B = same agent + distribution-matched **seed loadout pre-installed** (no live
   retrieval), pinned model, R ≥ 3 repeats:

   > **PASS** iff, at α = 0.05 as an **intersection-union test** —
   > (1) **quality non-inferior**: Δ_quality = rate(B) − rate(A) > −δ, **δ = 5 percentage
   > points**; **AND**
   > (2) **cost strictly lower** on the tasks both arms solve: Δ_cost < 0.

   Otherwise **FAIL** (clear regression or no cost win) or **INCONCLUSIVE** (underpowered at the
   achieved N — reported with its MDE, and treated as **not a pass**).

2. **Why an IUT and no multiplicity correction.** The gate fires only when *both* component nulls
   are rejected; an intersection-union test of two level-α tests is itself level α (Berger 1982).
   Requiring both **is** the type-I control — no Bonferroni. This is the honest way to make a
   two-part ("equal quality AND lower cost") claim without inflating false positives.

3. **Corpus ON = seeds pre-installed only** (not live `corpus_search`). Isolates the "skills in
   context" value, simplifies contamination control, and extends to v1 by swapping seeds →
   distilled skills in the same loadout slot. The seed loadout's per-task context tokens are
   **counted** in arm B's cost — the corpus must earn back the tokens it carries.

4. **New power-sized contested-band slate; the existing N≈10 slates are precedent only.** The v1
   (N=10) and v2 (N=9) slates are the underpowered artifacts DR-2026-06-02-b named; they are
   reused as **format + tooling**, not as the measurement. Construction widens the v2 screen's
   `base-fails-0/R` predicate to a **contested band** (stock pass-rate in ~[0.15, 0.85], measured
   blind to corpus), which is the regime where both halves of the bet — equal *quality* and lower
   *cost* — are meaningful. Estimand is scoped, and stated as such: *the corpus effect on coding
   tasks where the stock agent is neither saturated nor hopeless.*

5. **Contamination control is the load-bearing risk.** The slate is proven disjoint from a frozen,
   content-addressed corpus snapshot along three axes — instance_id, **repo**, and lexical
   gold-patch scan — via a fail-loud extension of `assertNoOverlap`. Model-pretraining
   contamination is *not* controlled for because it cancels in the paired difference (shared by
   both arms); **corpus** contamination is what the proof targets, because it helps only arm B.

6. **Reuse, do not reinvent the statistics.** Gate-primary quality test = paired per-task
   pass-rate difference with a one-sided BCa bootstrap CI (the R>1 path `paired.ts` already names
   as its roadmap). Legible corroboration = the shipped exact McNemar (`comparePaired`) on
   consensus verdicts + marginal Wilson (`wilson.ts`). Cost = paired Wilcoxon signed-rank on the
   both-solve set. Power/N via the Connor (1987) McNemar formula + a pilot bootstrap sim —
   **explicitly not N=10/R=1** (DR-2026-06-02-b proved that cannot detect < +60pp).

7. **Pinned model = Haiku-class** for the primary run (cheapest; matches the v2 screening base).
   Its low ceiling is a named external-validity threat, mitigated by an optional Sonnet-class
   replication (the methodology is model-agnostic; only the pinned id changes).

8. **Human-run measurement, not a CI gate.** Heavy, Docker/disk-bound, stochastic; wiring it to a
   push gate would be a flaky gate (worse than none). Output is a dated, anchored, reproducible
   report.

## Shared interface published by this decision

The **held-out task-set boundary** (the `cap-v0` slate artifact: instance_ids + repos + hash +
`corpusSnapshotCid`) is owned by this session and consumed by the distillation-design session.
Distillation MUST exclude it by **both instance_id and repo** (repo denylist forecloses
same-repo near-duplicate leakage), via the existing `excludeHeldOutSlate` chokepoint. Two-sided:
freeze corpus → draw slate disjoint from it → publish → distillation excludes it thereafter. See
`spec/2026-07-06-capability-eval-v0.md` §12.

## Status / next

Draft. Ratifies the gate for review before the rig is built. The rig is a follow-on `feat` gated
on sign-off of the spec; a pilot (N≈20–30, R=3) to estimate effect size for the final power calc
is in-scope for that `feat`.
