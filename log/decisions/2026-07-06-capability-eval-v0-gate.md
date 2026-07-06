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

The gate and choices below survived a 6-lens adversarial review (2026-07-06): the core design
(contested-band, seeds-only, IUT gate, reuse posture) is unchanged; the review hardened the gate's
inputs (relative-regression guard, provider-actual cost precondition, pre-registration + neutral
verification), named residual limits honestly (technique-leak, both-solve collider, pretraining
interaction), and scoped what a v0 result licenses against §8. Spec v0.2 folds in 23 findings.

## Decisions

1. **The gate (met/not-met-able).** On a frozen contested-band coding slate, arm A = stock
   jinn-agent, arm B = same agent + distribution-matched **seed loadout pre-installed** (no live
   retrieval), pinned model, R ≥ 3 repeats:

   > **PASS** iff, at α = 0.05 as an **intersection-union test** —
   > (1) **quality non-inferior**: Δ_quality = rate(B) − rate(A) > −δ, **δ = 5 percentage
   > points** (pre-registered with a stated basis; PASS additionally blocked when the relative
   > regression exceeds **15% of the stock base rate**, so a large relative drop at a low band base
   > rate cannot pass on the absolute margin); **AND**
   > (2) **cost strictly lower** on the tasks both arms solve: Δ_cost < 0, decided on
   > **provider-actual** token counts (heuristic-only cost → cost UNMEASURED → INCONCLUSIVE).

   Otherwise **FAIL** (clear regression or no cost win) or **INCONCLUSIVE** (underpowered at the
   achieved N, cost unmeasured, or the both-solve set below its pre-registered floor — reported with
   its MDE, treated as **not a pass**, and **terminal**: never silently re-screened into a PASS).

   **Scope (what a v0 result licenses against §8).** v0 is a seeds-only, no-live-retrieval,
   Haiku-class, contested-band **pre-gate**. A v0 PASS *supports* but does not fully discharge §8;
   a v0 FAIL/null does NOT by itself trigger §8's "stop and rethink" — a null is confounded between
   the corpus mechanism not helping and the generic skills.sh seeds being irrelevant to these
   contested tasks. A decisive §8 FAIL needs the deferred live-retrieval or distilled arm.

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
   content-addressed corpus snapshot along three content axes — instance_id, **repo**, and lexical
   gold-patch scan — via a fail-loud extension of `assertNoOverlap`, plus a per-record derived index
   so the instance/repo axes are **externally re-checkable** (the lexical axis is self-attested; raw
   corpus text stays private). These content axes prove the corpus lacks the *answer*; they
   **cannot** prove absence of a generic seed that supplies a slate task's *fix as a technique* —
   bounded only structurally by the distribution-matched, slate-blind, fixed seed loadout (attested
   in the artifact), with a semantic (embedding) axis optional at v0 and **mandatory at v1 arm C**.
   Model-pretraining contamination's **main effect** cancels in the paired difference (shared by both
   arms); its residual **skill×memorization interaction** (an arm-B-only cue that unlocks a memorized
   gold solution) does NOT cancel, and is bounded by the distribution-matched loadout + a pilot
   memorization-exposure probe (SWE-Bench Illusion, arXiv 2506.12286). **Corpus** contamination is
   what the proof targets, because it helps only arm B.

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

9. **Build vs adopt — adopt Inspect AI as the outer runner for the rig; no external eval supplies
   the number.** No public benchmark measures "does *our* corpus help *our* agent" (it is a
   differential on a slate disjoint from *our* corpus — irreducibly ours). But the plumbing is
   adoptable: the benchmark + grader are already reused (SWE-rebench-V2 + our scoring corrections),
   and the follow-on rig should adopt **Inspect AI** ([inspect.aisi.org.uk](https://inspect.aisi.org.uk))
   for the outer loop — its `sandbox_agent_bridge()` wraps a CLI agent in any language (validated
   fit for the jinn-agent fork), gives epochs (= our R), a pluggable scorer slot (our grader),
   and a scoring library with bootstrap CIs. Adoption is **partial** (keep our SWE-rebench-V2
   grader; do not use Inspect's vanilla SWE-bench scorer). One integration point to settle in the
   rig: token capture for the bridged CLI agent is not automatic — route its model calls through
   Inspect's proxy or capture from its own usage output. See `spec/2026-07-06-capability-eval-v0.md`
   §7.1. Independent corroboration: 2026 agent-ablation work uses the same paired McNemar/Wilcoxon
   and reports ~+6.4pp context-file effects, reinforcing the contested-band slate choice.

10. **Neutral verification + pre-registration (the team measures its own bet).** Recomputing the
    statistic from our records checks arithmetic, not fidelity — and every discretionary choice
    (band edges, ungradeable drops, when to stop) is made by the party who benefits from a PASS
    (PRINCIPLES → Neutral: the operator cannot be the house). Two binding requirements (spec §10.1):
    (a) a **pre-registered stopping rule** — band edges, candidate pool, screening model+R, δ + the
    relative cap, α, and the both-solve floor are content-addressed/signed **before** the pilot; the
    first run at the pilot-set N is the run of record; any re-screen/re-draw mints a new anchored
    slate version, published with its reason; an INCONCLUSIVE is never silently re-rolled into a
    PASS; the pilot feeds N/R sizing only, never band-edge selection. (b) an **independent fidelity
    re-run** of a random ≥20% pair subset by a party with no authorship stake, confirming re-run
    rates fall inside the published CIs; absent it, the report is labelled self-attested.

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
