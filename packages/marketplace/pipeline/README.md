# @jinn-network/marketplace-pipeline

The daemon's marketplace application: the pluggable operator claim predicate, execution wiring
(work-kind → harness/model/plugins/credential config), spend/AI-unit self-protection caps, and
the two-party engagement composition of the marketplace binding's venue verbs with an embedded
`@jinn-network/task-execution-backend-local` instance (as a peer, ruling §7.18) — a composition
LIBRARY proven by tests, not a live daemon cutover (design §9 carve; plan Out of scope).

See the design: `docs/superpowers/specs/2026-07-28-marketplace-binding-design.md` §7/§9.
Implementation plan: `docs/superpowers/plans/2026-07-28-marketplace-binding.md` (Milestone M6,
program §10 Phase 6 — extension wave 2, gated on the backend-local assembly + the TEP engagement
widening).

## Status

Scaffold only (plan Milestone M0). This package's `package.json` deliberately omits
`@jinn-network/task-execution-backend-local` as a dependency for now: that package does not
exist yet in this worktree (`packages/task-execution/backend-local` — Phase 4, "not started" per
the marketplace plan's dependency block). Declaring a portal resolution to a nonexistent
directory would break `yarn install` for this skeleton. The dependency edge lands with the
package's real implementation at Milestone M6 (Phase 6, extension wave 2), once the assembly
package exists — per program §7.6 ("guard-suite ownership ... extended by every later package
registration"). The M0 negative-scope test prevents runtime API from leaking before that gate;
Milestone M6 replaces it with tests for the implemented pipeline contract.
