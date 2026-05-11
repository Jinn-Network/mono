---
id: DR-2026-05-11-a
title: Prediction SolverNet is frozen; SWE-rebench v2 is the sole operational SolverNet through v1+
date: 2026-05-11
verb: Steer
status: ratified
authors: oak (proposed and ratified)
spec: GROWTH.md §3, §7; SPEC.md (Phase A narrative); CLAUDE.md (project overview)
supersedes-context-from: DR-2026-05-07-h
---

## Context

DR-2026-05-07-h locked SWE-rebench v2 as the operational launch SolverNet while leaving Prediction (Polymarket-derived) co-resident in the codebase and bd backlog. The `l2zl` epic and 11+ child issues continued to track Prediction build-out, the `uy6v` release epic was Polymarket-flavored in its body ("Launcher generator creates and posts tasks (Polymarket-derived)"), and contributor energy split between two SolverNets at exactly the moment the §3 recruit pitch needed to be sharp on one.

The 2026-05-08 single-operator SWE-rebench v2 loop closure (DR-2026-05-08; task `45` posted → solved via Codex learner → settled with `score: 0` / `passed_match: false`) proved the loop runs but exposed how much remaining work — multi-operator dogfood, cross-operator donation consumption, canary fleet stability, verdict success, JINN reward distribution — is on the SWE-rebench v2 path specifically.

## Decision

**Prediction SolverNet is frozen as of 2026-05-11.** SWE-rebench v2 is the sole operational SolverNet through the first public testnet release and the immediate post-release window (Hermes harness integration, Phase A.5+ self-modifying learner).

Concretely:

- No new Prediction-flavored work is merged. Code review rejects Prediction-only changes; bug fixes against existing Prediction surfaces require explicit Captain approval citing why the fix is load-bearing for SWE-rebench v2 or shared infrastructure.
- Existing Prediction code (Polymarket task generator, prediction.v0 / prediction.v1 contracts, prediction-flavored plugins and harness pieces) remains in place. It is not deleted. It is not maintained.
- All `l2zl*` bd epics and Prediction-only child issues close as **deferred** with reason "Prediction frozen 2026-05-11 — DR-2026-05-11-a." SolverNet-agnostic bugs that happened to live under `l2zl.15.4.*` reparent under the SWE-rebench v2 release epic (`uy6v`).
- Canonical docs (SPEC.md Phase A narrative, GROWTH.md §3 + §7, CLAUDE.md project overview) gain a short freeze note pointing at this DR.
- The `uy6v` release epic body is rewritten to point at SWE-rebench v2 explicitly; its Polymarket-derived framing is removed.

The recruit-time pitch remains *"help collectively train a swe-rebench v2 harness"* per DR-2026-05-07-h §Decision.

## Rationale

Three reasons, in order of weight:

- **Focus during the launch window.** The first public testnet release is the §2 bottleneck. Splitting engineering or contributor energy across two SolverNets dilutes the pitch and slows the gate. DR-2026-05-07-h chose SWE-rebench v2 as the operational launch SolverNet but kept Prediction co-resident; in practice that co-residency consumed review cycles and bd-backlog churn without producing release-relevant artifacts. Freezing makes the focus structural rather than aspirational.
- **The loop-closure evidence points at SWE-rebench v2.** As of 2026-05-08 the SWE-rebench v2 loop has closed end-to-end on Base Sepolia with real settlement; the Prediction loop has not been similarly demonstrated. Investing further in the un-demonstrated path during the launch window inverts the appropriate risk posture.
- **Subsumption is plausible.** DR-2026-05-07-h §Open already flagged that SWE-rebench v2's task-generator may be parameterisable to consume other task sources. If that lands, Prediction-shaped tasks become a multi-source mode of SWE-rebench v2 rather than a separate SolverNet build-out. Freezing now preserves that option without committing to it.

## Alternatives considered and rejected

- **Continue co-residence (status quo).** Rejected: §2 bottleneck pressure makes the focus split a real cost, and the lack of a Prediction loop closure makes the Prediction investment higher-variance than the SWE-rebench v2 investment.
- **Kill: delete Polymarket code, contracts, plugins; close all related bd issues as won't-do; canonical-doc pass to remove Prediction from SPEC/GROWTH/THESIS.** Rejected: forecloses the subsumption option from DR-2026-05-07-h §Open; introduces deletion-pass work during the launch window when capacity is already constrained. Preserving the code at zero maintenance cost is cheaper than re-deriving it if the subsumption question lands in Prediction's favour.
- **Sunset: soft-deprecate with a 30-day sunset window post-v1, then kill.** Rejected: defers the freeze-cleanup work into the immediate post-v1 window when Hermes harness integration and the self-modifying learner are already loading that window. Plain freeze keeps the post-v1 window for Hermes and the learner.

## Consequences

- **SPEC.md** — Phase A narrative gains a one-line freeze note citing DR-2026-05-11-a; the Prediction SolverNet references stay as historical context.
- **GROWTH.md** — §3 + §7 reflect that Prediction work is frozen; the pitch language stays anchored on SWE-rebench v2 per DR-2026-05-07-h.
- **CLAUDE.md** — Project overview gains a freeze note so contributors and AI agents stop wandering into Prediction surfaces.
- **bd backlog** — Prediction epics and child issues close as deferred; SolverNet-agnostic bugs reparent under `uy6v`; a new "EPIC: Freeze Prediction SolverNet (cleanup-tracked)" tracks the canonical-doc and review-guardrail work.
- **Review policy** — Reviewers reject Prediction-only PRs unless the author cites Captain approval for shared-infrastructure rationale. Code-owners notes (CONTRIBUTING-style) capture the rule.
- **Release epic `uy6v`** — Rewritten to point at SWE-rebench v2 explicitly. The `8qbc` Claude Code learner self-modification child moves out to a new Phase A.5+ self-modifying learner sibling epic.

## Open

- **Subsumption viability** (carried forward from DR-2026-05-07-h §Open). Revisit at the SWE-rebench v2 retro once two-source task generation has been exercised, or when the freeze is reviewed.
- **Freeze review trigger.** Reviewed when one of: (a) SWE-rebench v2 ships v1 public testnet and Hermes harness lands, (b) external participant interest in Prediction emerges with credible operator capacity, (c) 90 days elapsed. Whichever fires first.

## Status

Proposed and ratified by Captain oak on 2026-05-11. Locked.
