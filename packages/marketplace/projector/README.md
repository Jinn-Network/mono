# @jinn-network/marketplace-projector

The one chain-reading machine for the marketplace binding: decodes TaskCoordinator / JinnRouterV3
/ OLAS Mech Marketplace events (both contract generations) into Task Execution Protocol
observations and signed discovery announcements (design §8, "projector #1").

See the design: `docs/superpowers/specs/2026-07-28-marketplace-binding-design.md` §8.
Implementation plan: `docs/superpowers/plans/2026-07-28-marketplace-binding.md` (Milestone M4).

## Status

Scaffold only (plan Milestone M0). Event decoding, the derivation annotation, the
observation/announcement mapping, the finality policy, and the single-projector censorship
cross-check land at Milestone M4, after `@jinn-network/record-discovery-{protocol,serve,testing}`
+ `facts/task-execution` are green (Phase 3).

Depends on `@jinn-network/marketplace-binding` for the shared today-mode ABIs, event decoders,
and the `ContractGeneration` seam — never re-derives them.
