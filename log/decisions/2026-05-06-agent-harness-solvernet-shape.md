---
id: DR-2026-05-06-a
title: SolverNet shape — per-task continuous over fresh-supply benchmark
date: 2026-05-06
verb: Steer
status: ratified
authors: ritsukai, opus (drafted on jinn-mono-9fe5)
spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md
---

## Context

`jinn-mono-9fe5` was dispatched to design a SolverNet for evolving agent harnesses, with a benchmark score as the aggregator. Three structural shapes were considered during the design exercise:

- **(α) Tournament SolverNet.** Solution = a Harness manifest CID; Evaluator runs the slate on the Solver's behalf; reward concentrated to top-K per round.
- **(β) Per-task continuous, no harness identity.** Each benchmark item = one Task; harness identity is post-hoc derivable from `Executor.codeDigest` rollups.
- **(c′) Per-task continuous + Improve loop.** As (β), but the operator-Harness's Improve phase reads peer trajectories from corpus; harness mutates in-flight; cross-operator harness-quality compounds via the producer-consumer overlap mechanism from #59 §1.

## Decision

**Select (c′) — per-task continuous on fresh-supply benchmark with Improve loop.**

Tasks are posted as individual benchmark items on JinnRouter. Operators claim and solve them via their Harness packages. Solutions carry trajectory + deliverable + Executor metadata (signed). Evaluator emits Verdict per Solution. Improve phase reads peer Verdicts and trajectories from corpus, mutates implStateDir, evolves harness over time.

The benchmark is the truth oracle (deterministic test-suite grading via SWE-rebench v2's per-instance Docker images); the substrate's compounding mechanism (corpus reads + Improve loop) is what makes harnesses get better at the benchmark over time.

## Rationale

- **Trajectory locality is preserved.** In (α), trajectories are produced by the Evaluator inside its sandbox — the corpus only fills if we explicitly require evaluators to publish their sandbox traces. That's a bolt-on and the trajectory is evaluator-flavoured (sandbox runs of someone else's code), not solver-flavoured (an operator solving a real Task in flight). The producer-consumer overlap mechanism from #59 §1 is broken or significantly weakened.
- **The compounding mechanism actually fires.** In (c′), every Solution envelope carries the operator's trajectory; the corpus accumulates richly; future operators read past trajectories on similar Tasks; their Improve loops update implStateDir; their next Tasks reflect what they learned. This is the substrate's load-bearing claim — it requires (c′)'s shape.
- **The evolutionary mechanic is emergent, not architected.** (α) requires the protocol to design generations / crossover / Pareto front explicitly. (c′) lets harness evolution be a per-operator strategy: some operators run hand-tuned harnesses, some run meta-Harnesses-that-generate-Harnesses, all compete in the same SolverNet. The protocol stays narrow.

## Alternatives considered and rejected

- **(α) Tournament.** Rejected primarily for trajectory locality. Round structure with per-snapshot CID submissions also forces Evaluators to absorb almost all compute; Solvers contribute only a few-byte CID per round; asymmetric economics worse than per-task. The "no harness beats traditional ones" concern is later resolved separately by the freeze-mode mechanism (DR-c) — the tournament shape is not necessary to get clean per-snapshot benchmark scores.
- **(β) Per-task with no harness identity.** Subsumed by (c′). The harness identity is automatically present in the `Executor.codeDigest` field; no separate mechanism needed.
- **(γ) Hybrid: per-task continuous + periodic tournament rounds layered on top.** Rejected as over-engineered for v1. The freeze-mode mechanism (DR-c) handles externally-comparable per-snapshot scoring without needing explicit round events.

## Consequences

- **Reuses existing protocol surface.** No new on-chain primitives. The SolverNet contract pattern from `2026-05-05-solvernet-creation-and-launch.md` v0.2 + the harness-pack-architecture's `Harness` interface are sufficient.
- **Memorisation vector is structural.** With corpus reads + Improve loop, finite-pool benchmarks (apex-agents, GDPval, SWE-bench Pro) converge to memorisation as Tasks recycle. This decision implies the benchmark choice (DR-b) MUST be fresh-supply.
- **Per-snapshot benchmark scores require a separate mechanism.** Operators' codeDigests mutate per Task in train mode; no clean per-snapshot benchmark signal emerges from train mode alone. The freeze-mode contract (DR-c) is the bridge.

## Status

Ratified by Captain ritsukai during the design exercise on jinn-mono-9fe5; locked 2026-05-06.
