# @jinn-network/task-execution-launchers

The Executor Launcher contract and the v1 launchers — claude-code, codex, hermes, cursor
(design §8) — for the Jinn Task Execution Protocol (TEP) local execution backend. A launcher is
a pure function from `(TaskView, WorkspacePaths, AttemptIdentity)` to a `LaunchPlan`; it never
spawns, retries, touches secrets beyond declared forwards, or holds state.

Depends on `@jinn-network/task-execution-protocol`, `@jinn-network/task-execution-profiles`,
`@jinn-network/task-execution-supervisor` (for the `AttemptIdentity` type the frozen `plan(...)`
signature takes), and `@jinn-network/task-execution-workspace` (for `TaskView`/`WorkspacePaths`).
It never imports the `backend-local` (assembly) package or any evidence package, and never
spawns a process (`node:child_process` is forbidden here — the supervisor spawns, through the
shim, per the plan's launchers-plan-supervisor-spawns split).

See the design: `docs/superpowers/specs/2026-07-27-local-execution-backend-design.md` §8 (the
Executor Launcher), §14 items 8-9 (frozen interfaces), §15 (packages).

## Status

Milestone B: four harness-specific pure planners implement hermetic invocation, run-pinning,
structured output, correlation declarations, static capabilities, injected dynamic probes,
and exit/signal-authoritative result interpretation. Concrete conformance invocations live
downstream in `@jinn-network/task-execution-testing` per program ruling §7.25.

## Never touches

Spawning, retry, secrets beyond declared forwards, or state (design §5/§8.4).
