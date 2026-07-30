# @jinn-network/marketplace-projector

The one chain-reading machine for the marketplace binding: decodes TaskCoordinator / JinnRouterV3
/ OLAS Mech Marketplace events (both contract generations) into Task Execution Protocol
observations and signed discovery announcements (design §8, "projector #1").

See the design: `docs/superpowers/specs/2026-07-28-marketplace-binding-design.md` §8.
Implementation plan: `docs/superpowers/plans/2026-07-28-marketplace-binding.md` (Milestone M4).

## Projection contract

Milestone M4 is implemented. `reduceMarketplaceProjection` is the production composition seam:
the caller persists its explicit state and passes each ordered chain-log batch through one
transition. `projectAnnouncements` consumes that exact transition, so observations and signed
announcements share dedupe, cross-batch Mech joins, capacity, and sequence state. Rebuilding from
the canonical ordered log yields the same outputs.

Reorgs never rewrite signed history. Submission availability receives a signed discovery
retraction; Attempt-scoped facts additionally receive an authoritative `lost` terminal on the
same Attempt/source stream. `selectCanonicalMarketplaceObservations` fails closed unless each
correction names exactly one ordinary observation on that source/Attempt, the target block is
present in the caller's orphaned-hash substrate, and all exact derivation links agree. It then
filters the orphaned ordinary fact while preserving raw objects and the explicit `lost`
correction. A later genuine terminal may supersede `lost` under the unchanged TEP fold.

Depends on `@jinn-network/marketplace-binding` for the shared today-mode ABIs and the
`ContractGeneration` seam — never re-derives them.
