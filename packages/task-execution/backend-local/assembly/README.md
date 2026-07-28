# @jinn-network/task-execution-backend-local

The local execution backend: the `TaskExecutionBackend` implementation (design §9) wiring the
Attempt Supervisor, Workspace Provisioner, and Executor Launchers, plus the capacity gate,
single-writer state-root lock, observation projection, assembled `capabilities()`, and the
evidence recorder join (evidence contracts only — concrete bindings are host-injected through
the `awaitIndexed` port, design §10).

This package **is** the local backend (program §6 naming decision: it keeps the `backend-local`
npm name). Per the consumption rule (program §7.18), it is a library — every hosting product
embeds its own instance with its own state root, consumed only through this package's standard
`TaskExecutionBackend` interface. The `supervisor`/`workspace`/`launchers` sibling packages exist
to be consumed individually when building *other* backends; nothing outside
`packages/task-execution/backend-local/` may import them directly except this package, the
`@jinn-network/task-execution-testing` `./backend-local` slice, and the evaluation harness's
launcher surface.

Depends on the three sibling packages plus `@jinn-network/task-execution-protocol`,
`@jinn-network/task-execution-backend`, `@jinn-network/task-execution-profiles`, and the evidence
*contract* packages `@jinn-network/evidence-repository`, `@jinn-network/evidence-discovery`, and
`@jinn-network/execution-recorder`. It never imports `@jinn-network/evidence-local-runtime`, any
`record-discovery-*` package, or any application tree.

See the design: `docs/superpowers/specs/2026-07-27-local-execution-backend-design.md` §5
(component stack), §9 (the backend assembly), §10 (evidence integration), §14 items 1, 10-11
(frozen interfaces), §15 (packages), §16 (conformance — the reference implementation is the TEP
conformance kit's first real consumer).

## Status

Scaffold stage (backend plan Milestone A, Task A1): package registered, dependency edges and CI
job in place. `src/` fills in Milestone C (backend verbs, capacity gate, single-writer lock,
observation projection, assembled capabilities, the evidence join), turning the
`@jinn-network/task-execution-testing` `./backend-local` slice's `describeLocalBackendContract`
(and the TEP core conformance kit run against this binding) green.

## Never touches

Scheduling, queues, settlement, or application authority (design §5).
