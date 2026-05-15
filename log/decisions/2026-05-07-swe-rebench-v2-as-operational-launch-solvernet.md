---
id: DR-2026-05-07-h
title: SWE-rebench v2 is the operational launch SolverNet; trace-harvester sequences after
date: 2026-05-07
verb: Steer
status: ratified
authors: ritsukai (proposed), oak (ratified)
spec: GROWTH.md §3, §7; spec/2026-05-07-telemetry-collector-and-task-generator.md §9 (separate edit)
---

## Context

Two candidate SolverNets are being designed concurrently for Phase A.5+:

- **swe-rebench-v2** — a rolling-refresh program-repair benchmark on real GitHub issues, sourced from the `nebius/SWE-rebench-leaderboard` HuggingFace dataset (~750 instances at v1 launch, ~50/month thereafter). Shape: `task generator → solver → docker eval → settlement`. Plan: `docs/superpowers/plans/2026-05-06-swe-rebench-v2-solvernet.md`. Spec: `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md`.
- **trace-harvester / session-derived** — a telemetry collector that captures local agentic-CLI sessions into signed envelopes published to the corpus, plus a `session-derived.v0` SolverNet that LLM-distils captures into atomic Tasks. Shape: `task generator → solver → docker eval → settlement` (same loop). Spec: `spec/2026-05-07-telemetry-collector-and-task-generator.md`. Plan: `docs/superpowers/plans/2026-05-07-telemetry-collector-and-task-generator-plan.md` (~14 weeks build).

The earlier draft of the trace-harvester spec §9 allowed both to ship "concurrent or sequential, depending on resourcing." During the 2026-05-07 session between Ritsu and Oak, that posture was tightened: swe-rebench-v2 ships first as the operational launch SolverNet; trace-harvester sequences after; the question of whether trace-harvester is fully subsumed by parameterising swe-rebench-v2's task generator is open.

## Decision

**The first SolverNet that the network launches operationally — i.e., the first one targeted for real operator participation, real settlement, and the canonical recruit pitch in GROWTH §3 + §4 Phase 1 — is `swe-rebench-v2`.** The trace-harvester / telemetry-collector + session-derived SolverNet sequences *after* swe-rebench-v2 demonstrates the launch shape, and is potentially subsumed by it via task-generator parameterisation.

The recruit-time pitch while swe-rebench-v2 is the SolverNet of focus is *"help collectively train a swe-rebench v2 harness."*

## Rationale

Three reasons, each load-bearing:

- **Monthly task refresh structurally mitigates memorisation.** A static benchmark's signal degrades to zero over time as solvers (and their training data) absorb the corpus. SWE-rebench v2's monthly refresh keeps the signal alive without requiring novel infrastructure to enforce — the upstream maintainers do the work of producing fresh tasks. Within-month memorisation remains a concern and is being instrumented in Sprint #3, but the structural pressure is in the right direction. No static benchmark we considered (SWE-bench, GAIA, HumanEval, AgentBench, etc.) has this property.
- **The shape doubles as scaffolding.** The `task generator → solver → docker eval → settlement` loop swe-rebench-v2 needs is the same loop the trace-harvester's `session-derived.v0` SolverNet needs. Building it once for swe-rebench-v2 leaves the trace-harvester's task-generator as a parameterisation rather than a from-scratch build. Effort compounds rather than fragmenting.
- **Time-to-launch.** swe-rebench-v2's task source (HuggingFace dataset) and evaluator (the upstream `eval.py` harness in Docker) are external; we don't need to ship the operator-side capture surface (four-path collector, Captures-tab UI, harness-bundle assembler) to start running. The trace-harvester takes ~14 weeks of build per its plan; swe-rebench-v2's plan is shorter and produces a running network sooner. A running network with operators is the §2 bottleneck — sooner is strictly better.

## Alternatives considered and rejected

- **Concurrent: ship both swe-rebench-v2 and trace-harvester in parallel.** Rejected: (a) splits engineering focus during the launch window, (b) duplicates the launch-shape work since the trace-harvester's session-derived SolverNet uses the same loop, (c) doubles the recruit-pitch surface area at exactly the moment the §3 pitch needs to be sharp. The whole point of having one named pitch in GROWTH §3 is to focus the legitimacy bet; two SolverNets at launch dilute that.
- **Trace-harvester first, swe-rebench-v2 second.** Rejected: trace-harvester ships ~14 weeks of work and depends on the operator-side capture surface; swe-rebench-v2 can run with external task source and external evaluator. Reversing the order delays the operational launch, against the §2 bottleneck.
- **Skip swe-rebench-v2 entirely and only ship trace-harvester (the substrate).** Rejected: leaves the network with no operational SolverNet during the trace-harvester's build, and risks the recruit pitch being entirely abstract ("you'll be able to publish your sessions some day") rather than concrete ("here's a running benchmark you can join today").

## Consequences

- **GROWTH.md §3** — the concrete recruit pitch is *"help collectively train a swe-rebench v2 harness"* while swe-rebench-v2 is the operational SolverNet of focus. Updated alongside §7 when the SolverNet of focus changes.
- **GROWTH.md §7** — wording shifts from "Currently testing: swe-rebench v2" to "Operational launch SolverNet: swe-rebench v2 — locked 2026-05-07 (DR-2026-05-07-h)" and explicitly notes the trace-harvester sequences after.
- **`spec/2026-05-07-telemetry-collector-and-task-generator.md` §9 (separate edit)** — phase placement tightens from "concurrent with or sequential to swe-rebench-v2, depending on resourcing" to "sequenced after swe-rebench-v2 demonstrates the operational launch shape." Explicit ordering: A.1 → h43b → swe-rebench-v2 (A.5) → this spec (A.5+).
- **Implementation sequence.** Engineering capacity is directed to swe-rebench-v2 first per `docs/superpowers/plans/2026-05-06-swe-rebench-v2-solvernet.md`. Trace-harvester implementation begins after swe-rebench-v2 ships and produces real settlement on testnet. The trace-harvester's own implementation plan (`docs/superpowers/plans/2026-05-07-telemetry-collector-and-task-generator-plan.md`) remains valid; only its kickoff date moves.

## Open

- **Subsumption viability.** Whether swe-rebench-v2's task generator can be parameterised to also consume capture envelopes (in addition to HuggingFace dataset rows) is open. If yes, the session-derived SolverNet may collapse into a multi-source mode of swe-rebench-v2 — saving the §5 + §6 build of the trace-harvester spec. If no, both ship as siblings. Empirical question; revisit at the swe-rebench-v2 retro once both task-source shapes have been exercised, or at the trace-harvester spec's v0.5 retro if that ships first.

## Status

Proposed by ritsukai during the 2026-05-07 GTM-sequence session; ratified by Captain oak in the same session. Locked 2026-05-07.
