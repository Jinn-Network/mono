---
id: DR-2026-05-06-d
title: Trust stack composition for the frozen-state contract
date: 2026-05-06
verb: Steer
status: ratified
authors: ritsukai, opus (drafted on jinn-mono-9fe5)
spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md
---

## Context

DR-2026-05-06-c commits a Harness-interface contract: when `ctx.mode === 'frozen'`, a Harness MUST NOT write to `ctx.implStateDir`. Several enforcement mechanisms are possible — daemon-level, evaluator-level, subgraph-level, attested-tier (TEE), reputation-based. The design exercise considered which to commit to at v1.

## Decision

**Adopt a layered trust stack with five active layers at v1 and one future layer at Phase B.1:**

1. **Daemon-level hash-fence (active).** Operator's daemon hashes `implStateDir` before and after each Task in frozen mode. Mismatch → envelope rejected locally; state rolled back to pre-Task snapshot.
2. **Subgraph-level cross-envelope consistency (active, passive observation).** Subgraph indexes `(operator_signing_key, mode, codeDigest, timestamp)`; cross-envelope inconsistencies in claimed frozen-mode codeDigest are publicly observable.
3. **Cross-operator forking validation (active, when checkpoints are forked).** Multiple operators running the same published HarnessCheckpoint produce envelopes with matching codeDigest; discrepancy implies one party violated the contract.
4. **Source-bundle publication (active, voluntary).** Operators who publish source bundle CID + implStateDir CID enable independent codeDigest re-derivation. Verified-vs-unverified frozen credibility distinction surfaced in dashboard.
5. **ReputationRegistry slashing (active).** Caught violations slash reputation; higher-stakes claims (top-of-leaderboard, externally-cited checkpoints) carry larger slash multipliers. Composes with already-shipped `RestorationActivityCheckerV2.sol` SimHash anti-farming decay as defence in depth.
6. **(Future) Phase B.1 attested-tier.** TEE attestation cryptographically proves `mode=frozen` and zero implStateDir mutation. Closes residual gap. Out of v1 scope.

Explicitly **not** in the trust stack at v1: evaluator-level codeDigest verification.

## Rationale

- **Each layer addresses a different threat profile.** Daemon hash-fence catches honest implementation bugs and lazy attackers (operators running stock Jinn code with a buggy harness). Subgraph layer catches deliberate forgery in the codeDigest claim by observing cross-envelope inconsistency. Cross-operator forking is the strongest active verification when checkpoints are widely-forked. Source-bundle publication is the most powerful per-snapshot verification at v1 because it enables anyone to independently re-derive codeDigest. Reputation slashing creates economic disincentive proportional to the stakes of the lie. TEE is the cryptographic close for adversarial threat profiles.
- **Evaluator-level codeDigest check is rejected because it is redundant with the subgraph layer at lower cost.** The evaluator's per-Task scope cannot naturally do cross-Task consistency analysis — that is the subgraph's natural domain. Without source-bundle publication, the evaluator cannot independently re-derive codeDigest (it would need the source); with source-bundle publication, anyone can re-derive — the evaluator is not privileged. Same trust source as daemon (operator self-attestation); adding a redundant check at the same trust level is double-counting, not deepening.
- **Verified-vs-unverified frozen creates the right incentive.** Operators who care about external credibility publish their bundles voluntarily; operators who don't, don't bother. Free market for verification effort. The dashboard's frozen-mode leaderboard ranks verified entries above unverified.

## Alternatives considered and rejected

- **Single-layer enforcement (daemon hash-fence only).** Rejected: catches honest bugs but trivially defeated by an operator running modified Jinn code. The cross-envelope and cross-operator layers are necessary for the threat model.
- **Evaluator-level codeDigest verification as a primary layer.** Rejected per the rationale above.
- **Phase B.1 attested-tier in v1.** Out of scope: the attested-tier infrastructure is its own workstream (`docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md`) with its own dependencies; gating v1 on attested-tier delays the SolverNet ship. The layered honor-system stack is sufficient for v1's threat model and recruit population.
- **No enforcement at all (pure honor system).** Rejected: caught violations need consequences (reputation slashing); without that, the freeze contract is decorative.

## Consequences

- **`jinn checkpoint publish` becomes the discipline for credible benchmark claims.** Without source-bundle publication, frozen-mode scores have lower credibility (unverified). Operators wanting external recognition publish; the verified-vs-unverified distinction surfaces this in the dashboard.
- **Subgraph adds a new derived view.** Per-`(signing_key, mode, codeDigest)` consistency analysis. Engineering scope: ~1-2 days of subgraph schema + indexer work.
- **No evaluator code changes for freeze enforcement.** Evaluator stays focused on its primary job (running the canonical evaluation function on submitted Solutions). Cleaner separation of concerns.
- **ReputationRegistry slashing hook is needed.** A new event type (`FreezeContractViolation`) with slash-multiplier proportional to stake context. Engineering scope: ~1 day on top of existing ReputationRegistry primitives.
- **Phase B.1 attested-tier work is unblocked but not gated.** When attested-tier ships, the existing trust stack composes — verified-frozen + attested-tier becomes the highest-credibility tier; verified-frozen-without-attestation is mid-tier; unverified-frozen is lowest. Smooth migration without breaking existing checkpoints.

## Status

Ratified by Captain ritsukai during the design exercise on jinn-mono-9fe5; locked 2026-05-06.
