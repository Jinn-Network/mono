# @jinn-network/task-execution-workspace

The Workspace Provisioner (design §7): the per-attempt directory contract, two-phase
provisioning, input materialization, minimal local capability-grant resolution, and the
symlink-guarded verified-empty harvest for the Jinn Task Execution Protocol (TEP) local
execution backend.

Depends on `@jinn-network/task-execution-protocol` and `@jinn-network/task-execution-profiles`
only — it never imports the `supervisor`/`launchers`/`backend-local` (assembly) packages or any
evidence package. `TaskView` (the parsed Task ⊎ effective merged requirements ⊎ resolved profile
document) is homed here because it carries the profiles-typed resolved profile document, and the
supervisor package must stay profiles-free (design plan Finding (e)).

See the design: `docs/superpowers/specs/2026-07-27-local-execution-backend-design.md` §7 (the
Workspace Provisioner), §14 items 7-8 (frozen interfaces), §15 (packages).

## Status

Milestone B: the plain-directory and exact detached-OID worktree provisioners, typed
never-executed setup rejection, digest-verified/read-only inputs, opaque grant handles,
runtime-injected quota/meta-reserve/process-group custody, deterministic recursive harvest,
and terminal retention are implemented. Concrete conformance adapters live downstream in
`@jinn-network/task-execution-testing` per program ruling §7.25.

## Never touches

Spawning, outcome interpretation (design §5).
