---
id: DR-2026-08-03
title: Phase C converges requester, discovery and operator seams without creating new umbrella abstractions
date: 2026-08-03
verb: Decide
status: ratified
authors: Codex (implementation), repository operator (explicit implementation instruction)
spec: docs/superpowers/specs/2026-08-03-phase-c-capability-boundaries.md
amends: "docs/superpowers/specs/2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md §5 (a new work-client package is no longer the default); docs/superpowers/specs/2026-07-30-operator-daemon-composition-design.md §§3–6 (marketplace-pipeline is legacy compatibility, not native platform authority)"
relates-to: DR-2026-07-30; PR #2363; Phase C Capability Boundary and Transitional Seam Convergence Plan
---

## Context

Phase B implemented persistent native requester, operator and evaluator roles with exact records,
durable recovery, signed public sources, settlement and an independent consumer. The remaining
architecture debt was not missing protocol: product policy still appeared as a tier-3 marketplace
pipeline, requester posting had two recovery lifecycles, signed-source mechanics had product-local
copies, and compatibility paths lacked machine-readable deletion contracts.

Creating the previously proposed work-client and additional wrapper packages would expand public
surface before a second consumer had proved those lifecycles. Keeping the existing copies would
leave multiple durable authorities for the same side effect.

## Decision

1. Dissolve `@jinn-network/marketplace-pipeline` as permanent platform authority. Phase C removes
   native consumers, deprecates and freezes its legacy exports, and moves it from `platform-v1` to
   `legacy-product-lines`. Phase D deletes it after the legacy operator consumer reaches zero.
2. Move only the neutral run-pinning and backend preflight gate into
   `@jinn-network/task-execution-backend`. Operator desirability and execution-selection policy
   remains in tier-4 composition.
3. Do not create a marketplace work-client package. Harden marketplace binding's existing
   requester backend and recover its requester scope through the one posting WAL.
4. Declare Record Discovery the sole public discovery plane; retain evidence discovery as local
   catalog/outbox infrastructure and the evidence-journal adapter as a permanent translator.
5. Extract generic durable source writing into Record Discovery serve without rewriting records,
   signed entries, archive pages or heads.
6. Ratify no task-supply or environment package on Phase B evidence alone; keep speculative
   publication disabled and defer curation extraction until two real consumers prove the join.
7. Keep solution and verdict settlement distinct.
8. Keep the operator default `legacy` through Phase C. Every remaining compatibility surface must
   validate against the closed transition-manifest schema before the final Phase C closure.

## Consequences

- The native role closure loses marketplace-pipeline; platform-v1 loses one package and the
  legacy line gains one independently published compatibility package.
- Existing legacy imports and runtime behavior continue, but CI rejects new consumers and new
  runtime exports.
- Neutral preclaim behavior becomes available to any backend consumer without importing product
  marketplace policy.
- Phase D receives observable, executable deletion inputs rather than prose-only cleanup intent.
- A final live closure is still required for the exact merged Phase C SHA before any default flip.

## Alternatives rejected

- **Keep or narrow marketplace-pipeline as tier 3.** Its spend, claim, model, harness, credential
  and prioritisation choices are product policy already duplicated by the native product.
- **Mint a work-client now.** Only posting/recovery is proven shared; the broader lifecycle lacks
  two independent consumers.
- **Expose two public discovery planes.** That makes record identity and withdrawal authority
  ambiguous.
- **Extract a common settlement client.** Solution and verdict flows own different records and
  authority, and no second product proves a common lifecycle.

## Ratification

Ratified on 2026-08-03 by the operator's explicit instruction to implement the complete Phase C
plan. This record freezes ownership; later implementation pull requests may refine field shapes
but may not choose a different owner without a superseding decision record.
