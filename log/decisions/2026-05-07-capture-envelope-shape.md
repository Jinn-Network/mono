---
id: DR-2026-05-07-a
title: Capture as a third envelope role; sessionProvenance replaces taskProvenance
date: 2026-05-07
verb: Steer
status: ratified
authors: oaksprout, opus (drafted on jinn-mono-6m7t)
spec: spec/2026-05-07-telemetry-collector-and-task-generator.md
---

## Context

The telemetry collector needs a wire shape for locally-captured agent sessions. Three structural shapes were considered:

- **(α) Synthetic on-chain Task per session.** Telemetry collector creates a Task on JinnRouter, signs the envelope claiming to have solved it. 100% reuse of existing wire shapes; captured session indistinguishable from any other claim.
- **(β) New envelope kind.** Define `jinn.session.v1` as a sibling schema next to `jinn.execution.v1`, sharing `executor`/`participant`/`artifacts[]` via composition but with its own top-level discriminator.
- **(c) Same envelope, additive third role.** Add `role: 'capture'` (sibling to `restoration` and `verdict`); add an optional `sessionProvenance` field that replaces the otherwise-required `taskProvenance` when role is `capture`.

## Decision

**Select (c) — same `jinn.execution.v1` envelope, additive `'capture'` role, conditional optional fields.**

The capture envelope is structurally a self-attestation about local work. Adding one role + one optional field is the smallest protocol delta that captures the semantic distinction (no Task in flight; not a Solution) while keeping the wire shape uniform across `executor`, `participant`, `attestation`, `trajectoryRef`, and `artifacts[]`.

## Rationale

- **Self-claiming a synthetic Task is artificial.** Option (α) requires gas-per-session, creates a closed 1:1 loop that doesn't reflect what's happening (a builder doing their own work, then sharing it), and conflates two distinct semantic stances. The substrate's existing role taxonomy (`restoration` = "I responded to a Task"; `verdict` = "I evaluated a response") is asking to be extended, not worked around.
- **One envelope kind, not two.** Option (β) bifurcates the wire surface and the indexing path. Two envelope schemas mean two scrubbing pipelines, two subgraph entity stacks, two manifest-hygiene paths. The only structural difference between a capture and a restoration is provenance — that's a field, not an envelope kind.
- **The `executor.mode` and trust-stack work in the sibling spec compose cleanly.** Frozen-mode captures are valid (a checkpoint run on a local task is a meaningful capture); train-mode captures are the common case. Reuse of `executor` means freeze-fence enforcement, ReputationRegistry, and the rest of the trust stack apply uniformly.

## Alternatives considered and rejected

- **(α) Synthetic on-chain Task per session.** Rejected for the artificial closed-loop semantics, gas-per-session cost, and the on-chain registry pollution. Originally floated as the wire-shape-reuse-maximising option; the user pushed back on "why claim to have solved it when no one issued a task" and that pushback is correct.
- **(β) New envelope kind `jinn.session.v1`.** Rejected for the wire-surface duplication. The composition story (sharing `executor`, `participant`, `artifacts[]` via a base schema) is theoretically clean but practically introduces a second conformance surface, second migration story, and second indexing path. The cost/benefit doesn't justify the parallel kind.
- **No envelope wrapper — publish trajectory artifact alone.** Rejected for losing the `executor`/`participant`/`access` hygiene that the envelope provides. Captures are signed self-attestations; signing requires an envelope-shaped object; the `jinn.execution.v1` shape is what gives that to us.

## Consequences

- **Adds one new role value to `RoleSchema`** (`client/src/types/envelope.ts`). Existing readers must learn to handle `'capture'` (typically: filter it out unless they're capture-aware).
- **Makes `taskProvenance` optional** (required iff `role !== 'capture'`); adds `sessionProvenance` (required iff `role === 'capture'`). Validators must enforce the conditional. Existing envelopes (no `'capture'` role) parse unchanged.
- **Subgraph indexing extends to capture envelopes** as a parallel stream. New `CaptureEnvelope` entity; `CapturesByRepo` and `CapturesByOperator` aggregations.
- **`captureManifest` extends the existing `redactionManifest`** (in the trajectory artifact, not the envelope itself; envelope-level fields stay generic across roles).

## Status

Ratified by Captain oaksprout during the design exercise on jinn-mono-6m7t; locked 2026-05-07.
