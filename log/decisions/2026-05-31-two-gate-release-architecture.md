---
id: DR-2026-05-31
title: Two-gate release validation — split by determinism, verify-don't-rerun, environment suite in CI
date: 2026-05-31
verb: Steer
status: proposed
authors: opus + adrianobradley
relates-to: docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md (the spec this ratifies), docs/superpowers/specs/2026-05-19-release-readiness-and-substrate-design.md (the Tier ladder this replaces), docs/engineering/handbook.md §Cadence, DR-2026-05-20 (holistic release-review gate, unchanged), #341 (Ponder spawn helper), #531 (substrate doctor), #592 (RPC fallback chain)
---

## Context

A full audit of the release process (e2e tests, release skills, CI gates,
cadence) found that releases regularly block for *days*, the blocks are almost
never the product being broken, and the validation that is meant to catch
production issues mostly catches issues with itself.

The diagnosed root cause: high-fidelity validation (Tier 2/3) sits in four bad
places at once — on the blocking developer path, on the operator's laptop,
flaky-in-a-way-conflated-with-product-failure, and run twice (skill, then a
re-run at the publish guard because the hand-typed evidence marker isn't
trusted). The trust model is backwards: CI re-runs the cheap deterministic gate
but trusts a hand-typed string for the three expensive functional gates that
matter. Secondary findings: the indexer round-trip is a permanent skip stub
(#341); `daemon-harness` exits 0 when a harness key is absent; the real e2e
suite never runs in CI; the tiers grew by accretion and overlap.

## Decision

Adopt a **two-gate release architecture, split by determinism**:

1. **Hermetic gate (CI, per-PR, blocks merge to `next`)** — real daemon + real
   contracts (ours and real OLAS) on a **pinned Anvil snapshot** (not a fork),
   local Ponder for a real indexer round-trip, deterministic
   `prediction-v1-baseline` harness, adversarial conditions **provoked on real
   bytecode** rather than faked in a mock. Tests the loop, not the agent. Proves
   the code.

2. **Environment suite (a dedicated CI workflow, real testnet, gates the cut)** —
   real `claude-code` harness via **subscription auth** (`CLAUDE_CODE_OAUTH_TOKEN`,
   not an API key) against a **warm pre-staked testnet operator**. Consolidates
   today's scattered `yarn e2e` real phases + Tier 2 + Tier 3. Proves the real
   world.

Supporting decisions:

- **Verify, don't re-run.** Verdicts are **GitHub check-runs bound to the commit
  SHA** (`hermetic-gate`, `environment-suite`). The publish guard *queries* both
  on the release SHA and runs zero tests. The hand-typed marker retires.
- **Snapshot, not fork**, for the hermetic gate — no network on the blocking
  path, deterministic, no secret in PR CI, doesn't rot. Built by forking once.
- **Execution locus = CI, not laptop (Option B)** — the env-suite verdict is only
  trustworthy from a controlled box; this also eliminates the laptop-state
  (`JINN_PASSWORD`-poisoning) failure class.
- **Cadence = on-demand at readiness (authoritative) + one Thursday pre-flight
  (skip-if-unchanged)**; no daily run.
- **Three failure outcomes** — product-red (blocks), infra-blocked (not a
  regression), agent-quality (hard-asserted only with ground truth).
- The **warm operator is named, owned infrastructure**; lapses surface as
  `infra-blocked`.

The cadence primitives (`next` integration branch, canary-on-push, Monday named
cut, `promote-main`, hotfix sub-flow, the holistic release-review PR) are
**unchanged**. This DR changes what validates a release and where.

## Consequences

- The double-run dies (migration step 3 delivers it independently of the harder
  env work).
- A red gate means something: the hermetic gate can't flake on infra; the env
  suite's infra failures are classified distinctly from product failures.
- The indexer gap (#341) closes via local Ponder; bootstrap moves off the
  RPC-saturating critical path into the deterministic gate.
- New owned operational surface: a warm testnet operator that must be kept
  healthy, funded, and token-fresh, plus ~7 secrets in a protected `testnet-gate`
  Environment that must never be exposed to fork PRs.
- `release-readiness` slims to orchestration + canon audit + verdict-reading;
  `release-prep`'s run-role and the Tier ladder retire.

## Alternatives considered

- **Make the blocking gate fully real (status quo, more fidelity).** Rejected:
  fidelity on the blocking path is the cause of the multi-day blocks, not the
  cure.
- **Full hermetic, no real-world gate.** Rejected: a deterministic harness
  proves plumbing, not the production code against the real world; real-harness /
  real-chain / real-indexer drift would go uncaught.
- **Run the env suite on the operator's laptop (Option A).** Rejected: verdict is
  attestation-grade and the laptop-state failure class persists. Accepted cost of
  Option B: a funded testnet keystore in CI secrets (mitigated — testnet,
  dedicated, throwaway, protected Environment, no fork PRs).
- **Fork instead of snapshot for the hermetic gate.** Rejected: reintroduces
  network-on-blocking-path, non-determinism, a PR-CI secret, and silent rot.
- **Daily env-suite run.** Rejected: more than the drift rate justifies; burns
  subscription usage and warm-operator wear. Weekly-rhythm (readiness +
  Thursday pre-flight) suffices.
- **Harness API key.** Rejected in favor of subscription auth — flat-rate, fits
  the low-volume cadence, exercises the harness operators actually run, and auth
  failure classifies cleanly as infra.
