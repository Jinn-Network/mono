# @jinn-network/task-execution-supervisor

The Attempt Supervisor (design §6): process custody, the append-only journal, the durable
attempt record, recovery classification, the cancellation ladder, and deadline enforcement for
one Attempt of the Jinn Task Execution Protocol (TEP) local execution backend.

Deliberately the most dependency-free backend-local component — it depends on
`@jinn-network/task-execution-protocol` and `@jinn-network/task-execution-backend` only, and
never imports the `workspace`/`launchers`/`backend-local` (assembly) packages, profiles, git, or
any evidence package. This is what makes it the piece most worth reusing when building other
task-execution backends.

See the design: `docs/superpowers/specs/2026-07-27-local-execution-backend-design.md` §6 (the
Attempt Supervisor), §14 items 1-6 (frozen interfaces), §15 (packages).

## Status

Scaffold stage (backend plan Milestone A, Tasks A1-A2): sealing utilities
(`compareCodeUnitStrings`, `serializeCanonical`) and the `AttemptIdentity`/`SpawnRequest`
contract types. The shim (A4) and the journal/attempt-record/reconciler/cancellation/deadline
internals (A5) land next, turning the `@jinn-network/task-execution-testing` `./backend-local`
slice's `describeAttemptSupervisorContract` green.

## Never touches

Harness semantics, git, GitHub, marketplaces, or evidence record contents (design §5).
