---
id: DR-2026-05-06-h
title: Phase placement — A.5 (post-A.4 campaign launch)
date: 2026-05-06
verb: Steer
status: ratified
authors: ritsukai, opus (drafted on jinn-mono-9fe5)
spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md
---

## Context

`spec/2026-04-30-phase-a-umbrella.md` defines Phase A as the operational-loop + campaign-ready surface around `prediction.v1`. Phase A.4 trips when the campaign launches. The new SolverNet (`swe-rebench-v2`) and the freeze-mode mechanism could ship in two placement options:

- **(α) Phase A.5 — sequential after A.4.** Ships after the prediction-led campaign launches.
- **(β) Parallel to A.3.** Ships alongside Phase A.3's Polymarket-derived dashboard work; campaign launches with two SolverNets.

## Decision

**Adopt (α) — Phase A.5, sequential after Phase A.4 campaign launch.**

A.5 acceptance is the v1 acceptance criteria from the spec §9.2 plus: at least 3 operators participating in the launched `swe-rebench-v2` SolverNet on testnet; at least one published HarnessCheckpoint with cross-operator validation (≥2 operators running it).

## Rationale

- **Avoids splitting recruitment focus.** `prediction.v1` is the campaign-launch focus per #57; the recruitment cluster is forecasters / Polymarket-bot operators. Adding `swe-rebench-v2` in parallel risks splitting focus between two clusters with different recruitment narratives. Sequential lets the prediction launch dominate, then the substrate-generalisation story follows.
- **The substrate vision is primarily satisfied by `prediction.v1`.** #59's producer-consumer overlap mechanism operationalises through the corpus library + Improve loop running on Polymarket-fresh markets. `swe-rebench-v2` extends the substrate to a second cluster but doesn't carry the substrate burden alone in v1.
- **Freeze-mode mechanism back-applies cleanly.** Shipping `swe-rebench-v2` as A.5 means the freeze-mode protocol contract lands across the entire protocol — including back-applied to `prediction.v1`. Operators in `prediction.v1` can also flip to frozen mode and benchmark their forecasting harnesses (against held-out markets, against synthetic test slates, against historical Polymarket resolutions). The freeze mechanism is a protocol feature, not a SolverNet-specific feature; A.5 placement makes that explicit.
- **The narrative becomes "the substrate generalises."** The campaign launches with `prediction.v1`. After campaign-launch trips A.4, the network adds a second SolverNet. External story: "The substrate is the training environment; the second SolverNet (coding-agent benchmark) demonstrates that the substrate isn't single-purpose. More SolverNets follow." This is a stronger ecosystem-formation story than "we launched two SolverNets simultaneously."

## Alternatives considered and rejected

- **(β) Parallel to A.3.** Rejected: splits recruitment focus during the campaign launch; creates pressure to ship two SolverNets simultaneously when one is enough for the substrate's existence-proof claim. Filed for re-evaluation if A.4 trips fast and operator demand for a second SolverNet emerges before the A.5 ship is ready.
- **Phase B (gated by attested-tier work).** Rejected: gating `swe-rebench-v2` on Phase B.1 attested-tier delays the SolverNet ship behind the TEE infrastructure work, which is its own multi-month workstream. The honor-system trust stack (DR-d) is sufficient for v1; B.1 is the credibility upgrade, not the gating prerequisite.
- **No phase placement (ad-hoc whenever).** Rejected: protocol additions need named gates per the Charter; A.5 is the natural gate that follows A.4 in the existing Phase A umbrella.

## Consequences

- **A.4 → A.5 → A.6 sequence.** A.4 = campaign launches; A.5 = `swe-rebench-v2` + freeze-mode mechanism; A.6 (open) = whatever the next SolverNet or substrate extension is.
- **Implementation plan timing.** A.5 implementation work can begin in parallel with A.4 campaign-launch finalisation, but the SolverNet's testnet launch (the "operators participating" acceptance) gates on A.4 trip.
- **The freeze-mode mechanism becomes available across all SolverNets, not just `swe-rebench-v2`.** `prediction.v1` operators can flip to frozen mode and benchmark forecasting harnesses against held-out markets. The mechanism is protocol-level (DR-c).
- **Future SolverNets follow the same pattern.** Apex post-partnership; GDPval post-fresh-supply-infrastructure; SWE-rebench V2 as v1.5 companion. Each is its own phase gate (A.6, A.7, …) following the same structure.

## Status

Ratified by Captain ritsukai during the design exercise on jinn-mono-9fe5; locked 2026-05-06.
