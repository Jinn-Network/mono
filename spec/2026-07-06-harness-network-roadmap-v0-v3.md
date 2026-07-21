# Jinn harness-network roadmap — v0 to v3

- **Version:** 0.1 (draft — design session 2026-07-06)
- **Date:** 2026-07-06
- **Author:** Ritsu (design session)
- **Shape:** `design` — output is this roadmap
- **Parent:** `spec/2026-07-02-jinn-harness-network.md` (the vision). This is the
  versioned execution scoping, revised for the already-shipped `jinn-agent` fork.

## Spine

One number decides everything: **does a corpus-connected `jinn-agent` beat the same
agent stock — equal quality, lower total cost?** The roadmap is a de-risking
staircase: each version answers one question, re-measures that number, and does not
advance until the prior bet has paid. The entire economic layer is gated behind
proof; the core thesis (v0–v1) needs no contracts.

## Current state (baseline)

- **Built & shipping:** the `jinn-agent` fork (rebranded Hermes — consent flow,
  `/corpus` search, `corpus_search`/`corpus_fetch` tools, `/jinn skills install`),
  the consume SDK, the capture → scrub → publish → ledger pipeline, seeding (84
  skills.sh skills anchored), the distribution-signal view.
- **Broken:** scrub over-redaction defaces published content (mono #1409) — seeds
  come back mangled.
- **Not built:** the capability eval rig, distillation (layer-1 evidence → layer-2
  consumables), all economic contracts.

## v0 — Consume · *does connecting to the corpus help at all?*

- Build: fix scrub (#1409) → re-import clean seeds → the A/B capability rig. Capture
  stays on (default) to start the evidence flywheel — nothing consumes those traces
  yet.
- No contracts, no distillation.
- **Gate:** `jinn-agent` with seeded skills ≥ stock, on one distribution (recommend
  **coding** — seeds, the swe-rebench-v2 eval harness, and existing execution data
  all point there).

## v1 — Distill · *does the contribution loop close — does real usage beat imported public skills?*

- Build: distillation (layer-1 evidence → layer-2 SKILL.md) on the one distribution,
  plus the SolverNet-execution → corpus bridge (feed swe-rebench trajectories in).
  Re-measure.
- Still no contracts; distillation is a manual/scripted pipeline, not yet network
  work.
- **Gate:** distilled-from-evidence > seeds-only baseline. This is the core thesis —
  *the network deepens itself*.

## v2 — Earn · *will people contribute more/better when it pays, gaslessly?*

- Build: `ContributionActivityChecker` (contract), one-command sidecar node, gasless
  batch relayer (Tier-1 credits), stOLAS-pool bond (Tier-2). Verification gate before
  eligibility (anti-farming).
- First contracts land here — only because v0–v1 proved the corpus is worth paying
  for.
- **Gate:** a contributor with zero crypto setup earns emissions for verified
  contributions end to end, no wallet touched; capability number holds or rises.

## v3 — Deepen · *can distillation scale as paid network work, across distributions?*

- Build: distillation-as-network-task (SolverType generators operators run and earn
  from), driven by the distribution signal ("deepen where usage concentrates"); more
  than one distribution.
- **Gate:** the corpus deepens beyond the hand-run distribution; capability lifts
  across distributions.

## Through-lines

- **The capability number is the spine**, re-measured every version — not a one-time
  v0 gate. Any version that doesn't move or hold it is noise.
- **v0–v1 need zero contracts** — the whole premise can fail-fast on pure product +
  eval.
- **Contribution/capture is on from v0**, accumulating evidence each version does more
  with: unused (v0) → distilled (v1) → paid (v2) → network-scaled (v3).

## Out of scope of this one-pager (v4+)

Steer (veOLAS + per-distribution staking programs, manual then automated), plugin
distribution to other harnesses, and trust/verification economics (Phase B). Steer is
deferred by design (Gall's Law, friction-gated); plugin distribution depends only on
consume and could run as a parallel GTM track post-v1.

## Spec mapping

This re-scopes `spec/2026-07-02-jinn-harness-network.md`: its v0 (consume + capture)
is largely shipped and absorbed into this v0; its v0.5 (earn) = **v2**;
distillation-as-a-network-task = **v3**; its v1a/v1b (steer) are **v4+**.
