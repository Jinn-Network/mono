---
id: DR-2026-06-08
title: Paired (two-operator) SPA flow runs as a soft, human-judgment gate on the Monday named cut
date: 2026-06-08
verb: Steer
status: ratified
authors: opus (brainstorming session with ritsuKai2000)
amends: [DR-2026-06-03](2026-06-03-app-experience-coverage-two-modes.md) — its Mode 2 decision ("manual runbook, NOT a gate") is narrowed: the runbook stays manual and non-automated, but running it becomes a soft pre-publish gate on the Monday cut.
relates-to: [DR-2026-05-20](2026-05-20-holistic-release-review-gate.md) (the holistic release-review gate — the soft-gate shape this mirrors), [DR-2026-05-31](2026-05-31-two-gate-release-architecture.md) (two-gate architecture — the publish-guard "exactly two SHA-bound contexts" contract this deliberately does NOT touch), `.claude/skills/testing-jinn-app/references/scenario-multi-op-spa-flow.md` (the runbook this gates on), `docs/engineering/handbook.md` §Cadence
---

## Context

[DR-2026-06-03](2026-06-03-app-experience-coverage-two-modes.md) split app-experience
coverage into Mode 1 (deterministic mocked-daemon SPA flow tests, gating, in
`hermetic-gate`) and Mode 2 (the real two-operator paired SPA flow). It made Mode 2
a **manual runbook, explicitly not on a gate** — and that call was correct *for an
automated test*: against real Base Sepolia + a shared rate-limited RPC + IPFS + the
indexer, the paired flow's timing is irreducibly non-deterministic, so an automated
version can only flake, and a flaky red can't be told from a real bug.

But the DR's resolution left a real residue: **nothing requires the paired flow to
run before a release.** Mode 1 mocks the cross-operator handshake (op-b's catalog
fixture *contains* op-a's manifest); the environment-suite covers the real-world
*protocol* layer at the API level (T2.1/T2.2/T3.1) but drives **no browser**. So the
one thing only the paired flow exercises — the real cross-operator *app* experience
(on-chain launch propagating through chain + indexer + IPFS to a second operator's
SPA: catalog discovery, JoinFlow's full-manifest IPFS fetch, the per-operator
keystore-password restore path) — can ship a Monday cut entirely unverified
end-to-end, indefinitely.

## The reframe that makes this coherent with the DR it amends

DR-2026-06-03 rejected an **automated** gate because a flaky automated red is
indistinguishable from a real bug. A **human-run** gate does not have that failure
mode: the human *is* the classifier — a person can tell "that was an RPC 429, re-run"
from "that's a real regression in the join flow." So requiring a human to run the
paired flow before the cut recovers the missing end-to-end app coverage **without**
re-importing the flake-blocks-release problem the DR exists to avoid. This is
additive to DR-2026-06-03's reasoning, not a reversal of it: Mode 2 stays a manual,
non-automated runbook; what changes is that running it becomes expected, and its
verdict is recorded where Captain already looks before publishing.

## Decision

The paired flow (Mode 2) becomes a **soft, human-judgment gate on the Monday named
cut**, modeled exactly on the holistic release-review gate
([DR-2026-05-20](2026-05-20-holistic-release-review-gate.md)).

- **Strength — soft.** Nothing in `npm-publish.yml` mechanically blocks. The gate is
  "the check existing and being done," enforced by the pre-publish ritual, not by CI.
  The publish guard's **"exactly two SHA-bound contexts"** contract
  (`hermetic-gate` + `environment-suite`, DR-2026-05-31 spec §7) is **untouched** —
  this adds **no** third queried check-run.
- **Trigger — every Monday named cut, unconditionally.** No conditional-on-app-diff
  logic: it is always on the checklist.
- **Operational gate — the standing release-review PR.** The Monday scaffold
  (`.github/workflows/release-notes-scaffold.yml`) adds a checklist line to the
  release-review PR body. Before publishing, Captain runs the runbook, judges the
  outcome, and fills the line. This co-locates the paired-flow judgment with the
  whole-window-diff judgment Captain already makes on that PR.
- **Durable record — `release-readiness-runs.md`.** One appended line per cut records
  the verdict, so "did we run the paired flow before v2026.MM.DD, and what did it
  say?" is answerable without spelunking closed PRs.
- **Three outcomes (mirroring the env-suite taxonomy):**
  - **pass** → tick ✅, proceed.
  - **infra-blocked** (RPC 429 / IPFS lag / warm-operator lapse — human judges it is
    not the product) → tick ⚠️, record the symptom in the log line, **proceed**. This
    is the whole point of it being human-run rather than automated.
  - **product-red** (human judges a real app / cross-op regression) → ❌, **hold the
    cut**: do not publish; file a `fix` (or `fix(incident)` if it is already in
    `@latest`); re-run before publishing. A product-red that ships anyway becomes a
    **known-issue** in the Release notes.
- **Scope — Monday named cut only.** Hotfixes are **exempt by construction**: they
  target `main` directly and do not open a release-review PR, so the gate's surface
  does not exist for them. This also fits the hotfix philosophy (smallest patch,
  relaxed review, ship fast); the next Monday cut re-verifies the app surface.

## Consequences

- `.github/workflows/release-notes-scaffold.yml` — the release-review PR body gains a
  "Pre-publish checklist" with the paired-flow line, so it appears every week and
  cannot carry over stale (the scaffold reopens a fresh PR per window).
- `docs/engineering/handbook.md` §Cadence — documents the paired-flow soft gate as a
  sibling of the holistic release-review gate.
- `.claude/skills/testing-jinn-app/references/scenario-multi-op-spa-flow.md` — the
  runbook gains a closing "record your verdict (pass / infra-blocked / product-red)"
  step and its "don't wire it onto a gate" framing is reconciled: it stays off
  *automated* gates, but is now run as a soft *human* gate on the Monday cut.
- No CI/publish-guard plumbing changes; no new secrets; no new owned infra beyond the
  warm operators the env-suite already maintains.
- Honest residual: a soft gate that proceeds on infra-blocked can, on a chronically
  flaky testnet week, pass without a clean end-to-end run. That is the accepted cost
  of *soft* + *human-judged* — the alternative (block on infra) is the failure mode
  DR-2026-06-03 deleted T2.3 to escape.

## Alternatives considered

- **Hard mechanical block via a human-posted `paired-flow` check-run bound to the
  release SHA.** Rejected: it adds a third queried context (breaks the publish-guard
  §7 "exactly two" contract, needs waiver plumbing) and re-introduces "a red I can't
  trust blocks the release" — just with a human instead of a flake.
- **Conditional trigger (run only when the release window's diff touches the SPA
  render dirs).** Rejected in favor of unconditional: cheaper to enforce as a habit
  (always on the checklist, never a "does it apply this week?" judgment), and the
  operator chose the simpler ritual. A monthly-floor variant remains a cheap future
  upgrade if weekly cost bites.
- **Record the verdict in the public Release notes as the primary home.** Rejected as
  primary: routine process-state ("paired flow passed") is noise in user-facing
  notes. Release notes carry the verdict only when a product-red ships as a
  known-issue.
- **Extend the gate to hotfixes.** Rejected: hotfixes have no release-review PR
  surface and an out-of-cadence real-testnet paired run fights the relaxed-rigor,
  ship-fast hotfix lane.
- **Keep DR-2026-06-03 as-is (no gate).** Rejected: that is the gap this DR exists to
  close — the real cross-operator app experience could ship unverified end-to-end
  forever.
