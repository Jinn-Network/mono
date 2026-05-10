---
id: DR-2026-05-07-d
title: Generated Tasks post to own SolverNet `session-derived.v0`
date: 2026-05-07
verb: Steer
status: ratified
authors: oaksprout, opus (drafted on jinn-mono-6m7t)
spec: spec/2026-05-07-telemetry-collector-and-task-generator.md
---

## Context

The task-generator distils `role='capture'` envelopes from the corpus into atomic Tasks posted on JinnRouter. Three routing shapes were considered:

- **(α) Own SolverNet — `session-derived.v0`.** Launcher creates one SolverNet contract; every distilled Task posts into it. One evaluator (composite); one leaderboard; no classification.
- **(β) Route into existing SolverNets by classification.** Generator runs a classification pass over each capture: coding → swe-rebench-v2-shaped, prediction → prediction.v1, etc. Closer to GH#103's vision (outcome-similarity match; summon new SolverNet on miss).
- **(γ) Dynamic SolverNet summoning per capture-cluster.** Generator detects coherent clusters of captures and launches a new `session-derived.<topic>.v0` SolverNet on demand.

## Decision

**Select (α) — own SolverNet `session-derived.v0`.**

The launcher creates one `session-derived` v1.0.0 SolverNet contract instance. The task-generator posts every distilled Task into it. The contract's evaluator is composite (test-suite re-run where reproducible + structural similarity to capture's final patch + LLM-judge always); the aggregation is a 30-day rolling-window mean. (β) and (γ) are filed as future work.

## Rationale

- **Existing SolverNets have specific Task schemas.** `SweRebenchV2TaskSchema` requires `hf_dataset` + `instance_id` (HuggingFace dataset references); `PredictionV1TaskSchema` requires market identifiers. None of these are derivable from a generic captured session. Routing in v0 means either (a) constructing synthetic dataset entries that pretend to be from canonical sources (false provenance), or (b) skipping captures that don't fit (poor coverage). Both are worse than a dedicated SolverNet.
- **Classification is a v0.5+ research workstream.** The classifier needs a labelling corpus, accuracy metrics, confidence thresholds, and an operator-controlled override path. None of that exists at v0. Building it pre-launch blocks the collector on classification work that matters less than getting any captures flowing.
- **One SolverNet, one leaderboard.** v0's metric story is clear: how does the network's `session-derived` evaluator score Solutions to captured-and-distilled Tasks. Adding cross-SolverNet routing fragments the metric; you can't aggregate across heterogeneous schemas.
- **The composite evaluator handles signal-availability variance gracefully.** A capture with a reproducible test suite and a final patch gets all three signals; one with neither gets LLM-judge-only. The Verdict's `signal_breakdown` makes this transparent. This is the right place to absorb capture-quality variance, not in the routing layer.
- **GH#103 Q3 is correctly deferred.** The pooled-shadow-eval-sidecar writeup explicitly leaves "create-vs-route heuristics" open as a v0.5+ research surface. This decision is consistent with that framing.

## Alternatives considered and rejected

- **(β) Route into existing SolverNets by classification.** Rejected for v0 due to schema mismatch and classification-infrastructure cost. Filed as v0.5+ when (i) the corpus has enough capture volume to support a labelling exercise and (ii) downstream SolverNets have demonstrated demand for capture-derived Tasks.
- **(γ) Dynamic SolverNet summoning per capture-cluster.** Rejected for v0 as far out of scope. Captures have to flow before clusters can form; summoning machinery requires launcher-automation that isn't in scope. Filed as v1+ alongside the broader collapse-launcher-role question (GH#103 Q5).
- **Multiple parallel `session-derived.<topic>.v0` SolverNets at v0.** Considered as a mid-point — pre-defined topic SolverNets (coding, prediction, refactor, debug, etc.) without classification. Rejected because the operator would need to choose at capture time, and capture provenance doesn't naturally carry topic ("I worked on this for an hour" doesn't pre-classify). One SolverNet for v0; topic-shape evolves as the corpus matures.

## Consequences

- **`SESSION_DERIVED_V1_SOLVER_NET_CONTRACT` lands in `packages/sdk/src/contracts.ts`.** Sibling to `SWE_REBENCH_V2_V1_SOLVER_NET_CONTRACT` and `PREDICTION_V1_SOLVER_NET_CONTRACT`.
- **`@jinn-network/session-derived-evaluator`** is a new package with the composite evaluator (test-suite + structural-similarity + LLM-judge + signal-breakdown reporter).
- **Per-Verdict cost is heterogeneous.** Test-suite re-run can be expensive (Docker pull + test suite); LLM-judge is cheap; structural-similarity is local computation. Bonded evaluators absorb cost from the Verdict reward share per launcher manifest.
- **The 30-day rolling-window aggregation surfaces signal-coverage metrics** (`testSuiteCoverage`, `goldPatchCoverage`, `llmJudgeOnlyRate`) so consumers can interrogate the evaluator's signal mix. As capture volume grows and tooling improves, these shift toward the higher-trust majority.
- **Filed as v0.5+:** classification + routing into existing SolverNets (GH#103 Q3); dynamic summoning per cluster (GH#103 Q5); reward attribution back to the originating capture's operator.

## Status

Ratified by Captain oaksprout during the design exercise on jinn-mono-6m7t; locked 2026-05-07.
