---
id: DR-2026-05-06-f
title: Reward function — task-complexity-weighted escrow (R2)
date: 2026-05-06
verb: Steer
status: ratified
authors: ritsukai, opus (drafted on jinn-mono-9fe5)
spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md
---

## Context

How does a Solver get paid per Task on `swe-rebench-v2`? Three candidates:

- **R1 — Per-Solution flat reward.** Each Task escrow is a fixed amount; Solution wins → operator gets full escrow; ties → half; losses → zero. Simple but doesn't distinguish trivial typo fix from complex multi-file refactor.
- **R2 — Per-Solution reward proportional to task complexity.** Launcher sets `escrowWei` per-Task proportional to a complexity proxy. Complex tasks pay more; trivial ones pay less. Aligns operator incentives with the economic value of the work.
- **R3 — Top-K-per-Task winner-takes-all.** Tournament flavour; only the top-K Solutions per Task earn from escrow.

## Decision

**Adopt R2 — task-complexity-weighted escrow.**

For SWE-rebench v2, the launcher's Task generator computes per-Task escrow as:

```
escrowWei = base_escrow_wei × (1 + α × normalized_loc + β × normalized_files + γ × normalized_tests)
```

where:
- `normalized_loc` is the gold patch line count, normalised against the SWE-rebench v2 monthly drop's distribution (rank or z-score).
- `normalized_files` is the gold patch file count, normalised similarly.
- `normalized_tests` is the `fail2pass` test count, normalised similarly.
- `base_escrow_wei`, `α`, `β`, `γ` are launcher-set parameters in the launched SolverNet manifest. Different launchers can pick different weightings.

Per-Solution reward: `escrowWei × Verdict.score` (binary 0/1 for SWE-rebench v2; would be `0|0.5|1` for pairwise-graded benchmarks).

Verdict price (`verdictPriceWei` in the manifest, paid to the bonded evaluator) is separate from the Solver escrow.

## Rationale

- **Aligns operator incentives with task value.** A Solution resolving a complex multi-file refactor with broad test coverage earns proportionally more than one resolving a 2-line typo. Operators choose harder Tasks when they expect their harness to win them; cheaper Tasks become low-stakes practice or substrate-flow contributions.
- **Aggregation function's `complexityWeighted` metric falls out naturally.** Network-level economic-weighted resolved rate = `sum(escrowWei × resolved) / sum(escrowWei)`. The economic-alignment story emerges from per-Task pricing, not from a separate aggregation rule.
- **Launcher-tunable.** Different launchers can run `swe-rebench-v2` SolverNets with different `α / β / γ` weightings, exposing different incentive shapes. Operators pick which launched manifest to participate in.
- **Cleaner than tournament dynamics for v1.** R3 (top-K winner-takes-all) introduces tournament shape that complicates per-Task economics and reward attribution. Per-Solution proportional rewards keep the per-Task model simple; tournament dynamics can be layered as an optional v2 feature.

## Alternatives considered and rejected

- **R1 (flat per-Task escrow).** Rejected: doesn't distinguish task complexity; encourages operators to cherry-pick easy Tasks.
- **R3 (top-K winner-takes-all).** Rejected for v1: introduces unnecessary complexity in per-Task reward attribution; tournament dynamics are useful for ecosystem-level benchmarking events but not for substrate per-Task economics. Filed as future v2 variation.
- **Per-Verdict-grade reward (proportional to a continuous quality score).** Currently `Verdict.score` for SWE-rebench v2 is binary. For judge-graded benchmarks (apex, GDPval) where Verdict is `0|0.5|1` or continuous, R2 generalises trivially: `escrowWei × Verdict.score` works at any grading granularity. Not a separate decision.

## Consequences

- **Task generator computes per-Task escrow at posting time.** Requires the generator to fetch SWE-rebench v2's metadata for each Task (gold patch, files, tests), normalise against the monthly drop's distribution, and emit per-Task `escrowWei` in the JinnRouter posting transaction. Launcher-side complexity; operator-transparent.
- **Aggregation `complexityWeighted` is the natural network-level economic-substrate metric.** Per DR-e §Consequences.
- **Operator selection emerges.** Operators with strong harnesses on complex tasks earn disproportionately more by attempting them; operators with cheaper / simpler harnesses focus on lower-escrow Tasks. Pareto-front of operator strategies emerges naturally.
- **Manifest schema includes `α / β / γ` parameters.** Per the SolverNet manifest publishing pattern in `2026-05-05-solvernet-creation-and-launch.md` v0.2 §6.2, these become part of the signed launched-instance manifest. Different launched instances can advertise different parameters.

## Status

Ratified by Captain ritsukai during the design exercise on jinn-mono-9fe5; locked 2026-05-06.
