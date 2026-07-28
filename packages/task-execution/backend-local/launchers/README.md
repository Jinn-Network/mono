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

Scaffold stage (backend plan Milestone A, Tasks A1-A2): sealing utilities
(`compareCodeUnitStrings`, `serializeCanonical`) and the `LaunchPlan`/`LauncherContract`/
`LauncherCapabilities`/`BlameRule`/`ResultContract` contract types. The four v1 launchers
(Milestone B) land next, turning the `@jinn-network/task-execution-testing` `./backend-local`
slice's `describeLauncherContract` green over each of them (it already runs green over the
kit's deterministic fake launcher).

## Never touches

Spawning, retry, secrets beyond declared forwards, or state (design §5/§8.4).
