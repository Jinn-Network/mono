---
id: DR-2026-05-06-c
title: Frozen-state contract — at the Harness-interface level
date: 2026-05-06
verb: Steer
status: ratified
authors: ritsukai, opus (drafted on jinn-mono-9fe5)
spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md
---

## Context

DR-2026-05-06-a commits the SolverNet to per-task continuous shape with Improve-loop compounding. A consequence: operators' codeDigests mutate per Task in train mode; no `(implName, codeDigest)` ever runs the canonical benchmark slate; per-codeDigest rollups are confounded by Task-subset selection.

This produces an "no externally-comparable harness" gap. External recruitment, comparison to traditional harness leaderboards (OpenHands, SWE-Agent, Aider, Pi.dev), and forkable starting-state semantics all need a frozen-artifact-shaped entity.

## Decision

**Add a `mode: 'train' | 'frozen'` field to the `Harness` interface contract via `HarnessContext.mode` and the envelope's `Executor.mode`. The contract: when `ctx.mode === 'frozen'`, a Harness MUST NOT cause persistent writes to `ctx.implStateDir`.**

Enforcement is a layered trust stack (DR-d). The mode flag propagates from operator-side daemon config through to every `harness.run(ctx)` invocation. Each Harness package is responsible for respecting the contract; the daemon enforces by hashing implStateDir before and after each Task in frozen mode and rejecting envelopes where the hash changed.

## Rationale

- **Protocol-level, not harness-specific.** Locking freeze to claude-code-learner contradicts the Path-1 / Path-2 recruitment paths from `spec/2026-04-30-plug-in-surface.md`. The contract belongs at the `Harness` interface level so any Harness package — claude-code-learner, Path-2 forks, Pi.dev port, Stirrup-based custom harness, OpenHands bridge, etc. — implements it the same way.
- **Reuses existing identity machinery.** The Executor field already names `(implName, implVersion, codeDigest, signingKey)`. Frozen mode produces stable codeDigest across the window; the per-checkpoint identity is `(implName, implVersion, codeDigest)`. No new artifact type required.
- **Maps cleanly to ML training conventions.** `train` is universally understood (PyTorch's `model.train()`); `frozen` is standard ML transfer-learning vocab ("frozen weights"). Pairing avoids `eval` overload with the SolverNet protocol's Evaluator role. Recruits in our cluster understand the semantics with zero translation.
- **Makes the substrate-vs-benchmark synthesis honest.** The substrate is structurally a training environment (continuous, mutating, compounding via corpus reads). Frozen mode is the discipline that crystallises flow into a benchmark-comparable artifact. The two stories compose; neither dominates.
- **Cross-Harness benchmark competition emerges naturally.** The frozen-mode leaderboard surfaces multiple distinct Harness packages' frozen states with comparable scores. Real harness ecosystem; real recruitment surface for builders shipping their own runtime.

## Alternatives considered and rejected

- **Claude-code-learner-specific freeze.** Add a "freeze" feature only to the bundled learner. Rejected: locks one Harness package as the protocol's measurement target; contradicts Path-1 / Path-2; Path-2 builders shipping their own Harness can't get benchmark identity.
- **Separate HarnessSnapshot / HarnessCheckpoint manifest as a parallel artifact type.** Voluntary publication that runs alongside the envelope flow. Rejected as too heavy: requires new manifest schema, new CLI, new IPFS publish discipline, new ERC-8004 anchor pattern. The freeze-mode-on-the-existing-Harness-interface approach achieves the same artifact identity without a new artifact type. (HarnessCheckpoint as voluntary publication on top of the freeze mechanism is retained — see §7 of the spec — but it's an optional discoverability layer, not the load-bearing identity primitive.)
- **Layer-4 benchmark rounds with mandatory snapshot freeze.** Periodic events where operators commit to a frozen snapshot for one round window. Rejected as over-engineered for v1: ad-hoc operators flipping to frozen mode produce per-checkpoint scores derivable from continuous-stream Verdicts on whatever Tasks they happened to claim while frozen. Confidence intervals reflect partial-slate coverage; the `verified frozen` tier (DR-d) provides external credibility without explicit rounds.

## Consequences

- **Two-leaderboard dashboard.** Train-mode and frozen-mode rollups are surfaced separately. Train-mode is the substrate-progress signal; frozen-mode is the externally-comparable benchmark signal.
- **Compounding loop has three named levels.** Per-Solution Verdict score; per-snapshot intra-operator improvement (Improve loop reads corpus, mutates state, codeDigest evolves); per-checkpoint cross-operator improvement (publish, fork, train further from forked starting state).
- **Verified-vs-unverified frozen distinction.** Operators who publish source bundle + implStateDir CID via `jinn checkpoint publish` get "verified frozen" status (independent codeDigest re-derivation enabled). External claims and SolverNet headline numbers pull from verified-frozen entries only.
- **Soft enforcement at v1.** The daemon hash-fence catches honest implementation bugs and lazy attackers. Determined attackers running modified Jinn code can forge codeDigest; the rest of the trust stack (DR-d) covers them. Phase B.1 attested-tier is the cryptographic close.

## Status

Ratified by Captain ritsukai during the design exercise on jinn-mono-9fe5; locked 2026-05-06. Vocabulary `train` / `frozen` (vs earlier `learning` / `frozen`) and `HarnessCheckpoint` (vs earlier `HarnessSnapshot`) ratified the same day per ML-conventions discussion.
